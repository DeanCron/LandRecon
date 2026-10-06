import { describe, expect, it } from 'vitest'
import { escapeHtml, safeHttpUrl } from './html'

describe('escapeHtml', () => {
  it('neutralizes markup and attribute breakouts', () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">&`)).toBe('&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;')
  })
  it('coerces non-strings', () => {
    expect(escapeHtml(undefined)).toBe('')
    expect(escapeHtml(42)).toBe('42')
  })
})

describe('safeHttpUrl', () => {
  it('allows http and https', () => {
    expect(safeHttpUrl('https://www.epa.gov/site?a=1&b=2')).toBe('https://www.epa.gov/site?a=1&amp;b=2')
    expect(safeHttpUrl(' http://example.com/x ')).toBe('http://example.com/x')
  })
  it('rejects dangerous or invalid URLs', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull()
    expect(safeHttpUrl('JaVaScRiPt:alert(1)')).toBeNull()
    expect(safeHttpUrl('data:text/html,<script>')).toBeNull()
    expect(safeHttpUrl('/relative')).toBeNull()
    expect(safeHttpUrl('')).toBeNull()
    expect(safeHttpUrl(null)).toBeNull()
  })
  it('keeps the attribute closed', () => {
    expect(safeHttpUrl('https://x.com/"onmouseover="alert(1)')).not.toContain('"')
  })
})
