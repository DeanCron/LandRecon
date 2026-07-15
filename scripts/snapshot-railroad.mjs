// Nightly snapshot of all active railroad track geometry (freight + passenger)
// across CONUS. Unlike snapshot-transit-lines.mjs (passenger-only, filtered to
// route=train relations), this ships every railway=rail/light_rail/narrow_gauge
// way regardless of route membership, since freight-only lines — the most
// common case in rural areas — are exactly what the horn-noise/vibration
// proximity check in src/map/railroad.ts cares about.
//
// Uses a 6x6 grid (vs the default 4x4 for point datasets) to keep each
// Overpass `out geom` request inside the 25s default timeout. Geometry-heavy
// queries time out on size before they time out on count.
//
// Mirrors the live query in src/map/railroad.ts::fetchNearestRailroad.

import { crawlConus, writeSnapshot, envelope } from './lib/conus-crawl.mjs'

function buildQuery(bbox) {
  return (
    `[out:json][timeout:180];` +
    `way["railway"~"^(rail|light_rail|narrow_gauge)$"](${bbox});` +
    `out tags geom;`
  )
}

// Mirrors railName() in src/map/railroad.ts so the snapshot ships the exact
// display name a live Overpass call would have produced.
function railName(tags) {
  return tags.name || tags['name:en'] || tags.ref || tags.operator || 'Unnamed railroad track'
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
    // Pack as flat [lat, lon, lat, lon, ...] to roughly halve gzip size vs
    // [[lat, lon], ...] — the client unflattens on load. Also track the
    // bbox so the client can cheaply prune distant ways before unpacking.
    const coords = []
    let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity
    for (const g of el.geometry) {
      if (typeof g.lat !== 'number' || typeof g.lon !== 'number') continue
      // 6 decimal places ≈ 11 cm precision — plenty for proximity math.
      const lat = Number(g.lat.toFixed(6))
      const lon = Number(g.lon.toFixed(6))
      coords.push(lat, lon)
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
      if (lon < minLon) minLon = lon
      if (lon > maxLon) maxLon = lon
    }
    if (coords.length < 4) continue
    out.push({
      id: `way/${el.id}`,
      name: railName(el.tags || {}),
      coords,
      bbox: [minLat, minLon, maxLat, maxLon],
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

const totalPoints = lines.reduce((a, l) => a + l.coords.length / 2, 0)

await writeSnapshot('railroad-us', envelope({
  count: lines.length,
  kind: 'rail-light_rail-narrow_gauge',
  coords_format: 'flat-lat-lon-pairs',
  partial: failed.length > 0,
  failed_tiles: failed,
  lines,
}))

console.log(`  ${lines.length} tracks, ${totalPoints} total points`)
// 6x6 = 36 tiles; tolerate up to 10 misses before failing the script.
if (failed.length > 10) process.exit(1)
