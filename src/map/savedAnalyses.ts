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
  label: string
  icon: string
  score: number
  max: number
  detail: string
  tier: 'safety' | 'lifestyle' | 'convenience'
}

export type SavedAnalysis = {
  address: string
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
}

export function loadSavedAnalyses(): SavedAnalysis[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVED_ANALYSES_KEY) ?? '[]')
    return Array.isArray(raw) ? (raw as SavedAnalysis[]) : []
  } catch {
    return []
  }
}

export function writeSavedAnalyses(list: SavedAnalysis[]): void {
  localStorage.setItem(SAVED_ANALYSES_KEY, JSON.stringify(list))
}
