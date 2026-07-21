import { dbg } from '../utils/debug'
import type { CameraRecord } from './cameras'
import type { CrowdMagnet } from './crowd'

// Daily CONUS snapshots of every Overpass dataset, hydrated by
// .github/workflows/snapshot-overpass.yml and served from Azure Blob with
// Content-Encoding: gzip (browser auto-decompresses). The client prefers
// each over its per-bbox live Overpass call whenever the map center is
// inside CONUS — collapses dozens of pan-driven 1–5s Overpass calls into
// one CDN-cached fetch held in module-scope memory for the page session.
const SNAPSHOT_BASE =
  'https://landreconstorage.blob.core.windows.net/snapshots'
export const CONUS_BOUNDS: [[number, number], [number, number]] = [
  [24.5, -125.0],
  [49.4, -66.9],
]

export interface SnapshotEnvelope {
  version: number
  generated_at: string
  region: string
  bbox: number[]
  count: number
}

export interface CameraSnapshot extends SnapshotEnvelope { cameras: CameraRecord[] }
export interface CrowdSnapshotPayload extends SnapshotEnvelope { magnets: CrowdMagnet[] }
export interface TransitStopsSnapshot extends SnapshotEnvelope { stops: SnapshotTransitStop[] }
export interface TransitLinesSnapshot extends SnapshotEnvelope { lines: SnapshotTransitLine[] }
export interface RailroadSnapshot extends SnapshotEnvelope { lines: RailroadSnapshotLine[] }

// A single OSM railway way (freight + passenger — rail/light_rail/narrow_gauge,
// unfiltered by route relation, mirroring the live query in
// src/map/railroad.ts::fetchNearestRailroad). `bbox` is precomputed at build
// time so the client can cheaply skip lines that can't possibly be the
// nearest track before unpacking their full point list.
export interface RailroadSnapshotLine {
  id: string
  name: string
  // Flat [lat, lon, lat, lon, ...] pairs, same packing as transit lines.
  coords: number[]
  // [minLat, minLon, maxLat, maxLon] over all points in this way.
  bbox: [number, number, number, number]
}

export interface SnapshotTransitStop { id: string; type: 'rail' | 'subway' | 'tram'; lat: number; lon: number; name: string }
export interface SnapshotTransitLine { id: string; type: 'rail' | 'subway' | 'tram'; coords: number[] }

// Factory: returns a memoized snapshot fetcher with single-flight semantics.
// Multiple concurrent callers (e.g. layer toggle + URL replay) share one
// in-flight Promise; subsequent callers get the resolved cache instantly.
export function makeSnapshotLoader<T>(filename: string, dbgLabel: string) {
  let cache: T | null = null
  let inFlight: Promise<T | null> | null = null
  // Negative cache: timestamp of the last failed fetch. While within the
  // cooldown we skip re-fetching and let callers fall back to live Overpass
  // immediately, rather than re-hitting a slow/broken CDN on every pan.
  let failedAt = 0
  const FAILURE_COOLDOWN_MS = 5 * 60 * 1000
  return function load(signal?: AbortSignal): Promise<T | null> {
    if (signal?.aborted) return Promise.resolve(null)
    if (!cache && failedAt && performance.now() - failedAt < FAILURE_COOLDOWN_MS) {
      dbg(dbgLabel, `Snapshot ${filename} in failure cooldown — using live fallback`)
      return Promise.resolve(null)
    }
    let shared = cache ? Promise.resolve(cache) : inFlight
    if (!shared) {
      const t0 = performance.now()
      shared = (async () => {
        try {
          const res = await fetch(`${SNAPSHOT_BASE}/${filename}`, { cache: 'force-cache' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const snap = (await res.json()) as T
          cache = snap
          failedAt = 0
          const meta = snap as unknown as SnapshotEnvelope
          dbg(dbgLabel, `Snapshot ${filename} loaded in ${(performance.now() - t0).toFixed(0)}ms — ${meta.count} records, generated ${meta.generated_at}`)
          return snap
        } catch (err) {
          dbg(dbgLabel, `Snapshot ${filename} fetch failed; will fall back to live Overpass:`, err)
          inFlight = null
          failedAt = performance.now()
          return null
        }
      })()
      inFlight = shared
    }
    if (!signal) return shared
    return new Promise((resolve) => {
      const onAbort = () => resolve(null)
      signal.addEventListener('abort', onAbort, { once: true })
      shared.then((value) => {
        signal.removeEventListener('abort', onAbort)
        if (!signal.aborted) resolve(value)
      })
    })
  }
}

export const loadCamerasSnapshot = makeSnapshotLoader<CameraSnapshot>('cameras-us.json', 'cameras')
export const loadCrowdSnapshot = makeSnapshotLoader<CrowdSnapshotPayload>('crowd-us.json', 'crowd')
export const loadTransitStopsSnapshot = makeSnapshotLoader<TransitStopsSnapshot>('transit-stops-us.json', 'transit')
export const loadTransitLinesSnapshot = makeSnapshotLoader<TransitLinesSnapshot>('transit-lines-us.json', 'transit')
export const loadRailroadSnapshot = makeSnapshotLoader<RailroadSnapshot>('railroad-us.json', 'railroad')
