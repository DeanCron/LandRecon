import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
// protomaps-leaflet reads Leaflet's global `L`, which the app gets from MapPage.
import 'leaflet'
import type { View } from 'protomaps-leaflet'
import { createNoiseLayer, NOISE_MAX_ZOOM } from './airportNoise'

// Uses the real protomaps-leaflet (no mocks): the bug was in how its View maps
// a display tile to a data tile, which only shows up with the real library.
function noiseView(): View {
  const layer = createNoiseLayer('https://example.test/airport-noise.pmtiles') as unknown as {
    views: Map<string, View>
  }
  const [view] = [...layer.views.values()]
  return view
}

describe('createNoiseLayer overzoom', () => {
  // The layer builds a scratch canvas; jsdom has no canvas and warns about it.
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
  beforeAll(() => {
    getContext.mockReturnValue(null)
  })
  afterAll(() => {
    getContext.mockRestore()
  })

  it('never reads data tiles deeper than the archive provides', () => {
    const view = noiseView()
    for (let z = 4; z <= 22; z++) {
      const { dataTile } = view.dataTileForDisplayTile({ z, x: 0, y: 0 })
      expect(dataTile.z, `display z${z}`).toBeLessThanOrEqual(NOISE_MAX_ZOOM)
    }
  })

  it('scales the deepest data tiles up for display zooms beyond the archive', () => {
    const view = noiseView()
    const deep = view.dataTileForDisplayTile({ z: NOISE_MAX_ZOOM + 4, x: 0, y: 0 })
    const deeper = view.dataTileForDisplayTile({ z: NOISE_MAX_ZOOM + 6, x: 0, y: 0 })

    expect(deep.dataTile.z).toBe(NOISE_MAX_ZOOM)
    expect(deeper.dataTile.z).toBe(NOISE_MAX_ZOOM)
    expect(deeper.scale).toBeGreaterThan(deep.scale)
  })
})
