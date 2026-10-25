import { useEffect, useRef } from 'react'
import { SAVED_ANALYSES_KEY, replaceSavedAnalysesFromAccount, setSavedAnalysesWriteListener } from '../map/savedAnalyses'
import { useAuth } from './authContext'
import { pushRemoteSaved, syncOnSignIn } from './savedSync'

// Mirrors the saved-analyses list to the signed-in account. Renders nothing.
export function SavedSync() {
  const { status, user } = useAuth()
  const uid = user?.id

  useEffect(() => {
    if (status !== 'signedIn' || !uid) return
    let timer: number | undefined
    void syncOnSignIn(uid, (n) =>
      window.confirm(`Import ${n} saved location${n === 1 ? '' : 's'} from this device into your account?`),
    )
    setSavedAnalysesWriteListener((list) => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void pushRemoteSaved(list), 400)
    })
    return () => {
      window.clearTimeout(timer)
      setSavedAnalysesWriteListener(null)
    }
  }, [status, uid])

  // Only on an explicit sign-out: drop the account's cached items so they don't
  // linger on a shared device. Never wipes a device list that was not synced.
  const wasSignedIn = useRef(false)
  useEffect(() => {
    if (status === 'signedIn') wasSignedIn.current = true
    else if (status === 'signedOut' && wasSignedIn.current) {
      wasSignedIn.current = false
      localStorage.removeItem(SAVED_ANALYSES_KEY)
      replaceSavedAnalysesFromAccount([])
    }
  }, [status])

  return null
}
