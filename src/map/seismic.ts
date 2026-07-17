import { fetchJsonWithRetry } from './fetchRetry'

// ── USGS Seismic Design (ASCE 7-16) point lookup ────────────────────────
// There is no clean raster/tile service for point earthquake hazard, so the
// Recon Report uses the USGS Design Maps web service to read the design
// peak ground acceleration (PGA, in g) at a single location. PGA is always
// present inside the contiguous U.S. coverage; out-of-US / open-ocean points
// return HTTP 500, which the caller surfaces as an error state.
//
// earthquake.usgs.gov sends no CORS headers (and isn't in the SPA's CSP
// connect-src), so the browser can't call it directly. We route through a
// same-origin reverse proxy instead — `/usgs-designmaps` in both the nginx
// production config and the Vite dev server, which forward to the real
// `/ws/building-codes/asce7-16/calculate` endpoint (query string preserved).
// (USGS retired the older `/ws/designmaps/asce7-16.json` path, which now
// 301-redirects cross-origin and would re-trip CORS/CSP.)
const ASCE7_16_BASE = '/usgs-designmaps'

// Mirrors WHP_CLASS_COLORS: bands 1-5 (Very low → Very high) by index, so the
// Recon Report card/expand/legend can reuse the same value/label shape as
// wildfire. PGA thresholds (g) follow common engineering hazard breakpoints.
export const SEISMIC_BAND_COLORS: Array<{ label: string; color: string }> = [
  { label: 'Very low',  color: '#1a9850' },
  { label: 'Low',       color: '#a6d96a' },
  { label: 'Moderate',  color: '#fee08b' },
  { label: 'High',      color: '#fc8d59' },
  { label: 'Very high', color: '#d73027' },
]

// PGA (g) → band 1-5. <0.05 Very low, 0.05–0.15 Low, 0.15–0.30 Moderate,
// 0.30–0.50 High, ≥0.50 Very high.
export function seismicBand(pga: number): number {
  if (pga < 0.05) return 1
  if (pga < 0.15) return 2
  if (pga < 0.3) return 3
  if (pga < 0.5) return 4
  return 5
}

export function seismicClassLabel(value: number): string {
  return SEISMIC_BAND_COLORS[value - 1]?.label ?? 'Unknown'
}

// Recon Report severity. Consistent with wildfire: only High (4) and Very
// high (5) trigger a report flag. Moderate (3) and below are treated as clear
// so they don't surface a red flag (Moderate still carries a grade penalty in
// scoring.ts).
export function seismicSeverity(value: number): 'danger' | 'clear' {
  if (value === 4 || value === 5) return 'danger'
  return 'clear'
}

export type SeismicPointResult = { value: number; label: string; pga: number }

// Read the ASCE 7-16 design PGA at a single location for the Recon Report.
// Returns null when the service responds but PGA is missing/unparseable.
// Throws on network/HTTP failure (including the HTTP 500 returned for points
// outside the U.S. coverage) so the caller can flag an error.
export async function fetchSeismicAtPoint(
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<SeismicPointResult | null> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    riskCategory: 'II',
    siteClass: 'D',
    title: 'LandRecon',
  })
  const data = await fetchJsonWithRetry<{ response?: { data?: { pga?: number } } }>(
    `${ASCE7_16_BASE}?${params}`,
    { init: { signal } },
  )
  const pga = data?.response?.data?.pga
  if (typeof pga !== 'number' || !Number.isFinite(pga)) return null
  const value = seismicBand(pga)
  return { value, label: seismicClassLabel(value), pga }
}

// ── Map overlay: USGS National Seismic Hazard Map tile service ───────────
// Unlike the point lookup, the visual overlay is a pre-symbolized XYZ tile
// cache (ASCE 7-22 / 2022 NSHM, PGA with 2% probability of exceedance in 50
// years on firm rock). It's a standard Web Mercator (EPSG:3857) fused cache,
// so Leaflet's L.tileLayer renders it directly. Tiles are cached through
// zoom ~10; beyond that Leaflet upsamples (maxNativeZoom). Coverage is the
// conterminous U.S., so tiles are simply absent (transparent) elsewhere.
export const SEISMIC_TILE_URL =
  'https://gis.asce.org/arcgis/rest/services/ASCE722/eq2022_Tile/MapServer/tile/{z}/{y}/{x}'

export const SEISMIC_TILE_MAX_NATIVE_ZOOM = 10

export const SEISMIC_TILE_ATTRIBUTION = 'Seismic hazard: USGS NSHM 2022 / ASCE'

// Legend for the tile overlay's baked color ramp (9 PGA classes, in g),
// extracted from the service's own legend symbology. Low hazard (greenish)
// → very high (purple/blue).
export const SEISMIC_HAZARD_LEGEND: Array<{ label: string; color: string }> = [
  { label: '0.003 – 0.19 g', color: '#f2f1a2' },
  { label: '0.19 – 0.37 g',  color: '#fcfa62' },
  { label: '0.37 – 0.59 g',  color: '#ffff00' },
  { label: '0.59 – 0.84 g',  color: '#ff9500' },
  { label: '0.84 – 1.13 g',  color: '#ff0000' },
  { label: '1.14 – 1.46 g',  color: '#f505bd' },
  { label: '1.47 – 1.86 g',  color: '#b007ed' },
  { label: '1.87 – 2.36 g',  color: '#6318cc' },
  { label: '2.37 – 3.45 g',  color: '#071dad' },
]
