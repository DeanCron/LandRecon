#!/usr/bin/env node
/**
 * Build voting-district boundary files for the LandRecon "Voting districts"
 * layer.
 *
 * Source: U.S. Census Bureau Cartographic Boundary Files (2023 vintage).
 * Public domain.
 *
 * Output: public/data/districts/{cd118,sldu,sldl}.geojson
 *
 * Run with:  npm run build:districts
 */
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import mapshaper from 'mapshaper'

const CENSUS_BASE = 'https://www2.census.gov/geo/tiger/GENZ2023/shp'

const LAYERS = [
  {
    id: 'cd118',
    label: 'Congressional districts (118th)',
    zip: 'cb_2023_us_cd118_500k.zip',
    shp: 'cb_2023_us_cd118_500k.shp',
    keepFields: ['STATEFP', 'CD118FP', 'NAMELSAD', 'GEOID'],
  },
  {
    id: 'sldu',
    label: 'State Senate districts',
    zip: 'cb_2023_us_sldu_500k.zip',
    shp: 'cb_2023_us_sldu_500k.shp',
    keepFields: ['STATEFP', 'SLDUST', 'NAMELSAD', 'GEOID'],
  },
  {
    id: 'sldl',
    label: 'State House districts',
    zip: 'cb_2023_us_sldl_500k.zip',
    shp: 'cb_2023_us_sldl_500k.shp',
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

async function buildCongressResults() {
  console.log('\n[cd118-results] U.S. House 2024 (MIT Election Lab)')
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

  // Aggregate { GEOID -> { d, r, other, total } } from year=2024 general
  // contests. MIT codes at-large districts as "0"; Census uses CD118FP "00".
  const agg = new Map()
  for (const row of rows) {
    if (row.length < header.length) continue
    if (row[idx.year] !== '2024') continue
    if (row[idx.office] !== 'US HOUSE') continue
    if (row[idx.stage] !== 'GEN') continue
    if (row[idx.special] === 'TRUE') continue
    const fips = (row[idx.state_fips] || '').padStart(2, '0')
    let dist = String(row[idx.district] || '0')
    if (dist === '0') dist = '00'
    else dist = dist.padStart(2, '0')
    const geoid = fips + dist
    const party = (row[idx.party] || '').toUpperCase()
    const votes = Number(row[idx.candidatevotes]) || 0
    const total = Number(row[idx.totalvotes]) || 0
    if (!agg.has(geoid)) agg.set(geoid, { d: 0, r: 0, other: 0, total: 0 })
    const a = agg.get(geoid)
    if (party === 'DEMOCRAT') a.d += votes
    else if (party === 'REPUBLICAN') a.r += votes
    else a.other += votes
    a.total = Math.max(a.total, total)
  }

  // Roll up into compact { geoid: { d_pct, r_pct, margin_pct, winner, total } }
  const out = {}
  for (const [geoid, a] of agg) {
    const denom = a.d + a.r + a.other || 1
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
      total: a.total || denom,
      d_pct,
      r_pct,
      margin_pct,
      winner,
    }
  }

  const outPath = join(OUT_DIR, 'cd118-results.json')
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

async function buildStateLegResults(layerId, label) {
  console.log(`\n[${layerId}-results] ${label}`)
  const inputPath = join(process.cwd(), 'data-sources', `${layerId}-results.csv`)
  if (!existsSync(inputPath)) {
    console.log(`  no input at data-sources/${layerId}-results.csv — skipping`)
    console.log('  (drop a CSV with columns: geoid,d_pct,r_pct[,d,r,o,total,winner])')
    return
  }

  process.stdout.write(`  read ${inputPath} ... `)
  const text = await (await import('node:fs/promises')).readFile(inputPath, 'utf8')
  console.log(`${(text.length / 1024).toFixed(1)} KB`)

  const rows = parseCsvAll(text)
  if (rows.length < 2) {
    console.log('  empty input, skipping')
    return
  }
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const col = (name) => header.indexOf(name)
  const iGeoid = col('geoid')
  const iD = col('d_pct')
  const iR = col('r_pct')
  if (iGeoid < 0 || iD < 0 || iR < 0) {
    throw new Error(`${layerId}-results.csv: missing required columns geoid,d_pct,r_pct`)
  }
  const iDv = col('d')
  const iRv = col('r')
  const iOv = col('o')
  const iTot = col('total')
  const iWin = col('winner')

  const out = {}
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row[iGeoid]) continue
    const geoid = row[iGeoid].trim().padStart(5, '0')
    const d_pct = +row[iD] || 0
    const r_pct = +row[iR] || 0
    const margin_pct = +(d_pct - r_pct).toFixed(2)
    const d = iDv >= 0 ? Number(row[iDv]) || 0 : 0
    const rv = iRv >= 0 ? Number(row[iRv]) || 0 : 0
    const o = iOv >= 0 ? Number(row[iOv]) || 0 : 0
    const total = iTot >= 0 ? Number(row[iTot]) || (d + rv + o) : (d + rv + o)
    const winner = (iWin >= 0 && row[iWin])
      ? row[iWin].trim().toUpperCase()
      : (d_pct > r_pct ? 'D' : r_pct > d_pct ? 'R' : 'O')
    out[geoid] = { d, r: rv, o, total, d_pct, r_pct, margin_pct, winner }
  }

  const outPath = join(OUT_DIR, `${layerId}-results.json`)
  const meta = {
    source: 'User-supplied via data-sources/ (typically Daily Kos statewide-by-district, CC BY-NC)',
    fetched_at: new Date().toISOString().slice(0, 10),
    district_count: Object.keys(out).length,
  }
  await writeFile(outPath, JSON.stringify({ meta, results: out }))
  console.log(`  wrote ${outPath} (${Object.keys(out).length} districts)`)
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
  await buildStateLegResults('sldu', 'State Senate results')
  await buildStateLegResults('sldl', 'State House results')

  await rm(WORK_DIR, { recursive: true, force: true })
  console.log('\nDone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
