import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getZxy: vi.fn(),
}))

vi.mock('pmtiles', () => ({
  PMTiles: class {
    getZxy(...args: unknown[]) {
      return mocks.getZxy(...args)
    }
  },
}))

vi.mock('protomaps-leaflet', () => ({
  leafletLayer: vi.fn(),
  PolygonSymbolizer: class {},
}))

import { queryNoiseLevelAtPoint } from './airportNoise'

beforeEach(() => {
  mocks.getZxy.mockReset()
})

describe('queryNoiseLevelAtPoint', () => {
  it('propagates PMTiles failures instead of reporting a clear result', async () => {
    mocks.getZxy.mockRejectedValueOnce(new Error('PMTiles unavailable'))

    await expect(queryNoiseLevelAtPoint('/noise.pmtiles', 40, -75))
      .rejects.toThrow('PMTiles unavailable')
  })

  it('returns null when the archive has no tile for the point', async () => {
    mocks.getZxy.mockResolvedValueOnce(undefined)

    await expect(queryNoiseLevelAtPoint('/missing.pmtiles', 40, -75))
      .resolves.toBeNull()
  })
})
