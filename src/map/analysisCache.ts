import { quantizeCoord } from '../utils/perf'

const ANALYSIS_CACHE_PREFIX = 'lr_analysis_v4:'
// Persisted in localStorage so a recently-analyzed address is instant on a
// return visit (even after closing the tab). The underlying data is mostly
// static infrastructure (flood zones, Superfund sites, data centers, nearest
// ER), so a 24-hour TTL keeps revisits fast without serving badly stale info.
const ANALYSIS_CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

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
    // Same contract as floodZone, for the USFS Wildfire Hazard Potential class.
    wildfireHazard?: unknown
  }
}

function analysisCacheKey(lat: number, lng: number): string {
  return `${ANALYSIS_CACHE_PREFIX}${quantizeCoord(lat)},${quantizeCoord(lng)}`
}

export function readAnalysisCache(lat: number, lng: number): CachedAnalysisPayload['data'] | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(analysisCacheKey(lat, lng))
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedAnalysisPayload
    if (Date.now() - parsed.ts > ANALYSIS_CACHE_TTL_MS) return null
    return parsed.data
  } catch {
    return null
  }
}

// Drop expired (or unparseable) entries under our prefix. Called before a
// retry when a write hits the localStorage quota — since entries now persist
// across sessions, stale ones would otherwise accumulate until writes fail.
function pruneExpiredEntries() {
  if (typeof localStorage === 'undefined') return
  try {
    const now = Date.now()
    const stale: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(ANALYSIS_CACHE_PREFIX)) continue
      try {
        const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as CachedAnalysisPayload | null
        if (!parsed || now - parsed.ts > ANALYSIS_CACHE_TTL_MS) stale.push(key)
      } catch {
        stale.push(key)
      }
    }
    for (const key of stale) localStorage.removeItem(key)
  } catch {
    // ignore — pruning is best-effort
  }
}

export function writeAnalysisCache(lat: number, lng: number, data: CachedAnalysisPayload['data']) {
  if (typeof localStorage === 'undefined') return
  const key = analysisCacheKey(lat, lng)
  const value = JSON.stringify({ ts: Date.now(), data } satisfies CachedAnalysisPayload)
  try {
    localStorage.setItem(key, value)
  } catch {
    // Likely the quota is full (persisted entries accumulate over time). Drop
    // expired entries and retry once before giving up — analysis still ran.
    pruneExpiredEntries()
    try {
      localStorage.setItem(key, value)
    } catch {
      // Still full or disabled; not fatal.
    }
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

// Wildfire resolves independently too; merge its determined result in the same
// way as flood. No-op when there is no current cache entry.
export function patchAnalysisCacheWildfire(lat: number, lng: number, wildfireHazard: unknown) {
  const existing = readAnalysisCache(lat, lng)
  if (!existing) return
  writeAnalysisCache(lat, lng, { ...existing, wildfireHazard })
}
