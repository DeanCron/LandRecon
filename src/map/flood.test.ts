import { describe, it, expect } from 'vitest'
import { floodBucket, floodSeverity, floodZoneLabel } from './flood'

describe('floodBucket', () => {
  it('maps high-risk SFHA zones to "high"', () => {
    for (const zone of ['A', 'AE', 'AH', 'AO', 'AR', 'A99']) {
      expect(floodBucket({ FLD_ZONE: zone })).toBe('high')
    }
  })

  it('maps coastal V zones to "coastal"', () => {
    expect(floodBucket({ FLD_ZONE: 'V' })).toBe('coastal')
    expect(floodBucket({ FLD_ZONE: 'VE' })).toBe('coastal')
  })

  it('distinguishes shaded (moderate) X from unshaded (minimal) X', () => {
    expect(floodBucket({ FLD_ZONE: 'X', ZONE_SUBTY: '0.2 PCT ANNUAL CHANCE FLOOD HAZARD' })).toBe('moderate')
    expect(floodBucket({ FLD_ZONE: 'X', ZONE_SUBTY: 'AREA OF MINIMAL FLOOD HAZARD' })).toBe('minimal')
    expect(floodBucket({ FLD_ZONE: 'X' })).toBe('minimal')
  })

  it('handles water, undetermined, and unknown', () => {
    expect(floodBucket({ FLD_ZONE: 'OPEN WATER' })).toBe('water')
    expect(floodBucket({ FLD_ZONE: 'D' })).toBe('undetermined')
    expect(floodBucket(null)).toBe('minimal')
    expect(floodBucket({})).toBe('minimal')
  })

  it('is case-insensitive and trims whitespace', () => {
    expect(floodBucket({ FLD_ZONE: ' ae ' })).toBe('high')
  })
})

describe('floodSeverity', () => {
  it('flags high and coastal as danger, moderate as warning, rest clear', () => {
    expect(floodSeverity('high')).toBe('danger')
    expect(floodSeverity('coastal')).toBe('danger')
    expect(floodSeverity('moderate')).toBe('warning')
    expect(floodSeverity('minimal')).toBe('clear')
    expect(floodSeverity('undetermined')).toBe('clear')
    expect(floodSeverity('water')).toBe('clear')
  })
})

describe('floodZoneLabel', () => {
  it('includes the subtype when present', () => {
    expect(floodZoneLabel({ FLD_ZONE: 'AE', ZONE_SUBTY: 'FLOODWAY' })).toBe('Zone AE — FLOODWAY')
    expect(floodZoneLabel({ FLD_ZONE: 'X' })).toBe('Zone X')
    expect(floodZoneLabel(null)).toBe('Zone Unknown')
  })
})
