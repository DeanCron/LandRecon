import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  RAILROAD_ANALYSIS_RADIUS_MI,
  railroadSeverity,
  closestPointOnSegment,
  nearestRailroadFromElements,
  nearestRailroadFromSnapshot,
  fetchNearestRailroad,
} from './railroad'
import type { OverpassElement } from './overpass'
import * as overpass from './overpass'
import * as snapshots from './snapshots'
import type { RailroadSnapshotLine } from './snapshots'
import L from 'leaflet'

describe('railroadSeverity', () => {
  it('flags a track within a quarter mile as a warning', () => {
    expect(railroadSeverity(0)).toBe('warning')
    expect(railroadSeverity(0.1)).toBe('warning')
    expect(railroadSeverity(RAILROAD_ANALYSIS_RADIUS_MI)).toBe('warning')
  })

  it('clears tracks beyond a quarter mile and a missing track', () => {
    expect(railroadSeverity(0.26)).toBe('clear')
    expect(railroadSeverity(1)).toBe('clear')
    expect(railroadSeverity(null)).toBe('clear')
  })
})

describe('closestPointOnSegment', () => {
  it('measures distance to a track that passes just north of the point', () => {
    // Segment ~110 m due north of the point (0.001 deg lat ≈ 110.5 m), running
    // east–west so the nearest point is directly north of the origin.
    const p = { lat: 40, lng: -75 }
    const a = { lat: 40.001, lng: -75.01 }
    const b = { lat: 40.001, lng: -74.99 }
    const { distM } = closestPointOnSegment(p, a, b)
    expect(distM).toBeGreaterThan(100)
    expect(distM).toBeLessThan(120)
  })

  it('clamps to the nearest endpoint when the point is off the end', () => {
    const p = { lat: 40, lng: -75 }
    // Segment entirely east of the point; nearest is its western endpoint.
    const a = { lat: 40, lng: -74.99 }
    const b = { lat: 40, lng: -74.98 }
    const { distM } = closestPointOnSegment(p, a, b)
    // ~0.01 deg lng east at lat 40 ≈ 853 m.
    expect(distM).toBeGreaterThan(800)
    expect(distM).toBeLessThan(900)
  })
})

describe('nearestRailroadFromElements', () => {
  const center = { lat: 40, lng: -75 }

  it('returns null when no element carries usable geometry', () => {
    const els: OverpassElement[] = [
      { type: 'way', id: 1, tags: { railway: 'rail' } },
      { type: 'way', id: 2, tags: { railway: 'rail' }, geometry: [{ lat: 40, lon: -75 }] },
    ]
    expect(nearestRailroadFromElements(center, els)).toBeNull()
  })

  it('picks the closest of several tracks and names it', () => {
    const els: OverpassElement[] = [
      {
        type: 'way',
        id: 1,
        tags: { railway: 'rail', name: 'Far Line' },
        geometry: [
          { lat: 40.003, lon: -75.01 },
          { lat: 40.003, lon: -74.99 },
        ],
      },
      {
        type: 'way',
        id: 2,
        tags: { railway: 'rail', ref: 'CSX-12' },
        geometry: [
          { lat: 40.0005, lon: -75.01 },
          { lat: 40.0005, lon: -74.99 },
        ],
      },
    ]
    const hit = nearestRailroadFromElements(center, els)
    expect(hit).not.toBeNull()
    expect(hit!.name).toBe('CSX-12')
    // ~55 m north → well under 0.1 mi.
    expect(hit!.distanceMi).toBeLessThan(0.05)
    expect(railroadSeverity(hit!.distanceMi)).toBe('warning')
  })

  it('falls back to a generic name when no label tags are present', () => {
    const els: OverpassElement[] = [
      {
        type: 'way',
        id: 3,
        tags: { railway: 'rail' },
        geometry: [
          { lat: 40.001, lon: -75.01 },
          { lat: 40.001, lon: -74.99 },
        ],
      },
    ]
    expect(nearestRailroadFromElements(center, els)!.name).toBe('Unnamed railroad track')
  })

  it('returns clipped track geometry for highlighting', () => {
    // A densely-noded straight track running east–west ~55 m north of the
    // address, extending well past the clip window on both sides.
    const lngs: number[] = []
    for (let lng = -75.05; lng <= -74.95 + 1e-9; lng += 0.002) {
      lngs.push(Math.round(lng * 1000) / 1000)
    }
    const els: OverpassElement[] = [
      {
        type: 'way',
        id: 4,
        tags: { railway: 'rail', name: 'Main Line' },
        geometry: lngs.map((lng) => ({ lat: 40.0005, lon: lng })),
      },
    ]
    const hit = nearestRailroadFromElements(center, els)
    expect(hit).not.toBeNull()
    expect(hit!.tracks).toHaveLength(1)
    expect(hit!.tracks[0].name).toBe('Main Line')
    const pts = hit!.tracks[0].lines.flat()
    // The far reaches of the alignment are dropped — only the stretch near the
    // address survives the clip window.
    expect(pts.length).toBeGreaterThan(1)
    expect(pts.length).toBeLessThan(lngs.length)
    for (const [, lng] of pts) {
      expect(Math.abs(lng - center.lng)).toBeLessThan(0.02)
    }
  })
})

describe('fetchNearestRailroad', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // 40, -75 sits inside CONUS, so fetchNearestRailroad tries the snapshot
    // first. Default to "unavailable" so the pre-existing live-Overpass tests
    // exercise the fallback path without making a real network request.
    vi.spyOn(snapshots, 'loadRailroadSnapshot').mockResolvedValue(null)
  })

  it('throws when the Overpass query fails (null) so it is not mistaken for "no track"', async () => {
    vi.spyOn(overpass, 'fetchOverpass').mockResolvedValue(null)
    await expect(fetchNearestRailroad(L.latLng(40, -75))).rejects.toThrow()
  })

  it('returns null (genuine no-track) when Overpass returns an empty element set', async () => {
    vi.spyOn(overpass, 'fetchOverpass').mockResolvedValue({ elements: [] })
    await expect(fetchNearestRailroad(L.latLng(40, -75))).resolves.toBeNull()
  })

  it('prefers the CONUS snapshot over live Overpass when available', async () => {
    const fetchOverpassSpy = vi.spyOn(overpass, 'fetchOverpass')
    const lines: RailroadSnapshotLine[] = [
      {
        id: 'way/1',
        name: 'CSX-12',
        coords: [40.0005, -75.01, 40.0005, -74.99],
        bbox: [40.0005, -75.01, 40.0005, -74.99],
      },
    ]
    vi.spyOn(snapshots, 'loadRailroadSnapshot').mockResolvedValue({
      version: 1,
      generated_at: '2026-01-01T00:00:00Z',
      region: 'us-conus',
      bbox: [24.5, -125.0, 49.4, -66.9],
      count: 1,
      lines,
    })
    const hit = await fetchNearestRailroad(L.latLng(40, -75))
    expect(hit).not.toBeNull()
    expect(hit!.name).toBe('CSX-12')
    expect(fetchOverpassSpy).not.toHaveBeenCalled()
  })

  it('falls back to live Overpass when the snapshot is unavailable', async () => {
    vi.spyOn(snapshots, 'loadRailroadSnapshot').mockResolvedValue(null)
    const fetchOverpassSpy = vi.spyOn(overpass, 'fetchOverpass').mockResolvedValue({ elements: [] })
    await fetchNearestRailroad(L.latLng(40, -75))
    expect(fetchOverpassSpy).toHaveBeenCalled()
  })

  it('skips the snapshot entirely outside CONUS', async () => {
    const loadSnapshotSpy = vi.spyOn(snapshots, 'loadRailroadSnapshot')
    vi.spyOn(overpass, 'fetchOverpass').mockResolvedValue({ elements: [] })
    await fetchNearestRailroad(L.latLng(10, 10))
    expect(loadSnapshotSpy).not.toHaveBeenCalled()
  })
})

describe('nearestRailroadFromSnapshot', () => {
  const center = { lat: 40, lng: -75 }

  it('prunes lines whose bbox cannot be near the center', () => {
    const lines: RailroadSnapshotLine[] = [
      {
        id: 'way/far',
        name: 'Far Line',
        coords: [45, -75, 45, -74.9],
        bbox: [45, -75, 45, -74.9],
      },
      {
        id: 'way/near',
        name: 'Near Line',
        coords: [40.0005, -75.01, 40.0005, -74.99],
        bbox: [40.0005, -75.01, 40.0005, -74.99],
      },
    ]
    const hit = nearestRailroadFromSnapshot(center, lines)
    expect(hit).not.toBeNull()
    expect(hit!.name).toBe('Near Line')
  })

  it('returns null when no snapshot line is near enough', () => {
    const lines: RailroadSnapshotLine[] = [
      {
        id: 'way/far',
        name: 'Far Line',
        coords: [45, -75, 45, -74.9],
        bbox: [45, -75, 45, -74.9],
      },
    ]
    expect(nearestRailroadFromSnapshot(center, lines)).toBeNull()
  })
})
