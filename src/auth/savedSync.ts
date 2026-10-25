import {
  MAX_SAVED_ANALYSES,
  loadSavedAnalyses,
  replaceSavedAnalysesFromAccount,
  type SavedAnalysis,
} from '../map/savedAnalyses'
import { locationIdentity } from '../utils/locationTarget'
import { getSupabase } from './supabaseClient'

const importedKey = (uid: string) => `lr_saved_import_done_${uid}`

export function mergeSaved(primary: SavedAnalysis[], extra: SavedAnalysis[]): SavedAnalysis[] {
  const seen = new Set<string>()
  const out: SavedAnalysis[] = []
  for (const s of [...primary, ...extra]) {
    const id = locationIdentity(s.address, s.gps)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(s)
  }
  return out.slice(0, MAX_SAVED_ANALYSES)
}

export async function fetchRemoteSaved(): Promise<SavedAnalysis[] | null> {
  const sb = await getSupabase()
  if (!sb) return null
  const { data, error } = await sb
    .from('saved_analyses')
    .select('payload')
    .order('created_at', { ascending: false })
  if (error || !data) return null
  return data.map((r) => r.payload as SavedAnalysis)
}

// Replace-all keeps the account list identical to the local list (newest first).
// created_at is staggered so ordering survives the round trip.
export async function pushRemoteSaved(list: SavedAnalysis[]): Promise<boolean> {
  const sb = await getSupabase()
  if (!sb) return false
  const { data: userData } = await sb.auth.getUser()
  const uid = userData.user?.id
  if (!uid) return false
  const del = await sb.from('saved_analyses').delete().eq('user_id', uid)
  if (del.error) return false
  if (list.length === 0) return true
  const now = Date.now()
  const rows = list.map((payload, i) => ({
    user_id: uid,
    payload,
    created_at: new Date(now - i * 1000).toISOString(),
  }))
  const ins = await sb.from('saved_analyses').insert(rows)
  return !ins.error
}

// On sign-in: load the account list; offer a one-time import of this device's
// list. `confirmImport` is injected so the UI decides how to ask.
export async function syncOnSignIn(
  uid: string,
  confirmImport: (count: number) => boolean,
): Promise<void> {
  const remote = await fetchRemoteSaved()
  if (!remote) return
  let result = remote
  const local = loadSavedAnalyses()
  const alreadyAsked = localStorage.getItem(importedKey(uid)) === '1'
  if (!alreadyAsked && local.length > 0) {
    localStorage.setItem(importedKey(uid), '1')
    if (confirmImport(local.length)) {
      result = mergeSaved(remote, local)
      if (result.length !== remote.length) await pushRemoteSaved(result)
    }
  }
  replaceSavedAnalysesFromAccount(result)
}
