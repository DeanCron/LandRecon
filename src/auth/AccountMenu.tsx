import { useState } from 'react'
import { useAuth } from './authContext'
import './auth.css'

export function AccountMenu() {
  const { status, user, openSignIn, signOut, deleteAccount } = useAuth()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (status === 'disabled' || status === 'loading') return null
  if (status === 'signedOut') {
    return (
      <button className="auth-signin" onClick={openSignIn}>
        Sign in
      </button>
    )
  }

  const onDelete = async () => {
    if (!window.confirm('Permanently delete your account and all saved items? This cannot be undone.')) return
    const err = await deleteAccount()
    if (err) setError(err)
  }

  return (
    <div className="auth-menu">
      <button className="auth-signin" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        {user?.email ?? 'Account'}
      </button>
      {open && (
        <div className="auth-menu-pop" role="menu">
          <button role="menuitem" onClick={() => void signOut()}>Sign out</button>
          <button role="menuitem" className="auth-danger" onClick={() => void onDelete()}>Delete account</button>
          {error && <p className="auth-error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  )
}
