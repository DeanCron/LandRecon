import L from 'leaflet'
import { fetchOverpass } from '../map/overpass'
import { CONUS_BOUNDS, loadCrowdSnapshot } from './snapshots'

export const CROWD_TYPES = ['stadium', 'concert', 'park', 'raceway', 'themepark'] as const
export type CrowdType = typeof CROWD_TYPES[number]
export const CROWD_COLORS: Record<CrowdType, string> = {
  stadium: '#D55E00',
  concert: '#CC79A7',
  park: '#009E73',
  raceway: '#332288',
  themepark: '#E69F00',
}
export const CROWD_LABELS: Record<CrowdType, string> = {
  stadium: 'Stadiums',
  concert: 'Concert Venues',
  park: 'National Parks',
  raceway: 'Racetracks',
  themepark: 'Theme Parks',
}
export const CROWD_ICONS: Record<CrowdType, string> = {
  stadium: '🏟️',
  concert: '🎵',
  park: '🌲',
  raceway: '🏁',
  themepark: '🎢',
}
export const CROWD_LABEL_SINGULAR: Record<CrowdType, string> = {
  stadium: 'Stadium',
  concert: 'Concert Venue',
  park: 'National Park',
  raceway: 'Racetrack',
  themepark: 'Theme Park',
}
export const CROWD_ANALYSIS_RADIUS_MI = 2

export interface CrowdMagnet {
  id: string
  name: string
  type: CrowdType
  lat: number
  lng: number
}

const SCHOOL_NAME_RE = /\b(elementary|middle school|high school|junior high|preparatory|prep school|academy|charter|catholic school|christian school|christian academy|day school|public schools?)\b/i
const COMMUNITY_NAME_RE = /\b(community (center|centre|park)|recreation (center|centre)|rec center|rec centre|ymca|ywca|civic center|civic centre)\b/i
// State/regional/local parks are routinely mis-tagged boundary=national_park in
// OSM. They draw far smaller crowds than true national parks, so we exclude
// them from the "National Parks" crowd magnets by name or protection metadata.
const STATE_LOCAL_PARK_NAME_RE = /\b(state (park|recreation|beach|forest|natural area|historic|wildlife)|regional park|county park|city park|metropolitan park|metro park|municipal park|provincial park|local park)\b/i

function isSchoolVenue(tags: Record<string, string>, name: string): boolean {
  if (SCHOOL_NAME_RE.test(name)) return true
  if (tags.school) return true
  if (tags.amenity === 'school') return true
  if (tags.building === 'school') return true
  if ((tags['operator:type'] || '').toLowerCase() === 'education') return true
  const op = (tags.operator || '').toLowerCase()
  if (op.includes('school') || op.includes('academy') || op.includes('isd')) return true
  return false
}

function isCommunityVenue(tags: Record<string, string>, name: string): boolean {
  if (COMMUNITY_NAME_RE.test(name)) return true
  if (tags.amenity === 'community_centre') return true
  return false
}

// State/regional/local park mis-tagged as a national park. Trusts explicit
// protection metadata first (protection_title / protect_class), then falls back
// to the name. protect_class 2 is the IUCN "National Park" class, so anything
// explicitly higher/other is treated as sub-national.
function isStateOrLocalPark(tags: Record<string, string>, name: string): boolean {
  const title = (tags.protection_title || '').toLowerCase()
  if (/\b(state|regional|county|city|municipal|local|provincial|metropolitan)\b/.test(title)) return true
  if (STATE_LOCAL_PARK_NAME_RE.test(name)) return true
  return false
}

export function classifyCrowdElement(tags: Record<string, string>): CrowdType | null {
  if (tags.boundary === 'national_park') return 'park'
  if (tags.tourism === 'theme_park') return 'themepark'
  if (tags.leisure === 'stadium') return 'stadium'
  if (tags.amenity === 'amphitheatre') return 'concert'
  if (tags.highway === 'raceway') return 'raceway'
  if (tags.leisure === 'track') {
    const sport = (tags.sport || '').toLowerCase()
    if (/motor|drag|karting|horse_racing/.test(sport)) return 'raceway'
  }
  return null
}

// Whether a classified element actually qualifies as a crowd magnet. Filters
// out neighborhood-scale venues that pollute the count: school/community
// stadiums & amphitheatres, and state/regional parks mis-tagged as national
// parks. Pure + exported so the rules are unit-tested independently of Overpass.
export function shouldIncludeCrowdMagnet(type: CrowdType, tags: Record<string, string>, name: string): boolean {
  if ((type === 'stadium' || type === 'concert') && (isSchoolVenue(tags, name) || isCommunityVenue(tags, name))) return false
  if (type === 'park' && isStateOrLocalPark(tags, name)) return false
  return true
}

export async function fetchCrowdMagnets(bounds: L.LatLngBounds, signal?: AbortSignal): Promise<CrowdMagnet[]> {
  // Prefer the daily CONUS snapshot over a live Overpass call whenever the
  // bbox center falls inside CONUS. Previously only the toggleable map layer
  // did this — the Recon Report's crowd-magnet check called straight through
  // to live Overpass every run, making it one of the more common sources of
  // 429s from the shared public mirrors. Falls back to live Overpass outside
  // CONUS or when the snapshot fails to load.
  if (L.latLngBounds(CONUS_BOUNDS).contains(bounds.getCenter())) {
    const snap = await loadCrowdSnapshot(signal)
    if (snap) return snap.magnets.filter((m) => bounds.contains([m.lat, m.lng] as L.LatLngTuple))
  }
  const s = bounds.getSouth(), w = bounds.getWest()
  const n = bounds.getNorth(), e = bounds.getEast()
  const bbox = `${s},${w},${n},${e}`
  const q = `[out:json][timeout:25];(
    nwr["leisure"="stadium"]["name"](${bbox});
    nwr["tourism"="theme_park"]["name"](${bbox});
    nwr["amenity"="amphitheatre"]["name"][!"historic"](${bbox});
    nwr["highway"="raceway"]["name"](${bbox});
    way["leisure"="track"]["sport"~"motor|drag_racing|karting|horse_racing"]["name"](${bbox});
    relation["leisure"="track"]["sport"~"motor|drag_racing|karting|horse_racing"]["name"](${bbox});
    way["boundary"="national_park"]["name"](${bbox});
    relation["boundary"="national_park"]["name"](${bbox});
  );out body center;`
  const data = await fetchOverpass(q, { label: 'crowd', signal })
  // Distinguish a failed/aborted fetch (null) from a genuine empty result.
  // Returning [] here would falsely render as "no crowd magnets nearby" and get
  // cached as a clean all-clear. Throw so callers can surface an error state.
  if (!data) throw new Error('Overpass crowd query failed')
  if (!data.elements) return []
  const seen = new Set<string>()
  const out: CrowdMagnet[] = []
  for (const el of data.elements) {
    const lat = el.lat ?? el.center?.lat
    const lon = el.lon ?? el.center?.lon
    if (lat == null || lon == null) continue
    const tags = el.tags || {}
    const type = classifyCrowdElement(tags)
    if (!type) continue
    const rawName = tags.name || tags['name:en'] || tags.short_name
    if (!rawName) continue
    // Skip school/community stadiums & amphitheatres and state/regional parks
    // mis-tagged as national parks — too many in residential areas, and they
    // don't qualify as crowd magnets next to pro/college/national venues.
    if (!shouldIncludeCrowdMagnet(type, tags, rawName)) continue
    const id = `${el.type}-${el.id}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: rawName, type, lat, lng: lon })
  }
  // Dedupe by name+type within ~1.5 mi (catches multi-polygon parks and
  // stadiums tagged as both way and relation).
  const merged: CrowdMagnet[] = []
  for (const m of out) {
    const dup = merged.find((x) => x.type === m.type
      && x.name.toLowerCase() === m.name.toLowerCase()
      && L.latLng(x.lat, x.lng).distanceTo(L.latLng(m.lat, m.lng)) / 1609.34 < 1.5)
    if (!dup) merged.push(m)
  }
  return merged
}
