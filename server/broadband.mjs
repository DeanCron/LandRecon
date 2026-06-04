// server/broadband.mjs — per-address broadband availability lookup.
//
// Architecture:
//   1. Client SPA hits /api/broadband?lat=X&lng=Y (same-origin, no CSP burn)
//   2. nginx proxies to this sidecar (mounted in og.mjs at /api/broadband)
//   3. We resolve lat/lng → 15-digit census block FIPS via the keyless
//      FCC geo API (geo.fcc.gov/api/census/block/find).
//   4. If a pre-built SQLite index is present at server/data/broadband.db,
//      we look up the block's provider summary. Otherwise we return just
//      the census block metadata so the client can still show *something*.
//   5. Response is small JSON the client renders into an analysis card.
//
// The SQLite index is populated out-of-band by `scripts/build-broadband-index.mjs`
// using the user's FCC BDC API credentials (FCC_USERNAME + FCC_HASH_VALUE).
// See that script's header for the bootstrap procedure.

import { createRequire } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.LR_BROADBAND_DB
  || join(__dirname, 'data', 'broadband.db')

const LR_DEBUG = process.env.LR_DEBUG_BROADBAND === '1' || process.env.LR_DEBUG === '1'
function dbg(...args) { if (LR_DEBUG) console.debug('[broadband]', ...args) }

// FCC technology codes per BDC schema. Stored as integers in the DB; we
// render friendly labels client-side too, but expose them here as a single
// shared truth table so the build script and the runtime read agree.
export const BDC_TECH_LABELS = {
  0:  'Other',
  10: 'DSL (copper)',
  40: 'Cable',
  50: 'Fiber',
  60: 'GSO satellite',
  61: 'LEO satellite',
  70: 'Fixed wireless (unlicensed)',
  71: 'Fixed wireless (licensed)',
  72: 'Fixed wireless (CBRS)',
}

// Speed-tier color buckets the client will mirror in its CSS. Returned as
// part of the response so the client doesn't have to re-derive it.
function speedTier(downMbps) {
  if (downMbps == null) return null
  if (downMbps >= 1000) return 'gig'
  if (downMbps >= 100)  return 'fast'
  if (downMbps >= 25)   return 'served'
  return 'underserved'
}

// LRU for geo.fcc.gov lookups — typed addresses cluster on a small set of
// blocks (one per household), so a tiny cache eliminates 99% of the calls.
const geoCache = new Map()
const GEO_CACHE_LIMIT = 500

function geoCacheGet(key) {
  if (!geoCache.has(key)) return null
  const v = geoCache.get(key)
  geoCache.delete(key); geoCache.set(key, v)
  return v
}
function geoCacheSet(key, val) {
  if (geoCache.has(key)) geoCache.delete(key)
  geoCache.set(key, val)
  while (geoCache.size > GEO_CACHE_LIMIT) geoCache.delete(geoCache.keys().next().value)
}

async function lookupBlock(lat, lng) {
  // Quantize to 5 decimal places (~1m precision) for cache stability.
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`
  const cached = geoCacheGet(key)
  if (cached) return cached
  const url = `https://geo.fcc.gov/api/census/block/find?latitude=${lat}&longitude=${lng}&format=json`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'LandRecon/1.0' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      dbg('geo lookup HTTP', res.status)
      return null
    }
    const j = await res.json()
    if (j?.status !== 'OK' || !j?.Block?.FIPS) return null
    const result = {
      blockFips: String(j.Block.FIPS),
      county: String(j.County?.name || ''),
      countyFips: String(j.County?.FIPS || ''),
      state: String(j.State?.code || ''),
      stateName: String(j.State?.name || ''),
      stateFips: String(j.State?.FIPS || ''),
    }
    geoCacheSet(key, result)
    return result
  } catch (err) {
    dbg('geo lookup failed:', err?.message)
    return null
  }
}

// Lazy-loaded better-sqlite3. The module isn't loaded until the first
// request, so a container without the DB still starts cleanly and the
// /api/broadband endpoint just returns block info without provider summary.
let _db = null
let _dbStmt = null
let _dbMeta = null
// We deliberately do not cache "DB not present" because in the deployed
// container the DB is downloaded from blob storage in the background
// after entrypoint.sh starts, which may take 30-60s on cold start. If we
// cached the missing-DB result we'd be stuck in lookup-only mode for the
// life of the process. existsSync() is cheap and we only call it until
// the DB shows up.

async function getDb() {
  if (_db) return _db
  if (!existsSync(DB_PATH)) {
    return null
  }
  try {
    const require = createRequire(import.meta.url)
    const Database = require('better-sqlite3')
    _db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
    _db.pragma('journal_mode = OFF')
    _db.pragma('query_only = TRUE')
    _dbStmt = _db.prepare('SELECT provider_count, max_down_mbps, max_up_mbps, tech_codes, best_provider, providers_json FROM blocks WHERE block_fips = ?')
    const metaRows = _db.prepare('SELECT key, value FROM meta').all()
    _dbMeta = Object.fromEntries(metaRows.map((r) => [r.key, r.value]))
    const sizeMb = (statSync(DB_PATH).size / 1024 / 1024).toFixed(1)
    console.log(`[broadband] opened ${DB_PATH} (${sizeMb} MB, as_of=${_dbMeta.as_of_date || '?'}, rows=${_dbMeta.row_count || '?'})`)
    return _db
  } catch (err) {
    // Reset state so a subsequent call (e.g. after a partial download
    // finishes) can retry rather than being stuck with a half-open db.
    _db = null
    _dbStmt = null
    _dbMeta = null
    console.error('[broadband] failed to open SQLite index (will retry on next request):', err?.message)
    return null
  }
}

function lookupSummary(blockFips) {
  if (!_dbStmt) return null
  try {
    const row = _dbStmt.get(blockFips)
    if (!row) return null
    let providers = null
    if (row.providers_json) {
      try { providers = JSON.parse(row.providers_json) } catch { providers = null }
    }
    const techCodes = String(row.tech_codes || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n))
    const technologies = techCodes.map((c) => ({
      code: c,
      label: BDC_TECH_LABELS[c] || `Tech ${c}`,
    }))
    return {
      providerCount: row.provider_count,
      maxDownMbps: row.max_down_mbps,
      maxUpMbps: row.max_up_mbps,
      bestProvider: row.best_provider,
      hasFiber: techCodes.includes(50),
      speedTier: speedTier(row.max_down_mbps),
      technologies,
      providers,
    }
  } catch (err) {
    dbg('SQLite lookup failed:', err?.message)
    return null
  }
}

export async function handleBroadbandRequest(req, res) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url, 'http://x')
    const latRaw = url.searchParams.get('lat')
    const lngRaw = url.searchParams.get('lng')
    const lat = Number(latRaw)
    const lng = Number(lngRaw)
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid lat/lng' }))
      return
    }
    const block = await lookupBlock(lat, lng)
    if (!block) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      })
      res.end(JSON.stringify({ block: null, summary: null, source: null }))
      dbg(`miss lat=${lat} lng=${lng} ${Date.now() - t0}ms`)
      return
    }
    await getDb()
    const summary = lookupSummary(block.blockFips)
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=86400',
    })
    res.end(JSON.stringify({
      block,
      summary,
      source: summary ? 'FCC BDC' : null,
      asOfDate: _dbMeta?.as_of_date || null,
      attribution: 'Census block from FCC Area API. ' + (summary
        ? `Broadband availability from FCC BDC (advertised maximum, ${_dbMeta?.as_of_date || 'latest'} filing). Real speeds may differ.`
        : 'Broadband index not built — see scripts/build-broadband-index.mjs.'),
    }))
    dbg(`ok ${block.blockFips} providers=${summary?.providerCount ?? 'n/a'} ${Date.now() - t0}ms`)
  } catch (err) {
    console.error('[broadband] handler error:', err)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'broadband lookup failed' }))
  }
}
