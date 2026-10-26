import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import AccountMenu from './AccountMenu'
import AccountPage from '../pages/AccountPage'
import { fitSnapshot, loginUrl } from './accountApi'
import { importLocalSaves } from './importLocal'
import type { SavedAnalysis } from '../map/savedAnalyses'

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

const entry = (address: string, extra: Partial<SavedAnalysis> = {}): SavedAnalysis => ({
  address, date: '1/1/2026', grade: 'B', gradeColor: '#0a0', pct: 80, noiseLevel: null,
  noiseAirport: null, superfundCount: 0, superfundActive: 0, costcoMi: null, dataCenterCount: 0, ...extra,
})

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const body = handler(url, init)
    return body === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(body), { status: 200 })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

it('builds Easy Auth login URLs with a return path', () => {
  expect(loginUrl('google', '/account')).toBe('/.auth/login/google?post_login_redirect_uri=%2Faccount')
})

it('drops evidence from oversized snapshots', () => {
  const big = entry('x', { evidence: { 'Airport Noise': { rule: 'r'.repeat(40_000) } as never } })
  expect(fitSnapshot(big)?.evidence).toBeUndefined()
  expect(fitSnapshot(entry('y'))?.address).toBe('y')
})

it('shows sign-in links to anonymous users and the account links when signed in', async () => {
  stubFetch(() => ({ authenticated: false }))
  const { unmount } = render(<MemoryRouter><AccountMenu /></MemoryRouter>)
  expect(await screen.findByRole('link', { name: 'Google' })).toHaveAttribute('href', expect.stringContaining('/.auth/login/google'))
  unmount()
  stubFetch(() => ({ authenticated: true, user: { id: 'google:1', provider: 'google', name: 'Ada' } }))
  render(<MemoryRouter><AccountMenu /></MemoryRouter>)
  expect(await screen.findByRole('link', { name: 'My addresses' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Sign out' })).toHaveAttribute('href', expect.stringContaining('/.auth/logout'))
})

it('imports GPS saves, skips ones already in the account and stops at the limit', async () => {
  const gps = { kind: 'gps' as const, lat: 1, lng: 2, accuracy: 5, capturedAt: 1 }
  const posted: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
    posted.push(JSON.parse(String(init?.body)))
    return posted.length > 1 ? new Response(JSON.stringify({ error: 'limit' }), { status: 409 }) : new Response(JSON.stringify({}), { status: 201 })
  }))
  const existing = [{ id: 'a', label: 'dup', address: 'Dup', lat: 0, lng: 0, gps_accuracy_m: null, snapshot: entry('Dup'), created_at: '', updated_at: '' }]
  const res = await importLocalSaves(
    [entry('Dup'), entry('GPS one', { gps }), entry('GPS two', { gps: { ...gps, lat: 3 } })], existing, '')
  expect(res).toEqual({ imported: 1, skipped: 1, failed: 0, limitReached: true })
  expect(posted[0]).toMatchObject({ lat: 1, lng: 2, gps_accuracy_m: 5, address: 'GPS one' })
})

it('lists account addresses on the My addresses page', async () => {
  stubFetch((url) => url === '/api/me'
    ? { authenticated: true, user: { id: 'google:1', provider: 'google', name: 'Ada' } }
    : { addresses: [{ id: 'i1', label: '1 Main St', address: '1 Main St, Town', lat: 1, lng: 2, gps_accuracy_m: null, snapshot: entry('1 Main St, Town'), created_at: '', updated_at: '' }] })
  render(<MemoryRouter><AccountPage /></MemoryRouter>)
  await waitFor(() => expect(screen.getByText('1 Main St, Town')).toBeInTheDocument())
  expect(screen.getByRole('button', { name: 'Export my data' })).toBeEnabled()
})
