import { describe, expect, it } from 'vitest'
import { summarizeReportQuality, type FactorEvidence } from './evidence'

const evidence = (state: FactorEvidence['state']): FactorEvidence => ({
  state,
  source: 'Test source',
  rule: 'Test rule',
  whyItMatters: 'Test explanation',
})

describe('summarizeReportQuality', () => {
  it('counts states and marks mixed evidence as caution', () => {
    expect(summarizeReportQuality([evidence('verified'), evidence('caution'), evidence('unavailable')]))
      .toEqual({ state: 'caution', verifiedCount: 1, cautionCount: 1, unavailableCount: 1 })
  })

  it('marks an all-verified report verified', () => {
    expect(summarizeReportQuality([evidence('verified'), evidence('verified')]).state).toBe('verified')
  })

  it('marks an empty report unavailable', () => {
    expect(summarizeReportQuality([]).state).toBe('unavailable')
  })
})
