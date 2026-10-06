import { describe, expect, it } from 'vitest'
import L from 'leaflet'
import { addLoadedRegion, isRegionLoaded, MAX_LOADED_REGIONS } from './loadedRegions'

const box = (s: number, w: number, n: number, e: number) => L.latLngBounds([s, w], [n, e])

describe('loadedRegions', () => {
  it('reports nothing loaded for null', () => {
    expect(isRegionLoaded(null, box(0, 0, 1, 1))).toBe(false)
  })

  it('skips a viewport fully inside a loaded region', () => {
    const regions = addLoadedRegion(null, box(40, -75, 42, -73))
    expect(isRegionLoaded(regions, box(40.5, -74.5, 41, -74))).toBe(true)
  })

  it('does not treat the gap between two distant loads as loaded', () => {
    let regions = addLoadedRegion(null, box(40, -75, 41, -73)) // NYC-ish
    regions = addLoadedRegion(regions, box(33, -119, 35, -117)) // LA-ish
    expect(isRegionLoaded(regions, box(41, -88, 42, -87))).toBe(false) // Chicago-ish
    expect(isRegionLoaded(regions, box(40.2, -74.5, 40.8, -73.5))).toBe(true)
    expect(isRegionLoaded(regions, box(33.5, -118.5, 34.5, -117.5))).toBe(true)
  })

  it('does not mutate the previous list', () => {
    const first = addLoadedRegion(null, box(0, 0, 1, 1))
    addLoadedRegion(first, box(5, 5, 6, 6))
    expect(first).toHaveLength(1)
  })

  it('drops regions fully covered by a new, larger region', () => {
    let regions = addLoadedRegion(null, box(0, 0, 1, 1))
    regions = addLoadedRegion(regions, box(2, 2, 3, 3))
    regions = addLoadedRegion(regions, box(-1, -1, 1.5, 1.5))
    expect(regions).toHaveLength(2)
  })

  it('caps the list, evicting the oldest region', () => {
    let regions = addLoadedRegion(null, box(0, 0, 0.5, 0.5))
    for (let i = 1; i <= MAX_LOADED_REGIONS; i++) regions = addLoadedRegion(regions, box(i, i, i + 0.5, i + 0.5))
    expect(regions).toHaveLength(MAX_LOADED_REGIONS)
    expect(isRegionLoaded(regions, box(0.1, 0.1, 0.2, 0.2))).toBe(false)
    expect(isRegionLoaded(regions, box(1.1, 1.1, 1.2, 1.2))).toBe(true)
  })
})
