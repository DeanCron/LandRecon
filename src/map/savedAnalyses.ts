import type { FactorEvidence, ReportQuality } from './evidence'
import { parseGpsTarget, type GpsTarget } from '../utils/locationTarget'
import { rememberMapAddress, rememberMapGps, type MapAddressState } from '../utils/mapAddressState'
import type {
  AnalysisResults,
  LocationGradeBreakdownItem,
  LocationGradeFactorLabel,
} from './analysisTypes'

// Shared store for "saved analyses" — the locations a user pins from the
// Recon Report to compare later. Both the map's Save button and the map's
// Compare slide-in panel read and write this single localStorage list.

export const SAVED_ANALYSES_KEY = 'lr_saved_analyses'

// How many saved locations we retain. Oldest entries fall off the end.
export const MAX_SAVED_ANALYSES = 5

// One scored factor from computeLocationGrade()'s breakdown, persisted so the
// detailed comparison page can render a full side-by-side without re-running
// the analysis. Mirrors the breakdown element shape in src/map/scoring.ts.
export type SavedFactor = {
  label: LocationGradeFactorLabel
  icon: string
  score: number
  max: number
  detail: string
  tier: 'safety' | 'lifestyle' | 'convenience'
  evidence?: FactorEvidence
}

export type SavedEvidenceByFactor = Partial<Record<LocationGradeFactorLabel, FactorEvidence>>

export type SavedAnalysis = {
  address: string
  gps?: GpsTarget
  locationError?: string
  date: string
  grade: string
  gradeColor: string
  pct: number
  noiseLevel: number | null
  noiseAirport: string | null
  superfundCount: number
  superfundActive: number
  costcoMi: number | null
  dataCenterCount: number
  // Full scoring breakdown. Optional because entries saved before this field
  // existed won't have it — consumers must fall back gracefully.
  breakdown?: SavedFactor[]
  evidence?: SavedEvidenceByFactor
  quality?: ReportQuality
}

export function attachEvidenceToSavedBreakdown(
  breakdown: Array<LocationGradeBreakdownItem | SavedFactor>,
  evidenceByFactor?: SavedEvidenceByFactor,
): SavedFactor[] {
  return breakdown.map((factor) => ({
    ...factor,
    evidence: evidenceByFactor?.[factor.label] ?? ('evidence' in factor ? factor.evidence : undefined),
  }))
}

export function buildSavedAnalysisExplainability(
  breakdown: LocationGradeBreakdownItem[],
  evidenceByFactor: SavedEvidenceByFactor,
  quality: ReportQuality,
  pendingFactors: LocationGradeFactorLabel[] = [],
): Pick<SavedAnalysis, 'breakdown' | 'evidence' | 'quality'> {
  const pending = new Set(pendingFactors)
  const evidenceEntries = Object.entries(evidenceByFactor).filter(
    ([label]) => !pending.has(label as LocationGradeFactorLabel),
  )
  const evidence = evidenceEntries.length > 0
    ? Object.fromEntries(evidenceEntries) as SavedEvidenceByFactor
    : undefined
  return {
    breakdown: attachEvidenceToSavedBreakdown(breakdown, evidence),
    ...(evidence ? { evidence } : {}),
    ...(pending.size === 0 ? { quality } : {}),
  }
}

export function getPendingSavedAnalysisFactors(
  results: Pick<
    AnalysisResults,
    | 'noiseLoading'
    | 'costcoLoading'
    | 'broadbandLoading'
    | 'floodLoading'
    | 'wildfireLoading'
    | 'seismicLoading'
    | 'tornadoLoading'
  >,
  analysisProgress: Partial<Record<string, 'pending' | 'done'>>,
): LocationGradeFactorLabel[] {
  const pendingExplainabilityFactors: LocationGradeFactorLabel[] = []
  if (results.noiseLoading) pendingExplainabilityFactors.push('Airport Noise')
  if (results.floodLoading) pendingExplainabilityFactors.push('Flood Zone')
  if (results.wildfireLoading) pendingExplainabilityFactors.push('Wildfire Hazard')
  if (results.seismicLoading) pendingExplainabilityFactors.push('Seismic Hazard')
  if (results.tornadoLoading) pendingExplainabilityFactors.push('Tornado Risk')
  if (results.broadbandLoading) pendingExplainabilityFactors.push('Broadband')
  if (results.costcoLoading) pendingExplainabilityFactors.push('Nearest Costco')
  if (analysisProgress.crowd !== 'done') pendingExplainabilityFactors.push('Crowd Magnets')
  if (analysisProgress.railroad !== 'done') pendingExplainabilityFactors.push('Railroad')
  return pendingExplainabilityFactors
}

// Save only once every analysis check has resolved and the original core
// blocking lookups have finished, so persisted grades/evidence reflect the
// final snapshot shown in the Recon Report.
export function canSaveAnalysis(
  results: Pick<
    AnalysisResults,
    | 'loading'
    | 'noiseLoading'
    | 'costcoLoading'
    | 'broadbandLoading'
    | 'floodLoading'
    | 'wildfireLoading'
    | 'seismicLoading'
    | 'tornadoLoading'
  >,
  allChecksComplete = true,
): boolean {
  return !(
    !allChecksComplete ||
    results.loading ||
    results.noiseLoading ||
    results.costcoLoading
  )
}

function normalizeSavedAnalysis(entry: SavedAnalysis): SavedAnalysis {
  if (entry.gps !== undefined) {
    const gps = parseGpsTarget(entry.gps)
    entry = gps ? { ...entry, gps } : {
      ...entry, gps: undefined,
      locationError: 'This saved GPS location is invalid. Enter an address or score your location again.',
    }
  }
  return entry.breakdown && entry.evidence
    ? {
        ...entry,
        breakdown: attachEvidenceToSavedBreakdown(entry.breakdown, entry.evidence),
      }
    : entry
}

export function savedAnalysisState(entry: Pick<SavedAnalysis, 'address' | 'gps' | 'locationError'>): MapAddressState {
  if (entry.locationError) return { landReconLocationError: entry.locationError }
  return entry.gps ? rememberMapGps(entry.gps) : rememberMapAddress(entry.address)
}

export function loadSavedAnalyses(): SavedAnalysis[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVED_ANALYSES_KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .filter((entry): entry is SavedAnalysis => (
        !!entry && typeof entry === 'object' && typeof entry.address === 'string'
      ))
      .map(normalizeSavedAnalysis)
  } catch {
    return []
  }
}

export function writeSavedAnalyses(list: SavedAnalysis[]): void {
  localStorage.setItem(SAVED_ANALYSES_KEY, JSON.stringify(list))
}
