import { useEffect, useState } from 'react'
import { fetchMe, type AccountUser } from './accountApi'

export type AccountState =
  | { status: 'loading'; user: null }
  | { status: 'anonymous'; user: null }
  | { status: 'signed-in'; user: AccountUser }

// The identity lookup is shared across every useAccount() consumer so a page
// load makes a single /api/me call (the anonymous API limit is per IP and
// shared NATs can hit it). Sign-in/out are full-page navigations, which reset
// this cache.
let mePromise: Promise<AccountUser | null> | null = null

export function resetAccountCache() {
  mePromise = null
}

function lookupMe(): Promise<AccountUser | null> {
  mePromise ??= fetchMe().catch(() => null)
  return mePromise
}

// A failed lookup (API down, local dev without the sidecar) is treated as
// anonymous so the app stays usable.
export function useAccount(): AccountState {
  const [state, setState] = useState<AccountState>({ status: 'loading', user: null })
  useEffect(() => {
    let cancelled = false
    lookupMe().then((user) => {
      if (!cancelled) setState(user ? { status: 'signed-in', user } : { status: 'anonymous', user: null })
    })
    return () => { cancelled = true }
  }, [])
  return state
}
