import { describe, it, expect, vi, beforeEach } from 'vitest'
import { classifyCrowdElement, shouldIncludeCrowdMagnet, fetchCrowdMagnets } from './crowd'
import * as overpass from './overpass'
import * as snapshots from './snapshots'
import L from 'leaflet'

describe('classifyCrowdElement', () => {
  it('maps OSM tags to crowd types', () => {
    expect(classifyCrowdElement({ boundary: 'national_park' })).toBe('park')
    expect(classifyCrowdElement({ tourism: 'theme_park' })).toBe('themepark')
    expect(classifyCrowdElement({ leisure: 'stadium' })).toBe('stadium')
    expect(classifyCrowdElement({ amenity: 'amphitheatre' })).toBe('concert')
    expect(classifyCrowdElement({ highway: 'raceway' })).toBe('raceway')
    expect(classifyCrowdElement({ leisure: 'track', sport: 'motor' })).toBe('raceway')
    expect(classifyCrowdElement({ leisure: 'track', sport: 'running' })).toBeNull()
    expect(classifyCrowdElement({ amenity: 'restaurant' })).toBeNull()
  })
})

describe('shouldIncludeCrowdMagnet', () => {
  it('keeps pro/college stadiums', () => {
    expect(shouldIncludeCrowdMagnet('stadium', {}, 'SoFi Stadium')).toBe(true)
    expect(shouldIncludeCrowdMagnet('stadium', { operator: 'University of Michigan' }, 'Michigan Stadium')).toBe(true)
  })

  it('drops school stadiums by name, tag, or operator', () => {
    expect(shouldIncludeCrowdMagnet('stadium', {}, 'Lincoln High School Stadium')).toBe(false)
    expect(shouldIncludeCrowdMagnet('stadium', { amenity: 'school' }, 'Memorial Field')).toBe(false)
    expect(shouldIncludeCrowdMagnet('stadium', { 'operator:type': 'education' }, 'District Field')).toBe(false)
    expect(shouldIncludeCrowdMagnet('stadium', { operator: 'Plano ISD' }, 'Clark Field')).toBe(false)
    expect(shouldIncludeCrowdMagnet('stadium', { building: 'school' }, 'Gymnasium')).toBe(false)
  })

  it('drops community/rec amphitheatres', () => {
    expect(shouldIncludeCrowdMagnet('concert', {}, 'Riverside Community Park Amphitheater')).toBe(false)
    expect(shouldIncludeCrowdMagnet('concert', { amenity: 'community_centre' }, 'Bandshell')).toBe(false)
    expect(shouldIncludeCrowdMagnet('concert', {}, 'Red Rocks Amphitheatre')).toBe(true)
  })

  it('drops state/regional/local parks mis-tagged as national parks', () => {
    expect(shouldIncludeCrowdMagnet('park', {}, 'Topanga State Park')).toBe(false)
    expect(shouldIncludeCrowdMagnet('park', { protection_title: 'State Park' }, 'Some Park')).toBe(false)
    expect(shouldIncludeCrowdMagnet('park', {}, 'Cook County Forest Preserve Regional Park')).toBe(false)
    expect(shouldIncludeCrowdMagnet('park', {}, 'Yosemite National Park')).toBe(true)
    expect(shouldIncludeCrowdMagnet('park', { protection_title: 'National Park' }, 'Zion National Park')).toBe(true)
  })

  it('does not apply school/community filter to parks or racetracks', () => {
    expect(shouldIncludeCrowdMagnet('park', {}, 'Academy Park National Park')).toBe(true)
    expect(shouldIncludeCrowdMagnet('raceway', {}, 'High School Kart Track')).toBe(true)
  })
})

describe('fetchCrowdMagnets', () => {
  const bounds = L.latLngBounds([39.9, -83.1], [40.1, -82.9])

  beforeEach(() => {
    vi.restoreAllMocks()
    // These bounds sit inside CONUS, so fetchCrowdMagnets tries the snapshot
    // first. Default to "unavailable" so the pre-existing live-Overpass tests
    // exercise the fallback path without making a real network request.
    vi.spyOn(snapshots, 'loadCrowdSnapshot').mockResolvedValue(null)
  })

  it('throws when the Overpass query fails (null) so it is not mistaken for "none nearby"', async () => {
    vi.spyOn(overpass, 'fetchOverpass').mockResolvedValue(null)
    await expect(fetchCrowdMagnets(bounds)).rejects.toThrow()
  })

  it('returns an empty list (genuine none) when Overpass returns an empty element set', async () => {
    vi.spyOn(overpass, 'fetchOverpass').mockResolvedValue({ elements: [] })
    await expect(fetchCrowdMagnets(bounds)).resolves.toEqual([])
  })

  it('prefers the CONUS snapshot over live Overpass when available', async () => {
    const fetchOverpassSpy = vi.spyOn(overpass, 'fetchOverpass')
    vi.spyOn(snapshots, 'loadCrowdSnapshot').mockResolvedValue({
      version: 1,
      generated_at: '2026-01-01T00:00:00Z',
      region: 'us-conus',
      bbox: [24.5, -125.0, 49.4, -66.9],
      count: 2,
      magnets: [
        { id: 'way/1', name: 'In Bounds Stadium', type: 'stadium', lat: 40.0, lng: -83.0 },
        { id: 'way/2', name: 'Out of Bounds Stadium', type: 'stadium', lat: 10.0, lng: -83.0 },
      ],
    })
    const items = await fetchCrowdMagnets(bounds)
    expect(items).toEqual([{ id: 'way/1', name: 'In Bounds Stadium', type: 'stadium', lat: 40.0, lng: -83.0 }])
    expect(fetchOverpassSpy).not.toHaveBeenCalled()
  })

  it('falls back to live Overpass when the snapshot is unavailable', async () => {
    vi.spyOn(snapshots, 'loadCrowdSnapshot').mockResolvedValue(null)
    const fetchOverpassSpy = vi.spyOn(overpass, 'fetchOverpass').mockResolvedValue({ elements: [] })
    await fetchCrowdMagnets(bounds)
    expect(fetchOverpassSpy).toHaveBeenCalled()
  })

  it('skips the snapshot entirely outside CONUS', async () => {
    const loadSnapshotSpy = vi.spyOn(snapshots, 'loadCrowdSnapshot')
    vi.spyOn(overpass, 'fetchOverpass').mockResolvedValue({ elements: [] })
    const farBounds = L.latLngBounds([10, 10], [10.2, 10.2])
    await fetchCrowdMagnets(farBounds)
    expect(loadSnapshotSpy).not.toHaveBeenCalled()
  })
})
