import type { AnalysisDetail, AnalysisResults } from './analysisTypes'
import type { CachedAnalysisPayload } from './analysisCache'

// Sections rendered on the standalone /report page, in print order.
// Broadband and commute are excluded: broadband is not cached and commute
// needs a user-entered work address.
export const REPORT_SECTIONS: { detail: Exclude<AnalysisDetail, null>; title: string }[] = [
  { detail: 'score', title: 'Score Breakdown' },
  { detail: 'noise', title: 'Airport Noise' },
  { detail: 'superfunds', title: 'Superfund Sites' },
  { detail: 'er', title: 'Emergency Room' },
  { detail: 'flood', title: 'Flood Zone' },
  { detail: 'wildfire', title: 'Wildfire Hazard' },
  { detail: 'seismic', title: 'Seismic Hazard' },
  { detail: 'tornado', title: 'Tornado Risk' },
  { detail: 'railroad', title: 'Railroad Proximity' },
  { detail: 'datacenters', title: 'Data Centers' },
  { detail: 'crowd', title: 'Crowd Magnets' },
  { detail: 'costco', title: 'Nearest Costco' },
]

/* eslint-disable @typescript-eslint/no-explicit-any */
export function analysisResultsFromCache(cached: CachedAnalysisPayload['data']): AnalysisResults {
  return {
    loading: false,
    noiseLevel: cached.noiseLevel ?? null,
    noiseAirport: cached.noiseAirport ?? null,
    noiseAirportCode: cached.noiseAirportCode ?? null,
    noiseLoading: false,
    noiseError: cached.noiseLevel === undefined,
    superfunds: cached.superfunds as any,
    costco: cached.costco as any,
    costcoNearby: cached.costcoNearby as any,
    costcoNearestBeyond: (cached.costcoNearestBeyond ?? null) as any,
    costcoError: cached.costcoError,
    costcoLoading: false,
    dataCenters: cached.dataCenters as any,
    nearestER: cached.nearestER as any,
    erError: cached.erError,
    crowdMagnets: (cached.crowdMagnets ?? []) as any,
    crowdError: cached.crowdMagnets === undefined,
    nearestRailroad: (cached.nearestRailroad ?? null) as any,
    railroadError: cached.nearestRailroad === undefined,
    broadband: null,
    broadbandLoading: false,
    floodZone: (cached.floodZone ?? null) as any,
    floodError: cached.floodZone === undefined,
    floodLoading: false,
    wildfireHazard: (cached.wildfireHazard ?? null) as any,
    wildfireError: cached.wildfireHazard === undefined,
    wildfireLoading: false,
    seismicHazard: (cached.seismicHazard ?? null) as any,
    seismicError: cached.seismicHazard === undefined,
    seismicLoading: false,
    tornadoHazard: (cached.tornadoHazard ?? null) as any,
    tornadoError: cached.tornadoHazard === undefined,
    tornadoLoading: false,
  }
}
