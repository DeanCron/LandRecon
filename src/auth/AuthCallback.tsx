import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { getSupabase } from './supabaseClient'
import { takeReturnPath } from './authContext'

// Finishes the PKCE exchange. The ?code is exchanged once and then stripped
// from the URL so it never reaches analytics or history.
export default function AuthCallback() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [configured, setConfigured] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const sb = await getSupabase()
      if (!sb) {
        if (!cancelled) setConfigured(false)
        return
      }
      const params = new URLSearchParams(window.location.search)
      const providerError = params.get('error_description') ?? params.get('error')
      const code = params.get('code')
      window.history.replaceState(null, '', window.location.pathname)
      if (providerError) {
        if (!cancelled) setError(providerError)
        return
      }
      if (code) {
        const { error: exErr } = await sb.auth.exchangeCodeForSession(code)
        if (exErr) {
          if (!cancelled) setError(exErr.message)
          return
        }
      }
      if (!cancelled) navigate(takeReturnPath(), { replace: true })
    })()
    return () => {
      cancelled = true
    }
  }, [navigate])

  if (!configured) return <Navigate to="/" replace />
  if (error) {
    return (
      <main role="alert" style={{ padding: '2rem' }}>
        <h1>Sign-in failed</h1>
        <p>{error}</p>
        <a href="/">Back to LandRecon</a>
      </main>
    )
  }
  return <main style={{ padding: '2rem' }}>Signing you in…</main>
}
