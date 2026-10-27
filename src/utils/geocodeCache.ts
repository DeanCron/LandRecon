// Address -> coordinates remembered from geocodes the map page already paid
// for, so /report can resolve an address without making its own TomTom call.
const KEY = 'lr_geocode_cache'
const MAX_ENTRIES = 50

type Entry = { address: string; lat: number; lng: number }

const normalize = (address: string) => address.trim().toLowerCase().replace(/\s+/g, ' ')

function load(): Entry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e): e is Entry =>
      typeof e?.address === 'string' && Number.isFinite(e.lat) && Number.isFinite(e.lng))
  } catch {
    return []
  }
}

export function rememberGeocode(address: string, lat: number, lng: number): void {
  const key = normalize(address)
  if (!key || !Number.isFinite(lat) || !Number.isFinite(lng)) return
  const next = [{ address: key, lat, lng }, ...load().filter((e) => e.address !== key)].slice(0, MAX_ENTRIES)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // storage full or disabled; the report page falls back to "run it on the map first"
  }
}

export function lookupGeocode(address: string): { lat: number; lng: number } | null {
  const key = normalize(address)
  const hit = key ? load().find((e) => e.address === key) : undefined
  return hit ? { lat: hit.lat, lng: hit.lng } : null
}
