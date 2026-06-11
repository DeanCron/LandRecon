import { describe, it, expect } from 'vitest'
import { parseCostcoAddress } from './costco'

describe('parseCostcoAddress', () => {
  it('splits a full US address into street and locality', () => {
    expect(parseCostcoAddress('1051 Burnett Ave, San Jose, CA 95125, USA')).toEqual({
      street: '1051 Burnett Ave',
      locality: 'San Jose, CA',
    })
  })

  it('drops a trailing USA/US token', () => {
    expect(parseCostcoAddress('500 Main St, Reno, NV 89501, US').locality).toBe('Reno, NV')
  })

  it('handles a two-part address with no state', () => {
    expect(parseCostcoAddress('123 A St, Springfield')).toEqual({
      street: '123 A St',
      locality: 'Springfield',
    })
  })

  it('returns empty fields for an empty string', () => {
    expect(parseCostcoAddress('')).toEqual({ street: '', locality: '' })
  })
})
