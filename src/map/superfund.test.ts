import L from 'leaflet'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchSuperfundFeatures } from './superfund'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('fetchSuperfundFeatures', () => {
  it('rejects an ArcGIS error envelope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: { code: 500 } }),
    }))

    await expect(fetchSuperfundFeatures(
      L.latLngBounds([40, -105], [40.1, -104.9]),
    )).rejects.toThrow('API error 500')
  })

  it('accepts a valid empty feature collection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ type: 'FeatureCollection', features: [] }),
    }))

    await expect(fetchSuperfundFeatures(
      L.latLngBounds([40, -105], [40.1, -104.9]),
    )).resolves.toEqual({ type: 'FeatureCollection', features: [] })
  })
})
