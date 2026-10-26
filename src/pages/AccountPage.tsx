import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AccountApiError, deleteAddress, listAddresses, loginUrl, logoutUrl, type AccountAddress } from '../account/accountApi'
import { importLocalSaves } from '../account/importLocal'
import { useAccount } from '../account/useAccount'
import { loadSavedAnalyses, savedAnalysisState } from '../map/savedAnalyses'
import '../account/account.css'

const TOMTOM_API_KEY = import.meta.env.VITE_TOMTOM_API_KEY || ''

export default function AccountPage() {
  const account = useAccount()
  const navigate = useNavigate()
  const [addresses, setAddresses] = useState<AccountAddress[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const localCount = loadSavedAnalyses().length

  const refresh = useCallback(async () => {
    try {
      setAddresses(await listAddresses())
      setError('')
    } catch {
      setError('Could not load your saved addresses. Try again in a moment.')
    }
  }, [])

  useEffect(() => {
    if (account.status !== 'signed-in') return
    void refresh()
  }, [account.status, refresh])

  if (account.status === 'loading') return <main className="account-page"><p className="account-status">Loading…</p></main>

  if (account.status === 'anonymous') {
    return (
      <main className="account-page">
        <h1>My addresses</h1>
        <p className="account-page-sub">Sign in to keep saved addresses across devices. Sign-in is Google or Microsoft only; we never see your password.</p>
        <div className="account-page-actions">
          <a className="account-btn" href={loginUrl('google', '/account')}>Sign in with Google</a>
          <a className="account-btn" href={loginUrl('aad', '/account')}>Sign in with Microsoft</a>
        </div>
        <p><Link to="/">Back to search</Link></p>
      </main>
    )
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setStatus('')
    try {
      await fn()
    } catch (err) {
      setError(err instanceof AccountApiError && err.status === 429
        ? 'Too many requests. Please wait a minute and try again.'
        : 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const onImport = () => run(async () => {
    const res = await importLocalSaves(loadSavedAnalyses(), addresses ?? [], TOMTOM_API_KEY)
    await refresh()
    const parts = [`Imported ${res.imported}`]
    if (res.skipped) parts.push(`${res.skipped} already saved`)
    if (res.failed) parts.push(`${res.failed} failed`)
    if (res.limitReached) parts.push('account address limit reached')
    setStatus(parts.join(', ') + '.')
  })

  const onRemove = (a: AccountAddress) => run(async () => {
    await deleteAddress(a.id)
    setAddresses((prev) => prev?.filter((x) => x.id !== a.id) ?? null)
  })

  const onExport = () => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), addresses: addresses ?? [] }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'landrecon-my-data.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const onDeleteAll = () => {
    if (!addresses?.length || !window.confirm('Permanently delete all addresses saved to your account? This cannot be undone.')) return
    void run(async () => {
      for (const a of addresses) await deleteAddress(a.id)
      await refresh()
      setStatus('All saved data deleted. Sign out below to finish; nothing else is stored about you.')
    })
  }

  const open = (a: AccountAddress) => {
    navigate('/map', { state: savedAnalysisState({ address: a.address, gps: a.snapshot?.gps, locationError: a.snapshot?.locationError }) })
  }

  return (
    <main className="account-page">
      <h1>My addresses</h1>
      <p className="account-page-sub">Signed in as {account.user.name || 'your account'}.</p>
      <div className="account-page-actions">
        <button className="account-btn" onClick={onImport} disabled={busy || localCount === 0}>
          Import {localCount} saved on this device
        </button>
        <button className="account-btn" onClick={onExport} disabled={busy || !addresses?.length}>Export my data</button>
        <button className="account-btn account-btn-danger" onClick={onDeleteAll} disabled={busy || !addresses?.length}>Delete all my data</button>
        <a className="account-btn" href={logoutUrl()}>Sign out</a>
      </div>
      {status && <p className="account-status" role="status">{status}</p>}
      {error && <p className="account-error" role="alert">{error}</p>}
      {addresses === null && !error && <p className="account-status">Loading…</p>}
      {addresses?.length === 0 && <p className="account-status">No saved addresses yet. Use “Save to account” on a report.</p>}
      <ul className="account-list">
        {addresses?.map((a) => (
          <li key={a.id} className="account-item">
            {a.snapshot?.grade && (
              <span className="account-grade" style={{ color: a.snapshot.gradeColor }}>{a.snapshot.grade}</span>
            )}
            <button className="account-item-main" onClick={() => open(a)}>
              <span className="account-item-label">{a.label}</span>
              <span className="account-item-meta">{a.address}</span>
            </button>
            <button className="account-btn" onClick={() => void onRemove(a)} disabled={busy} aria-label={`Remove ${a.label}`}>Remove</button>
          </li>
        ))}
      </ul>
      <p className="account-hint">Report data is point-in-time. Open an address to re-run it with current data.</p>
      <p><Link to="/">Back to search</Link></p>
    </main>
  )
}
