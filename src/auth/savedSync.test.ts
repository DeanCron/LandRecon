import { describe, expect, it } from 'vitest'
import { mergeSaved } from './savedSync'
import { MAX_SAVED_ANALYSES, type SavedAnalysis } from '../map/savedAnalyses'

const mk = (address: string): SavedAnalysis => ({
  address, date: 'd', grade: 'A', gradeColor: '#000', pct: 90, noiseLevel: null, noiseAirport: null,
  superfundCount: 0, superfundActive: 0, costcoMi: null, dataCenterCount: 0,
})

describe('mergeSaved', () => {
  it('de-dupes by location and keeps the primary entry', () => {
    const a = mk('1 Main St')
    const out = mergeSaved([a], [mk('1 Main St'), mk('2 Oak Ave')])
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(a)
  })

  it('caps at the saved limit', () => {
    const many = Array.from({ length: 8 }, (_, i) => mk(`${i} Rd`))
    expect(mergeSaved(many.slice(0, 3), many.slice(3))).toHaveLength(MAX_SAVED_ANALYSES)
  })
})
