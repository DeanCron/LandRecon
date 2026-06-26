import { describe, it, expect } from 'vitest'
import {
  RAILROAD_ANALYSIS_RADIUS_MI,
  railroadSeverity,
  closestPointOnSegment,
  nearestRailroadFromElements,
} from './railroad'
import type { OverpassElement } from './overpass'

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
})
