import { describe, it, expect, beforeEach } from 'vitest'
import {
  readAnalysisCache,
  writeAnalysisCache,
  patchAnalysisCacheFlood,
  patchAnalysisCacheWildfire,
  type CachedAnalysisPayload,
} from './analysisCache'

const LAT = 34.0102
const LNG = -118.4961

function sampleData(): CachedAnalysisPayload['data'] {
  return {
    noiseLevel: null,
    noiseAirport: null,
    noiseAirportCode: null,
    superfunds: [],
    costco: null,
    costcoNearby: [],
    costcoNearestBeyond: null,
    costcoError: false,
    dataCenters: [],
    nearestER: null,
    erError: false,
    crowdMagnets: [],
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('analysisCache', () => {
  it('round-trips a written entry', () => {
    writeAnalysisCache(LAT, LNG, sampleData())
    expect(readAnalysisCache(LAT, LNG)).toEqual(sampleData())
  })

  it('returns null for an un-cached location', () => {
    expect(readAnalysisCache(LAT, LNG)).toBeNull()
  })

  it('treats entries older than the TTL as a miss', () => {
    // Write directly with a stale timestamp (>24h old).
    const stale = JSON.stringify({ ts: Date.now() - 25 * 60 * 60 * 1000, data: sampleData() })
    // Mirror the key scheme by writing through the public API then overwriting.
    writeAnalysisCache(LAT, LNG, sampleData())
    const key = Object.keys(localStorage).find((k) => k.startsWith('lr_analysis_v4:'))!
    localStorage.setItem(key, stale)
    expect(readAnalysisCache(LAT, LNG)).toBeNull()
  })

  it('patchAnalysisCacheFlood merges into an existing entry', () => {
    writeAnalysisCache(LAT, LNG, sampleData())
    patchAnalysisCacheFlood(LAT, LNG, { bucket: 'high', zone: 'AE', label: 'High risk' })
    expect(readAnalysisCache(LAT, LNG)?.floodZone).toEqual({ bucket: 'high', zone: 'AE', label: 'High risk' })
  })

  it('patchAnalysisCacheWildfire is a no-op without an existing entry', () => {
    patchAnalysisCacheWildfire(LAT, LNG, { value: 4, label: 'High' })
    expect(readAnalysisCache(LAT, LNG)).toBeNull()
  })
})
