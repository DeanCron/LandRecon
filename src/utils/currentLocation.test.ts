import { afterEach, describe, expect, it, vi } from 'vitest'
import { confirmUsGpsTarget, requestGpsPosition } from './currentLocation'

const fix = { kind: 'gps' as const, lat: 47.61, lng: -122.33, accuracy: 18, capturedAt: 1790680000000 }
const signal = () => new AbortController().signal

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('current location', () => {
  it('requests a fresh high-accuracy fix and preserves the measured point', async () => {
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({
      coords: { latitude: fix.lat, longitude: fix.lng, accuracy: fix.accuracy },
      timestamp: fix.capturedAt,
    } as GeolocationPosition))
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } })
    expect(await requestGpsPosition(signal())).toEqual(fix)
    expect(getCurrentPosition.mock.calls[0]).toHaveLength(3)
    expect(getCurrentPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 })
  })

  it('never replaces GPS coordinates with reverse-geocoded coordinates', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      addresses: [{ position: '48,-123', address: { countryCode: 'US', freeformAddress: 'Nearby street' } }],
    }))))
    expect(await confirmUsGpsTarget(fix, 'test-key', signal())).toEqual({ ...fix, label: 'Nearby street' })
  })

  it('accepts a confirmed US area without a street address', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      addresses: [{ address: { countryCode: 'US' } }],
    }))))
    expect(await confirmUsGpsTarget({ ...fix, label: 'Old label' }, 'test-key', signal())).toEqual(fix)
  })

  it.each(['CA', undefined])('refuses unsupported or unconfirmed coverage (%s)', async (countryCode) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      addresses: [{ address: { countryCode, freeformAddress: 'Somewhere' } }],
    }))))
    await expect(confirmUsGpsTarget(fix, 'test-key', signal())).rejects.toThrow(/US|coverage/)
  })

  it('reports provider HTTP errors rather than unsupported country', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })))
    await expect(confirmUsGpsTarget(fix, 'test-key', signal())).rejects.toThrow(/confirm|lookup/i)
  })

  it('reports unsupported geolocation and denied permission', async () => {
    vi.stubGlobal('navigator', {})
    await expect(requestGpsPosition(signal())).rejects.toThrow(/support/)
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: (_: unknown, fail: PositionErrorCallback) => fail({ code: 1 } as GeolocationPositionError) } })
    await expect(requestGpsPosition(signal())).rejects.toThrow(/blocked/)
  })

  it('bounds browser and provider waits even when callbacks never arrive', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: vi.fn() } })
    const request = expect(requestGpsPosition(signal())).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(15000)
    await request
    vi.stubGlobal('fetch', (_: unknown, options: RequestInit) => new Promise((_, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason))
    }))
    const lookup = expect(confirmUsGpsTarget(fix, 'test-key', signal())).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(10000)
    await lookup
  })

  it('aborts an outstanding browser request', async () => {
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: vi.fn() } })
    const controller = new AbortController()
    const request = requestGpsPosition(controller.signal)
    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  })
})
