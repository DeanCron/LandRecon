#!/usr/bin/env node
// scripts/build-broadband-index.mjs
//
// Build server/data/broadband.db — a per-block SQLite summary of the latest
// FCC Broadband Data Collection (BDC) fixed-broadband availability filing.
//
// USAGE
//   # 1. Sign in to https://broadbandmap.fcc.gov/manage-api-access, generate
//   #    an API key. Note: the FCC docs call it a "hash_value" but their UI
//   #    sometimes calls it a "token". They're the same thing.
//   #
//   # 2. Export creds (your FCC account username, usually your email):
//   $ export FCC_USERNAME="you@example.com"
//   $ export FCC_HASH_VALUE="abcdef0123456789..."
//   #
//   # 3a. Full national build (50 states + DC + territories, ~5-15 GB of raw
//   #     CSV download, ~30-90 min depending on bandwidth, final DB ~300-800 MB):
//   $ npm run build:broadband
//   #
//   # 3b. Single-state smoke test (recommended first run, ~30-90 sec):
//   $ npm run build:broadband -- --state=CA
//   #
//   # 3c. Multi-state:
//   $ npm run build:broadband -- --state=CA --state=NV --state=AZ
//
// FLAGS
//   --state=XX            Two-letter postal code, repeatable. Default: all states.
//   --residential-only    Drop business-only providers (default: keep both).
//   --keep-zips           Don't delete downloaded ZIPs after extraction (debug).
//   --out=path/to.db      Override output path (default: server/data/broadband.db).
//   --as-of=YYYY-MM-DD    Override which filing to fetch (default: latest).
//
// Re-running is idempotent: ZIPs cached under tmp/broadband/<as_of>/ are
// reused on the next run. To force a re-download, delete the tmp dir.

import { createRequire } from 'node:module'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const AdmZip = require('adm-zip')

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

// ---------- CLI ----------
const argv = process.argv.slice(2)
const args = {
  states: [],
  residentialOnly: false,
  keepZips: false,
  out: join(REPO_ROOT, 'server', 'data', 'broadband.db'),
  asOf: null,
}
for (const a of argv) {
  if (a.startsWith('--state=')) args.states.push(a.slice(8).toUpperCase())
  else if (a === '--residential-only') args.residentialOnly = true
  else if (a === '--keep-zips') args.keepZips = true
  else if (a.startsWith('--out=')) args.out = resolve(a.slice(6))
  else if (a.startsWith('--as-of=')) args.asOf = a.slice(8)
  else if (a === '--help' || a === '-h') {
    console.log(await readFile(fileURLToPath(import.meta.url), 'utf8').then((s) => s.split('\n').slice(0, 35).join('\n')))
    process.exit(0)
  } else {
    console.error(`Unknown arg: ${a}`)
    process.exit(2)
  }
}

const USERNAME = process.env.FCC_USERNAME
const HASH_VALUE = process.env.FCC_HASH_VALUE
if (!USERNAME || !HASH_VALUE) {
  console.error('FATAL: FCC_USERNAME and FCC_HASH_VALUE env vars required.')
  console.error('  Get a key at https://broadbandmap.fcc.gov/manage-api-access')
  process.exit(1)
}

const FCC_HEADERS = {
  username: USERNAME,
  hash_value: HASH_VALUE,
  'User-Agent': 'LandRecon-broadband-indexer/1.0',
}
const API = 'https://broadbandmap.fcc.gov/api/public/map'

// ---------- helpers ----------
async function fetchJson(url) {
  const res = await fetch(url, { headers: FCC_HEADERS })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
  return await res.json()
}

async function downloadFile(url, dest) {
  const res = await fetch(url, { headers: FCC_HEADERS })
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`)
  const fs = await import('node:fs')
  const out = fs.createWriteStream(dest)
  await pipeline(Readable.fromWeb(res.body), out)
}

function fmtBytes(n) {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`
}

// FCC CSV column names we care about. Names match the BDC public spec
// (lowercase snake_case after FCC's mid-2023 schema cleanup).
const CSV_COLS = [
  'frn', 'provider_id', 'brand_name', 'location_id', 'technology',
  'max_advertised_download_speed', 'max_advertised_upload_speed',
  'low_latency', 'business_residential_code', 'state_usps',
  'block_geoid', 'h3_res8_id',
]

function parseCsvHeader(line) {
  const cols = line.split(',').map((c) => c.trim().toLowerCase().replace(/^"|"$/g, ''))
  const idx = {}
  for (const want of CSV_COLS) idx[want] = cols.indexOf(want)
  return idx
}

function parseCsvRow(line) {
  // Simple CSV parser — FCC BDC files don't contain quoted commas (brand
  // names are pre-sanitized). If a future filing introduces them, swap in
  // papaparse or csv-parse here.
  return line.split(',')
}

// ---------- pipeline ----------
async function main() {
  console.log('[bdc] discovering latest availability filing...')
  const dates = await fetchJson(`${API}/listAsOfDates`)
  const avail = dates?.data
    ?.filter((d) => d.data_type === 'availability')
    ?.sort((a, b) => b.as_of_date.localeCompare(a.as_of_date)) || []
  if (avail.length === 0) throw new Error('No availability dates returned from FCC API')

  const asOf = args.asOf || avail[0].as_of_date
  console.log(`[bdc] as_of_date = ${asOf} (latest of ${avail.length} filings)`)

  const fileList = await fetchJson(`${API}/downloads/listAvailabilityData/${asOf}`)
  const files = (fileList?.data || []).filter((f) => {
    if (f.category !== 'State') return false
    // Subcategory naming has drifted across filings. Accept any of these.
    const sub = String(f.subcategory || '').toLowerCase()
    return sub.includes('fixed') && (sub.includes('broadband') || sub.includes('availability'))
  })
  console.log(`[bdc] ${files.length} state files for ${asOf}`)
  if (files.length === 0) {
    console.error('[bdc] FATAL: no state fixed-broadband files in filing. Schema may have changed.')
    console.error('[bdc] Raw sample:', JSON.stringify(fileList?.data?.slice(0, 3), null, 2))
    process.exit(1)
  }

  let filtered = files
  if (args.states.length > 0) {
    filtered = files.filter((f) => args.states.includes(String(f.state_usps || f.state_name || '').toUpperCase().slice(0, 2)))
    console.log(`[bdc] filtered to ${filtered.length} files for states: ${args.states.join(', ')}`)
    if (filtered.length === 0) {
      console.error('[bdc] FATAL: no files matched --state filter. Sample state values from API:',
        [...new Set(files.slice(0, 10).map((f) => f.state_usps || f.state_name))])
      process.exit(1)
    }
  }

  const tmpRoot = join(REPO_ROOT, 'tmp', 'broadband', asOf)
  await mkdir(tmpRoot, { recursive: true })

  // ---------- prepare SQLite ----------
  await mkdir(dirname(args.out), { recursive: true })
  if (existsSync(args.out)) await rm(args.out)
  const db = new Database(args.out)
  db.pragma('journal_mode = OFF')
  db.pragma('synchronous = OFF')
  db.pragma('temp_store = MEMORY')
  db.exec(`
    CREATE TABLE blocks (
      block_fips TEXT PRIMARY KEY,
      provider_count INTEGER NOT NULL,
      max_down_mbps INTEGER,
      max_up_mbps INTEGER,
      tech_codes TEXT,
      best_provider TEXT,
      providers_json TEXT
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `)

  // Aggregator: Map<block_fips, Map<provider_id, {brand, tech, down, up, br}>>
  // Per-block entries deduped on (provider_id, technology). Keep max speeds
  // across multiple rows from the same provider/tech (BDC sometimes splits
  // a provider's coverage across rows).
  let totalRows = 0
  let blockCount = 0
  const insertBlock = db.prepare(`INSERT OR REPLACE INTO blocks
    (block_fips, provider_count, max_down_mbps, max_up_mbps, tech_codes, best_provider, providers_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)

  const startWall = Date.now()
  // We flush per-state to keep memory bounded. Per-state aggregation is
  // safe because BDC files are partitioned by state (a block FIPS never
  // crosses state lines).
  for (const file of filtered) {
    const stateCode = String(file.state_usps || file.state_name || '?').toUpperCase().slice(0, 2)
    const tech = file.technology_code_desc || file.technology_code || ''
    const zipPath = join(tmpRoot, `${stateCode}_${file.file_id}_${tech}.zip`.replace(/[^\w.-]/g, '_'))

    if (!existsSync(zipPath) || statSync(zipPath).size < 100) {
      console.log(`  [download] ${stateCode} ${tech} (file_id=${file.file_id})`)
      try {
        await downloadFile(`${API}/downloads/downloadFile/availability/${file.file_id}`, zipPath)
      } catch (err) {
        console.error(`  [download FAILED] ${stateCode} ${tech}: ${err.message}`)
        continue
      }
    } else {
      console.log(`  [cached]   ${stateCode} ${tech} ${fmtBytes(statSync(zipPath).size)}`)
    }

    // Extract CSV into memory, aggregate.
    let zip
    try { zip = new AdmZip(zipPath) }
    catch (err) {
      console.error(`  [zip ERROR] ${zipPath}: ${err.message} — deleting and skipping`)
      try { await rm(zipPath) } catch {}
      continue
    }
    const csvEntry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.csv'))
    if (!csvEntry) {
      console.error(`  [no CSV inside ${zipPath}]`)
      continue
    }

    const text = csvEntry.getData().toString('utf8')
    const lines = text.split(/\r?\n/)
    if (lines.length < 2) continue
    const idx = parseCsvHeader(lines[0])
    if (idx.block_geoid < 0) {
      console.error(`  [missing block_geoid col in ${csvEntry.entryName}]`)
      continue
    }

    const stateBlocks = new Map()
    let rowsInFile = 0
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      const r = parseCsvRow(line)
      const block = r[idx.block_geoid]
      if (!block) continue
      const techCode = Number(r[idx.technology])
      const down = Number(r[idx.max_advertised_download_speed]) || 0
      const up = Number(r[idx.max_advertised_upload_speed]) || 0
      const brCode = r[idx.business_residential_code] || ''
      if (args.residentialOnly && brCode === 'B') continue
      const providerId = Number(r[idx.provider_id])
      const brand = r[idx.brand_name] || `Provider ${providerId}`

      let b = stateBlocks.get(block)
      if (!b) { b = new Map(); stateBlocks.set(block, b) }
      const key = `${providerId}|${techCode}`
      const prev = b.get(key)
      if (prev) {
        if (down > prev.down) prev.down = down
        if (up > prev.up) prev.up = up
      } else {
        b.set(key, { providerId, brand, tech: techCode, down, up, br: brCode })
      }
      rowsInFile++
    }
    totalRows += rowsInFile

    // Write this state's aggregations into SQLite. INSERT OR REPLACE
    // handles the rare case where two tech-files in the same state both
    // touch the same block (shouldn't happen but cheap insurance).
    const tx = db.transaction(() => {
      for (const [block, providers] of stateBlocks) {
        let maxDown = 0, maxUp = 0
        const techSet = new Set()
        let bestProv = null, bestScore = -1
        const arr = []
        for (const p of providers.values()) {
          if (p.down > maxDown) maxDown = p.down
          if (p.up > maxUp) maxUp = p.up
          techSet.add(p.tech)
          // Score: prefer fiber, then highest speed.
          const score = p.down + (p.tech === 50 ? 100000 : 0)
          if (score > bestScore) { bestScore = score; bestProv = p.brand }
          arr.push({
            name: p.brand,
            tech: p.tech,
            down: p.down,
            up: p.up,
            br: p.br,
          })
        }
        // Sort providers: fiber first, then by down speed desc.
        arr.sort((a, b) => (b.tech === 50 ? 1 : 0) - (a.tech === 50 ? 1 : 0) || b.down - a.down)
        const techCodesCsv = [...techSet].sort((a, b) => a - b).join(',')
        insertBlock.run(
          block,
          providers.size,
          maxDown || null,
          maxUp || null,
          techCodesCsv,
          bestProv,
          JSON.stringify(arr),
        )
        blockCount++
      }
    })
    tx()

    console.log(`  [parsed]   ${stateCode} ${tech}: ${rowsInFile} rows -> ${stateBlocks.size} blocks (DB: ${blockCount} total)`)
    if (!args.keepZips) await rm(zipPath).catch(() => {})
  }

  // Write meta.
  const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
  insertMeta.run('as_of_date', asOf)
  insertMeta.run('built_at', new Date().toISOString())
  insertMeta.run('row_count', String(blockCount))
  insertMeta.run('source_rows', String(totalRows))
  insertMeta.run('residential_only', args.residentialOnly ? '1' : '0')
  insertMeta.run('schema_version', '1')
  insertMeta.run('states_filter', args.states.join(',') || 'ALL')

  db.exec('VACUUM')
  db.close()

  const size = statSync(args.out).size
  const elapsed = ((Date.now() - startWall) / 1000).toFixed(1)
  console.log(`\n[bdc] DONE: ${args.out} (${fmtBytes(size)}) — ${blockCount} blocks, ${totalRows} source rows, ${elapsed}s`)
  console.log(`[bdc] Restart the og sidecar (or full container) to pick up the new index.`)
}

main().catch((err) => {
  console.error('[bdc] FATAL:', err)
  process.exit(1)
})
