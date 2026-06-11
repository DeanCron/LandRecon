import L from 'leaflet'
import { fetchOverpass } from '../map/overpass'

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

function isSchoolVenue(tags: Record<string, string>, name: string): boolean {
  if (SCHOOL_NAME_RE.test(name)) return true
  if (tags.school) return true
  if (tags.amenity === 'school') return true
  const op = (tags.operator || '').toLowerCase()
  if (op.includes('school') || op.includes('academy') || op.includes('isd')) return true
  return false
}

function isCommunityVenue(tags: Record<string, string>, name: string): boolean {
  if (COMMUNITY_NAME_RE.test(name)) return true
  if (tags.amenity === 'community_centre') return true
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

export async function fetchCrowdMagnets(bounds: L.LatLngBounds, signal?: AbortSignal): Promise<CrowdMagnet[]> {
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
  if (!data?.elements) return []
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
    // Skip school stadiums/fields and community/rec centers — too many in
    // residential areas, and they don't really qualify as crowd magnets
    // compared to pro/college venues.
    if ((type === 'stadium' || type === 'concert') && (isSchoolVenue(tags, rawName) || isCommunityVenue(tags, rawName))) continue
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
