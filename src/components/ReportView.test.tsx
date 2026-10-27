import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import ReportView from './ReportView'
import AnalysisDetailPanel from './AnalysisDetailPanel'
import type { AnalysisResults } from '../map/analysisTypes'

const analysisResults = {
  loading: false,
  noiseLevel: 70,
  noiseAirport: null,
  noiseAirportCode: null,
  noiseLoading: false,
  noiseError: false,
} as unknown as AnalysisResults

const noop = vi.fn()
const props = {
  analysisDetail: 'noise' as const,
  analysisResults,
  address: '1 Main St',
  workAddress: null,
  workAddressEditing: false,
  workAddressDraft: '',
  workAddressSaving: false,
  workAddressInputError: null,
  commuteLoading: false,
  commuteResult: null,
  setWorkAddressDraft: noop,
  setWorkAddressInputError: noop,
  setWorkAddressEditing: noop,
  submitWorkAddress: noop,
  removeWorkAddress: noop,
  retryCostco: noop,
}

describe('ReportView', () => {
  it('renders the selected detail body', () => {
    const { container } = render(<ReportView {...props} />)
    expect(container.textContent).toContain('65 dB threshold the FAA uses')
  })

  it('renders nothing for a null detail', () => {
    const { container } = render(<ReportView {...props} analysisDetail={null} />)
    expect(container.textContent).toBe('')
  })

  it('renders identical body content inside AnalysisDetailPanel', () => {
    const standalone = render(<ReportView {...props} />).container.textContent
    const panel = render(
      <AnalysisDetailPanel {...props} setAnalysisDetail={noop} setShowScoreBreakdown={noop} />,
    ).container.querySelector('.analysis-popout-body')
    expect(panel?.textContent).toBe(standalone)
  })
})
