import { describe, it, expect } from 'vitest'
import { buildReconPdfDocDefinition, reconPdfFilename } from './reconPdf'
import type { LocationGradeResult } from './analysisTypes'
import type { FactorEvidence } from './evidence'

function ev(state: FactorEvidence['state'], extra: Partial<FactorEvidence> = {}): FactorEvidence {
  return {
    state,
    source: 'FEMA',
    rule: 'Point lookup',
    whyItMatters: 'Matters because reasons.',
    ...extra,
  }
}

function grade(overrides: Partial<LocationGradeResult> = {}): LocationGradeResult {
  return {
    letter: 'A',
    color: '#4caf50',
    severity: 'clear',
    pct: 1,
    breakdown: [
      { label: 'Flood Zone', icon: '🌊', score: 0, max: 3, detail: 'Zone X', tier: 'safety' },
      { label: 'Nearest Costco', icon: '🛒', score: 0, max: 1, detail: '4 mi away', tier: 'convenience' },
    ],
    evidence: {
      'Flood Zone': ev('verified'),
      'Nearest Costco': ev('verified', { whyItMatters: 'Bulk mayonnaise proximity, obviously.' }),
    } as LocationGradeResult['evidence'],
    quality: { state: 'verified', verifiedCount: 2, cautionCount: 0, unavailableCount: 0 },
    ...overrides,
  }
}

describe('buildReconPdfDocDefinition', () => {
  it('includes the address, date, and grade letter', () => {
    const doc = buildReconPdfDocDefinition({ address: '123 Main St', date: new Date('2026-09-15T12:00:00Z'), grade: grade() })
    const json = JSON.stringify(doc)
    expect(json).toContain('123 Main St')
    expect(json).toContain('Recon Report')
    expect(json).toContain('2026')
    expect(json).toContain('"A"')
  })

  it('renders each factor with its evidence source and why-it-matters', () => {
    const json = JSON.stringify(buildReconPdfDocDefinition({ address: 'x', date: new Date(), grade: grade() }))
    expect(json).toContain('Flood Zone')
    expect(json).toContain('Nearest Costco')
    expect(json).toContain('Zone X')
    expect(json).toContain('4 mi away')
    expect(json).toContain('FEMA')
    expect(json).toContain('Bulk mayonnaise proximity, obviously.')
  })

  it('renders factor detail verbatim without invented status labels', () => {
    const json = JSON.stringify(buildReconPdfDocDefinition({ address: 'x', date: new Date(), grade: grade() }))
    expect(json).toContain('Zone X')
    expect(json).toContain('4 mi away')
    expect(json).not.toContain('No concerns')
    expect(json).not.toContain('Minor concern')
    expect(json).not.toContain('Notable concern')
  })

  it('omits the caveats block when all checks are verified', () => {
    const json = JSON.stringify(buildReconPdfDocDefinition({ address: 'x', date: new Date(), grade: grade() }))
    expect(json).not.toContain('Incomplete data')
  })

  it('renders a prominent caveats block listing unavailable factors', () => {
    const g = grade({
      evidence: {
        'Flood Zone': ev('unavailable', { rule: 'Lookup failed' }),
        'Nearest Costco': ev('verified'),
      } as LocationGradeResult['evidence'],
      quality: { state: 'caution', verifiedCount: 1, cautionCount: 0, unavailableCount: 1 },
    })
    const json = JSON.stringify(buildReconPdfDocDefinition({ address: 'x', date: new Date(), grade: g }))
    expect(json).toContain('Incomplete data')
    expect(json).toContain('Flood Zone')
  })

  it('includes the map image node only when a data URL is provided', () => {
    const withMap = JSON.stringify(buildReconPdfDocDefinition({ address: 'x', date: new Date(), grade: grade(), mapDataUrl: 'data:image/png;base64,AAAA' }))
    expect(withMap).toContain('data:image/png;base64,AAAA')
    const withoutMap = JSON.stringify(buildReconPdfDocDefinition({ address: 'x', date: new Date(), grade: grade(), mapDataUrl: null }))
    expect(withoutMap).not.toContain('data:image/png;base64')
  })
})

describe('reconPdfFilename', () => {
  it('slugifies the address and appends the ISO date', () => {
    expect(reconPdfFilename('123 Main St, Denver CO', new Date('2026-09-15T12:00:00Z')))
      .toBe('LandRecon-123-main-st-denver-co-2026-09-15.pdf')
  })

  it('falls back to "report" for an empty address', () => {
    expect(reconPdfFilename('', new Date('2026-09-15T12:00:00Z'))).toBe('LandRecon-report-2026-09-15.pdf')
  })
})
