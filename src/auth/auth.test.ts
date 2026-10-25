import { describe, expect, it } from 'vitest'
import { authConfigured, getSupabase } from './supabaseClient'
import { safeReturnPath } from './authContext'

describe('auth core (inert without env vars)', () => {
  it('reports not configured and returns a null client', async () => {
    expect(authConfigured).toBe(false)
    expect(await getSupabase()).toBeNull()
  })

  it('only allows same-origin relative return paths', () => {
    expect(safeReturnPath('/map?x=1')).toBe('/map?x=1')
    expect(safeReturnPath('//evil.com')).toBe('/')
    expect(safeReturnPath('https://evil.com')).toBe('/')
    expect(safeReturnPath('/\\evil.com')).toBe('/')
    expect(safeReturnPath(null)).toBe('/')
  })
})
