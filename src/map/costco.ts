import { cachedPlacesSearchText, type PlacesSearchTextBody } from '../utils/placesCache'

const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY || ''

// Fetch nearby Costco Wholesale warehouses via Google Places Text Search.
// We previously queried Overpass/OSM but OSM coverage of Costco brand tags
// is uneven — many real warehouses are missing the brand or shop tags and
// were silently excluded, producing results like "nearest is 24mi away"
// when there's actually one much closer. Google Places matches what users
// see when they search "costco" on maps.google.com.
export type CostcoPlace = { id: string; name: string; addr: string; lat: number; lng: number }

export async function fetchCostcosViaPlaces(opts: {
  circle?: { lat: number; lng: number; radiusM: number }
  rectangle?: { south: number; west: number; north: number; east: number }
  signal?: AbortSignal
}): Promise<CostcoPlace[]> {
  if (!GOOGLE_MAPS_KEY) return []
  const body: PlacesSearchTextBody = {
    textQuery: 'Costco Wholesale',
    maxResultCount: 20,
  }
  if (opts.circle) {
    body.locationBias = {
      circle: {
        center: { latitude: opts.circle.lat, longitude: opts.circle.lng },
        radius: Math.min(opts.circle.radiusM, 50000),
      },
    }
  } else if (opts.rectangle) {
    body.locationRestriction = {
      rectangle: {
        low: { latitude: opts.rectangle.south, longitude: opts.rectangle.west },
        high: { latitude: opts.rectangle.north, longitude: opts.rectangle.east },
      },
    }
  }

  const data = await cachedPlacesSearchText({
    body,
    fieldMask: 'places.id,places.displayName,places.location,places.formattedAddress',
    apiKey: GOOGLE_MAPS_KEY,
    signal: opts.signal,
  })
  if (!data) return []
  const out: CostcoPlace[] = []
  for (const raw of (data.places || []) as Record<string, unknown>[]) {
    const loc = raw.location as { latitude: number; longitude: number } | undefined
    if (!loc) continue
    const displayName = raw.displayName as { text?: string } | undefined
    const name = (displayName?.text || 'Costco').trim()
    // The store warehouse always matches /costco/. Filter out adjacent
    // Costco Gas, Costco Tire Center, Costco Pharmacy, etc. so they don't
    // count as separate locations.
    if (!/costco/i.test(name)) continue
    if (/\b(gas|fuel|tire|pharmacy|optical|food court|hearing|liquor)\b/i.test(name)) continue
    out.push({
      id: raw.id as string,
      name,
      addr: (raw.formattedAddress as string) || '',
      lat: loc.latitude,
      lng: loc.longitude,
    })
  }
  return out
}

// Split "123 Main St, Springfield, IL 62701, USA" into street + locality.
export function parseCostcoAddress(addr: string): { street: string; locality: string } {
  if (!addr) return { street: '', locality: '' }
  const parts = addr.split(',').map((s) => s.trim()).filter(Boolean)
  // Drop trailing "USA"
  if (parts.length && /^USA?$/i.test(parts[parts.length - 1])) parts.pop()
  const street = parts[0] || ''
  let city = ''
  let state = ''
  if (parts.length >= 3) {
    city = parts[1]
    state = (parts[2].split(/\s+/)[0] || '')
  } else if (parts.length === 2) {
    city = parts[1]
  }
  const locality = [city, state].filter(Boolean).join(', ')
  return { street, locality }
}
