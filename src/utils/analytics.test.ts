import { describe, expect, it } from 'vitest'
import { sanitizeAnalyticsUrl } from './analytics'

describe('analytics URL sanitization', () => {
  it('removes query strings and fragments', () => {
    expect(sanitizeAnalyticsUrl(
      'https://landrecon.ai/map?address=1500%20River%20Road#report',
    )).toBe('https://landrecon.ai/map')
  })

  it('supports relative referrers without retaining their query', () => {
    expect(sanitizeAnalyticsUrl(
      '/map?address=private',
      'https://landrecon.ai/home',
    )).toBe('https://landrecon.ai/map')
  })

  it('returns an empty value for missing or invalid URLs', () => {
    expect(sanitizeAnalyticsUrl('')).toBe('')
    expect(sanitizeAnalyticsUrl('not a URL')).toBe('')
  })
})
