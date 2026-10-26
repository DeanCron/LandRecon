import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ReportPage from './ReportPage'
import { writeAnalysisCache } from '../map/analysisCache'
import { analysisResultsFromCache } from '../map/reportFromCache'

const gpsQuery = '?lat=47.61&lng=-122.33&accuracy=18&capturedAt=1790680000000'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ReportPage />
    </MemoryRouter>,
  )
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('ReportPage', () => {
  it('prompts for a location when none is given', () => {
    renderAt('/report')
    expect(screen.getByText('Choose a property to see its printable report.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Search for an address' })).toBeTruthy()
  })

  it('links to the map when there is no cached analysis', () => {
    renderAt(`/report${gpsQuery}`)
    expect(screen.getByText(/No recent analysis found/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Analyze this location on the map' })).toBeTruthy()
    expect((document.querySelector('.report-page-print') as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders print-ready sections and disclaimer from a cached analysis', () => {
    writeAnalysisCache(47.61, -122.33, {
      noiseLevel: 70,
      noiseAirport: null,
      noiseAirportCode: null,
      superfunds: [],
      costco: null,
      costcoNearby: [],
      costcoNearestBeyond: null,
      costcoError: false,
      dataCenters: [],
      nearestER: null,
      erError: false,
      crowdMagnets: [],
      nearestRailroad: null,
      floodZone: null,
      wildfireHazard: null,
      seismicHazard: null,
      tornadoHazard: null,
    })
    const { container } = renderAt(`/report${gpsQuery}`)
    expect(screen.getByRole('heading', { name: 'Score Breakdown' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Airport Noise' })).toBeTruthy()
    expect(container.textContent).toContain('65 dB threshold the FAA uses')
    expect(container.textContent).toContain('not a verified property boundary')
    expect((document.querySelector('.report-page-print') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('analysisResultsFromCache', () => {
  it('marks absent optional factors as errored so they are not reported as clear', () => {
    const results = analysisResultsFromCache({
      superfunds: [], costco: null, costcoNearby: [], costcoNearestBeyond: null, costcoError: false,
      dataCenters: [], nearestER: null, erError: false,
    })
    expect(results.loading).toBe(false)
    expect(results.noiseError).toBe(true)
    expect(results.floodError).toBe(true)
    expect(results.crowdError).toBe(true)
  })
})
