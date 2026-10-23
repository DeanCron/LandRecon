import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import AnalysisDetailPanel from './AnalysisDetailPanel'
import type { AnalysisResults } from '../map/analysisTypes'

function renderNoisePanel(noiseLevel: number | null): string {
  const analysisResults = {
    loading: false,
    noiseLevel,
    noiseAirport: null,
    noiseAirportCode: null,
    noiseLoading: false,
    noiseError: false,
  } as unknown as AnalysisResults
  const noop = vi.fn()
  const { container } = render(
    <AnalysisDetailPanel
      analysisDetail="noise"
      analysisResults={analysisResults}
      address="1 Main St"
      workAddress={null}
      workAddressEditing={false}
      workAddressDraft=""
      workAddressSaving={false}
      workAddressInputError={null}
      commuteLoading={false}
      commuteResult={null}
      setAnalysisDetail={noop}
      setShowScoreBreakdown={noop}
      setWorkAddressDraft={noop}
      setWorkAddressInputError={noop}
      setWorkAddressEditing={noop}
      submitWorkAddress={noop}
      removeWorkAddress={noop}
      retryCostco={noop}
    />,
  )
  return container.textContent ?? ''
}

// BTS publishes a 24-hr LAeq level, not DNL, so the panel must not label or
// measure it as DNL, nor claim FAA significance below the 65 dB threshold.
describe('AnalysisDetailPanel airport noise copy', () => {
  it('labels the level as LAeq and explains it as a 24-hour average', () => {
    const text = renderNoisePanel(65)
    expect(text).toContain('~65 dB LAeq')
    expect(text).toContain('24-hour')
    expect(text).not.toMatch(/dB DNL/)
    expect(text).not.toMatch(/measured in DNL/)
  })

  it('cites the FAA 65 dB threshold only at or above 65', () => {
    expect(renderNoisePanel(70)).toContain('65 dB threshold the FAA uses')
    expect(renderNoisePanel(60)).not.toContain('FAA uses')
  })

  it('does not call 55 dB significantly impacted', () => {
    expect(renderNoisePanel(55)).not.toMatch(/55 dB[^.]*significant/)
  })
})
