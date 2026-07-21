import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAP_ADDRESS_STATE_KEY,
  rememberMapAddress,
  resolveMapAddress,
  scrubMapAddressBeforeAnalytics,
} from './mapAddressState'

beforeEach(() => {
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('map address navigation state', () => {
  it('scrubs a shared address before analytics while preserving other options', () => {
    window.history.replaceState(
      { existing: true },
      '',
      '/map?address=1500%20River%20Road%20West&layers=noise#report',
    )

    scrubMapAddressBeforeAnalytics()

    expect(window.location.pathname).toBe('/map')
    expect(window.location.search).toBe('?layers=noise')
    expect(window.location.hash).toBe('#report')
    expect(window.history.state.existing).toBe(true)
    expect(window.history.state.usr[MAP_ADDRESS_STATE_KEY]).toBe('1500 River Road West')
    expect(resolveMapAddress(window.history.state.usr)).toBe('1500 River Road West')
  })

  it('normalizes route state and rejects missing values', () => {
    expect(rememberMapAddress('  History address  ')).toEqual({
      [MAP_ADDRESS_STATE_KEY]: 'History address',
    })
    expect(resolveMapAddress({ [MAP_ADDRESS_STATE_KEY]: ' History address ' })).toBe('History address')
    expect(resolveMapAddress(null)).toBe('')
  })
})
