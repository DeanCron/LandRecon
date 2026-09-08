import { beforeEach, describe, expect, it } from 'vitest'
import {
  SAVED_ANALYSES_KEY,
  attachEvidenceToSavedBreakdown,
  buildSavedAnalysisExplainability,
  canSaveAnalysis,
  getPendingSavedAnalysisFactors,
  loadSavedAnalyses,
  writeSavedAnalyses,
  type SavedAnalysis,
} from './savedAnalyses'
import type { LocationGradeBreakdownItem, LocationGradeFactorLabel } from './analysisTypes'
import type { FactorEvidence, ReportQuality } from './evidence'

function sampleEvidence(state: FactorEvidence['state']): FactorEvidence {
  return {
    state,
    source: 'Test source',
    rule: 'Test rule',
    whyItMatters: 'Test rationale',
  }
}

type SavedAnalysisWithEvidence = SavedAnalysis & {
  evidence?: Partial<Record<LocationGradeFactorLabel, FactorEvidence>>
}

beforeEach(() => {
  localStorage.clear()
})

describe('savedAnalyses', () => {
  it('loads legacy records without evidence fields', () => {
    localStorage.setItem(SAVED_ANALYSES_KEY, JSON.stringify([{ address: '1 Main St' }]))

    const [entry] = loadSavedAnalyses()

    expect(entry.address).toBe('1 Main St')
    expect(entry.breakdown).toBeUndefined()
    expect(entry.quality).toBeUndefined()
  })

  it('attaches matching factor evidence to saved breakdown items', () => {
    const factor: LocationGradeBreakdownItem = {
      label: 'Flood Zone',
      icon: '🌊',
      score: 3,
      max: 3,
      detail: 'High risk',
      tier: 'safety',
    }

    expect(typeof attachEvidenceToSavedBreakdown).toBe('function')
    expect(
      attachEvidenceToSavedBreakdown([factor], {
        'Flood Zone': sampleEvidence('verified'),
      }),
    ).toEqual([
      {
        ...factor,
        evidence: sampleEvidence('verified'),
      },
    ])
  })

  it('omits still-loading factors from explainability metadata while preserving completed unavailable factors', () => {
    const breakdown: LocationGradeBreakdownItem[] = [
      {
        label: 'Flood Zone',
        icon: '🌊',
        score: 0,
        max: 3,
        detail: 'Very low risk',
        tier: 'safety',
      },
    ]
    const quality: ReportQuality = {
      state: 'unavailable',
      verifiedCount: 1,
      cautionCount: 0,
      unavailableCount: 1,
    }

    expect(
      buildSavedAnalysisExplainability(
        breakdown,
        {
          'Airport Noise': sampleEvidence('unavailable'),
          'Flood Zone': sampleEvidence('verified'),
          'Seismic Hazard': sampleEvidence('unavailable'),
        },
        quality,
        ['Seismic Hazard'],
      ),
    ).toEqual({
      breakdown: [
        {
          ...breakdown[0],
          evidence: sampleEvidence('verified'),
        },
      ],
      evidence: {
        'Airport Noise': sampleEvidence('unavailable'),
        'Flood Zone': sampleEvidence('verified'),
      },
    })
  })

  it('treats crowd and railroad as pending for persisted explainability until analysis progress marks them done', () => {
    const breakdown: LocationGradeBreakdownItem[] = [
      {
        label: 'Flood Zone',
        icon: '🌊',
        score: 0,
        max: 3,
        detail: 'Very low risk',
        tier: 'safety',
      },
      {
        label: 'Railroad',
        icon: '🚂',
        score: 0,
        max: 3,
        detail: 'No track within range',
        tier: 'safety',
      },
      {
        label: 'Crowd Magnets',
        icon: '🎟️',
        score: 0,
        max: 2,
        detail: 'None nearby',
        tier: 'lifestyle',
      },
    ]
    const quality: ReportQuality = {
      state: 'verified',
      verifiedCount: 3,
      cautionCount: 0,
      unavailableCount: 0,
    }

    const pendingFactors = getPendingSavedAnalysisFactors(
      {
        noiseLoading: false,
        costcoLoading: false,
        broadbandLoading: false,
        floodLoading: false,
        wildfireLoading: false,
        seismicLoading: false,
        tornadoLoading: false,
      },
      {
        crowd: 'pending',
        railroad: 'pending',
      },
    )

    expect(
      buildSavedAnalysisExplainability(
        breakdown,
        {
          'Flood Zone': sampleEvidence('verified'),
          Railroad: sampleEvidence('verified'),
          'Crowd Magnets': sampleEvidence('verified'),
        },
        quality,
        pendingFactors,
      ),
    ).toEqual({
      breakdown: [
        {
          ...breakdown[0],
          evidence: sampleEvidence('verified'),
        },
        breakdown[1],
        breakdown[2],
      ],
      evidence: {
        'Flood Zone': sampleEvidence('verified'),
      },
    })
  })

  it('returns false when analysis checks are not complete even if loading flags are clear', () => {
    expect(
      canSaveAnalysis({
        loading: false,
        noiseLoading: false,
        costcoLoading: false,
        broadbandLoading: false,
        floodLoading: false,
        wildfireLoading: false,
        seismicLoading: false,
        tornadoLoading: false,
      }, false),
    ).toBe(false)
  })

  it('returns true only when loading guards pass and analysis checks are complete', () => {
    expect(
      canSaveAnalysis(
        {
          loading: false,
          noiseLoading: false,
          costcoLoading: false,
          broadbandLoading: false,
          floodLoading: false,
          wildfireLoading: false,
          seismicLoading: false,
          tornadoLoading: false,
        },
        true,
      ),
    ).toBe(true)
  })

  it('returns false when a core loading flag is still set even if analysis checks are complete', () => {
    expect(
      canSaveAnalysis(
        {
          loading: false,
          noiseLoading: false,
          costcoLoading: true,
          broadbandLoading: false,
          floodLoading: false,
          wildfireLoading: false,
          seismicLoading: false,
          tornadoLoading: false,
        },
        true,
      ),
    ).toBe(false)
  })

  it('round-trips quality and factor evidence', () => {
    const quality: ReportQuality = {
      state: 'verified',
      verifiedCount: 1,
      cautionCount: 0,
      unavailableCount: 0,
    }
    const entry: SavedAnalysis = {
      address: '1 Main St',
      date: '9/2/2026',
      grade: 'A',
      gradeColor: '#4caf50',
      pct: 1,
      noiseLevel: null,
      noiseAirport: null,
      superfundCount: 0,
      superfundActive: 0,
      costcoMi: 2,
      dataCenterCount: 0,
      breakdown: [
        {
          label: 'Flood Zone',
          icon: '🌊',
          score: 0,
          max: 3,
          detail: 'Very low risk',
          tier: 'safety',
          evidence: sampleEvidence('verified'),
        },
      ],
      quality,
    }

    writeSavedAnalyses([entry])

    const [loaded] = loadSavedAnalyses()

    expect(loaded.quality?.state).toBe('verified')
    expect(loaded.breakdown?.[0].evidence?.state).toBe('verified')
  })

  it('hydrates saved breakdown evidence while preserving unavailable factors omitted from the breakdown', () => {
    const rawEntry: SavedAnalysisWithEvidence = {
      address: '2 Main St',
      date: '9/2/2026',
      grade: 'A',
      gradeColor: '#4caf50',
      pct: 1,
      noiseLevel: null,
      noiseAirport: null,
      superfundCount: 0,
      superfundActive: 0,
      costcoMi: 2,
      dataCenterCount: 0,
      breakdown: [
        {
          label: 'Flood Zone',
          icon: '🌊',
          score: 0,
          max: 3,
          detail: 'Very low risk',
          tier: 'safety',
        },
      ],
      evidence: {
        'Airport Noise': sampleEvidence('unavailable'),
        'Flood Zone': sampleEvidence('verified'),
      },
    }

    writeSavedAnalyses([rawEntry as SavedAnalysis])

    const [loaded] = loadSavedAnalyses() as SavedAnalysisWithEvidence[]

    expect(loaded.evidence?.['Airport Noise']?.state).toBe('unavailable')
    expect(loaded.breakdown?.[0].evidence?.state).toBe('verified')
  })
})
