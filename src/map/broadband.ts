// FCC Broadband Data Collection (BDC) types + helpers. Data ships through
// the same-origin /api/broadband sidecar endpoint, so no CSP burn and the
// FCC API token never reaches the browser. See server/broadband.mjs and
// scripts/build-broadband-index.mjs for the bootstrap pipeline.
import { startPerformanceSpan } from '../utils/performanceTelemetry'
export type BroadbandTech = { code: number; label: string }
export type BroadbandProvider = { name: string; tech: number; down: number; up: number; br: string }
export type BroadbandBlock = {
  blockFips: string
  county: string
  countyFips: string
  state: string
  stateName: string
  stateFips: string
}
export type BroadbandSummary = {
  providerCount: number
  maxDownMbps: number | null
  maxUpMbps: number | null
  bestProvider: string | null
  hasFiber: boolean
  speedTier: 'gig' | 'fast' | 'served' | 'underserved' | null
  technologies: BroadbandTech[]
  providers: BroadbandProvider[] | null
}
export type BroadbandResponse = {
  block: BroadbandBlock | null
  summary: BroadbandSummary | null
  source: string | null
  asOfDate: string | null
  attribution: string
}

export function broadbandSeverity(tier: BroadbandSummary['speedTier'] | null | undefined): 'good' | 'warning' | 'danger' | 'clear' {
  if (tier === 'gig' || tier === 'fast') return 'good'
  if (tier === 'served') return 'warning'
  if (tier === 'underserved') return 'danger'
  return 'clear'
}

export function formatBroadbandSpeed(mbps: number | null | undefined): string {
  if (mbps == null || !Number.isFinite(mbps) || mbps <= 0) return '—'
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(mbps % 1000 === 0 ? 0 : 1)} Gbps`
  return `${mbps} Mbps`
}

export async function fetchBroadband(lat: number, lng: number, signal?: AbortSignal): Promise<BroadbandResponse | null> {
  const finishTiming = startPerformanceSpan('api_broadband')
  try {
    const res = await fetch(`/api/broadband?lat=${lat}&lng=${lng}`, { signal })
    if (!res.ok) {
      finishTiming('error', { status: res.status })
      return null
    }
    const data = await res.json() as BroadbandResponse
    finishTiming('success')
    return data
  } catch {
    finishTiming(signal?.aborted ? 'cancelled' : 'error')
    return null
  }
}

export const BROADBAND_TECH_LABELS: Record<number, string> = {
  0: 'Other',
  10: 'DSL',
  40: 'Cable',
  50: 'Fiber',
  60: 'GSO Satellite',
  61: 'LEO Satellite',
  70: 'Wireless (Unlicensed)',
  71: 'Wireless (Licensed)',
  72: 'Wireless (CBRS)',
}
