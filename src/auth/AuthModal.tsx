import { useState, type FormEvent } from 'react'
import { useAuth } from './authContext'
import './auth.css'

type Step = 'start' | 'code'

export function AuthModal({ onClose }: { onClose: () => void }) {
  const { signInWithGoogle, signInWithEmail, verifyEmailCode } = useAuth()
  const [step, setStep] = useState<Step>('start')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<string | null>, next?: Step) => {
    setBusy(true)
    setError(null)
    const err = await fn()
    setBusy(false)
    if (err) setError(err)
    else if (next) setStep(next)
  }

  const onEmail = (e: FormEvent) => {
    e.preventDefault()
    void run(() => signInWithEmail(email), 'code')
  }
  const onCode = (e: FormEvent) => {
    e.preventDefault()
    void run(() => verifyEmailCode(email, code))
  }

  return (
    <div className="auth-overlay" onClick={onClose}>
      <div
        className="auth-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="auth-close" onClick={onClose} aria-label="Close">×</button>
        <h2 id="auth-modal-title">Sign in to save</h2>
        <p className="auth-note">Saving needs an account. The map, search and PDF export stay open to everyone.</p>
        {step === 'start' ? (
          <>
            <button className="auth-google" disabled={busy} onClick={() => void run(() => signInWithGoogle())}>
              Continue with Google
            </button>
            <div className="auth-or" aria-hidden="true">or</div>
            <form onSubmit={onEmail}>
              <label htmlFor="auth-email">Email</label>
              <input
                id="auth-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button type="submit" className="auth-primary" disabled={busy || !email.trim()}>
                Email me a sign-in code
              </button>
            </form>
          </>
        ) : (
          <form onSubmit={onCode}>
            <p className="auth-note">We sent a code to {email}. Enter it below, or open the link in the email.</p>
            <label htmlFor="auth-code">Code</label>
            <input
              id="auth-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <button type="submit" className="auth-primary" disabled={busy || !code.trim()}>
              Verify
            </button>
            <button type="button" className="auth-link" onClick={() => { setStep('start'); setCode(''); setError(null) }}>
              Use a different email
            </button>
          </form>
        )}
        {error && <p className="auth-error" role="alert">{error}</p>}
      </div>
    </div>
  )
}
