import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { FactorEvidence as FactorEvidenceData } from '../map/evidence'
import { FactorEvidence } from './FactorEvidence'

afterEach(cleanup)

const verified: FactorEvidenceData = {
  state: 'verified',
  source: 'FEMA National Flood Hazard Layer',
  rule: 'Point lookup at the searched address',
  whyItMatters: 'Flood exposure can affect insurance, access, and property risk.',
}

describe('FactorEvidence', () => {
  it('shows source and explanation for a verified factor', () => {
    render(<FactorEvidence label="Flood Zone" evidence={verified} />)
    expect(screen.getByText(/Source:/i)).toBeInTheDocument()
    expect(screen.getByText(/Why it matters/i)).toBeInTheDocument()
  })

  it('labels unavailable evidence explicitly', () => {
    render(
      <FactorEvidence
        label="Flood Zone"
        evidence={{
          ...verified,
          state: 'unavailable',
          rule: 'Point lookup did not resolve',
        }}
      />,
    )
    expect(screen.getByText(/Data unavailable/i)).toBeInTheDocument()
  })

  it('labels caution evidence with its own distinct state label', () => {
    render(
      <FactorEvidence
        label="Flood Zone"
        evidence={{
          ...verified,
          state: 'caution',
          rule: 'Partial coverage at the searched address',
          freshness: 'Updated 2024',
        }}
      />,
    )
    expect(screen.getByText(/Limited data/i)).toBeInTheDocument()
    expect(screen.getByText(/Updated 2024/i)).toBeInTheDocument()
  })

  it('renders the legacy message when evidence is omitted', () => {
    render(<FactorEvidence label="Flood Zone" />)
    expect(
      screen.getByText(
        'Evidence details unavailable for this saved analysis. Re-analyze to refresh.',
      ),
    ).toBeInTheDocument()
  })
})
