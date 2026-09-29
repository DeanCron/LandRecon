import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import HomePage from './HomePage'

const mocks = vi.hoisted(() => ({ locate: vi.fn(), cancel: vi.fn() }))
vi.mock('../hooks/useCurrentLocation', () => ({
  useCurrentLocation: () => ({ ...mocks, locating: false, error: null }),
}))
vi.mock('./mapPageLoader', () => ({ prefetchMapAnalysis: vi.fn(), prefetchMapPage: vi.fn() }))
afterEach(() => { localStorage.clear(); vi.clearAllMocks() })

function Destination() {
  return <pre data-testid="target">{JSON.stringify(useLocation().state)}</pre>
}

it('opens a GPS report without converting the fix to an address search', async () => {
  const fix = { kind: 'gps', lat: 47.61, lng: -122.33, accuracy: 18, capturedAt: 1790680000000, label: 'Nearby' }
  mocks.locate.mockResolvedValue(fix)
  render(<MemoryRouter><Routes>
    <Route path="/" element={<HomePage />} />
    <Route path="/map" element={<Destination />} />
  </Routes></MemoryRouter>)
  expect(mocks.locate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Score my location' }))
  expect(await screen.findByTestId('target')).toHaveTextContent('"landReconGps"')
  expect(screen.getByTestId('target')).toHaveTextContent('"lat":47.61')
  expect(localStorage.getItem('lr_recent_searches')).toBeNull()
})
