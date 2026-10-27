import { afterEach, describe, expect, it, vi } from 'vitest'
import { getGoogleMapsKey } from './runtimeConfig'

describe('getGoogleMapsKey', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('picks up the public VITE_GOOGLE_MAPS_KEY build-time value', () => {
    vi.stubEnv('VITE_GOOGLE_MAPS_KEY', 'browser-key')
    expect(getGoogleMapsKey()).toBe('browser-key')
  })

  it('falls back to the server-only GOOGLE_MAPS_API_KEY', () => {
    vi.stubEnv('VITE_GOOGLE_MAPS_KEY', '')
    vi.stubEnv('GOOGLE_MAPS_API_KEY', 'server-key')
    expect(getGoogleMapsKey()).toBe('server-key')
  })
})
