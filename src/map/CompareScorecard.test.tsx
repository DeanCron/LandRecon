import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import CompareScorecard from './CompareScorecard'
import type { SavedAnalysis } from './savedAnalyses'

it('reanalyzes the full saved GPS target, not its nearby-address label', () => {
  const saved: SavedAnalysis = {
    address: 'Nearby', date: '2026-09-29', grade: 'A', gradeColor: 'green', pct: 1,
    noiseLevel: null, noiseAirport: null, superfundCount: 0, superfundActive: 0,
    costcoMi: null, dataCenterCount: 0,
    gps: { kind: 'gps', lat: 47, lng: -122, accuracy: 12, capturedAt: 1790680000000 },
  }
  const reanalyze = vi.fn()
  render(<CompareScorecard saved={[saved]} onRemove={vi.fn()} onReanalyze={reanalyze} />)
  fireEvent.click(screen.getByRole('button', { name: 'Re-analyze' }))
  expect(reanalyze).toHaveBeenCalledWith(saved)
})
