// Web Worker that owns Overpass fetching + parsing. Offloads JSON.parse
// of large responses and the element-classification loops off the main
// thread so the map stays interactive while a transit / bus / lines layer
// is loading.
//
// Protocol: postMessage({ id, kind, payload }) -> postMessage({ id, ok, result | error })
//   kinds:
//     'stops' — payload: { bbox, rail, bus }
//                returns Array<{ id, stop: { lat, lon, name, type } }>
//     'lines' — payload: { bbox }
//                returns Array<{ id, type, coords: [lat, lon][] }>
//     'bus'   — payload: { bbox }
//                returns Array<{ id, coords: [lat, lon][] }>

export type TransitStopType = 'rail' | 'subway' | 'tram' | 'bus'
export type TransitLineType = 'rail' | 'subway' | 'tram'

export interface StopResult { id: string; stop: { lat: number; lon: number; name: string; type: TransitStopType } }
export interface LineResult { id: string; type: TransitLineType; coords: [number, number][] }
export interface BusLineResult { id: string; coords: [number, number][] }

export interface CameraResult {
  id: string
  lat: number
  lon: number
  manufacturer: string
  operator: string
  direction: string
  isFlock: boolean
  tags: Record<string, string>
}

type Kind = 'stops' | 'lines' | 'bus' | 'cameras'

interface InMsg { id: number; kind: Kind; payload: unknown }
interface OutMsg<T = unknown> { id: number; ok: boolean; result?: T; error?: string }

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'

async function postOverpass(query: string): Promise<{ elements?: unknown[] }> {
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query),
  })
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`)
  return res.json()
}

async function handleStops(p: { bbox: string; rail: boolean; bus: boolean }): Promise<StopResult[]> {
  const parts: string[] = []
  if (p.rail) {
    parts.push(`node["railway"~"^(station|halt|tram_stop)$"](${p.bbox});`)
    parts.push(`node["station"~"^(subway|light_rail)$"](${p.bbox});`)
  }
  if (p.bus) {
    parts.push(`node["highway"="bus_stop"](${p.bbox});`)
    parts.push(`node["amenity"="bus_station"](${p.bbox});`)
  }
  if (parts.length === 0) return []
  const query = `[out:json][timeout:25];(${parts.join('')});out;`
  const data = await postOverpass(query)
  const out: StopResult[] = []
  for (const raw of (data.elements || [])) {
    const el = raw as { type?: string; id?: number; lat?: number; lon?: number; tags?: Record<string, string> }
    if (el.type !== 'node' || typeof el.lat !== 'number' || typeof el.lon !== 'number' || typeof el.id !== 'number') continue
    const tags = el.tags || {}
    let type: TransitStopType
    if (tags.highway === 'bus_stop' || tags.amenity === 'bus_station') type = 'bus'
    else if (tags.railway === 'tram_stop') type = 'tram'
    else if (tags.station === 'subway' || tags.subway === 'yes') type = 'subway'
    else type = 'rail'
    out.push({
      id: `node/${el.id}`,
      stop: { lat: el.lat, lon: el.lon, name: tags.name || tags['name:en'] || '', type },
    })
  }
  return out
}

async function handleLines(p: { bbox: string }): Promise<LineResult[]> {
  const query =
    `[out:json][timeout:25];` +
    `way["railway"~"^(light_rail|subway|tram)$"](${p.bbox});` +
    `out geom;` +
    `rel["route"="train"](${p.bbox});` +
    `way(r)["railway"~"^(rail|light_rail|narrow_gauge)$"](${p.bbox});` +
    `out geom;`
  const data = await postOverpass(query)
  const out: LineResult[] = []
  for (const raw of (data.elements || [])) {
    const el = raw as { type?: string; id?: number; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[] }
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2 || typeof el.id !== 'number') continue
    const railwayTag = el.tags?.railway
    let type: TransitLineType
    if (railwayTag === 'subway') type = 'subway'
    else if (railwayTag === 'tram') type = 'tram'
    else type = 'rail'
    const coords: [number, number][] = el.geometry.map((g) => [g.lat, g.lon])
    out.push({ id: `way/${el.id}`, type, coords })
  }
  return out
}

async function handleBus(p: { bbox: string }): Promise<BusLineResult[]> {
  const query =
    `[out:json][timeout:25];` +
    `rel["route"="bus"](${p.bbox});` +
    `way(r)["highway"](${p.bbox});` +
    `out geom;`
  const data = await postOverpass(query)
  const out: BusLineResult[] = []
  for (const raw of (data.elements || [])) {
    const el = raw as { type?: string; id?: number; geometry?: { lat: number; lon: number }[] }
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2 || typeof el.id !== 'number') continue
    const coords: [number, number][] = el.geometry.map((g) => [g.lat, g.lon])
    out.push({ id: `bus/${el.id}`, coords })
  }
  return out
}

async function handleCameras(p: { bbox: string }): Promise<CameraResult[]> {
  // ALPR cameras as tagged in OpenStreetMap by the DeFlock project and
  // other contributors. Three clauses to catch the common tag variants.
  const query =
    `[out:json][timeout:25];` +
    `(` +
    `node["man_made"="surveillance"]["surveillance:type"~"^ALPR$",i](${p.bbox});` +
    `node["man_made"="surveillance"]["camera:type"~"^ALPR$",i](${p.bbox});` +
    `node["surveillance:type"~"^ALPR$",i](${p.bbox});` +
    `);` +
    `out;`
  const data = await postOverpass(query)
  const out: CameraResult[] = []
  const seen = new Set<string>()
  for (const raw of (data.elements || [])) {
    const el = raw as { type?: string; id?: number; lat?: number; lon?: number; tags?: Record<string, string> }
    if (el.type !== 'node' || typeof el.lat !== 'number' || typeof el.lon !== 'number' || typeof el.id !== 'number') continue
    const id = `node/${el.id}`
    if (seen.has(id)) continue
    seen.add(id)
    const tags = el.tags || {}
    const manufacturer = tags.manufacturer || tags.brand || ''
    const isFlock = /flock/i.test(manufacturer)
    out.push({
      id,
      lat: el.lat,
      lon: el.lon,
      manufacturer,
      operator: tags.operator || '',
      direction: tags.direction || '',
      isFlock,
      tags,
    })
  }
  return out
}

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const { id, kind, payload } = ev.data
  try {
    let result: unknown
    if (kind === 'stops') result = await handleStops(payload as { bbox: string; rail: boolean; bus: boolean })
    else if (kind === 'lines') result = await handleLines(payload as { bbox: string })
    else if (kind === 'bus') result = await handleBus(payload as { bbox: string })
    else if (kind === 'cameras') result = await handleCameras(payload as { bbox: string })
    else throw new Error(`Unknown kind: ${String(kind)}`)
    const msg: OutMsg = { id, ok: true, result }
    self.postMessage(msg)
  } catch (err) {
    const msg: OutMsg = { id, ok: false, error: err instanceof Error ? err.message : String(err) }
    self.postMessage(msg)
  }
}

export {}
