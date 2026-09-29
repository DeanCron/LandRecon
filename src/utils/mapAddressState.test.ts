import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAP_ADDRESS_STATE_KEY,
  rememberMapAddress,
  rememberMapGps,
  resolveMapAddress,
  resolveMapGps,
  resolveMapLocationError,
  scrubMapAddressBeforeAnalytics,
} from './mapAddressState'

beforeEach(() => {
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('map address navigation state', () => {
  it('scrubs GPS metadata and preserves the exact fix and router state', () => {
    window.history.replaceState({ key: 'router', usr: { other: true } }, '',
      '/map?lat=47.61&lng=-122.33&accuracy=18&capturedAt=1790680000000&locationLabel=Nearby&layers=noise#report')
    scrubMapAddressBeforeAnalytics()
    expect(window.location.search).toBe('?layers=noise')
    expect(window.location.hash).toBe('#report')
    expect(window.history.state.key).toBe('router')
    expect(window.history.state.usr.other).toBe(true)
    const fix = { kind: 'gps', lat: 47.61, lng: -122.33, accuracy: 18, capturedAt: 1790680000000, label: 'Nearby' }
    expect(resolveMapGps(window.history.state.usr)).toEqual(fix)
    expect(resolveMapGps(rememberMapGps(fix as Parameters<typeof rememberMapGps>[0]))).toEqual(fix)
  })

  it('scrubs invalid GPS links and marks them as errors rather than falling back to an address', () => {
    window.history.replaceState(null, '', '/map?address=Nearby&lat=nope&lng=-122&locationLabel=Private')
    scrubMapAddressBeforeAnalytics()
    expect(window.location.search).toBe('')
    expect(resolveMapGps(window.history.state.usr)).toBeNull()
    expect(resolveMapAddress(window.history.state.usr)).toBe('')
    expect(resolveMapLocationError(window.history.state.usr)).toContain('invalid')
  })

  it('a new address link replaces stale GPS route state', () => {
    const gps = { kind: 'gps' as const, lat: 47, lng: -122, accuracy: 5, capturedAt: 1790680000000 }
    window.history.replaceState({ usr: rememberMapGps(gps) }, '', '/map?address=New%20address')
    scrubMapAddressBeforeAnalytics()
    expect(resolveMapGps(window.history.state.usr)).toBeNull()
    expect(resolveMapAddress(window.history.state.usr)).toBe('New address')
  })

  it('scrubs a shared address before analytics while preserving other options', () => {
    window.history.replaceState(
      { existing: true },
      '',
      '/map?address=1500%20River%20Road%20West&layers=noise#report',
    )

    scrubMapAddressBeforeAnalytics()

    expect(window.location.pathname).toBe('/map')
    expect(window.location.search).toBe('?layers=noise')
    expect(window.location.hash).toBe('#report')
    expect(window.history.state.existing).toBe(true)
    expect(window.history.state.usr[MAP_ADDRESS_STATE_KEY]).toBe('1500 River Road West')
    expect(resolveMapAddress(window.history.state.usr)).toBe('1500 River Road West')
  })

  it('normalizes route state and rejects missing values', () => {
    expect(rememberMapAddress('  History address  ')).toEqual({
      [MAP_ADDRESS_STATE_KEY]: 'History address',
    })
    expect(resolveMapAddress({ [MAP_ADDRESS_STATE_KEY]: ' History address ' })).toBe('History address')
    expect(resolveMapAddress(null)).toBe('')
  })
})
