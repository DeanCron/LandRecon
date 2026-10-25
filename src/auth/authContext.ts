import { createContext, useContext } from 'react'
import type { User } from '@supabase/supabase-js'

export type AuthStatus = 'disabled' | 'loading' | 'signedOut' | 'signedIn'

export interface AuthApi {
  status: AuthStatus
  user: User | null
  signInWithGoogle: (returnTo?: string) => Promise<string | null>
  signInWithEmail: (email: string, returnTo?: string) => Promise<string | null>
  verifyEmailCode: (email: string, code: string) => Promise<string | null>
  signOut: () => Promise<void>
  deleteAccount: () => Promise<string | null>
}

const RETURN_KEY = 'lr_auth_return_to'

// Only same-origin relative paths are allowed, to prevent open redirects.
export function safeReturnPath(p: string | null | undefined): string {
  if (!p || !p.startsWith('/') || p.startsWith('//') || p.includes('\\')) return '/'
  return p
}

export function callbackUrl(returnTo?: string) {
  sessionStorage.setItem(RETURN_KEY, safeReturnPath(returnTo ?? window.location.pathname + window.location.search))
  return `${window.location.origin}/auth/callback`
}

export function takeReturnPath(): string {
  const p = safeReturnPath(sessionStorage.getItem(RETURN_KEY))
  sessionStorage.removeItem(RETURN_KEY)
  return p
}

export const AuthContext = createContext<AuthApi | null>(null)

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
