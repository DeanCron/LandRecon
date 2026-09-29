import { confirmUsGpsTarget } from './currentLocation'
import type { GpsTarget } from './locationTarget'

export async function resolveLocation(address: string, gps: GpsTarget | null, apiKey: string, signal: AbortSignal): Promise<{ lat: number; lng: number }> {
  if (gps) {
    const confirmed = await confirmUsGpsTarget(gps, apiKey, signal)
    return { lat: confirmed.lat, lng: confirmed.lng }
  }
  const response = await fetch(
    `https://api.tomtom.com/search/2/geocode/${encodeURIComponent(address)}.json?key=${encodeURIComponent(apiKey)}&countrySet=US&limit=1`,
    { signal },
  )
  if (!response.ok) throw new Error('Address lookup failed. Check your connection and try again.')
  const data = await response.json()
  signal.throwIfAborted()
  const point = data?.results?.[0]?.position
  if (typeof point?.lat !== 'number' || !Number.isFinite(point.lat) || Math.abs(point.lat) > 90
    || typeof point?.lon !== 'number' || !Number.isFinite(point.lon) || Math.abs(point.lon) > 180) {
    throw new Error('Address not found. Make sure it is a valid US address.')
  }
  return { lat: point.lat, lng: point.lon }
}
