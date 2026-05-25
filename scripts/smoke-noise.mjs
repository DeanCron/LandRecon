// Smoke test: replays the production point-query logic against the live
// PMTiles archive (served by the dev server or any HTTP host) for a set of
// known sites. No browser, no protomaps-leaflet — just `pmtiles` +
// `@mapbox/vector-tile`, the same modules MapPage uses for analysis.
//
// Usage:  node scripts/smoke-noise.mjs [url]

import { PMTiles } from 'pmtiles'
import { VectorTile, classifyRings } from '@mapbox/vector-tile'
import Pbf from 'pbf'

const URL = process.argv[2] || 'http://localhost:5173/data/airport-noise.pmtiles'
const NOISE_LAYER_NAME = 'airport_noise'
const NOISE_MAX_ZOOM = 12

// Known reference points. Each major airport site should land in a noise
// band; the rural Kansas point should not.
const SITES = [
  { name: 'ATL (Hartsfield-Jackson)',        lat: 33.6407,  lng: -84.4277, expectState: 'GA', expectInBand: true },
  { name: 'ORD (O\u2019Hare)',                lat: 41.9786,  lng: -87.9048, expectState: 'IL', expectInBand: true },
  { name: 'LAX',                              lat: 33.9416,  lng: -118.4085, expectState: 'CA', expectInBand: true },
  { name: 'JFK',                              lat: 40.6413,  lng: -73.7781, expectState: 'NY', expectInBand: true },
  { name: 'SEA-TAC',                          lat: 47.4502,  lng: -122.3088, expectState: 'WA', expectInBand: true },
  { name: 'Rural Kansas (control, no noise)', lat: 38.5,     lng: -98.5,    expectState: null, expectInBand: false },
  { name: 'Mid-Atlantic ocean (off-CONUS)',   lat: 38.0,     lng: -65.0,    expectState: null, expectInBand: false },
]

function pointInRing(x, y, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, yi = ring[i].y
    const xj = ring[j].x, yj = ring[j].y
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function pointInFeature(x, y, geom) {
  const polygons = classifyRings(geom)
  for (const polygon of polygons) {
    const [outer, ...holes] = polygon
    if (!outer || !pointInRing(x, y, outer)) continue
    let inHole = false
    for (const h of holes) { if (pointInRing(x, y, h)) { inHole = true; break } }
    if (!inHole) return true
  }
  return false
}

async function query(pmt, lat, lng) {
  const z = NOISE_MAX_ZOOM, n = 2 ** z
  const latRad = (lat * Math.PI) / 180
  const xf = ((lng + 180) / 360) * n
  const yf = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  const x = Math.floor(xf), y = Math.floor(yf)
  let tile
  try { tile = await pmt.getZxy(z, x, y) } catch { return null }
  if (!tile) return null
  const vt = new VectorTile(new Pbf(tile.data))
  const layer = vt.layers[NOISE_LAYER_NAME]
  if (!layer) return null
  const ext = layer.extent
  const px = (xf - x) * ext, py = (yf - y) * ext
  let best = null
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i)
    const geom = f.loadGeometry()
    if (!pointInFeature(px, py, geom)) continue
    const dbMin = Number(f.properties.db_min)
    const dbMax = Number(f.properties.db_max)
    const state = f.properties.state != null ? String(f.properties.state) : null
    if (!Number.isFinite(dbMin) || !Number.isFinite(dbMax)) continue
    if (!best || dbMin > best.dbMin) best = { dbMin, dbMax, state }
  }
  return best
}

console.log(`Smoke-testing PMTiles archive at ${URL}\n`)
const pmt = new PMTiles(URL)
const header = await pmt.getHeader()
console.log(`  PMTiles v${header.specVersion} | tile type ${header.tileType} | zoom ${header.minZoom}-${header.maxZoom}`)
console.log(`  Bounds: [${header.minLon.toFixed(2)}, ${header.minLat.toFixed(2)}] -> [${header.maxLon.toFixed(2)}, ${header.maxLat.toFixed(2)}]\n`)

let pass = 0, fail = 0
for (const s of SITES) {
  const r = await query(pmt, s.lat, s.lng)
  const got = r ? `${r.dbMin}\u2013${r.dbMax === 200 ? '\u221E' : r.dbMax} dB / ${r.state}` : 'OUTSIDE'
  const ok = (s.expectInBand ? r !== null : r === null) && (!s.expectState || r?.state === s.expectState)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${s.name.padEnd(35)} -> ${got}`)
  if (ok) pass++; else fail++
}
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
