import type { BroadbandResponse } from './broadband'
import type { CrowdType } from './crowd'
import type { FactorEvidence, ReportQuality } from './evidence'
import type { FloodPointResult } from './flood'
import type { NearestRailroad } from './railroad'
import type { SeismicPointResult } from './seismic'
import type { TornadoPointResult } from './tornado'
import type { WildfirePointResult } from './wildfire'

export type AnalysisDetail =
  | 'noise'
  | 'superfunds'
  | 'costco'
  | 'datacenters'
  | 'er'
  | 'score'
  | 'crowd'
  | 'railroad'
  | 'broadband'
  | 'flood'
  | 'wildfire'
  | 'seismic'
  | 'tornado'
  | 'commute'
  | null

export interface AnalysisResults {
  loading: boolean
  noiseLevel: number | null
  noiseAirport: string | null
  noiseAirportCode: string | null
  noiseLoading: boolean
  noiseError: boolean
  superfunds: {
    name: string
    distanceMi: number
    status: string
    statusCode: string
    city: string
    epaId: string
    url: string
    lat: number
    lng: number
  }[]
  costco: {
    osmId: string
    name: string
    city: string
    address: string
    distanceMi: number
    lat: number
    lng: number
  } | null
  costcoNearby: {
    osmId: string
    name: string
    city: string
    address: string
    distanceMi: number
    lat: number
    lng: number
  }[]
  costcoNearestBeyond: {
    osmId: string
    name: string
    city: string
    address: string
    distanceMi: number
    lat: number
    lng: number
  } | null
  costcoError: boolean
  costcoLoading: boolean
  dataCenters: {
    name: string
    city: string
    state: string
    distanceMi: number
    status: string
    operator: string
    mw: string
    sizerank: string
    lat: number
    lng: number
  }[]
  nearestER: {
    name: string
    address: string
    distanceMi: number
    lat: number
    lng: number
  } | null
  erError: boolean
  crowdMagnets: {
    id: string
    name: string
    type: CrowdType
    distanceMi: number
    lat: number
    lng: number
  }[]
  crowdError: boolean
  nearestRailroad: NearestRailroad | null
  railroadError: boolean
  broadband: BroadbandResponse | null
  broadbandLoading: boolean
  floodZone: FloodPointResult | null
  floodError: boolean
  floodLoading: boolean
  wildfireHazard: WildfirePointResult | null
  wildfireError: boolean
  wildfireLoading: boolean
  seismicHazard: SeismicPointResult | null
  seismicError: boolean
  seismicLoading: boolean
  tornadoHazard: TornadoPointResult | null
  tornadoError: boolean
  tornadoLoading: boolean
}

export type LocationGradeFactorLabel =
  | 'Airport Noise'
  | 'Superfund Sites'
  | 'Emergency Room'
  | 'Flood Zone'
  | 'Wildfire Hazard'
  | 'Seismic Hazard'
  | 'Tornado Risk'
  | 'Railroad'
  | 'Data Centers'
  | 'Crowd Magnets'
  | 'Broadband'
  | 'Nearest Costco'

export type LocationGradeTier = 'safety' | 'lifestyle' | 'convenience'

export type LocationGradeSeverity = 'clear' | 'good' | 'warning' | 'danger'

export type LocationGradeInput = {
  noiseLevel: number | null
  noiseLoading?: boolean
  noiseError?: boolean
  superfunds: { status: string }[]
  costco: { distanceMi: number } | null
  costcoError: boolean
  costcoLoading?: boolean
  dataCenters: unknown[]
  nearestER: { distanceMi: number } | null
  erError?: boolean
  crowdMagnets: unknown[]
  crowdError?: boolean
  broadband?: BroadbandResponse | null
  broadbandLoading?: boolean
  floodZone?: FloodPointResult | null
  floodError?: boolean
  floodLoading?: boolean
  wildfireHazard?: WildfirePointResult | null
  wildfireError?: boolean
  wildfireLoading?: boolean
  seismicHazard?: SeismicPointResult | null
  seismicError?: boolean
  seismicLoading?: boolean
  tornadoHazard?: TornadoPointResult | null
  tornadoError?: boolean
  tornadoLoading?: boolean
  nearestRailroad?: NearestRailroad | null
  railroadError?: boolean
}

export type LocationGradeBreakdownItem = {
  label: LocationGradeFactorLabel
  icon: string
  score: number
  max: number
  detail: string
  tier: LocationGradeTier
}

export type LocationGradeResult = {
  letter: string
  color: string
  severity: LocationGradeSeverity
  pct: number
  breakdown: LocationGradeBreakdownItem[]
  evidence: Record<LocationGradeFactorLabel, FactorEvidence>
  quality: ReportQuality
}
