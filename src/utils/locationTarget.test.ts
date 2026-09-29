import { describe, expect, it } from 'vitest'
import {
  gpsTargetFromParams, gpsTargetLabel, locationIdentity, parseGpsTarget, setGpsTargetParams,
} from './locationTarget'

const fix = { kind: 'gps' as const, lat: 47.610123456, lng: -122.330123456, accuracy: 18, capturedAt: 1790680000000 }

describe('GPS targets', () => {
  it('validates coordinates, accuracy and capture time without coercion', () => {
    expect(parseGpsTarget(fix)).toEqual(fix)
    expect(parseGpsTarget({ ...fix, lat: 0, lng: 0 })).not.toBeNull()
    for (const invalid of [
      { lat: 91 }, { lng: -181 }, { lat: NaN }, { accuracy: -1 },
      { accuracy: Infinity }, { capturedAt: 0 }, { capturedAt: 9e20 },
      { lat: '47' }, { kind: 'address' },
    ]) expect(parseGpsTarget({ ...fix, ...invalid })).toBeNull()
  })

  it('round-trips exact coordinates and contextual metadata', () => {
    const params = new URLSearchParams('layers=noise')
    const target = { ...fix, label: 'Nearby street' }
    setGpsTargetParams(params, target)
    expect(gpsTargetFromParams(params)).toEqual(target)
    expect(params.get('layers')).toBe('noise')
    expect(gpsTargetLabel(target)).toContain('GPS location near Nearby street')
  })

  it('rejects empty, incomplete and nonnumeric link values', () => {
    for (const value of ['', ' ', 'abc', 'Infinity']) {
      const params = new URLSearchParams()
      setGpsTargetParams(params, fix)
      params.set('lat', value)
      expect(gpsTargetFromParams(params)).toBeNull()
    }
    expect(gpsTargetFromParams(new URLSearchParams('lat=47&lng=-122'))).toBeNull()
  })

  it('distinguishes same-label locations without treating a fresh fix as a different place', () => {
    expect(locationIdentity('Same street', fix))
      .not.toBe(locationIdentity('Same street', { ...fix, lat: 47.62 }))
    expect(locationIdentity('Same street', fix))
      .toBe(locationIdentity('New label', { ...fix, accuracy: 22, capturedAt: fix.capturedAt + 100 }))
  })
})
