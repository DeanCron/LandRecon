import { describe, it, expect, vi } from 'vitest'
import { buildStaticMapUrl, fetchStaticMapDataUrl } from './staticMap'

describe('buildStaticMapUrl', () => {
  it('encodes center, zoom, size, scale, marker, and key', () => {
    const url = buildStaticMapUrl({ lat: 40.1, lng: -74.2, key: 'KEY123' })
    expect(url).toContain('https://maps.googleapis.com/maps/api/staticmap')
    expect(url).toContain('center=40.1%2C-74.2')
    expect(url).toContain('markers=')
    expect(url).toContain('40.1%2C-74.2')
    expect(url).toContain('zoom=15')
    expect(url).toContain('size=640x320')
    expect(url).toContain('scale=2')
    expect(url).toContain('key=KEY123')
  })

  it('honors explicit zoom and size overrides', () => {
    const url = buildStaticMapUrl({ lat: 1, lng: 2, zoom: 12, width: 320, height: 200, scale: 1, key: 'K' })
    expect(url).toContain('zoom=12')
    expect(url).toContain('size=320x200')
    expect(url).toContain('scale=1')
  })
})

describe('fetchStaticMapDataUrl', () => {
  it('returns null when no key is provided (without fetching)', async () => {
    const fetchImpl = vi.fn()
    const result = await fetchStaticMapDataUrl({ lat: 1, lng: 2, key: '' }, { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('resolves to a base64 PNG data URL on success', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]).buffer
    const fetchImpl = vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes })) as unknown as typeof fetch
    const result = await fetchStaticMapDataUrl({ lat: 1, lng: 2, key: 'K' }, { fetchImpl })
    expect(result).toMatch(/^data:image\/png;base64,/)
  })

  it('returns null on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch
    const result = await fetchStaticMapDataUrl({ lat: 1, lng: 2, key: 'K' }, { fetchImpl })
    expect(result).toBeNull()
  })

  it('returns null when fetch throws', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network') }) as unknown as typeof fetch
    const result = await fetchStaticMapDataUrl({ lat: 1, lng: 2, key: 'K' }, { fetchImpl })
    expect(result).toBeNull()
  })

  it('returns null when fetch setup throws synchronously', async () => {
    const fetchImpl = (() => { throw new Error('sync boom') }) as unknown as typeof fetch
    const result = await fetchStaticMapDataUrl({ lat: 1, lng: 2, key: 'K' }, { fetchImpl })
    expect(result).toBeNull()
  })
})
