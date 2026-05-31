// Nightly snapshot of ALPR cameras across the contiguous United States.
//
// Queries the public Overpass API in a 4×4 grid of bounding boxes covering
// CONUS, dedupes by node id, and writes a single gzipped JSON file shipped
// to Azure Blob storage. The client (MapPage) prefers this snapshot over a
// live Overpass call whenever the map center is inside CONUS — collapsing
// hundreds of per-bbox network calls into one CDN-cached blob.
//
// Run: node scripts/snapshot-cameras.mjs
// Output: dist-snapshots/cameras-us.json.gz (gzipped JSON, served with
//         Content-Encoding: gzip so browsers auto-decompress).

import { writeFile, mkdir } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'

const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter'
const UA = 'LandRecon-Snapshotter/1.0 (+https://github.com/DeanCron/LandRecon)'

// CONUS bbox — lower-48 + a small ocean margin so border tiles are inclusive.
const CONUS = { south: 24.5, north: 49.4, west: -125.0, east: -66.9 }
const COLS = 4
const ROWS = 4
const REQUEST_DELAY_MS = 3000
const MAX_RETRIES = 3
const BACKOFF_MS = 30_000

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function buildQuery(bbox) {
  // Three clauses to catch every common DeFlock / OSM tagging variant.
  // Matches the live worker query in src/workers/overpassWorker.ts.
  return (
    `[out:json][timeout:180];` +
    `(` +
      `node["man_made"="surveillance"]["surveillance:type"~"^ALPR$",i](${bbox});` +
      `node["man_made"="surveillance"]["camera:type"~"^ALPR$",i](${bbox});` +
      `node["surveillance:type"~"^ALPR$",i](${bbox});` +
    `);` +
    `out;`
  )
}

async function fetchTile(bbox, label) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[${label}] attempt ${attempt}/${MAX_RETRIES} bbox=${bbox}`)
      const t0 = performance.now()
      const res = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
        },
        body: 'data=' + encodeURIComponent(buildQuery(bbox)),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
      }
      const data = await res.json()
      const ms = Math.round(performance.now() - t0)
      const n = Array.isArray(data.elements) ? data.elements.length : 0
      console.log(`[${label}] ok in ${ms}ms — ${n} elements`)
      return data.elements || []
    } catch (err) {
      console.warn(`[${label}] attempt ${attempt} failed: ${err.message}`)
      if (attempt === MAX_RETRIES) throw err
      const wait = BACKOFF_MS * attempt
      console.warn(`[${label}] backing off ${wait}ms`)
      await sleep(wait)
    }
  }
  return []
}

function project(raw) {
  const out = []
  const seen = new Set()
  for (const el of raw) {
    if (
      el.type !== 'node' ||
      typeof el.lat !== 'number' ||
      typeof el.lon !== 'number' ||
      typeof el.id !== 'number'
    ) continue
    const id = `node/${el.id}`
    if (seen.has(id)) continue
    seen.add(id)
    const tags = el.tags || {}
    const manufacturer = tags.manufacturer || tags.brand || ''
    out.push({
      id,
      lat: el.lat,
      lon: el.lon,
      manufacturer,
      operator: tags.operator || '',
      direction: tags.direction || '',
      isFlock: /flock/i.test(manufacturer),
      tags,
    })
  }
  return out
}

async function main() {
  await mkdir('dist-snapshots', { recursive: true })

  const all = []
  const seen = new Set()
  const latStep = (CONUS.north - CONUS.south) / ROWS
  const lngStep = (CONUS.east - CONUS.west) / COLS

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const s = CONUS.south + r * latStep
      const n = s + latStep
      const w = CONUS.west + c * lngStep
      const e = w + lngStep
      const bbox = `${s.toFixed(3)},${w.toFixed(3)},${n.toFixed(3)},${e.toFixed(3)}`
      const label = `r${r}c${c}`
      const raw = await fetchTile(bbox, label)
      const items = project(raw)
      let added = 0
      for (const it of items) {
        if (seen.has(it.id)) continue
        seen.add(it.id)
        all.push(it)
        added++
      }
      console.log(`[${label}] +${added} unique (${items.length - added} dup); running total ${all.length}`)
      if (r * COLS + c < ROWS * COLS - 1) await sleep(REQUEST_DELAY_MS)
    }
  }

  const flock = all.filter(c => c.isFlock).length
  const withDir = all.filter(c => c.direction).length
  const payload = {
    version: 1,
    generated_at: new Date().toISOString(),
    region: 'us-conus',
    bbox: [CONUS.south, CONUS.west, CONUS.north, CONUS.east],
    count: all.length,
    cameras: all,
  }
  const json = JSON.stringify(payload)
  const gz = gzipSync(Buffer.from(json), { level: 9 })

  await writeFile('dist-snapshots/cameras-us.json', json)
  await writeFile('dist-snapshots/cameras-us.json.gz', gz)

  const kbJson = (json.length / 1024).toFixed(1)
  const kbGz = (gz.length / 1024).toFixed(1)
  console.log('')
  console.log(`Snapshot complete:`)
  console.log(`  cameras:   ${all.length} (Flock ${flock}, other ${all.length - flock}, with direction ${withDir})`)
  console.log(`  raw JSON:  ${kbJson} KB`)
  console.log(`  gzipped:   ${kbGz} KB`)
}

main().catch(err => {
  console.error('FATAL', err)
  process.exit(1)
})
