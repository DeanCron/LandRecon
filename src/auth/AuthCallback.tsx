import { useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { getSupabase } from './supabaseClient'
import { takeReturnPath } from './authContext'

// Finishes the PKCE exchange. The ?code is exchanged once and then stripped
// from the URL so it never reaches analytics or history.
export default function AuthCallback() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [configured, setConfigured] = useState(true)

  const started = useRef(false)

  useEffect(() => {
    // The auth code is single-use; StrictMode's double effect must not run it twice.
    if (started.current) return
    started.current = true
    void (async () => {
      const sb = await getSupabase()
      if (!sb) {
        setConfigured(false)
        return
      }
      const params = new URLSearchParams(window.location.search)
      const providerError = params.get('error_description') ?? params.get('error')
      const code = params.get('code')
      window.history.replaceState(null, '', window.location.pathname)
      if (providerError) {
        setError(providerError)
        return
      }
      if (code) {
        const { error: exErr } = await sb.auth.exchangeCodeForSession(code)
        if (exErr) {
          setError(exErr.message)
          return
        }
      }
      navigate(takeReturnPath(), { replace: true })
    })()
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
