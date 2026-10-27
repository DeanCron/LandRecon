import type { SavedAnalysis } from '../map/savedAnalyses'

export type AccountUser = { id: string; provider: string; name: string }

export type AccountAddress = {
  id: string
  label: string
  address: string
  lat: number
  lng: number
  gps_accuracy_m: number | null
  snapshot: SavedAnalysis | null
  created_at: string
  updated_at: string
}

export type AddressInput = {
  label: string
  address: string
  lat: number
  lng: number
  gps_accuracy_m?: number
  snapshot?: SavedAnalysis
}

export class AccountApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// The API sidecar rejects snapshots over 30 KB; leave headroom for the envelope.
const MAX_SNAPSHOT_BYTES = 28_000

export type AuthProvider = 'google' | 'aad'

// Easy Auth endpoints live on the same origin; they are served by the platform,
// not by our nginx.
export function loginUrl(provider: AuthProvider, returnTo = window.location.pathname + window.location.search): string {
  return `/.auth/login/${provider}?post_login_redirect_uri=${encodeURIComponent(returnTo)}`
}

export function logoutUrl(returnTo = '/'): string {
  return `/.auth/logout?post_logout_redirect_uri=${encodeURIComponent(returnTo)}`
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  })
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const body = await res.json()
      if (typeof body?.error === 'string') message = body.error
    } catch { /* non-JSON error body */ }
    throw new AccountApiError(res.status, message)
  }
  return res.status === 204 ? (undefined as T) : (await res.json()) as T
}

export async function fetchMe(): Promise<AccountUser | null> {
  const body = await call<{ authenticated: boolean; user?: AccountUser }>('/api/me')
  return body.authenticated && body.user ? body.user : null
}

export async function listAddresses(): Promise<AccountAddress[]> {
  return (await call<{ addresses: AccountAddress[] }>('/api/me/addresses')).addresses
}

export function fitSnapshot(snapshot: SavedAnalysis | undefined): SavedAnalysis | undefined {
  if (!snapshot) return undefined
  if (JSON.stringify(snapshot).length <= MAX_SNAPSHOT_BYTES) return snapshot
  const slim: SavedAnalysis = { ...snapshot, evidence: undefined }
  if (slim.breakdown) slim.breakdown = slim.breakdown.map((factor) => ({ ...factor, evidence: undefined }))
  if (JSON.stringify(slim).length <= MAX_SNAPSHOT_BYTES) return slim
  return { ...slim, breakdown: undefined }
}

export function createAddress(input: AddressInput): Promise<AccountAddress> {
  return call<AccountAddress>('/api/me/addresses', {
    method: 'POST',
    body: JSON.stringify({ ...input, snapshot: fitSnapshot(input.snapshot) }),
  })
}

export function deleteAddress(id: string): Promise<void> {
  return call<void>(`/api/me/addresses/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function addressLabel(address: string): string {
  return address.trim().slice(0, 100) || 'Saved address'
}
