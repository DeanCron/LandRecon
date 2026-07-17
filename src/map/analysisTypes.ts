import type { BroadbandResponse } from './broadband'
import type { CrowdType } from './crowd'
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
