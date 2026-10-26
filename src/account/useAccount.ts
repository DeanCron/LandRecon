import { useEffect, useState } from 'react'
import { fetchMe, type AccountUser } from './accountApi'

export type AccountState =
  | { status: 'loading'; user: null }
  | { status: 'anonymous'; user: null }
  | { status: 'signed-in'; user: AccountUser }

// Resolves the Easy Auth identity once per mount. A failed lookup (API down,
// local dev without the sidecar) is treated as anonymous so the app stays usable.
export function useAccount(): AccountState {
  const [state, setState] = useState<AccountState>({ status: 'loading', user: null })
  useEffect(() => {
    let cancelled = false
    fetchMe()
      .then((user) => { if (!cancelled) setState(user ? { status: 'signed-in', user } : { status: 'anonymous', user: null }) })
      .catch(() => { if (!cancelled) setState({ status: 'anonymous', user: null }) })
    return () => { cancelled = true }
  }, [])
  return state
}
