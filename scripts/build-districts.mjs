#!/usr/bin/env node
/**
 * Build voting-district boundary files for the LandRecon "Voting districts"
 * layer.
 *
 * Source: U.S. Census Bureau Cartographic Boundary Files (2025 vintage,
 * 119th Congress). Public domain.
 *
 * Congressional boundaries must be the same Congress as the election results
 * joined to them: the 2024 House results are on the 119th Congress lines
 * (AL, GA, LA, NY and NC were redrawn after the 118th).
 *
 * Output: public/data/districts/{cd119,sldu,sldl}.geojson
 *         public/data/districts/cd119-results.json
 *
 * Run with:  npm run build:districts
 */
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import mapshaper from 'mapshaper'

const VINTAGE = 2025
const CENSUS_BASE = `https://www2.census.gov/geo/tiger/GENZ${VINTAGE}/shp`

const LAYERS = [
  {
    id: 'cd119',
    label: 'Congressional districts (119th)',
    zip: `cb_${VINTAGE}_us_cd119_500k.zip`,
    shp: `cb_${VINTAGE}_us_cd119_500k.shp`,
    keepFields: ['STATEFP', 'CD119FP', 'NAMELSAD', 'GEOID'],
  },
  {
    id: 'sldu',
    label: 'State Senate districts',
    zip: `cb_${VINTAGE}_us_sldu_500k.zip`,
    shp: `cb_${VINTAGE}_us_sldu_500k.shp`,
    keepFields: ['STATEFP', 'SLDUST', 'NAMELSAD', 'GEOID'],
  },
  {
    id: 'sldl',
    label: 'State House districts',
    zip: `cb_${VINTAGE}_us_sldl_500k.zip`,
    shp: `cb_${VINTAGE}_us_sldl_500k.shp`,
    keepFields: ['STATEFP', 'SLDLST', 'NAMELSAD', 'GEOID'],
  },
]

const OUT_DIR = join(process.cwd(), 'public', 'data', 'districts')
const WORK_DIR = join(tmpdir(), 'landrecon-districts')

async function download(url, dest) {
  process.stdout.write(`  fetch ${url} ... `)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(dest, buf)
  console.log(`${(buf.length / 1024 / 1024).toFixed(1)} MB`)
}

function unzip(zipPath, outDir) {
  const z = new AdmZip(zipPath)
  z.extractAllTo(outDir, true)
}

async function buildLayer(layer) {
  console.log(`\n[${layer.id}] ${layer.label}`)
  const zipPath = join(WORK_DIR, layer.zip)
  const shpDir = join(WORK_DIR, layer.id)
  const outPath = join(OUT_DIR, `${layer.id}.geojson`)

  await download(`${CENSUS_BASE}/${layer.zip}`, zipPath)
  await mkdir(shpDir, { recursive: true })
  unzip(zipPath, shpDir)

  const shpPath = join(shpDir, layer.shp)
  const fields = layer.keepFields.join(',')

  // -simplify 10% dp keep-shapes : Douglas-Peucker, retain small islands
  // -filter-fields                : drop noisy Census attributes we don't use
  // -proj wgs84                   : Leaflet expects lon/lat (EPSG:4326)
  // -o precision=0.00001          : ~1m, plenty for choropleth display
  const cmd =
    `-i "${shpPath}" ` +
    `-simplify 10% dp keep-shapes ` +
    `-filter-fields ${fields} ` +
    `-proj wgs84 ` +
    `-o format=geojson precision=0.00001 "${outPath}"`

  await mapshaper.runCommands(cmd)

  const { size } = await import('node:fs').then((m) =>
    new Promise((resolve, reject) =>
      m.stat(outPath, (err, s) => (err ? reject(err) : resolve(s))),
    ),
  )
  console.log(`  wrote ${outPath} (${(size / 1024 / 1024).toFixed(2)} MB)`)
}

// Ballot-accounting rows in the MIT export, not votes for anyone. MIT counts
// them in some states' totals and not others', so they are dropped to keep
// vote shares comparable (and the popup's rows summing to its total).
const NON_VOTE_ROWS = new Set([
  'BLANK', 'BLANKS', 'BLANK VOTES', 'VOID', 'OVER VOTES', 'UNDER VOTES', 'EXHAUSTED BALLOTS',
])

// MIT party labels are "DEMOCRAT" / "REPUBLICAN" except where a state's party
// has its own name: Minnesota's is "DEMOCRATIC-FARMER-LABOR", Vermont's
// Republican line is "REPUBLICAN, LIBERTARIAN".
function majorSide(party) {
  if (party.startsWith('DEMOCRAT')) return 'd'
  if (party.startsWith('REPUBLICAN')) return 'r'
  return null
}

// Tally one contest's rows into { d, r, other } candidate votes. New York-style
// fusion voting lists a candidate's minor-party lines (Working Families,
// Conservative, ...) as separate rows flagged fusion_ticket; they belong to
// the major party the same candidate also ran under. Fusion lines MIT records
// without a candidate name (CT Working Families) stay in "other".
function tallyContest(candidates) {
  const side = new Map()
  for (const c of candidates) {
    const s = majorSide(c.party)
    if (s && !c.fusion && !side.has(c.candidate)) side.set(c.candidate, s)
  }
  const tally = { d: 0, r: 0, other: 0 }
  for (const c of candidates) {
    if (NON_VOTE_ROWS.has(c.candidate)) continue
    const s = majorSide(c.party) ?? (c.fusion ? side.get(c.candidate) : undefined)
    if (s === 'd') tally.d += c.votes
    else if (s === 'r') tally.r += c.votes
    else tally.other += c.votes
  }
  return tally
}

async function buildCongressResults() {
  console.log('\n[cd119-results] U.S. House 2024 (MIT Election Lab)')
  const guestbookBody = JSON.stringify({
    guestbookResponse: {
      name: 'LandRecon Build Pipeline',
      email: 'noreply@landrecon.io',
      institution: 'LandRecon',
      position: 'Build',
      downloadtype: 'Original Format',
    },
  })

  process.stdout.write('  request signed URL ... ')
  const gbRes = await fetch(
    'https://dataverse.harvard.edu/api/access/datafile/13592823',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: guestbookBody,
    },
  )
  if (!gbRes.ok) throw new Error(`Guestbook POST failed: HTTP ${gbRes.status}`)
  const gbData = await gbRes.json()
  const signedUrl = gbData?.data?.signedUrl
  if (!signedUrl) throw new Error('No signedUrl in guestbook response')
  console.log('ok')

  process.stdout.write('  fetch MIT House 1976-2024 ... ')
  const csvRes = await fetch(signedUrl)
  if (!csvRes.ok) throw new Error(`CSV fetch failed: HTTP ${csvRes.status}`)
  const csvText = await csvRes.text()
  console.log(`${(csvText.length / 1024 / 1024).toFixed(1)} MB`)

  // The MIT export wraps each whole data row in `"..."` and uses `\"` for
  // embedded quotes (JSON-style, not RFC 4180 `""`). After stripping the
  // outer quotes and unescaping, the result is standard RFC 4180 CSV with
  // some quoted fields that contain commas and newlines (e.g. "AL LAWSON,\nJR").
  // Strip header (it's clean) then normalize and parse the rest.
  const newline = csvText.indexOf('\n')
  const headerLine = csvText.slice(0, newline).replace(/\r$/, '')
  const header = parseCsvAll(headerLine)[0]
  const idx = Object.fromEntries(header.map((h, i) => [h, i]))

  // Strip outer record quotes + unescape \" -> "
  const body = csvText
    .slice(newline + 1)
    .replace(/^"|"\r?\n?$/gm, '')
    .replace(/\\"/g, '"')

  const rows = parseCsvAll(body)

  // Group candidate rows by GEOID from year=2024 general contests. MIT codes
  // at-large districts as "0"; Census uses CD119FP "00". DC's delegate race is
  // also "0" at MIT, but Census numbers non-voting delegate districts "98"
  // (DC would otherwise never join to its boundary).
  const contests = new Map()
  for (const row of rows) {
    if (row.length < header.length) continue
    if (row[idx.year] !== '2024') continue
    if (row[idx.office] !== 'US HOUSE') continue
    if (row[idx.stage] !== 'GEN') continue
    if (row[idx.special] === 'TRUE') continue
    const fips = (row[idx.state_fips] || '').padStart(2, '0')
    let dist = String(row[idx.district] || '0')
    if (dist === '0') dist = fips === '11' ? '98' : '00'
    else dist = dist.padStart(2, '0')
    const geoid = fips + dist
    if (!contests.has(geoid)) contests.set(geoid, [])
    contests.get(geoid).push({
      candidate: row[idx.candidate] || '',
      party: (row[idx.party] || '').toUpperCase(),
      fusion: row[idx.fusion_ticket] === 'TRUE',
      votes: Number(row[idx.candidatevotes]) || 0,
    })
  }

  // Roll up into compact { geoid: { d_pct, r_pct, margin_pct, winner, total } }.
  // total is the votes cast for candidates, so d + r + o === total.
  const out = {}
  for (const [geoid, candidates] of contests) {
    const a = tallyContest(candidates)
    const total = a.d + a.r + a.other
    const denom = total || 1
    const d_pct = +((a.d / denom) * 100).toFixed(2)
    const r_pct = +((a.r / denom) * 100).toFixed(2)
    const margin_pct = +(d_pct - r_pct).toFixed(2)
    const winner =
      a.d > a.r && a.d > a.other ? 'D' :
      a.r > a.d && a.r > a.other ? 'R' :
      'O'
    out[geoid] = {
      d: a.d,
      r: a.r,
      o: a.other,
      total,
      d_pct,
      r_pct,
      margin_pct,
      winner,
    }
  }

  const outPath = join(OUT_DIR, 'cd119-results.json')
  const meta = {
    source: 'MIT Election Data and Science Lab — U.S. House 1976-2024 (CC0)',
    cycle: 2024,
    fetched_at: new Date().toISOString().slice(0, 10),
    district_count: Object.keys(out).length,
  }
  await writeFile(outPath, JSON.stringify({ meta, results: out }))
  console.log(`  wrote ${outPath} (${Object.keys(out).length} districts)`)
}

// Minimal RFC 4180 CSV parser over a full document. Handles quoted fields
// containing commas, escaped quotes (""), and newlines.
function parseCsvAll(text) {
  const rows = []
  let row = []
  let cur = ''
  let i = 0
  let inQuotes = false
  while (i < text.length) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i += 2; continue }
      if (c === '"') { inQuotes = false; i++; continue }
      cur += c; i++; continue
    }
    if (c === '"') { inQuotes = true; i++; continue }
    if (c === ',') { row.push(cur); cur = ''; i++; continue }
    if (c === '\r') { i++; continue }
    if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; i++; continue }
    cur += c; i++
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row) }
  return rows
}

async function main() {
  console.log('Building LandRecon voting-district boundary + results files')
  console.log(`  out: ${OUT_DIR}`)
  console.log(`  tmp: ${WORK_DIR}`)
  await mkdir(OUT_DIR, { recursive: true })
  if (existsSync(WORK_DIR)) await rm(WORK_DIR, { recursive: true, force: true })
  await mkdir(WORK_DIR, { recursive: true })

  for (const layer of LAYERS) {
    await buildLayer(layer)
  }

  await buildCongressResults()

  await rm(WORK_DIR, { recursive: true, force: true })
  console.log('\nDone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
