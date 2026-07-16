import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import {
  loadSavedWorkAddress,
  saveWorkAddress,
  clearSavedWorkAddress,
  geocodeWorkAddress,
  fetchCommute,
  nextWeekdayNineAM,
  formatCommuteMinutes,
  commuteSeverity,
} from './commute'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('work address persistence', () => {
  it('returns null when nothing is saved', () => {
    expect(loadSavedWorkAddress()).toBeNull()
  })

  it('round-trips a saved work address', () => {
    saveWorkAddress({ address: '1 Infinite Loop, Cupertino, CA', lat: 37.33, lng: -122.03 })
    expect(loadSavedWorkAddress()).toEqual({ address: '1 Infinite Loop, Cupertino, CA', lat: 37.33, lng: -122.03 })
  })

  it('clears a saved work address', () => {
    saveWorkAddress({ address: 'x', lat: 1, lng: 2 })
    clearSavedWorkAddress()
    expect(loadSavedWorkAddress()).toBeNull()
  })

  it('ignores malformed stored JSON', () => {
    window.localStorage.setItem('lr_work_address', '{not json')
    expect(loadSavedWorkAddress()).toBeNull()
  })

  it('ignores a stored value missing required fields', () => {
    window.localStorage.setItem('lr_work_address', JSON.stringify({ address: 'x' }))
    expect(loadSavedWorkAddress()).toBeNull()
  })
})

describe('geocodeWorkAddress', () => {
  it('returns null for an empty address without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await geocodeWorkAddress('   ', 'key')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null when there is no API key', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await geocodeWorkAddress('123 Main St', '')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('parses the first geocode result', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ address: { freeformAddress: '123 Main St, Springfield, IL' }, position: { lat: 39.8, lon: -89.6 } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await geocodeWorkAddress('123 Main St', 'key')).toEqual({
      address: '123 Main St, Springfield, IL',
      lat: 39.8,
      lng: -89.6,
    })
  })

  it('returns null when there are no results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) }))
    expect(await geocodeWorkAddress('nowhere', 'key')).toBeNull()
  })

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    await expect(geocodeWorkAddress('123 Main St', 'key')).rejects.toThrow('HTTP 500')
  })
})

describe('nextWeekdayNineAM', () => {
  it('stays on the same day when before 9am on a weekday', () => {
    const from = new Date(2026, 0, 5, 7, 0, 0) // Monday, Jan 5 2026, 7am
    const result = nextWeekdayNineAM(from)
    expect(result.getDay()).toBe(1)
    expect(result.getDate()).toBe(5)
    expect(result.getHours()).toBe(9)
  })

  it('rolls to the next day when already past 9am', () => {
    const from = new Date(2026, 0, 5, 14, 0, 0) // Monday 2pm
    const result = nextWeekdayNineAM(from)
    expect(result.getDate()).toBe(6)
    expect(result.getDay()).toBe(2)
  })

  it('skips the weekend when Friday afternoon rolls to Monday', () => {
    const from = new Date(2026, 0, 9, 14, 0, 0) // Friday 2pm
    const result = nextWeekdayNineAM(from)
    expect(result.getDay()).toBe(1) // Monday
    expect(result.getDate()).toBe(12)
  })
})

describe('fetchCommute', () => {
  const routeResponse = (minutes: number, meters: number) => ({
    ok: true,
    json: async () => ({
      routes: [{
        summary: { travelTimeInSeconds: minutes * 60, lengthInMeters: meters },
        legs: [{ points: [{ latitude: 1, longitude: 2 }, { latitude: 3, longitude: 4 }] }],
      }],
    }),
  })

  it('returns null when there is no API key', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchCommute({ originLat: 1, originLng: 2, destLat: 3, destLng: 4, apiKey: '' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('combines the live and typical routing calls', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(routeResponse(20, 16093.4))
      .mockResolvedValueOnce(routeResponse(35, 16093.4))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchCommute({ originLat: 1, originLng: 2, destLat: 3, destLng: 4, apiKey: 'key' })
    expect(result).toEqual({
      distanceMi: 10,
      liveMinutes: 20,
      typicalMinutes: 35,
      route: [[1, 2], [3, 4]],
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toContain('traffic=true')
    expect(fetchMock.mock.calls[1][0]).toContain('arriveAt=')
  })

  it('falls back to the live minutes when the typical call fails to resolve', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(routeResponse(20, 16093.4))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ routes: [] }) })
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchCommute({ originLat: 1, originLng: 2, destLat: 3, destLng: 4, apiKey: 'key' })
    expect(result?.typicalMinutes).toBe(20)
  })

  it('returns null when the live call has no route', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ routes: [] }) })
      .mockResolvedValueOnce(routeResponse(35, 16093.4))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchCommute({ originLat: 1, originLng: 2, destLat: 3, destLng: 4, apiKey: 'key' })
    expect(result).toBeNull()
  })

  it('throws on a non-ok routing response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    await expect(fetchCommute({ originLat: 1, originLng: 2, destLat: 3, destLng: 4, apiKey: 'key' })).rejects.toThrow('HTTP 503')
  })
})

describe('formatCommuteMinutes', () => {
  it('formats sub-hour durations as minutes', () => {
    expect(formatCommuteMinutes(45)).toBe('45 min')
  })

  it('formats exact hours without minutes', () => {
    expect(formatCommuteMinutes(120)).toBe('2h')
  })

  it('formats hours plus minutes', () => {
    expect(formatCommuteMinutes(95)).toBe('1h 35m')
  })
})

describe('commuteSeverity', () => {
  it('is good for short commutes', () => {
    expect(commuteSeverity(15)).toBe('good')
  })

  it('is warning for moderate commutes', () => {
    expect(commuteSeverity(40)).toBe('warning')
  })

  it('is danger for long commutes', () => {
    expect(commuteSeverity(75)).toBe('danger')
  })
})

beforeEach(() => {
  window.localStorage.clear()
})
