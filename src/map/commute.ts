// TomTom Routing API integration for the optional "Commute Time" report
// card. Unlike every other Recon Report check, this one has no dataset to
// crawl or snapshot — the destination is a work address the user enters
// themselves, so it's a live per-user query rather than a cacheable CONUS
// dataset. Reuses the same TomTom key/geocode endpoint already used for the
// property address search, so no new API integration is introduced.

const TOMTOM_GEOCODE_URL = 'https://api.tomtom.com/search/2/geocode'
const TOMTOM_ROUTING_URL = 'https://api.tomtom.com/routing/1/calculateRoute'
const STORAGE_KEY = 'lr_work_address'

export type WorkAddress = {
  address: string
  lat: number
  lng: number
}

export type CommuteEstimate = {
  distanceMi: number
  liveMinutes: number
  typicalMinutes: number
  /** [lat, lng] pairs for the live-traffic route, for drawing on the map. */
  route: [number, number][]
}

export function loadSavedWorkAddress(): WorkAddress | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed?.address === 'string' && typeof parsed?.lat === 'number' && typeof parsed?.lng === 'number') {
      return { address: parsed.address, lat: parsed.lat, lng: parsed.lng }
    }
    return null
  } catch {
    return null
  }
}

export function saveWorkAddress(work: WorkAddress): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(work))
  } catch {
    /* private browsing / storage disabled — commute just won't persist */
  }
}

export function clearSavedWorkAddress(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

// Geocodes a free-text work address via the same TomTom endpoint the app
// already uses for the property address search.
export async function geocodeWorkAddress(
  address: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<WorkAddress | null> {
  const trimmed = address.trim()
  if (!trimmed || !apiKey) return null
  const url = `${TOMTOM_GEOCODE_URL}/${encodeURIComponent(trimmed)}.json?key=${apiKey}&countrySet=US&limit=1`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Geocode failed: HTTP ${res.status}`)
  const data = await res.json()
  const first = data?.results?.[0]
  if (!first) return null
  return {
    address: first.address?.freeformAddress || trimmed,
    lat: first.position.lat,
    lng: first.position.lon,
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

// Formats a Date as a timezone-less "YYYY-MM-DDTHH:mm:ss" using its local
// getters (not toISOString, which would convert to UTC). TomTom interprets
// an offset-less arriveAt as local time at the destination — this is an
// approximation that assumes the viewer's browser timezone matches the
// destination's, which won't hold when scouting a property across timezones.
function toLocalIsoNoTz(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// Next weekday 9:00 AM from `from`, used as a stand-in "typical rush hour"
// arrival target — TomTom's arriveAt routing factors in historical/
// predictive traffic for that time rather than current conditions.
export function nextWeekdayNineAM(from: Date = new Date()): Date {
  const d = new Date(from)
  d.setHours(9, 0, 0, 0)
  if (d <= from) d.setDate(d.getDate() + 1)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
  return d
}

type RouteResponse = {
  routes?: Array<{
    summary?: { travelTimeInSeconds?: number; lengthInMeters?: number }
    legs?: Array<{ points?: Array<{ latitude: number; longitude: number }> }>
  }>
}

async function calculateRoute(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number,
  apiKey: string,
  extraParams: string,
  signal?: AbortSignal,
): Promise<{ minutes: number; miles: number; route: [number, number][] } | null> {
  const url = `${TOMTOM_ROUTING_URL}/${originLat},${originLng}:${destLat},${destLng}/json?key=${apiKey}&travelMode=car&routeType=fastest${extraParams}`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Routing failed: HTTP ${res.status}`)
  const data = (await res.json()) as RouteResponse
  const route = data.routes?.[0]
  if (!route?.summary) return null
  const minutes = Math.round((route.summary.travelTimeInSeconds ?? 0) / 60)
  const miles = Math.round(((route.summary.lengthInMeters ?? 0) / 1609.34) * 10) / 10
  const points: [number, number][] = []
  for (const leg of route.legs || []) {
    for (const p of leg.points || []) points.push([p.latitude, p.longitude])
  }
  return { minutes, miles, route: points }
}

// Fetches both a live-traffic ("leave right now") estimate and a typical
// weekday rush-hour estimate (arriving 9am), in parallel. These need two
// separate TomTom Routing API calls since live and time-dependent/historical
// traffic models aren't both returned by a single request.
export async function fetchCommute(opts: {
  originLat: number
  originLng: number
  destLat: number
  destLng: number
  apiKey: string
  signal?: AbortSignal
}): Promise<CommuteEstimate | null> {
  const { originLat, originLng, destLat, destLng, apiKey, signal } = opts
  if (!apiKey) return null
  const arriveAt = toLocalIsoNoTz(nextWeekdayNineAM())
  const [live, typical] = await Promise.all([
    calculateRoute(originLat, originLng, destLat, destLng, apiKey, '&traffic=true', signal),
    calculateRoute(originLat, originLng, destLat, destLng, apiKey, `&arriveAt=${arriveAt}`, signal),
  ])
  if (!live) return null
  return {
    distanceMi: live.miles,
    liveMinutes: live.minutes,
    typicalMinutes: typical ? typical.minutes : live.minutes,
    route: live.route,
  }
}

export function formatCommuteMinutes(mins: number): string {
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

// Rough, arbitrary thresholds — a "good" commute is subjective, so this is
// meant to flag a genuinely long haul rather than grade the property itself.
export function commuteSeverity(liveMinutes: number): 'good' | 'warning' | 'danger' {
  if (liveMinutes <= 25) return 'good'
  if (liveMinutes <= 50) return 'warning'
  return 'danger'
}
