import L from 'leaflet'
import { fetchJsonWithRetry } from './fetchRetry'

// ── FEMA National Risk Index — Tornado Risk Index Rating ─────────────────
// Tornado hazard has no clean raster/tile service, so both the Recon Report
// point lookup and the map overlay read FEMA's National Risk Index (NRI)
// census-tract polygons. Each tract carries a composite tornado risk rating
// string (TRND_RISKR, e.g. "Relatively High") and a 0–100 score (TRND_RISKS).
// Coverage is the U.S.; tracts outside the model return no feature.
const TORNADO_API =
  'https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Census_Tract_Tornado_Hazard_Type_Risk_Index_Rating/FeatureServer/0/query'

const TORNADO_OUT_FIELDS = 'TRND_RISKR,TRND_RISKS'

// The overlay starts at a metro-ish zoom — tract polygons are coarse, so a
// wide view would pull thousands of features for little visual gain.
export const TORNADO_MIN_ZOOM = 8

// Mirrors SEISMIC_BAND_COLORS / WHP_CLASS_COLORS: bands 1-5 (Very low → Very
// high) by index, so the Recon Report card/expand/legend reuse the same
// value/label shape. NRI ratings map onto these five bands; non-rated tracts
// (No/insufficient data) resolve to null and render gray on the overlay.
export const TORNADO_BAND_COLORS: Array<{ label: string; color: string }> = [
  { label: 'Very low',  color: '#1a9850' },
  { label: 'Low',       color: '#a6d96a' },
  { label: 'Moderate',  color: '#fee08b' },
  { label: 'High',      color: '#fc8d59' },
  { label: 'Very high', color: '#d73027' },
]

export const TORNADO_NO_RATING_COLOR = '#9ca3af'

// NRI tornado rating string → band 1-5. The model emits the five "Relatively"
// ratings plus the non-rated sentinels; anything unrecognized is treated as
// non-rated (band 0).
export function tornadoBand(rating: string): number {
  switch (rating.trim().toLowerCase()) {
    case 'very low':
      return 1
    case 'relatively low':
      return 2
    case 'relatively moderate':
      return 3
    case 'relatively high':
      return 4
    case 'very high':
      return 5
    default:
      return 0
  }
}

export function tornadoClassLabel(value: number): string {
  return TORNADO_BAND_COLORS[value - 1]?.label ?? 'Unknown'
}

// The raw NRI rating string the feature reports (for overlay popups / legends).
export function tornadoRatingColor(rating: string): string {
  const band = tornadoBand(rating)
  return band >= 1 ? TORNADO_BAND_COLORS[band - 1].color : TORNADO_NO_RATING_COLOR
}

// Overlay tooltip label for a tract polygon: its NRI rating, normalized.
export function tornadoFeatureLabel(props: GeoJSON.GeoJsonProperties): string {
  const rating = String((props as Record<string, unknown> | null | undefined)?.TRND_RISKR ?? '').trim()
  if (!rating) return 'No tornado rating'
  return `${rating} tornado risk`
}

// Recon Report severity. Consistent with seismic/wildfire: only High (4) and
// Very high (5) trigger a report flag. Moderate (3) and below stay clear
// (Moderate still carries a grade penalty in scoring.ts).
export function tornadoSeverity(value: number): 'danger' | 'clear' {
  if (value === 4 || value === 5) return 'danger'
  return 'clear'
}

export type TornadoPointResult = { value: number; label: string; rating: string; score: number }

// Point-in-polygon query against the NRI tract layer for the Recon Report.
// Returns null when the point falls outside the model coverage or the tract
// has no usable rating. Throws on network/HTTP failure so the caller can flag
// an error state.
export async function fetchTornadoAtPoint(lat: number, lng: number): Promise<TornadoPointResult | null> {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: TORNADO_OUT_FIELDS,
    geometry: `${lng},${lat}`,
    geometryType: 'esriGeometryPoint',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outSR: '4326',
    returnGeometry: 'false',
    f: 'json',
  })
  const data = await fetchJsonWithRetry<{ features?: Array<{ attributes?: { TRND_RISKR?: string; TRND_RISKS?: number } }> }>(
    `${TORNADO_API}?${params}`,
  )
  const attrs = data?.features?.[0]?.attributes
  const rating = String(attrs?.TRND_RISKR ?? '').trim()
  if (!rating) return null
  const value = tornadoBand(rating)
  if (value === 0) return null
  const score = typeof attrs?.TRND_RISKS === 'number' && Number.isFinite(attrs.TRND_RISKS) ? attrs.TRND_RISKS : 0
  return { value, label: tornadoClassLabel(value), rating, score }
}

// ── Map overlay: viewport GeoJSON of NRI tract polygons ──────────────────
// The NRI FeatureServer caps responses at maxRecordCount (2000) in OID order,
// so a dense viewport can drop the highest-OID tracts. Mirroring flood, when a
// cell comes back truncated we split its envelope into quadrants and re-query
// each until every cell returns whole. Census tracts are far coarser than FEMA
// flood polygons, so this rarely needs to recurse.
const TORNADO_PAGE_SIZE = 2000
const TORNADO_MAX_SUBDIVIDE = 2 // depth cap → at most 4^2 = 16 leaf queries
const TORNADO_FETCH_RETRIES = 2
const TORNADO_FETCH_TIMEOUT_MS = 20000

// Server-side geometry generalisation tolerance (degrees, matching outSR 4326),
// scaled to the queried span so tract edges stay ~one screen pixel — overlays
// don't need survey precision, and a coarser tolerance shrinks the payload.
function tornadoSimplifyTolerance(west: number, east: number): number {
  const span = Math.abs(east - west)
  return Math.min(0.0015, Math.max(0.00003, span / 1500))
}

function tornadoDedupeKey(feature: GeoJSON.Feature): string {
  const props = (feature.properties as Record<string, unknown> | null) ?? {}
  let c: unknown = (feature.geometry as { coordinates?: unknown } | null)?.coordinates
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0]
  const vertex = Array.isArray(c) ? c.join(',') : ''
  return `${props.TRND_RISKR ?? ''}|${vertex}`
}

export async function fetchTornadoFeatures(
  bounds: L.LatLngBounds,
  onChunk?: (newFeatures: GeoJSON.Feature[]) => void,
): Promise<GeoJSON.FeatureCollection> {
  const features: GeoJSON.Feature[] = []
  const seen = new Set<string>()
  const tolerance = tornadoSimplifyTolerance(bounds.getWest(), bounds.getEast())

  function addFeatures(fc: GeoJSON.FeatureCollection | null | undefined): void {
    const fresh: GeoJSON.Feature[] = []
    for (const f of fc?.features ?? []) {
      const key = tornadoDedupeKey(f)
      if (seen.has(key)) continue
      seen.add(key)
      features.push(f)
      fresh.push(f)
    }
    if (fresh.length && onChunk) onChunk(fresh)
  }

  async function fetchCell(west: number, south: number, east: number, north: number, depth: number): Promise<void> {
    const params = new URLSearchParams({
      where: '1=1',
      outFields: 'TRND_RISKR',
      geometry: `${west},${south},${east},${north}`,
      geometryType: 'esriGeometryEnvelope',
      spatialRel: 'esriSpatialRelIntersects',
      inSR: '4326',
      outSR: '4326',
      f: 'geojson',
      maxAllowableOffset: String(tolerance),
      resultRecordCount: String(TORNADO_PAGE_SIZE),
    })
    const url = `${TORNADO_API}?${params}`
    let data: (GeoJSON.FeatureCollection & { exceededTransferLimit?: boolean }) | null = null
    for (let attempt = 0; attempt <= TORNADO_FETCH_RETRIES; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(TORNADO_FETCH_TIMEOUT_MS) })
        if (!res.ok) throw new Error(`FEMA NRI ${res.status}`)
        data = await res.json()
        break
      } catch {
        data = null
        if (attempt < TORNADO_FETCH_RETRIES) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
        }
      }
    }
    if (!data || !Array.isArray(data.features)) return

    addFeatures(data)

    if (data.exceededTransferLimit && depth < TORNADO_MAX_SUBDIVIDE) {
      const midX = (west + east) / 2
      const midY = (south + north) / 2
      await Promise.all([
        fetchCell(west, south, midX, midY, depth + 1),
        fetchCell(midX, south, east, midY, depth + 1),
        fetchCell(west, midY, midX, north, depth + 1),
        fetchCell(midX, midY, east, north, depth + 1),
      ])
    }
  }

  await fetchCell(bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth(), 0)
  return { type: 'FeatureCollection', features }
}
