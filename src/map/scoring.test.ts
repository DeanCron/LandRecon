import { describe, it, expect } from 'vitest'
import {
  costcoSeverity,
  noiseSeverity,
  superfundSeverity,
  dataCenterSeverity,
  crowdMagnetsSeverity,
  erSeverity,
  computeLocationGrade,
} from './scoring'

describe('severity helpers', () => {
  it('costcoSeverity buckets by distance', () => {
    expect(costcoSeverity(5)).toBe('good')
    expect(costcoSeverity(30)).toBe('good')
    expect(costcoSeverity(31)).toBe('warning')
    expect(costcoSeverity(50)).toBe('warning')
    expect(costcoSeverity(51)).toBe('danger')
  })

  it('noiseSeverity flags 65 dB+ as danger', () => {
    expect(noiseSeverity(50)).toBe('warning')
    expect(noiseSeverity(64)).toBe('warning')
    expect(noiseSeverity(65)).toBe('danger')
  })

  it('superfundSeverity distinguishes active from deleted', () => {
    expect(superfundSeverity([])).toBe('clear')
    expect(superfundSeverity([{ status: 'Deleted' }])).toBe('warning')
    expect(superfundSeverity([{ status: 'Active' }])).toBe('danger')
    expect(superfundSeverity([{ status: 'Deleted' }, { status: 'Final' }])).toBe('danger')
  })

  it('dataCenterSeverity and crowdMagnetsSeverity bucket by count', () => {
    for (const fn of [dataCenterSeverity, crowdMagnetsSeverity]) {
      expect(fn(0)).toBe('clear')
      expect(fn(1)).toBe('warning')
      expect(fn(2)).toBe('warning')
      expect(fn(3)).toBe('danger')
    }
  })

  it('erSeverity treats null as danger and buckets by distance', () => {
    expect(erSeverity(null)).toBe('danger')
    expect(erSeverity(10)).toBe('clear')
    expect(erSeverity(15)).toBe('warning')
    expect(erSeverity(16)).toBe('danger')
  })
})

// A fully-clear analysis result. Helpers spread overrides onto this.
function clearResults() {
  return {
    noiseLevel: 0,
    superfunds: [] as { status: string }[],
    costco: { distanceMi: 5 },
    costcoError: false,
    costcoLoading: false,
    dataCenters: [] as unknown[],
    nearestER: { distanceMi: 2 },
    crowdMagnets: [] as unknown[],
    broadband: null,
    broadbandLoading: false,
    floodZone: null,
    floodError: false,
    floodLoading: false,
    wildfireHazard: null,
    wildfireError: false,
    wildfireLoading: false,
  }
}

describe('computeLocationGrade (tier-normalized)', () => {
  it('an all-clear location scores A at 100%', () => {
    const g = computeLocationGrade(clearResults())
    expect(g.pct).toBeCloseTo(1, 5)
    expect(g.letter).toBe('A')
  })

  it('one safety danger (flood) is a modest drop within the safety tier', () => {
    const g = computeLocationGrade({
      ...clearResults(),
      floodZone: { bucket: 'high', zone: 'AE', label: 'High risk' },
    })
    // 1 of 5 safety items maxed → safety fraction 0.2 → 0.6 * 0.2 = 0.12 penalty
    expect(g.pct).toBeCloseTo(0.88, 5)
    expect(g.letter).toBe('B')
  })

  it('a single missing Costco only costs the 10% convenience weight', () => {
    const g = computeLocationGrade({ ...clearResults(), costco: null })
    expect(g.pct).toBeCloseTo(0.9, 5)
    expect(g.letter).toBe('A')
  })

  it('redistributes weight when a whole tier is still loading', () => {
    // Convenience (Costco) loading → its weight is dropped, so an otherwise
    // clear location still scores a clean 100%.
    const g = computeLocationGrade({ ...clearResults(), costcoLoading: true })
    expect(g.pct).toBeCloseTo(1, 5)
    expect(g.letter).toBe('A')
  })

  it('skips loading items rather than penalizing them', () => {
    const withFlood = computeLocationGrade({ ...clearResults() })
    const flagged = withFlood.breakdown.find((b) => b.label === 'Flood Zone')
    expect(flagged).toBeDefined()
    const loading = computeLocationGrade({ ...clearResults(), floodLoading: true })
    expect(loading.breakdown.find((b) => b.label === 'Flood Zone')).toBeUndefined()
  })

  it('stacked safety dangers push the grade down to C or worse', () => {
    const g = computeLocationGrade({
      ...clearResults(),
      noiseLevel: 70,
      floodZone: { bucket: 'coastal', zone: 'VE', label: 'Coastal' },
      wildfireHazard: { value: 5, label: 'Very high' },
    })
    expect(g.pct).toBeLessThan(0.75)
    expect(['C', 'D', 'F']).toContain(g.letter)
  })
})
