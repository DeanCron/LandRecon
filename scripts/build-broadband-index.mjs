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
//   --tech=N              FCC technology_code (10/40/50/60/61/70/71/72), repeatable.
//                         Default: all fixed-broadband techs. Use --tech=50 for a
//                         fiber-only smoke test (smallest meaningful subset).
//   --residential-only    Drop business-only providers (default: keep both).
//   --max-rows=N          Stop after N rows per file (debug; default unlimited).
//   --keep-zips           Don't delete downloaded ZIPs after extraction (debug).
//   --out=path/to.db      Override output path (default: server/data/broadband.db).
//   --as-of=YYYY-MM-DD    Override which filing to fetch (default: latest).
//
// Re-running is idempotent: ZIPs cached under tmp/broadband/<as_of>/ are
// reused on the next run. To force a re-download, delete the tmp dir.

import { createRequire } from 'node:module'
import { mkdir, rm, readFile } from 'node:fs/promises'
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
  techs: [],
  residentialOnly: false,
  keepZips: false,
  maxRows: 0,
  out: join(REPO_ROOT, 'server', 'data', 'broadband.db'),
  asOf: null,
}
for (const a of argv) {
  if (a.startsWith('--state=')) args.states.push(a.slice(8).toUpperCase())
  else if (a.startsWith('--tech=')) args.techs.push(Number(a.slice(7)))
  else if (a === '--residential-only') args.residentialOnly = true
  else if (a === '--keep-zips') args.keepZips = true
  else if (a.startsWith('--max-rows=')) args.maxRows = Number(a.slice(11))
  else if (a.startsWith('--out=')) args.out = resolve(a.slice(6))
  else if (a.startsWith('--as-of=')) args.asOf = a.slice(8)
  else if (a === '--help' || a === '-h') {
    console.log(await readFile(fileURLToPath(import.meta.url), 'utf8').then((s) => s.split('\n').slice(0, 40).join('\n')))
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

// Extract the first .csv entry from a ZIP onto disk and return its path.
// Streaming the file off disk uses bounded memory regardless of how
// large the CSV is (FCC fixed-broadband files can exceed 10 GB
// uncompressed for the larger states + satellite techs).
async function extractCsvToDisk(zipPath, destDir) {
  let zip
  try { zip = new AdmZip(zipPath) }
  catch (err) {
    console.error(`  [zip ERROR] ${zipPath}: ${err.message}`)
    return null
  }
  const csvEntry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.csv'))
  if (!csvEntry) return null
  const fs = await import('node:fs')
  const outPath = join(destDir, csvEntry.entryName)
  await mkdir(dirname(outPath), { recursive: true })
  // AdmZip returns the full decompressed entry as one Buffer. For huge
  // entries (GSO satellite in CA is ~2.7 GB) we can't use writeFileSync
  // because its `length` param is capped at INT32_MAX (~2.1 GB). Chunk
  // the write through openSync/writeSync/closeSync instead.
  const data = csvEntry.getData()
  const fd = fs.openSync(outPath, 'w')
  try {
    const CHUNK = 1 << 28 // 256 MB per write — well under the int32 cap
    for (let off = 0; off < data.length; off += CHUNK) {
      const end = Math.min(off + CHUNK, data.length)
      fs.writeSync(fd, data, off, end - off, off)
    }
  } finally {
    fs.closeSync(fd)
  }
  return outPath
}

// Stream-parse a CSV onto disk into the per-state `blocks` aggregator.
// Returns the number of source rows ingested, or -1 if the header was
// missing required columns.
async function streamCsv(csvPath, blocks, opts) {
  const stream = createReadStream(csvPath, { encoding: 'utf8', highWaterMark: 1 << 20 })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let idx = null
  let rows = 0
  for await (const line of rl) {
    if (!line) continue
    if (!idx) {
      idx = parseCsvHeader(line)
      if (idx.block_geoid < 0) {
        console.error(`  [missing block_geoid col in ${csvPath}]`)
        rl.close()
        return -1
      }
      continue
    }
    if (opts.maxRows && rows >= opts.maxRows) { rl.close(); break }
    const r = parseCsvRow(line)
    const block = r[idx.block_geoid]
    if (!block) continue
    const techCode = Number(r[idx.technology])
    const down = Number(r[idx.max_advertised_download_speed]) || 0
    const up = Number(r[idx.max_advertised_upload_speed]) || 0
    const brCode = r[idx.business_residential_code] || ''
    if (opts.residentialOnly && brCode === 'B') { rows++; continue }
    const providerId = Number(r[idx.provider_id])
    const brand = r[idx.brand_name] || `Provider ${providerId}`

    let b = blocks.get(block)
    if (!b) { b = new Map(); blocks.set(block, b) }
    const key = `${providerId}|${techCode}`
    const prev = b.get(key)
    if (prev) {
      if (down > prev.down) prev.down = down
      if (up > prev.up) prev.up = up
    } else {
      b.set(key, { providerId, brand, tech: techCode, down, up, br: brCode })
    }
    rows++
  }
  return rows
}

// Tiny FIPS -> USPS lookup, just enough for --state filtering and log
// formatting (~60 entries, no need to import a real dataset).
const STATE_FIPS_TO_USPS = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT',
  '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL',
  '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD',
  '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE',
  '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND',
  '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV',
  '55': 'WI', '56': 'WY', '60': 'AS', '66': 'GU', '69': 'MP', '72': 'PR', '78': 'VI',
}
function stateFipsToUsps(fips) {
  return STATE_FIPS_TO_USPS[String(fips || '').padStart(2, '0')] || `?${fips}`
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
  // The state-level "Location Coverage" Fixed Broadband files are the
  // canonical aggregate: one file per (state × technology_code), each row
  // is one BSL × one provider × one tech. (Per-provider files cover the
  // same data partitioned differently.) Subcategory naming has drifted a
  // bit historically — be generous in matching.
  const files = (fileList?.data || []).filter((f) => {
    if (f.category !== 'State') return false
    if (f.file_type !== 'csv') return false
    const tt = String(f.technology_type || '').toLowerCase()
    const sub = String(f.subcategory || '').toLowerCase()
    return tt.includes('fixed') && tt.includes('broadband')
      && (sub.includes('location coverage') || sub.includes('availability'))
  })
  console.log(`[bdc] ${files.length} state Fixed Broadband Location Coverage files for ${asOf}`)
  if (files.length === 0) {
    console.error('[bdc] FATAL: no state fixed-broadband files in filing. Schema may have changed.')
    console.error('[bdc] Raw sample:', JSON.stringify(fileList?.data?.slice(0, 3), null, 2))
    process.exit(1)
  }

  let filtered = files
  if (args.states.length > 0) {
    // CA -> state_fips=06; we filter on state_usps but also accept state_name fallback.
    filtered = filtered.filter((f) => args.states.includes(String(f.state_name || '').toUpperCase()) || args.states.includes(stateFipsToUsps(f.state_fips)))
    console.log(`[bdc] after --state filter: ${filtered.length} files for ${args.states.join(', ')}`)
    if (filtered.length === 0) {
      console.error('[bdc] FATAL: no files matched --state filter. Sample state values from API:',
        [...new Set(files.slice(0, 10).map((f) => f.state_name))])
      process.exit(1)
    }
  }
  if (args.techs.length > 0) {
    filtered = filtered.filter((f) => args.techs.includes(Number(f.technology_code)))
    console.log(`[bdc] after --tech filter: ${filtered.length} files for tech codes ${args.techs.join(', ')}`)
    if (filtered.length === 0) {
      console.error('[bdc] FATAL: no files matched --tech filter.')
      process.exit(1)
    }
  }

  // Group by state so we can flush the per-state aggregation Map to
  // SQLite at state boundaries (keeps heap bounded — never holds more
  // than one state's blocks in memory at a time).
  const byState = new Map()
  for (const f of filtered) {
    const sf = String(f.state_fips || '').padStart(2, '0')
    if (!byState.has(sf)) byState.set(sf, [])
    byState.get(sf).push(f)
  }
  console.log(`[bdc] processing ${byState.size} state${byState.size === 1 ? '' : 's'} with ${filtered.length} files total`)

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

  let totalRows = 0
  let blockCount = 0
  const insertBlock = db.prepare(`INSERT OR REPLACE INTO blocks
    (block_fips, provider_count, max_down_mbps, max_up_mbps, tech_codes, best_provider, providers_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)

  const startWall = Date.now()

  for (const [stateFips, stateFiles] of byState) {
    const stateName = stateFiles[0].state_name || `FIPS ${stateFips}`
    const stateUsps = stateFipsToUsps(stateFips)
    console.log(`\n[bdc] === ${stateUsps} (${stateName}) — ${stateFiles.length} tech files ===`)

    // One aggregator per state. Block FIPS never cross state lines, so
    // dumping after the state is processed yields complete per-block rows.
    // Map<block_fips, Map<"provider|tech", {brand, tech, down, up, br}>>
    const blocks = new Map()
    let stateSourceRows = 0

    for (const file of stateFiles) {
      const tech = file.technology_code_desc || file.technology_code || ''
      const zipPath = join(tmpRoot, `${stateUsps}_${file.file_id}_${tech}.zip`.replace(/[^\w.-]/g, '_'))

      if (!existsSync(zipPath) || statSync(zipPath).size < 100) {
        const sizeHint = file.record_count ? ` (~${file.record_count} rows)` : ''
        console.log(`  [download] ${tech}${sizeHint}`)
        try {
          await downloadFile(`${API}/downloads/downloadFile/availability/${file.file_id}`, zipPath)
        } catch (err) {
          console.error(`  [download FAILED] ${tech}: ${err.message}`)
          continue
        }
      } else {
        console.log(`  [cached]   ${tech} ${fmtBytes(statSync(zipPath).size)}`)
      }

      // Stream the CSV out of the ZIP rather than loading whole files
      // into memory — individual tech files for big states (GSO sat in
      // CA = 30M rows) can exceed Node's 2GB string limit.
      const csvPath = await extractCsvToDisk(zipPath, tmpRoot)
      if (!csvPath) {
        console.error(`  [no CSV inside ${zipPath}]`)
        continue
      }

      const rowsInFile = await streamCsv(csvPath, blocks, {
        residentialOnly: args.residentialOnly,
        maxRows: args.maxRows,
      })
      if (rowsInFile === -1) {
        // Header parse failure already logged.
        await rm(csvPath).catch(() => {})
        continue
      }
      stateSourceRows += rowsInFile
      totalRows += rowsInFile
      console.log(`  [parsed]   ${tech}: ${rowsInFile.toLocaleString()} rows (state agg: ${blocks.size.toLocaleString()} blocks)`)
      await rm(csvPath).catch(() => {})
      if (!args.keepZips) await rm(zipPath).catch(() => {})
    }

    // Flush state aggregation to SQLite.
    console.log(`  [flush]    ${stateUsps}: ${blocks.size.toLocaleString()} blocks, ${stateSourceRows.toLocaleString()} source rows`)
    const tx = db.transaction(() => {
      for (const [block, providers] of blocks) {
        let maxDown = 0, maxUp = 0
        const techSet = new Set()
        let bestProv = null, bestScore = -1
        const arr = []
        for (const p of providers.values()) {
          if (p.down > maxDown) maxDown = p.down
          if (p.up > maxUp) maxUp = p.up
          techSet.add(p.tech)
          const score = p.down + (p.tech === 50 ? 100000 : 0)
          if (score > bestScore) { bestScore = score; bestProv = p.brand }
          arr.push({ name: p.brand, tech: p.tech, down: p.down, up: p.up, br: p.br })
        }
        arr.sort((a, b) => (b.tech === 50 ? 1 : 0) - (a.tech === 50 ? 1 : 0) || b.down - a.down)
        const techCodesCsv = [...techSet].sort((a, b) => a - b).join(',')
        insertBlock.run(block, providers.size, maxDown || null, maxUp || null, techCodesCsv, bestProv, JSON.stringify(arr))
        blockCount++
      }
    })
    tx()
    // Drop the state aggregation Map so its memory is reclaimed before
    // we start the next state.
    blocks.clear()
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
