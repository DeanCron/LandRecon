import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { authConfigured, getSupabase } from './supabaseClient'
import { AuthContext, callbackUrl, type AuthApi } from './authContext'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(authConfigured)

  useEffect(() => {
    if (!authConfigured) return
    let unsub: (() => void) | undefined
    let cancelled = false
    void getSupabase().then(async (sb) => {
      if (!sb || cancelled) return
      const { data } = await sb.auth.getSession()
      if (cancelled) return
      setSession(data.session)
      setLoading(false)
      unsub = sb.auth.onAuthStateChange((_e, s) => setSession(s)).data.subscription.unsubscribe
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  const signInWithGoogle = useCallback(async (returnTo?: string) => {
    const sb = await getSupabase()
    if (!sb) return 'Sign-in is not available.'
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: callbackUrl(returnTo), scopes: 'openid email profile' },
    })
    return error?.message ?? null
  }, [])

  const signInWithEmail = useCallback(async (email: string, returnTo?: string) => {
    const sb = await getSupabase()
    if (!sb) return 'Sign-in is not available.'
    const { error } = await sb.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: callbackUrl(returnTo), shouldCreateUser: true },
    })
    return error?.message ?? null
  }, [])

  const verifyEmailCode = useCallback(async (email: string, code: string) => {
    const sb = await getSupabase()
    if (!sb) return 'Sign-in is not available.'
    const { error } = await sb.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' })
    return error?.message ?? null
  }, [])

  const signOut = useCallback(async () => {
    const sb = await getSupabase()
    await sb?.auth.signOut()
  }, [])

  const deleteAccount = useCallback(async () => {
    const sb = await getSupabase()
    if (!sb) return 'Sign-in is not available.'
    const { error } = await sb.functions.invoke('delete-account', { method: 'POST' })
    if (error) return error.message
    await sb.auth.signOut()
    return null
  }, [])

  const value = useMemo<AuthApi>(
    () => ({
      status: !authConfigured ? 'disabled' : loading ? 'loading' : session ? 'signedIn' : 'signedOut',
      user: session?.user ?? null,
      signInWithGoogle,
      signInWithEmail,
      verifyEmailCode,
      signOut,
      deleteAccount,
    }),
    [loading, session, signInWithGoogle, signInWithEmail, verifyEmailCode, signOut, deleteAccount],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
