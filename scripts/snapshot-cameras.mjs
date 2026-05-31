// Nightly snapshot of ALPR cameras across the contiguous United States.
// See scripts/lib/conus-crawl.mjs for the shared crawler.

import { crawlConus, writeSnapshot, envelope } from './lib/conus-crawl.mjs'

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
    const manufacturer = tags.manufacturer || tags.brand || ''
    out.push({
      id: `node/${el.id}`,
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

const { items: cameras, failed } = await crawlConus({ buildQuery, project })
const flock = cameras.filter((c) => c.isFlock).length
const withDir = cameras.filter((c) => c.direction).length

await writeSnapshot('cameras-us', envelope({
  count: cameras.length,
  partial: failed.length > 0,
  failed_tiles: failed,
  cameras,
}))

console.log(`  Flock: ${flock}; other: ${cameras.length - flock}; with direction: ${withDir}`)
if (failed.length > 5) {
  console.error(`Too many failed tiles (${failed.length}); exiting non-zero so upload step still runs but workflow flags failure`)
  process.exit(1)
}
