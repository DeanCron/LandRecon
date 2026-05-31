// Nightly snapshot of passenger rail / subway / tram polyline geometry
// across CONUS. Bus routes are excluded — they're an order of magnitude
// larger and only displayed at zoom >= 13 where live Overpass is fast.
//
// Uses a 6x6 grid (vs the default 4x4 for point datasets) to keep each
// Overpass `out geom` request inside the 25s default timeout. Geometry-
// heavy queries time out before they time out on count.
//
// Mirrors src/workers/overpassWorker.ts::handleLines so the client renders
// the same passenger-only filter (route=train relations for heavy rail).

import { crawlConus, writeSnapshot, envelope } from './lib/conus-crawl.mjs'

function buildQuery(bbox) {
  return (
    `[out:json][timeout:180];` +
    `way["railway"~"^(light_rail|subway|tram)$"](${bbox});` +
    `out geom;` +
    `rel["route"="train"](${bbox});` +
    `way(r)["railway"~"^(rail|light_rail|narrow_gauge)$"](${bbox});` +
    `out geom;`
  )
}

function project(raw) {
  const out = []
  for (const el of raw) {
    if (
      el.type !== 'way' ||
      !Array.isArray(el.geometry) ||
      el.geometry.length < 2 ||
      typeof el.id !== 'number'
    ) continue
    const railway = el.tags?.railway
    let type
    if (railway === 'subway') type = 'subway'
    else if (railway === 'tram') type = 'tram'
    else type = 'rail'
    // Pack as flat [lat, lon, lat, lon, ...] to roughly halve gzip size
    // vs [[lat, lon], [lat, lon], ...] — the client unflattens on load.
    const coords = []
    for (const g of el.geometry) {
      if (typeof g.lat === 'number' && typeof g.lon === 'number') {
        // 6 decimal places ≈ 11 cm precision — plenty for rendering.
        coords.push(Number(g.lat.toFixed(6)), Number(g.lon.toFixed(6)))
      }
    }
    if (coords.length < 4) continue
    out.push({
      id: `way/${el.id}`,
      type,
      coords,
    })
  }
  return out
}

const { items: lines, failed } = await crawlConus({
  buildQuery,
  project,
  rows: 6,
  cols: 6,
})

const byType = lines.reduce((acc, l) => { acc[l.type] = (acc[l.type] || 0) + 1; return acc }, {})
const totalPoints = lines.reduce((a, l) => a + l.coords.length / 2, 0)

await writeSnapshot('transit-lines-us', envelope({
  count: lines.length,
  kind: 'rail-subway-tram',
  coords_format: 'flat-lat-lon-pairs',
  partial: failed.length > 0,
  failed_tiles: failed,
  lines,
}))

console.log(`  Breakdown: ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(', ')} (${totalPoints} total points)`)
// 6x6 = 36 tiles; tolerate up to 10 misses before failing the script.
if (failed.length > 10) process.exit(1)
