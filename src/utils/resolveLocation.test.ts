import { afterEach, expect, it, vi } from 'vitest'
import { resolveLocation } from './resolveLocation'
const gps = { kind: 'gps' as const, lat: 47.610123, lng: -122.33123, accuracy: 25, capturedAt: 1790680000000 }
afterEach(() => vi.unstubAllGlobals())

it('analyzes the original GPS point rather than the nearby address', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    addresses: [{ position: '47.9,-122.9', address: { countryCode: 'US', freeformAddress: 'Nearby' } }],
  })))
  vi.stubGlobal('fetch', fetchMock)
  const point = await resolveLocation('Nearby', gps, 'test-key', new AbortController().signal)
  expect(point).toMatchObject({ lat: gps.lat, lng: gps.lng })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock.mock.calls[0][0]).toContain('/reverseGeocode/')
})

it('preserves forward geocoding for address searches', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    results: [{ position: { lat: 40, lon: -75 } }],
  }))))
  expect(await resolveLocation('Address', null, 'test-key', new AbortController().signal)).toEqual({ lat: 40, lng: -75 })
})
