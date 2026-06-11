import { quantizeCoord } from '../utils/perf'

const ANALYSIS_CACHE_PREFIX = 'lr_analysis_v3:'
const ANALYSIS_CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes

export interface CachedAnalysisPayload {
  ts: number
  data: {
    noiseLevel: number | null
    noiseAirport: string | null
    noiseAirportCode: string | null
    superfunds: unknown[]
    costco: unknown
    costcoNearby: unknown[]
    costcoNearestBeyond: unknown
    costcoError: boolean
    dataCenters: unknown[]
    nearestER: unknown
    erError: boolean
    crowdMagnets: unknown[]
    // Optional: present (object or null) once the FEMA point query has
    // produced a determined result. Absent means "not determined" (errored or
    // never resolved) so a cache hit re-fetches instead of showing "no hazard".
    floodZone?: unknown
  }
}

function analysisCacheKey(lat: number, lng: number): string {
  return `${ANALYSIS_CACHE_PREFIX}${quantizeCoord(lat)},${quantizeCoord(lng)}`
}

export function readAnalysisCache(lat: number, lng: number): CachedAnalysisPayload['data'] | null {
  if (typeof sessionStorage === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(analysisCacheKey(lat, lng))
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedAnalysisPayload
    if (Date.now() - parsed.ts > ANALYSIS_CACHE_TTL_MS) return null
    return parsed.data
  } catch {
    return null
  }
}

export function writeAnalysisCache(lat: number, lng: number, data: CachedAnalysisPayload['data']) {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(
      analysisCacheKey(lat, lng),
      JSON.stringify({ ts: Date.now(), data } satisfies CachedAnalysisPayload),
    )
  } catch {
    // Storage is full or disabled; not fatal — analysis still ran.
  }
}

// Flood resolves independently of the rest of the analysis, so it may land
// after the cache entry has already been written (by the Costco step). Merge
// the determined flood result into the existing entry when that happens. No-op
// if there is no current entry (the Costco write will include the captured
// value instead).
export function patchAnalysisCacheFlood(lat: number, lng: number, floodZone: unknown) {
  const existing = readAnalysisCache(lat, lng)
  if (!existing) return
  writeAnalysisCache(lat, lng, { ...existing, floodZone })
}
