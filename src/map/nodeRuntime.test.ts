// @vitest-environment node
import { describe, expect, it, vi, afterEach } from 'vitest'
import { boundsContains, haversineMeters, makeBounds, pointInConus } from './geo'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('runtime-neutral scoring modules (Node)', () => {
  it('has no browser globals', () => {
    expect(typeof window).toBe('undefined')
    expect(typeof localStorage).toBe('undefined')
  })

  it('imports scoring and the point-fetch modules without a DOM or Leaflet', async () => {
    const scoring = await import('./scoring')
    await import('./flood')
    await import('./wildfire')
    await import('./seismic')
    await import('./tornado')
    await import('./crowd')
    await import('./railroad')
    await import('./costco')
    await import('./broadband')
    expect(scoring.getExpFlag('LR_DEBUG', true)).toBe(true)
    expect(scoring.costcoSeverity(10)).toBe('good')
  })

  it('reads the Google key from the server-only env var', async () => {
    vi.stubEnv('GOOGLE_MAPS_API_KEY', 'server-key')
    const { getGoogleMapsKey, getApiBaseUrl, getOverpassEndpoints } = await import('./runtimeConfig')
    expect(getGoogleMapsKey()).toBe('server-key')
    expect(getApiBaseUrl()).toBe('')
    expect(getOverpassEndpoints()[0]).toMatch(/^https:/)
  })

  it('honours server overrides for API base URL and Overpass mirrors', async () => {
    vi.stubEnv('LANDRECON_API_BASE_URL', 'http://localhost:3001/')
    vi.stubEnv('OVERPASS_ENDPOINTS', 'http://a/x, http://b/y')
    const { getApiBaseUrl, getOverpassEndpoints } = await import('./runtimeConfig')
    expect(getApiBaseUrl()).toBe('http://localhost:3001')
    expect(getOverpassEndpoints()).toEqual(['http://a/x', 'http://b/y'])
  })

  it('fetches broadband through the configured base URL', async () => {
    vi.stubEnv('LANDRECON_API_BASE_URL', 'http://api.test')
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: 1 }) }))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchBroadband } = await import('./broadband')
    await fetchBroadband(1, 2)
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/broadband?lat=1&lng=2', { signal: undefined })
  })

  it('falls back to live Overpass outside CONUS for railroad', async () => {
    vi.stubEnv('OVERPASS_ENDPOINTS', 'http://overpass.test/api')
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ elements: [] }),
      text: async () => '{"elements":[]}',
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchNearestRailroad } = await import('./railroad')
    const result = await fetchNearestRailroad({ lat: 51.5, lng: -0.1 })
    expect(result).toBeNull()
    expect(String((fetchMock.mock.calls as unknown[][])[0][0])).toContain('overpass.test')
  })
})

describe('geo helpers', () => {
  it('matches Leaflet distance and containment semantics', () => {
    expect(haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(111194.9, 0)
    const b = makeBounds(10, 20, 30, 40)
    expect(b.getCenter()).toEqual({ lat: 20, lng: 30 })
    expect(boundsContains(b, { lat: 10, lng: 40 })).toBe(true)
    expect(boundsContains(b, { lat: 9.9, lng: 30 })).toBe(false)
  })

  it('detects CONUS', () => {
    expect(pointInConus({ lat: 39, lng: -98 })).toBe(true)
    expect(pointInConus({ lat: 51.5, lng: -0.1 })).toBe(false)
  })
})
