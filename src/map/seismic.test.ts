import { describe, it, expect } from 'vitest'
import { seismicBand, seismicClassLabel, seismicSeverity } from './seismic'

describe('seismicBand', () => {
  it('maps PGA (g) to the 1-5 hazard band', () => {
    expect(seismicBand(0.0)).toBe(1)
    expect(seismicBand(0.049)).toBe(1)
    expect(seismicBand(0.05)).toBe(2)
    expect(seismicBand(0.149)).toBe(2)
    expect(seismicBand(0.15)).toBe(3)
    expect(seismicBand(0.299)).toBe(3)
    expect(seismicBand(0.3)).toBe(4)
    expect(seismicBand(0.499)).toBe(4)
    expect(seismicBand(0.5)).toBe(5)
    expect(seismicBand(1.2)).toBe(5)
  })

  it('matches probed city values', () => {
    expect(seismicBand(0.033)).toBe(1) // Houston
    expect(seismicBand(0.058)).toBe(2) // Chicago
    expect(seismicBand(0.583)).toBe(5) // San Francisco
    expect(seismicBand(0.843)).toBe(5) // Los Angeles
  })
})

describe('seismicSeverity', () => {
  it('flags High (4) and Very high (5) as danger', () => {
    expect(seismicSeverity(4)).toBe('danger')
    expect(seismicSeverity(5)).toBe('danger')
  })

  it('treats Moderate (3) and below as clear so they do not trigger a report flag', () => {
    expect(seismicSeverity(1)).toBe('clear')
    expect(seismicSeverity(2)).toBe('clear')
    expect(seismicSeverity(3)).toBe('clear')
  })
})

describe('seismicClassLabel', () => {
  it('maps band value to its label (1-indexed)', () => {
    expect(seismicClassLabel(1)).toBe('Very low')
    expect(seismicClassLabel(3)).toBe('Moderate')
    expect(seismicClassLabel(4)).toBe('High')
    expect(seismicClassLabel(5)).toBe('Very high')
  })

  it('returns "Unknown" for out-of-range values', () => {
    expect(seismicClassLabel(0)).toBe('Unknown')
    expect(seismicClassLabel(99)).toBe('Unknown')
  })
})
