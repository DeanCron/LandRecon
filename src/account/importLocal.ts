import { locationIdentity } from '../utils/locationTarget'
import { resolveLocation } from '../utils/resolveLocation'
import type { SavedAnalysis } from '../map/savedAnalyses'
import { AccountApiError, addressLabel, createAddress, type AccountAddress } from './accountApi'

export type ImportResult = { imported: number; skipped: number; failed: number; limitReached: boolean }

function identityOfRecord(a: AccountAddress): string {
  return a.snapshot?.gps ? locationIdentity(a.address, a.snapshot.gps) : locationIdentity(a.address)
}

// Copies browser-local saves into the account. Entries already in the account
// (same address / GPS point) are skipped. Address-only entries need coordinates,
// which costs one geocode each (at most MAX_SAVED_ANALYSES, user-initiated).
export async function importLocalSaves(
  local: SavedAnalysis[],
  existing: AccountAddress[],
  apiKey: string,
  signal?: AbortSignal,
): Promise<ImportResult> {
  const have = new Set(existing.map(identityOfRecord))
  const result: ImportResult = { imported: 0, skipped: 0, failed: 0, limitReached: false }
  for (const entry of local) {
    if (signal?.aborted) break
    const id = locationIdentity(entry.address, entry.gps)
    if (have.has(id)) {
      result.skipped += 1
      continue
    }
    try {
      const { lat, lng } = entry.gps
        ? { lat: entry.gps.lat, lng: entry.gps.lng }
        : await resolveLocation(entry.address, null, apiKey, signal ?? new AbortController().signal)
      await createAddress({
        label: addressLabel(entry.address),
        address: entry.address.slice(0, 300),
        lat,
        lng,
        ...(entry.gps ? { gps_accuracy_m: entry.gps.accuracy } : {}),
        snapshot: entry,
      })
      have.add(id)
      result.imported += 1
    } catch (err) {
      if (err instanceof AccountApiError && err.status === 409) {
        result.limitReached = true
        break
      }
      result.failed += 1
    }
  }
  return result
}
