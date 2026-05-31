// Nightly snapshot of "crowd magnets" across the contiguous United States.
// Stadiums, theme parks, amphitheatres, racetracks, and national parks
// (anything that draws a meaningful crowd and affects nearby noise / traffic
// / event-night chaos). Mirrors the live worker query in
// src/pages/MapPage.tsx::fetchCrowdMagnets.

import { crawlConus, writeSnapshot, envelope } from './lib/conus-crawl.mjs'

function buildQuery(bbox) {
  return (
    `[out:json][timeout:180];` +
    `(` +
      `nwr["leisure"="stadium"]["name"](${bbox});` +
      `nwr["tourism"="theme_park"]["name"](${bbox});` +
      `nwr["amenity"="amphitheatre"]["name"][!"historic"](${bbox});` +
      `nwr["highway"="raceway"]["name"](${bbox});` +
      `way["leisure"="track"]["sport"~"motor|drag_racing|karting|horse_racing"]["name"](${bbox});` +
      `relation["leisure"="track"]["sport"~"motor|drag_racing|karting|horse_racing"]["name"](${bbox});` +
      `way["boundary"="national_park"]["name"](${bbox});` +
      `relation["boundary"="national_park"]["name"](${bbox});` +
    `);` +
    `out body center;`
  )
}

// School / community-center false-positive filters, mirroring MapPage.tsx
// classification helpers so the snapshot ships exactly what the client
// would have rendered from a live Overpass call.
const SCHOOL_NAME_RE = /\b(school|academy|hs|high\s*school|elementary|middle\s*school|isd)\b/i
const COMMUNITY_NAME_RE = /\b(community\s*(center|centre)|civic\s*center)\b/i

function classify(tags) {
  if (tags.boundary === 'national_park') return 'park'
  if (tags.tourism === 'theme_park') return 'themepark'
  if (tags.leisure === 'stadium') return 'stadium'
  if (tags.amenity === 'amphitheatre') return 'concert'
  if (tags.highway === 'raceway') return 'raceway'
  if (tags.leisure === 'track') {
    const sport = (tags.sport || '').toLowerCase()
    if (/motor|drag|karting|horse_racing/.test(sport)) return 'raceway'
  }
  return null
}

function project(raw) {
  const out = []
  for (const el of raw) {
    const lat = el.lat ?? el.center?.lat
    const lon = el.lon ?? el.center?.lon
    if (typeof lat !== 'number' || typeof lon !== 'number') continue
    if (typeof el.id !== 'number' || !el.type) continue
    const tags = el.tags || {}
    const name = tags.name || tags['name:en'] || ''
    if (!name) continue
    // Skip schools / community centers that share the stadium tag set.
    if (SCHOOL_NAME_RE.test(name)) continue
    if (COMMUNITY_NAME_RE.test(name)) continue
    const lc = (tags.operator || '').toLowerCase()
    if (lc.includes('school') || lc.includes('academy') || lc.includes('isd')) continue
    if (tags.amenity === 'school' || tags.school) continue
    if (tags.amenity === 'community_centre') continue
    const type = classify(tags)
    if (!type) continue
    out.push({
      id: `${el.type}/${el.id}`,
      type,
      name,
      lat,
      lng: lon,
    })
  }
  return out
}

const magnets = await crawlConus({ buildQuery, project })
const byType = magnets.reduce((acc, m) => { acc[m.type] = (acc[m.type] || 0) + 1; return acc }, {})

await writeSnapshot('crowd-us', envelope({
  count: magnets.length,
  magnets,
}))

console.log(`  Breakdown: ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(', ')}`)
