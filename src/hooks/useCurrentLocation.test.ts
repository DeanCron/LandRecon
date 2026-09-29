import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useCurrentLocation } from './useCurrentLocation'

afterEach(() => vi.unstubAllGlobals())

it('requests only on demand and ignores a late fix after cancellation', async () => {
  let success: PositionCallback | undefined
  const request = vi.fn((callback: PositionCallback) => { success = callback })
  const fetchMock = vi.fn()
  vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: request } })
  vi.stubGlobal('fetch', fetchMock)
  const { result } = renderHook(() => useCurrentLocation('test-key'))
  expect(request).not.toHaveBeenCalled()
  let pending: Promise<unknown>
  act(() => { pending = result.current.locate() })
  expect(result.current.locating).toBe(true)
  act(() => result.current.cancel())
  success?.({ coords: { latitude: 47, longitude: -122, accuracy: 12 }, timestamp: Date.now() } as GeolocationPosition)
  await act(async () => { expect(await pending).toBeNull() })
  expect(fetchMock).not.toHaveBeenCalled()
  expect(result.current.locating).toBe(false)
  expect(result.current.error).toBeNull()
})

it('restores controls and exposes an actionable error on denial', async () => {
  vi.stubGlobal('navigator', { geolocation: {
    getCurrentPosition: (_: unknown, fail: PositionErrorCallback) => fail({ code: 1 } as GeolocationPositionError),
  } })
  const { result } = renderHook(() => useCurrentLocation('test-key'))
  await act(async () => { expect(await result.current.locate()).toBeNull() })
  expect(result.current.locating).toBe(false)
  expect(result.current.error).toContain('blocked')
})
