import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ReportPage from './ReportPage'
import { writeAnalysisCache } from '../map/analysisCache'
import { analysisResultsFromCache } from '../map/reportFromCache'
import { rememberGeocode } from '../utils/geocodeCache'

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

describe('ReportPage address visits', () => {
  it('never geocodes and asks to run the address on the map first', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    renderAt('/report?address=1%20Main%20St%2C%20Town')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(screen.getByText(/Run this address on the map first/)).toBeTruthy()
    vi.unstubAllGlobals()
  })

  it('uses coordinates remembered from a prior map geocode', () => {
    writeAnalysisCache(40, -100, {
      noiseLevel: 70, noiseAirport: null, noiseAirportCode: null, superfunds: [], costco: null,
      costcoNearby: [], costcoNearestBeyond: null, costcoError: false, dataCenters: [], nearestER: null,
      erError: false, crowdMagnets: [], nearestRailroad: null, floodZone: null, wildfireHazard: null,
      seismicHazard: null, tornadoHazard: null,
    })
    rememberGeocode('1 Main St, Town', 40, -100)
    renderAt('/report?address=1%20main%20st%2C%20town')
    expect(screen.getByRole('heading', { name: 'Score Breakdown' })).toBeTruthy()
  })

  it('does not throw on a partial cached payload', () => {
    writeAnalysisCache(41, -101, {} as never)
    rememberGeocode('2 Main St, Town', 41, -101)
    expect(() => renderAt('/report?address=2%20Main%20St%2C%20Town')).not.toThrow()
    expect(document.querySelector('.report-page')).toBeTruthy()
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
