// Nightly snapshot of rail / subway / tram transit stops across CONUS.
// Excludes bus stops by design — bus stops are roughly two orders of
// magnitude denser (hundreds of thousands across CONUS), only loaded at
// zoom >= 13 in the client, and a small live Overpass call at that zoom is
// sub-second. Mirrors the rail clauses in
// src/workers/overpassWorker.ts::handleStops.

import { crawlConus, writeSnapshot, envelope } from './lib/conus-crawl.mjs'

function buildQuery(bbox) {
  return (
    `[out:json][timeout:180];` +
    `(` +
      `node["railway"~"^(station|halt|tram_stop)$"](${bbox});` +
      `node["station"~"^(subway|light_rail)$"](${bbox});` +
    `);` +
    `out;`
  )
}

function project(raw) {
  const out = []
  for (const el of raw) {
    if (
      el.type !== 'node' ||
      typeof el.lat !== 'number' ||
      typeof el.lon !== 'number' ||
      typeof el.id !== 'number'
    ) continue
    const tags = el.tags || {}
    let type
    if (tags.railway === 'tram_stop') type = 'tram'
    else if (tags.station === 'subway' || tags.subway === 'yes') type = 'subway'
    else type = 'rail'
    out.push({
      id: `node/${el.id}`,
      type,
      lat: el.lat,
      lon: el.lon,
      name: tags.name || tags['name:en'] || '',
    })
  }
  return out
}

const { items: stops, failed } = await crawlConus({ buildQuery, project })
const byType = stops.reduce((acc, s) => { acc[s.type] = (acc[s.type] || 0) + 1; return acc }, {})

await writeSnapshot('transit-stops-us', envelope({
  count: stops.length,
  kind: 'rail-subway-tram',  // explicitly NOT bus stops
  partial: failed.length > 0,
  failed_tiles: failed,
  stops,
}))

console.log(`  Breakdown: ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(', ')}`)
if (failed.length > 5) process.exit(1)
