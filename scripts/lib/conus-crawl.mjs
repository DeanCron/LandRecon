// Shared Overpass crawler used by every snapshot script in scripts/.
//
// Splits CONUS into a configurable row×col grid of bounding boxes, fetches
// each tile sequentially with polite delay + retry/backoff, dedupes results
// across tiles, and writes the final payload as both raw + gzipped JSON.
// Caller supplies a `buildQuery(bbox)` and `project(rawElements)` pair.

import { writeFile, mkdir } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'

const OVERPASS_ENDPOINTS = (process.env.OVERPASS_URL || [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean)
const UA = 'LandRecon-Snapshotter/1.0 (+https://github.com/DeanCron/LandRecon)'
// Comfortably above the [timeout:180] embedded in every query. Overpass QL's
// timeout only bounds server-side compute — it does nothing if the mirror
// stalls the connection instead of erroring, which would otherwise hang this
// fetch (and the whole job) forever, since undici's fetch has no default
// timeout of its own.
const FETCH_TIMEOUT_MS = 200_000

// CONUS — lower-48 with small ocean margin so border tiles are inclusive.
export const CONUS = Object.freeze({
  south: 24.5,
  north: 49.4,
  west: -125.0,
  east: -66.9,
})

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function fetchFromAnyEndpoint(query, label) {
  let lastErr
  for (const url of OVERPASS_ENDPOINTS) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(new Error(`client-side timeout after ${FETCH_TIMEOUT_MS}ms`)), FETCH_TIMEOUT_MS)
    try {
      const t0 = performance.now()
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
        },
        body: 'data=' + encodeURIComponent(query),
        signal: ctrl.signal,
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        lastErr = new Error(`HTTP ${res.status} at ${new URL(url).host}: ${body.slice(0, 120)}`)
        console.warn(`[${label}] ${lastErr.message}`)
        continue
      }
      const data = await res.json()
      const ms = Math.round(performance.now() - t0)
      const n = Array.isArray(data.elements) ? data.elements.length : 0
      console.log(`[${label}] ok via ${new URL(url).host} in ${ms}ms — ${n} elements`)
      return data
    } catch (err) {
      lastErr = err
      console.warn(`[${label}] ${new URL(url).host} threw: ${err.message}`)
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr || new Error('All Overpass endpoints failed')
}

async function postOverpass(query, label, maxRetries, backoff) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[${label}] attempt ${attempt}/${maxRetries}`)
      const data = await fetchFromAnyEndpoint(query, label)
      return data.elements || []
    } catch (err) {
      console.warn(`[${label}] attempt ${attempt} failed: ${err.message}`)
      if (attempt === maxRetries) throw err
      const wait = backoff * attempt
      console.warn(`[${label}] backing off ${wait}ms before next attempt`)
      await sleep(wait)
    }
  }
  return []
}

/**
 * Crawl CONUS, returning { items, failed } — fault-tolerant: a tile that
 * exhausts retries on every endpoint is logged and the crawl continues.
 * Caller decides what to do with the failed list (mark snapshot partial,
 * hard-fail above some threshold, etc).
 *
 * @param {object} opts
 * @param {(bbox: string) => string} opts.buildQuery - Overpass QL for one tile
 * @param {(raw: any[]) => Array<{id: string}>} opts.project - map Overpass elements to your record type
 * @param {number} [opts.rows=4]
 * @param {number} [opts.cols=4]
 * @param {number} [opts.delayMs=3000]
 * @param {number} [opts.maxRetries=3]
 * @param {number} [opts.backoff=30000]
 * @param {string} [opts.idKey='id']
 * @returns {Promise<{items: any[], failed: Array<{tile: string, bbox: string, error: string}>}>}
 */
export async function crawlConus(opts) {
  const {
    buildQuery,
    project,
    rows = 4,
    cols = 4,
    delayMs = 3000,
    maxRetries = 3,
    backoff = 30_000,
    idKey = 'id',
  } = opts

  const all = []
  const failed = []
  const seen = new Set()
  const latStep = (CONUS.north - CONUS.south) / rows
  const lngStep = (CONUS.east - CONUS.west) / cols

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const s = CONUS.south + r * latStep
      const n = s + latStep
      const w = CONUS.west + c * lngStep
      const e = w + lngStep
      const bbox = `${s.toFixed(3)},${w.toFixed(3)},${n.toFixed(3)},${e.toFixed(3)}`
      const label = `r${r}c${c}`
      try {
        const raw = await postOverpass(buildQuery(bbox), label, maxRetries, backoff)
        const items = project(raw)
        let added = 0
        for (const it of items) {
          const id = it[idKey]
          if (id == null || seen.has(id)) continue
          seen.add(id)
          all.push(it)
          added++
        }
        console.log(`[${label}] +${added} unique (${items.length - added} dup); running total ${all.length}`)
      } catch (err) {
        failed.push({ tile: label, bbox, error: String(err?.message || err) })
        console.warn(`[${label}] FAILED after ${maxRetries} attempts on all endpoints — continuing. Snapshot will be marked partial.`)
      }
      if (r * cols + c < rows * cols - 1) await sleep(delayMs)
    }
  }
  if (failed.length > 0) {
    console.warn(`\nCrawl finished with ${failed.length}/${rows * cols} failed tiles:`)
    for (const f of failed) console.warn(`  ${f.tile} (${f.bbox}): ${f.error}`)
  }
  return { items: all, failed }
}

/**
 * Write a snapshot payload to dist-snapshots/{name}.json and {name}.json.gz.
 * Returns sizes for logging.
 */
export async function writeSnapshot(name, payload) {
  await mkdir('dist-snapshots', { recursive: true })
  const json = JSON.stringify(payload)
  const gz = gzipSync(Buffer.from(json), { level: 9 })
  await writeFile(`dist-snapshots/${name}.json`, json)
  await writeFile(`dist-snapshots/${name}.json.gz`, gz)
  console.log('')
  console.log(`Snapshot "${name}" written:`)
  console.log(`  raw JSON: ${(json.length / 1024).toFixed(1)} KB`)
  console.log(`  gzipped:  ${(gz.length / 1024).toFixed(1)} KB`)
  return { jsonBytes: json.length, gzBytes: gz.length }
}

/** Common payload envelope used by every snapshot. */
export function envelope(extra) {
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    region: 'us-conus',
    bbox: [CONUS.south, CONUS.west, CONUS.north, CONUS.east],
    ...extra,
  }
}
