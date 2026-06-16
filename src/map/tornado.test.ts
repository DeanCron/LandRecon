import { describe, it, expect } from 'vitest'
import { tornadoBand, tornadoClassLabel, tornadoSeverity, tornadoRatingColor } from './tornado'

describe('tornadoBand', () => {
  it('maps NRI rating strings to the 1-5 hazard band', () => {
    expect(tornadoBand('Very Low')).toBe(1)
    expect(tornadoBand('Relatively Low')).toBe(2)
    expect(tornadoBand('Relatively Moderate')).toBe(3)
    expect(tornadoBand('Relatively High')).toBe(4)
    expect(tornadoBand('Very High')).toBe(5)
  })

  it('is case- and whitespace-insensitive', () => {
    expect(tornadoBand('  very high  ')).toBe(5)
    expect(tornadoBand('RELATIVELY MODERATE')).toBe(3)
  })

  it('returns 0 (non-rated) for unrecognized ratings', () => {
    expect(tornadoBand('No Rating')).toBe(0)
    expect(tornadoBand('Insufficient Data')).toBe(0)
    expect(tornadoBand('Not Applicable')).toBe(0)
    expect(tornadoBand('')).toBe(0)
  })
})

describe('tornadoSeverity', () => {
  it('flags High (4) and Very high (5) as danger', () => {
    expect(tornadoSeverity(4)).toBe('danger')
    expect(tornadoSeverity(5)).toBe('danger')
  })

  it('treats Moderate (3) and below as clear so they do not trigger a report flag', () => {
    expect(tornadoSeverity(1)).toBe('clear')
    expect(tornadoSeverity(2)).toBe('clear')
    expect(tornadoSeverity(3)).toBe('clear')
  })
})

describe('tornadoClassLabel', () => {
  it('maps band value to its label (1-indexed)', () => {
    expect(tornadoClassLabel(1)).toBe('Very low')
    expect(tornadoClassLabel(3)).toBe('Moderate')
    expect(tornadoClassLabel(5)).toBe('Very high')
  })

  it('returns "Unknown" for out-of-range values', () => {
    expect(tornadoClassLabel(0)).toBe('Unknown')
    expect(tornadoClassLabel(99)).toBe('Unknown')
  })
})

describe('tornadoRatingColor', () => {
  it('colors rated tracts by band and non-rated tracts gray', () => {
    expect(tornadoRatingColor('Very High')).toBe('#d73027')
    expect(tornadoRatingColor('Very Low')).toBe('#1a9850')
    expect(tornadoRatingColor('No Rating')).toBe('#9ca3af')
  })
})
