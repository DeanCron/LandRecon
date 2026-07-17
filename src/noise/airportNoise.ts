// Airport noise PMTiles client.
//
// Replaces the legacy `/tiles/airport-noise/{z}/{x}/{y}.png` raster server
// (since retired) with a single static `airport-noise.pmtiles` archive
// (built by `scripts/build_noise_pmtiles.py`). Exposes:
//
//   - NOISE_BAND_COLORS              styling table, keyed by `db_min`
//   - LEGEND_BANDS                   ordered band labels for the UI legend
//   - createNoiseLayer(url, opts)    Leaflet layer for the visual overlay
//   - queryNoiseLevelAtPoint(...)    decoupled point query (works without
//                                    the visual layer being mounted)

import type L from 'leaflet'
import { leafletLayer, PolygonSymbolizer, type Feature } from 'protomaps-leaflet'
import { PMTiles } from 'pmtiles'
import { VectorTile, classifyRings } from '@mapbox/vector-tile'
import Pbf from 'pbf'
import {
  NOISE_LAYER_NAME,
  NOISE_MAX_ZOOM,
  NOISE_BAND_COLORS,
  NOISE_BAND_BREAKS,
  LEGEND_BANDS,
  colorForDbMin,
  type LegendBand,
} from './legend'

// Re-export the constants so legacy importers (and tests) continue to work,
// even though the canonical home for them is ./legend.
export {
  NOISE_LAYER_NAME,
  NOISE_MAX_ZOOM,
  NOISE_BAND_COLORS,
  NOISE_BAND_BREAKS,
  LEGEND_BANDS,
}
export type { LegendBand }

export interface NoiseLayerOptions {
  opacity?: number
  attribution?: string
  bounds?: L.LatLngBoundsExpression
}

/**
 * Build the Leaflet overlay layer for the PMTiles archive at `url`.
 * The returned object satisfies the `L.Layer` contract (extends `L.GridLayer`)
 * and can be added to / removed from a map normally.
 */
export function createNoiseLayer(url: string, opts: NoiseLayerOptions = {}): L.Layer {
  const opacity = opts.opacity ?? 0.7
  const layer = leafletLayer({
    url,
    attribution: opts.attribution ?? 'Noise: FAA/BTS Aviation Noise 2020',
    bounds: opts.bounds,
    paintRules: [
      {
        dataLayer: NOISE_LAYER_NAME,
        symbolizer: new PolygonSymbolizer({
          fill: (_z: number, f?: Feature) => colorForDbMin(f?.props?.db_min),
          opacity,
        }),
      },
    ],
  })
  return layer as unknown as L.Layer
}

// PMTiles instances cache the directory + tile responses; share across queries.
const pmtilesCache = new Map<string, PMTiles>()
function getPMTiles(url: string): PMTiles {
  let p = pmtilesCache.get(url)
  if (!p) {
    p = new PMTiles(url)
    pmtilesCache.set(url, p)
  }
  return p
}

export interface NoiseBand {
  dbMin: number
  dbMax: number
  state: string | null
}

function pointInRing(x: number, y: number, ring: { x: number; y: number }[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x
    const yi = ring[i].y
    const xj = ring[j].x
    const yj = ring[j].y
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

type Ring = { x: number; y: number }[]

function pointInFeature(x: number, y: number, geom: Ring[]): boolean {
  // MVT geometry can pack multiple polygons + holes into a single feature;
  // classifyRings splits them into [outer, ...holes] groups by winding order.
  // classifyRings types its input as `Point[][]` from @mapbox/point-geometry,
  // but only reads `.x` and `.y`, so a plain {x,y} shape is structurally fine.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const polygons = classifyRings(geom as any) as unknown as Ring[][]
  for (const polygon of polygons) {
    const [outer, ...holes] = polygon
    if (!outer || !pointInRing(x, y, outer)) continue
    let inHole = false
    for (const hole of holes) {
      if (pointInRing(x, y, hole)) {
        inHole = true
        break
      }
    }
    if (!inHole) return true
  }
  return false
}

/**
 * Resolve the noise band containing (lat, lng) by fetching the single
 * z=NOISE_MAX_ZOOM tile from the PMTiles archive and running point-in-polygon
 * against its vector features. Returns `null` if the point is outside every
 * band (i.e. below the data floor) or the tile isn't present in the archive.
 *
 * This is decoupled from `createNoiseLayer` so the address analysis can run
 * even when the visual overlay is toggled off.
 */
export async function queryNoiseLevelAtPoint(
  url: string,
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<NoiseBand | null> {
  const pmt = getPMTiles(url)
  const zoom = NOISE_MAX_ZOOM
  const n = 2 ** zoom
  const latRad = (lat * Math.PI) / 180
  const xFloat = ((lng + 180) / 360) * n
  const yFloat =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  const x = Math.floor(xFloat)
  const y = Math.floor(yFloat)

  let tile: { data: ArrayBuffer } | undefined
  try {
    tile = await pmt.getZxy(zoom, x, y, signal)
  } catch {
    return null
  }
  if (!tile) return null
  if (signal?.aborted) return null

  const vt = new VectorTile(new Pbf(tile.data))
  const layer = vt.layers[NOISE_LAYER_NAME]
  if (!layer) return null

  const ext = layer.extent
  const px = (xFloat - x) * ext
  const py = (yFloat - y) * ext

  let best: NoiseBand | null = null
  for (let i = 0; i < layer.length; i++) {
    if (signal?.aborted) return null
    const feat = layer.feature(i)
    const geom = feat.loadGeometry() as unknown as Ring[]
    if (!pointInFeature(px, py, geom)) continue
    const dbMin = Number(feat.properties.db_min)
    const dbMax = Number(feat.properties.db_max)
    const state =
      feat.properties.state != null ? String(feat.properties.state) : null
    if (!Number.isFinite(dbMin) || !Number.isFinite(dbMax)) continue
    // Polygons stack (a 65 dB band sits inside the 60 dB band); keep the
    // highest-intensity match for an honest answer at the click point.
    if (!best || dbMin > best.dbMin) {
      best = { dbMin, dbMax, state }
    }
  }
  return best
}
