import { useCallback, useEffect, useRef, useState } from 'react'
import { trackEvent } from '../utils/analytics'

type Props = {
  shareUrl: string | null
  shareLongUrl: string | null
  loading: boolean
  error: string | null
  onError: (message: string) => void
  isGps: boolean
  address: string
  onClose: () => void
}

export function ShareModal({ shareUrl, shareLongUrl, loading, error, onError, isGps, address, onClose }: Props) {
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<number | null>(null)
  const value = shareUrl || shareLongUrl
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  useEffect(() => () => {
    if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current)
  }, [])

  const handleCopy = useCallback(async () => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      trackEvent('share_copy', { result: 'success' })
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2000)
    } catch {
      onError('Clipboard access denied — please copy manually.')
    }
  }, [value, onError])

  // Native Web Share — only available on secure contexts with a system
  // share sheet (iOS Safari, most modern Android Chromes). Silently ignore
  // user-cancellation; report any other error as a fallback to copy.
  const handleNativeShare = useCallback(async () => {
    if (!value || typeof navigator.share !== 'function') return
    try {
      await navigator.share({
        title: 'Land Recon',
        text: address ? `Land Recon — ${address}` : 'Land Recon map view',
        url: value,
      })
      trackEvent('share_native', { result: 'success' })
    } catch (err) {
      // AbortError = user cancelled; don't surface that as an error.
      if (err instanceof Error && err.name !== 'AbortError') {
        trackEvent('share_native', { result: 'error' })
        onError('Native share failed — copy the link instead.')
      }
    }
  }, [value, address, onError])

  return (
    <div className="analysis-detail-overlay" onClick={onClose}>
      <div className="analysis-detail-popup share-popup" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="share-modal-title">
        <button className="analysis-detail-close" onClick={onClose} aria-label="Close">×</button>
        <h3 id="share-modal-title">Share Results</h3>
        {loading ? (
          <div className="share-loading"><div className="spinner" /><p>Creating short link…</p></div>
        ) : (
          <>
            <p className="share-description">
              {isGps
                ? 'This link reveals the analyzed GPS location, its accuracy, and capture time. Anyone with the link can open that location.'
                : 'Anyone with this link will see the same address and the layers you have active.'}
            </p>
            <input
              className="share-modal-input"
              type="text"
              readOnly
              value={value || ''}
              onFocus={(e) => e.currentTarget.select()}
            />
            {error && (
              <p className="share-error">Could not shorten URL ({error}); using the full link instead.</p>
            )}
            <div className="share-modal-actions">
              {canNativeShare && (
                <button className="share-copy-button share-native-button" onClick={handleNativeShare}>
                  Share…
                </button>
              )}
              <button className="share-copy-button" onClick={handleCopy}>
                {copied ? '✓ Copied!' : 'Copy link'}
              </button>
              {shareUrl && (
                <a href={shareUrl} target="_blank" rel="noopener noreferrer" className="share-open-link">
                  Open in new tab →
                </a>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
