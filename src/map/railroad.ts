import L from 'leaflet'
import { fetchOverpass, type OverpassElement } from './overpass'

// ── Railroad proximity ──────────────────────────────────────────────────
// A railroad track within a quarter mile of a home is a meaningful nuisance:
// horn noise (FRA rules require sounding the horn at every public grade
// crossing), ground vibration, and overnight freight movements. Unlike a
// hazard layer this is advisory — the recommendation is to visit the property
// at different times of day before committing, since how disruptive it is
// depends heavily on traffic frequency and time of day.
export const RAILROAD_ANALYSIS_RADIUS_MI = 0.25
// Track geometry is clipped to this window around the address before being
// returned, so a highlight never draws an entire cross-country alignment — just
// the stretch of track in the immediate vicinity of the property.
export const RAILROAD_CLIP_RADIUS_MI = 0.6
const MILES_TO_METERS = 1609.34

// A single nearby railroad, with its geometry clipped to the window around the
// address. `lines` is one or more polylines (each a list of [lat, lng] points)
// so a track that briefly leaves and re-enters the window stays disjoint.
export interface RailroadTrack {
  name: string
  lines: [number, number][][]
}

export interface NearestRailroad {
  // Display name (track/line name, ref number, or operator). Never empty.
  name: string
  // Distance from the searched address to the closest point on the track.
  distanceMi: number
  // The closest point on the track itself (useful for marker placement).
  lat: number
  lng: number
  // Nearby track geometry to highlight on the map, clipped to the window.
  tracks: RailroadTrack[]
}

// Advisory severity. There is a single threshold: a track within a quarter
// mile is flagged as a 'warning' (worth investigating in person), otherwise
// 'clear'. Returns 'clear' for a null distance (no track found nearby).
export function railroadSeverity(distanceMi: number | null): 'clear' | 'warning' {
  if (distanceMi === null) return 'clear'
  return distanceMi <= RAILROAD_ANALYSIS_RADIUS_MI ? 'warning' : 'clear'
}

// Closest point on segment a–b to point p, plus the distance in meters. Uses a
// local equirectangular projection centered on p, which is accurate to well
// under a meter at the sub-mile scale we care about and avoids the cost of a
// full geodesic solve. Exported so the geometry math can be unit-tested
// independently of Overpass.
export function closestPointOnSegment(
  p: { lat: number; lng: number },
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): { distM: number; lat: number; lng: number } {
  const mPerDegLat = 110540
  const mPerDegLng = 111320 * Math.cos((p.lat * Math.PI) / 180)
  // Project into a planar frame whose origin is p, so p is (0, 0).
  const ax = (a.lng - p.lng) * mPerDegLng
  const ay = (a.lat - p.lat) * mPerDegLat
  const bx = (b.lng - p.lng) * mPerDegLng
  const by = (b.lat - p.lat) * mPerDegLat
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  // Parameter of the projection of the origin onto the (clamped) segment.
  let t = len2 === 0 ? 0 : -((ax * dx + ay * dy) / len2)
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return {
    distM: Math.hypot(cx, cy),
    lat: p.lat + cy / mPerDegLat,
    lng: p.lng + cx / mPerDegLng,
  }
}

function railName(tags: Record<string, string>): string {
  return (
    tags.name ||
    tags['name:en'] ||
    tags.ref ||
    tags.operator ||
    'Unnamed railroad track'
  )
}

// Pure reducer over Overpass way elements (railway lines fetched with
// `out geom`). Returns the single closest track to `center`, or null when none
// of the supplied elements carry usable geometry. Does NOT enforce the radius
// itself — fetchNearestRailroad relies on Overpass's `around` filter to
// pre-scope candidates; the caller decides severity from the distance. Exported
// so the proximity math is unit-tested without hitting the network.
export function nearestRailroadFromElements(
  center: { lat: number; lng: number },
  elements: OverpassElement[],
): NearestRailroad | null {
  const clipM = RAILROAD_CLIP_RADIUS_MI * MILES_TO_METERS
  let best: { name: string; distanceMi: number; lat: number; lng: number } | null = null
  const tracks: RailroadTrack[] = []
  for (const el of elements) {
    const geom = el.geometry
    if (!geom || geom.length < 2) continue
    const name = railName(el.tags || {})
    // Single pass: track the globally-nearest point AND build the clipped
    // polylines (maximal runs of consecutive segments within the clip window).
    const lines: [number, number][][] = []
    let current: [number, number][] = []
    for (let i = 0; i < geom.length - 1; i++) {
      const a = { lat: geom[i].lat, lng: geom[i].lon }
      const b = { lat: geom[i + 1].lat, lng: geom[i + 1].lon }
      const { distM, lat, lng } = closestPointOnSegment(center, a, b)
      const distanceMi = distM / MILES_TO_METERS
      if (!best || distanceMi < best.distanceMi) {
        best = { name, distanceMi, lat, lng }
      }
      if (distM <= clipM) {
        if (current.length === 0) current.push([a.lat, a.lng])
        current.push([b.lat, b.lng])
      } else if (current.length >= 2) {
        lines.push(current)
        current = []
      } else {
        current = []
      }
    }
    if (current.length >= 2) lines.push(current)
    if (lines.length > 0) tracks.push({ name, lines })
  }
  if (!best) return null
  // Round for stable display without losing the "is it inside the radius"
  // decision (kept at hundredths of a mile ≈ 50 ft).
  return {
    name: best.name,
    distanceMi: Math.round(best.distanceMi * 100) / 100,
    lat: best.lat,
    lng: best.lng,
    tracks,
  }
}

// Fetch the nearest active railroad track within RADIUS of the address via
// Overpass. The `around` filter pre-scopes candidate ways to the radius, so any
// element returned has geometry within range; we then compute the precise
// nearest point. Heavy rail, light rail, and narrow-gauge lines count; subways
// (underground), trams, and abandoned/disused alignments are excluded.
export async function fetchNearestRailroad(
  center: L.LatLng,
  signal?: AbortSignal,
): Promise<NearestRailroad | null> {
  const radiusM = Math.ceil(RAILROAD_ANALYSIS_RADIUS_MI * MILES_TO_METERS)
  const q = `[out:json][timeout:25];way(around:${radiusM},${center.lat},${center.lng})["railway"~"^(rail|light_rail|narrow_gauge)$"];out tags geom;`
  const data = await fetchOverpass(q, { label: 'railroad', signal })
  // Distinguish a failed/aborted fetch (null) from a genuine empty result.
  // Returning null here would falsely render as "no track within range" and,
  // worse, cache that false-clear. Throw so callers can surface an error state.
  if (!data) throw new Error('Overpass railroad query failed')
  if (!data.elements) return null
  return nearestRailroadFromElements({ lat: center.lat, lng: center.lng }, data.elements)
}
