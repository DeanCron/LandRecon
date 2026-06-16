import {
  FLOOD_ZONE_LABELS,
  floodSeverity,
  type FloodPointResult,
} from '../map/flood'
import {
  wildfireSeverity,
  type WildfirePointResult,
} from '../map/wildfire'
import {
  seismicSeverity,
  type SeismicPointResult,
} from '../map/seismic'
import {
  tornadoSeverity,
  type TornadoPointResult,
} from '../map/tornado'
import {
  type BroadbandResponse,
  broadbandSeverity,
  formatBroadbandSpeed,
} from '../map/broadband'
import { CROWD_ANALYSIS_RADIUS_MI } from '../map/crowd'

const COSTCO_GREEN_RADIUS_MI = 30
const SUPERFUND_ANALYSIS_RADIUS_MI = 3

export function getExpFlag(key: string, fallback: boolean): boolean {
  const v = localStorage.getItem(key)
  return v === null ? fallback : v === '1'
}

export function costcoSeverity(distMi: number): 'good' | 'warning' | 'danger' {
  if (distMi <= COSTCO_GREEN_RADIUS_MI) return 'good'
  if (distMi <= 50) return 'warning'
  return 'danger'
}

export function noiseSeverity(db: number): 'warning' | 'danger' {
  if (db < 65) return 'warning'
  return 'danger'
}

export function superfundSeverity(sites: { status: string }[]): 'clear' | 'warning' | 'danger' {
  if (sites.length === 0) return 'clear'
  const hasActive = sites.some(s => s.status !== 'Deleted')
  return hasActive ? 'danger' : 'warning'
}

export function dataCenterSeverity(count: number): 'clear' | 'warning' | 'danger' {
  if (count === 0) return 'clear'
  if (count <= 2) return 'warning'
  return 'danger'
}

export function crowdMagnetsSeverity(count: number): 'clear' | 'warning' | 'danger' {
  if (count === 0) return 'clear'
  if (count <= 2) return 'warning'
  return 'danger'
}

export function erSeverity(distMi: number | null): 'clear' | 'good' | 'warning' | 'danger' {
  if (distMi === null) return 'danger'
  if (distMi <= 10) return 'clear'
  if (distMi <= 15) return 'warning'
  return 'danger'
}

export type SeverityLevel = 'clear' | 'good' | 'warning' | 'danger'

export function computeLocationGrade(results: {
  noiseLevel: number | null
  superfunds: { status: string }[]
  costco: { distanceMi: number } | null
  costcoError: boolean
  costcoLoading?: boolean
  dataCenters: unknown[]
  nearestER: { distanceMi: number } | null
  crowdMagnets: unknown[]
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
}): { letter: string; color: string; severity: SeverityLevel; pct: number; breakdown: { label: string; icon: string; score: number; max: number; detail: string; tier: 'safety' | 'lifestyle' | 'convenience' }[] } {
  const breakdown: { label: string; icon: string; score: number; max: number; detail: string; tier: 'safety' | 'lifestyle' | 'convenience' }[] = []

  // Tiered weighting. Each tier contributes a FIXED share of the grade,
  // independent of how many checks it contains — so adding a new check (e.g.
  // Wildfire) refines its tier's sub-score rather than inflating that tier's
  // overall influence. Within a tier, items split the weight in proportion to
  // their per-item `max` (Safety items are equal at 3, Lifestyle at 2, etc.).
  //   Safety 60%  — Noise, Superfund, ER, Flood, Wildfire, Seismic, Tornado
  //   Lifestyle 30% — Data Centers, Crowd, Broadband
  //   Convenience 10% — Costco
  // A tier whose items are all still loading drops out and its weight is
  // redistributed across the present tiers. A=≥90% / B=≥75% / C=≥50% / D=≥25%.

  // --- SAFETY (max 3) ---

  // Noise: 0 = none, 2 = moderate (<65), 3 = high (65+)
  let noiseScore = 0
  let noiseDetail = 'No airport noise detected'
  if (results.noiseLevel) {
    if (results.noiseLevel < 65) { noiseScore = 2; noiseDetail = `~${results.noiseLevel} dB DNL (moderate)` }
    else { noiseScore = 3; noiseDetail = `~${results.noiseLevel} dB DNL (high)` }
  }
  breakdown.push({ label: 'Airport Noise', icon: '✈️', score: noiseScore, max: 3, detail: noiseDetail, tier: 'safety' })

  // Superfund: clear=0, warning=2, danger=3
  const sfSev = superfundSeverity(results.superfunds)
  const sfScore = sfSev === 'clear' ? 0 : sfSev === 'warning' ? 2 : 3
  const sfDetail = results.superfunds.length === 0 ? `None within ${SUPERFUND_ANALYSIS_RADIUS_MI} mi`
    : `${results.superfunds.length} site${results.superfunds.length > 1 ? 's' : ''} (${results.superfunds.filter(s => s.status !== 'Deleted').length} active)`
  breakdown.push({ label: 'Superfund Sites', icon: '☢️', score: sfScore, max: 3, detail: sfDetail, tier: 'safety' })

  // Emergency Room: good/clear=0, warning=2, danger=3
  const erDist = results.nearestER?.distanceMi ?? null
  const erSev = erSeverity(erDist)
  const erScore = (erSev === 'clear' || erSev === 'good') ? 0 : erSev === 'warning' ? 2 : 3
  const erDetail = erDist !== null ? `${erDist} mi away` : 'None found within search area'
  breakdown.push({ label: 'Emergency Room', icon: '🏥', score: erScore, max: 3, detail: erDetail, tier: 'safety' })

  // Flood zone: clear=0, warning=2 (moderate / 0.2%), danger=3 (SFHA / coastal).
  // Skipped while still loading so the grade isn't penalized before the FEMA
  // point query resolves. On error, included as a neutral 0 with a note.
  if (!results.floodLoading) {
    const floodSev = results.floodZone ? floodSeverity(results.floodZone.bucket) : 'clear'
    const floodScore = floodSev === 'danger' ? 3 : floodSev === 'warning' ? 2 : 0
    const floodDetail = results.floodError
      ? 'Flood data unavailable'
      : results.floodZone
        ? FLOOD_ZONE_LABELS[results.floodZone.bucket]
        : 'No mapped FEMA hazard'
    breakdown.push({ label: 'Flood Zone', icon: '🌊', score: floodScore, max: 3, detail: floodDetail, tier: 'safety' })
  }

  // Wildfire: clear=0, moderate (class 3)=2, danger=3 (high / very high).
  // Moderate no longer surfaces as a report flag (wildfireSeverity returns
  // 'clear' for it), but it still carries a grade penalty here. Same
  // loading/error contract as flood — skipped while loading, neutral 0 on
  // error so a flaky USFS lookup doesn't penalize the grade.
  if (!results.wildfireLoading) {
    const wf = results.wildfireHazard
    const wfScore = wf ? (wildfireSeverity(wf.value) === 'danger' ? 3 : wf.value === 3 ? 2 : 0) : 0
    const wfDetail = results.wildfireError
      ? 'Wildfire data unavailable'
      : results.wildfireHazard
        ? `${results.wildfireHazard.label} wildfire hazard`
        : 'No mapped USFS hazard'
    breakdown.push({ label: 'Wildfire Hazard', icon: '🔥', score: wfScore, max: 3, detail: wfDetail, tier: 'safety' })
  }

  // Seismic: clear=0, moderate (band 3)=2, danger=3 (high / very high). Mirrors
  // wildfire — only High+ surfaces as a report flag (seismicSeverity returns
  // 'clear' for Moderate), but Moderate still carries a grade penalty here.
  // Same loading/error contract — skipped while loading, neutral 0 on error so
  // a flaky USGS lookup doesn't penalize the grade.
  if (!results.seismicLoading) {
    const sq = results.seismicHazard
    const sqScore = sq ? (seismicSeverity(sq.value) === 'danger' ? 3 : sq.value === 3 ? 2 : 0) : 0
    const sqDetail = results.seismicError
      ? 'Seismic data unavailable'
      : results.seismicHazard
        ? `${results.seismicHazard.label} seismic hazard`
        : 'No mapped seismic hazard'
    breakdown.push({ label: 'Seismic Hazard', icon: '🌎', score: sqScore, max: 3, detail: sqDetail, tier: 'safety' })
  }

  // Tornado: clear=0, moderate (band 3)=2, danger=3 (high / very high). Mirrors
  // seismic — only High+ surfaces as a report flag (tornadoSeverity returns
  // 'clear' for Moderate), but Moderate still carries a grade penalty here.
  // Same loading/error contract — skipped while loading, neutral 0 on error so
  // a flaky FEMA NRI lookup doesn't penalize the grade.
  if (!results.tornadoLoading) {
    const tn = results.tornadoHazard
    const tnScore = tn ? (tornadoSeverity(tn.value) === 'danger' ? 3 : tn.value === 3 ? 2 : 0) : 0
    const tnDetail = results.tornadoError
      ? 'Tornado data unavailable'
      : results.tornadoHazard
        ? `${results.tornadoHazard.label} tornado risk`
        : 'No mapped tornado risk'
    breakdown.push({ label: 'Tornado Risk', icon: '🌪️', score: tnScore, max: 3, detail: tnDetail, tier: 'safety' })
  }

  // --- LIFESTYLE (max 2) ---

  // Data centers: clear=0, warning=1, danger=2
  const dcSev = dataCenterSeverity(results.dataCenters.length)
  const dcScore = dcSev === 'clear' ? 0 : dcSev === 'warning' ? 1 : 2
  const dcDetail = results.dataCenters.length === 0 ? 'None nearby' : `${results.dataCenters.length} nearby`
  breakdown.push({ label: 'Data Centers', icon: '🏢', score: dcScore, max: 2, detail: dcDetail, tier: 'lifestyle' })

  // Crowd magnets: clear=0, warning=1, danger=2
  const cmCount = results.crowdMagnets.length
  const cmSev = crowdMagnetsSeverity(cmCount)
  const cmScore = cmSev === 'clear' ? 0 : cmSev === 'warning' ? 1 : 2
  const cmDetail = cmCount === 0
    ? `None within ${CROWD_ANALYSIS_RADIUS_MI} mi`
    : `${cmCount} within ${CROWD_ANALYSIS_RADIUS_MI} mi`
  breakdown.push({ label: 'Crowd Magnets', icon: '🎟️', score: cmScore, max: 2, detail: cmDetail, tier: 'lifestyle' })

  // Broadband: good/clear=0, warning=1, danger=2
  // Skip entirely while still loading (so the grade isn't artificially
  // penalized before broadband resolves). If broadband resolved but returned
  // no summary (block-only fallback or no data), include it as 0 with a
  // "data not available" note so it stays neutral.
  if (!results.broadbandLoading) {
    const bbSummary = results.broadband?.summary ?? null
    const bbSev = broadbandSeverity(bbSummary?.speedTier)
    const bbScore = (bbSev === 'clear' || bbSev === 'good') ? 0 : bbSev === 'warning' ? 1 : 2
    let bbDetail = 'No data available'
    if (bbSummary) {
      const speed = formatBroadbandSpeed(bbSummary.maxDownMbps)
      bbDetail = `${speed} down · ${bbSummary.providerCount} ${bbSummary.providerCount === 1 ? 'provider' : 'providers'}${bbSummary.hasFiber ? ' · fiber' : ''}`
    }
    breakdown.push({ label: 'Broadband', icon: '📶', score: bbScore, max: 2, detail: bbDetail, tier: 'lifestyle' })
  }

  // --- CONVENIENCE (max 1) ---

  // Costco: good=0, warning=0, danger=1. Only the worst case (no Costco
  // within range, or search timed out) costs a point. Skipped while loading
  // so the grade isn't artificially penalized.
  if (!results.costcoLoading) {
    let costcoScore = 0
    let costcoDetail: string
    if (!results.costco) {
      costcoScore = 1
      costcoDetail = results.costcoError ? 'Search timed out' : 'None within range'
    } else {
      const cs = costcoSeverity(results.costco.distanceMi)
      costcoScore = cs === 'danger' ? 1 : 0
      costcoDetail = `${results.costco.distanceMi} mi away`
    }
    breakdown.push({ label: 'Nearest Costco', icon: '🛒', score: costcoScore, max: 1, detail: costcoDetail, tier: 'convenience' })
  }

  // Combine tiers by their fixed weights. Each tier's penalty fraction is its
  // items' total score over their total max (0 = all clear, 1 = all maxed),
  // so the number of checks in a tier doesn't change the tier's clout. Tiers
  // with no scored items yet (everything still loading) are skipped and their
  // weight redistributed via the running weightSum.
  const TIER_WEIGHTS: Record<'safety' | 'lifestyle' | 'convenience', number> = {
    safety: 0.60,
    lifestyle: 0.30,
    convenience: 0.10,
  }
  let weightedPenalty = 0
  let weightSum = 0
  for (const tier of ['safety', 'lifestyle', 'convenience'] as const) {
    const items = breakdown.filter((b) => b.tier === tier)
    const tierMax = items.reduce((a, b) => a + b.max, 0)
    if (tierMax <= 0) continue
    const tierScore = items.reduce((a, b) => a + b.score, 0)
    weightedPenalty += TIER_WEIGHTS[tier] * (tierScore / tierMax)
    weightSum += TIER_WEIGHTS[tier]
  }

  const pct = weightSum > 0 ? 1 - weightedPenalty / weightSum : 1
  if (pct >= 0.9) return { letter: 'A', color: '#4caf50', severity: 'clear', pct, breakdown }
  if (pct >= 0.75) return { letter: 'B', color: '#8bc34a', severity: 'good', pct, breakdown }
  if (pct >= 0.5) return { letter: 'C', color: '#ffb300', severity: 'warning', pct, breakdown }
  if (pct >= 0.25) return { letter: 'D', color: '#ff7043', severity: 'warning', pct, breakdown }
  return { letter: 'F', color: '#ef5350', severity: 'danger', pct, breakdown }
}
