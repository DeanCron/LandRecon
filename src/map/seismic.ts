import { fetchJsonWithRetry } from './fetchRetry'

// ── USGS Seismic Design (ASCE 7-16) point lookup ────────────────────────
// There is no clean raster/tile service for point earthquake hazard, so the
// Recon Report uses the USGS Design Maps web service to read the design
// peak ground acceleration (PGA, in g) at a single location. PGA is always
// present inside the contiguous U.S. coverage; out-of-US / open-ocean points
// return HTTP 500, which the caller surfaces as an error state.
const ASCE7_16_BASE = 'https://earthquake.usgs.gov/ws/designmaps/asce7-16.json'

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
export async function fetchSeismicAtPoint(lat: number, lng: number): Promise<SeismicPointResult | null> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    riskCategory: 'II',
    siteClass: 'D',
    title: 'LandRecon',
  })
  const data = await fetchJsonWithRetry<{ response?: { data?: { pga?: number } } }>(`${ASCE7_16_BASE}?${params}`)
  const pga = data?.response?.data?.pga
  if (typeof pga !== 'number' || !Number.isFinite(pga)) return null
  const value = seismicBand(pga)
  return { value, label: seismicClassLabel(value), pga }
}
