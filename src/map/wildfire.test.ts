import { describe, it, expect } from 'vitest'
import { wildfireSeverity, wildfireClassLabel } from './wildfire'

describe('wildfireSeverity', () => {
  it('flags High (4) and Very high (5) as danger', () => {
    expect(wildfireSeverity(4)).toBe('danger')
    expect(wildfireSeverity(5)).toBe('danger')
  })

  it('treats Moderate (3) as clear so it does not trigger a report flag', () => {
    expect(wildfireSeverity(3)).toBe('clear')
  })

  it('treats Low/Very low and non-burnable/water as clear', () => {
    expect(wildfireSeverity(1)).toBe('clear')
    expect(wildfireSeverity(2)).toBe('clear')
    expect(wildfireSeverity(6)).toBe('clear')
    expect(wildfireSeverity(7)).toBe('clear')
  })
})

describe('wildfireClassLabel', () => {
  it('maps class value to its USFS label (1-indexed)', () => {
    expect(wildfireClassLabel(1)).toBe('Very low')
    expect(wildfireClassLabel(3)).toBe('Moderate')
    expect(wildfireClassLabel(4)).toBe('High')
    expect(wildfireClassLabel(5)).toBe('Very high')
    expect(wildfireClassLabel(6)).toBe('Non-burnable')
    expect(wildfireClassLabel(7)).toBe('Water')
  })

  it('returns "Unknown" for out-of-range values', () => {
    expect(wildfireClassLabel(0)).toBe('Unknown')
    expect(wildfireClassLabel(99)).toBe('Unknown')
  })
})
