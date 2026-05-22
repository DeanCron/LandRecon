import { useEffect, useRef, useState, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './MapPage.css'

const NOISE_TILE_URL = '/tiles/airport-noise/{z}/{x}/{y}.png'

// TomTom Traffic Flow tile layer (real-time)
const TOMTOM_API_KEY = import.meta.env.VITE_TOMTOM_API_KEY || ''
const TRAFFIC_TILE_URL = `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${TOMTOM_API_KEY}`

type BaseMapId = 'street' | 'satellite' | 'light' | 'dark'

const BASE_MAPS: Record<BaseMapId, { label: string; url: string; attribution: string; maxZoom: number }> = {
  street: {
    label: 'Street',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  },
  satellite: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
  },
  light: {
    label: 'Light',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom: 20,
  },
  dark: {
    label: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom: 20,
  },
}

const SUPERFUND_API =
  'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/FAC_Superfund_Site_Boundaries_EPA_Public/FeatureServer/0/query'

const SUPERFUND_FIELDS = [
  'SITE_NAME', 'EPA_ID', 'NPL_STATUS_CODE', 'CITY_NAME',
  'STATE_CODE', 'SITE_FEATURE_TYPE', 'URL_ALIAS_TXT',
].join(',')

const LEGEND_STOPS = [
  { db: 45, color: 'rgb(34, 139, 34)' },
  { db: 50, color: 'rgb(124, 179, 66)' },
  { db: 55, color: 'rgb(255, 235, 59)' },
  { db: 60, color: 'rgb(255, 152, 0)' },
  { db: 65, color: 'rgb(244, 67, 54)' },
  { db: 70, color: 'rgb(136, 14, 79)' },
]

const SUPERFUND_STYLE: L.PathOptions = {
  color: '#d500f9',
  weight: 3,
  opacity: 1,
  fillColor: '#aa00ff',
  fillOpacity: 0.25,
  dashArray: '6, 4',
}

const SUPERFUND_HOVER_STYLE: L.PathOptions = {
  weight: 5,
  fillOpacity: 0.45,
  color: '#ff6eff',
}

// Schools API endpoints (NCES)
const SCHOOLS_PUBLIC_API =
  'https://services1.arcgis.com/Ua5sjt3LWTPigjyD/arcgis/rest/services/School_Characteristics_Current/FeatureServer/0/query'

const SCHOOLS_PRIVATE_API =
  'https://services1.arcgis.com/Ua5sjt3LWTPigjyD/arcgis/rest/services/Private_School_Locations_Current/FeatureServer/0/query'

type SchoolCategory = 'public' | 'charter' | 'private-religious' | 'private-other'

interface SchoolPoint {
  lat: number
  lon: number
  name: string
  category: SchoolCategory
  city?: string
  state?: string
  grades?: string
  enrollment?: number
}

const SCHOOL_COLORS: Record<SchoolCategory, string> = {
  public: '#1565c0',
  charter: '#2e7d32',
  'private-religious': '#7b1fa2',
  'private-other': '#e65100',
}

const SCHOOL_LABELS: Record<SchoolCategory, string> = {
  public: 'Public School',
  charter: 'Charter School',
  'private-religious': 'Private (Religious)',
  'private-other': 'Private (Other)',
}

const RELIGIOUS_KEYWORDS = [
  'catholic', 'christian', 'baptist', 'lutheran', 'methodist',
  'episcopal', 'presbyterian', 'adventist', 'pentecostal',
  'church', 'parish', 'parochial', 'diocese', 'apostolic',
  'assembly of god', 'nazarene', 'covenant', 'evangel',
  'holy', 'sacred heart', 'st.', 'saint', 'our lady',
  'blessed', 'trinity', 'calvary', 'grace', 'faith',
  'bible', 'gospel', 'redeemer', 'salvation', 'resurrection',
  'jewish', 'hebrew', 'yeshiva', 'torah', 'shalom',
  'synagogue', 'talmud', 'chabad',
]

function isReligiousSchool(name: string): boolean {
  const lower = name.toLowerCase()
  return RELIGIOUS_KEYWORDS.some((kw) => lower.includes(kw))
}

async function fetchSchools(bounds: L.LatLngBounds): Promise<SchoolPoint[]> {
  const env = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`

  const publicParams = new URLSearchParams({
    where: "STATUS=1",
    outFields: 'SCH_NAME,CHARTER_TEXT,SCHOOL_TYPE_TEXT,LCITY,LSTATE,GSLO,GSHI,MEMBER',
    geometry: env,
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outSR: '4326',
    f: 'json',
    resultRecordCount: '2000',
  })

  const privateParams = new URLSearchParams({
    where: '1=1',
    outFields: 'NAME,CITY,STATE',
    geometry: env,
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outSR: '4326',
    f: 'json',
    resultRecordCount: '2000',
  })

  // OSM Overpass query for schools
  const s = bounds.getSouth(), w = bounds.getWest()
  const n = bounds.getNorth(), e = bounds.getEast()
  const bbox = `${s},${w},${n},${e}`
  const osmQuery = `[out:json][timeout:15];(
    node["amenity"="school"](${bbox});
    way["amenity"="school"](${bbox});
    relation["amenity"="school"](${bbox});
  );out body center;`

  const [pubRes, privRes, osmRes] = await Promise.all([
    fetch(`${SCHOOLS_PUBLIC_API}?${publicParams}`).then((r) => r.json()).catch((err) => {
      console.warn('Public school fetch failed:', err)
      return { features: [] }
    }),
    fetch(`${SCHOOLS_PRIVATE_API}?${privateParams}`).then((r) => r.json()).catch((err) => {
      console.warn('Private school fetch failed:', err)
      return { features: [] }
    }),
    fetch(OVERPASS_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'LandRecon/1.0',
        'Accept': 'application/json',
      },
      body: `data=${encodeURIComponent(osmQuery)}`,
    }).then((r) => r.json()).catch((err) => {
      console.warn('OSM school fetch failed:', err)
      return { elements: [] }
    }),
  ])

  const schools: SchoolPoint[] = []
  // Track locations to deduplicate OSM against NCES
  const knownLocations = new Set<string>()

  for (const feat of pubRes.features || []) {
    const a = feat.attributes
    const g = feat.geometry
    if (!g) continue
    const isCharter = a.CHARTER_TEXT === 'Yes'
    knownLocations.add(`${g.y.toFixed(4)},${g.x.toFixed(4)}`)
    schools.push({
      lat: g.y,
      lon: g.x,
      name: a.SCH_NAME || 'Unknown',
      category: isCharter ? 'charter' : 'public',
      city: a.LCITY,
      state: a.LSTATE,
      grades: a.GSLO && a.GSHI ? `${a.GSLO}–${a.GSHI}` : undefined,
      enrollment: a.MEMBER > 0 ? a.MEMBER : undefined,
    })
  }

  for (const feat of privRes.features || []) {
    const a = feat.attributes
    const g = feat.geometry
    if (!g) continue
    const name = a.NAME || 'Unknown'
    knownLocations.add(`${g.y.toFixed(4)},${g.x.toFixed(4)}`)
    schools.push({
      lat: g.y,
      lon: g.x,
      name,
      category: isReligiousSchool(name) ? 'private-religious' : 'private-other',
      city: a.CITY,
      state: a.STATE,
    })
  }

  // Add OSM schools not already in NCES data
  for (const el of osmRes.elements || []) {
    const lat = el.lat ?? el.center?.lat
    const lon = el.lon ?? el.center?.lon
    if (!lat || !lon) continue
    const name = el.tags?.name
    if (!name) continue
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`
    if (knownLocations.has(key)) continue
    knownLocations.add(key)
    const opType = (el.tags?.['operator:type'] || '').toLowerCase()
    let category: SchoolCategory
    if (opType === 'public' || opType === 'government') {
      category = 'public'
    } else if (isReligiousSchool(name) || el.tags?.religion) {
      category = 'private-religious'
    } else if (opType === 'private') {
      category = 'private-other'
    } else {
      category = 'private-other'
    }
    schools.push({ lat, lon, name, category })
  }

  return schools
}

function schoolPopup(school: SchoolPoint): string {
  const color = SCHOOL_COLORS[school.category]
  const label = SCHOOL_LABELS[school.category]
  const location = [school.city, school.state].filter(Boolean).join(', ')
  return `
    <div class="school-popup">
      <div class="popup-header">
        <span class="school-icon" style="background:${color}"></span>
        <strong>${school.name}</strong>
      </div>
      <div class="popup-body">
        <div class="popup-row">
          <span class="popup-label">Type</span>
          <span class="school-badge" style="background:${color}15;color:${color}">${label}</span>
        </div>
        ${location ? `<div class="popup-row"><span class="popup-label">Location</span><span>${location}</span></div>` : ''}
        ${school.grades ? `<div class="popup-row"><span class="popup-label">Grades</span><span>${school.grades}</span></div>` : ''}
        ${school.enrollment ? `<div class="popup-row"><span class="popup-label">Enrollment</span><span>${school.enrollment.toLocaleString()}</span></div>` : ''}
      </div>
    </div>
  `
}

const OVERPASS_API = 'https://overpass-api.de/api/interpreter'
const OVERPASS_API_ALT = 'https://overpass.kumi.systems/api/interpreter'

interface TransitStop {
  lat: number
  lon: number
  name: string
  type: 'rail' | 'subway' | 'tram' | 'bus'
}

const TRANSIT_COLORS: Record<TransitStop['type'], string> = {
  rail: '#0d47a1',
  subway: '#ff3d00',
  tram: '#00c853',
  bus: '#ff8f00',
}

const TRANSIT_LABELS: Record<TransitStop['type'], string> = {
  rail: 'Rail Station',
  subway: 'Subway',
  tram: 'Tram Stop',
  bus: 'Bus Stop',
}

interface TransitRoute {
  type: TransitStop['type']
  name: string
  ref: string
  coords: [number, number][]
}

interface CatsStop {
  id: string
  name: string
  lat: number
  lon: number
}

interface CatsRoute {
  name: string
  short: string
  type: TransitStop['type']
  coords: [number, number][]
}

let catsStopsCache: CatsStop[] | null = null
let catsRoutesCache: CatsRoute[] | null = null

async function fetchCatsStops(): Promise<CatsStop[]> {
  if (catsStopsCache) return catsStopsCache
  const res = await fetch('/data/cats-stops.json')
  if (!res.ok) return []
  catsStopsCache = await res.json()
  return catsStopsCache!
}

async function fetchCatsRoutes(): Promise<CatsRoute[]> {
  if (catsRoutesCache) return catsRoutesCache
  const res = await fetch('/data/cats-routes.json')
  if (!res.ok) return []
  catsRoutesCache = await res.json()
  return catsRoutesCache!
}

function classifyRoute(tags: Record<string, string>): TransitStop['type'] {
  if (tags.route === 'train' || tags.route === 'railway') return 'rail'
  if (tags.route === 'subway' || tags.route === 'light_rail') return 'subway'
  if (tags.route === 'tram') return 'tram'
  return 'bus'
}

async function fetchTransitRoutes(bounds: L.LatLngBounds): Promise<TransitRoute[]> {
  const s = bounds.getSouth(), w = bounds.getWest()
  const n = bounds.getNorth(), e = bounds.getEast()
  const bbox = `${s},${w},${n},${e}`
  const query = `[out:json][timeout:25];(
    relation["route"="tram"](${bbox});
    relation["route"="subway"](${bbox});
    relation["route"="light_rail"](${bbox});
  );out body;way(r);out geom;`

  const res = await fetch(OVERPASS_API_ALT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'LandRecon/1.0',
      'Accept': 'application/json',
    },
    body: `data=${encodeURIComponent(query)}`,
  })
  if (!res.ok) return []
  const data = await res.json()
  if (!data.elements) return []

  const ways = new Map<number, [number, number][]>()
  for (const el of data.elements) {
    if (el.type === 'way' && el.geometry) {
      ways.set(el.id, el.geometry.map((g: { lat: number; lon: number }) => [g.lat, g.lon] as [number, number]))
    }
  }

  const routes: TransitRoute[] = []
  const seen = new Set<string>()
  for (const el of data.elements) {
    if (el.type !== 'relation') continue
    const tags = el.tags || {}
    const name = tags.name || tags.ref || ''
    const ref = tags.ref || ''
    const routeType = classifyRoute(tags)
    const key = `${routeType}-${ref || name}`
    if (seen.has(key)) continue
    seen.add(key)

    const coords: [number, number][] = []
    for (const member of el.members || []) {
      if (member.type === 'way') {
        const wayCoords = ways.get(member.ref)
        if (wayCoords) coords.push(...wayCoords)
      }
    }
    if (coords.length > 1) {
      routes.push({ type: routeType, name, ref, coords })
    }
  }
  return routes
}

function classifyTransitStop(tags: Record<string, string>): TransitStop['type'] {
  if (tags.railway === 'station' || tags.railway === 'halt') return 'rail'
  if (tags.station === 'subway' || tags.railway === 'subway_entrance') return 'subway'
  if (tags.railway === 'tram_stop') return 'tram'
  return 'bus'
}

async function fetchTransitStops(bounds: L.LatLngBounds, zoom: number): Promise<TransitStop[]> {
  const s = bounds.getSouth()
  const w = bounds.getWest()
  const n = bounds.getNorth()
  const e = bounds.getEast()
  const bbox = `${s},${w},${n},${e}`
  const busQueries = zoom >= 12
    ? `node["highway"="bus_stop"](${bbox});node["amenity"="bus_station"](${bbox});`
    : `node["amenity"="bus_station"](${bbox});`
  const query = `[out:json][timeout:15];(
    node["railway"="station"](${bbox});
    node["railway"="halt"](${bbox});
    node["railway"="subway_entrance"](${bbox});
    node["railway"="tram_stop"](${bbox});
    ${busQueries}
    node["public_transport"="station"](${bbox});
  );out body;`

  const res = await fetch(OVERPASS_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'LandRecon/1.0',
      'Accept': 'application/json',
    },
    body: `data=${encodeURIComponent(query)}`,
  })
  const data = await res.json()

  // Deduplicate by proximity (some stops have overlapping nodes)
  const seen = new Set<string>()
  const stops: TransitStop[] = []
  for (const el of data.elements) {
    const key = `${el.lat.toFixed(4)},${el.lon.toFixed(4)}`
    if (seen.has(key)) continue
    seen.add(key)
    stops.push({
      lat: el.lat,
      lon: el.lon,
      name: el.tags?.name || el.tags?.description || '',
      type: classifyTransitStop(el.tags || {}),
    })
  }
  return stops
}

function transitPopup(stop: TransitStop): string {
  const label = TRANSIT_LABELS[stop.type]
  const color = TRANSIT_COLORS[stop.type]
  return `
    <div class="transit-popup">
      <div class="popup-header">
        <span class="transit-icon" style="background:${color}"></span>
        <strong>${stop.name || 'Unnamed Stop'}</strong>
      </div>
      <div class="popup-body">
        <div class="popup-row">
          <span class="popup-label">Type</span>
          <span>${label}</span>
        </div>
      </div>
    </div>
  `
}

async function fetchSuperfundFeatures(bounds: L.LatLngBounds): Promise<GeoJSON.FeatureCollection> {
  const bbox = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`
  const params = new URLSearchParams({
    where: '1=1',
    outFields: SUPERFUND_FIELDS,
    geometry: bbox,
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outSR: '4326',
    f: 'geojson',
    resultRecordCount: '500',
  })
  const res = await fetch(`${SUPERFUND_API}?${params}`)
  return res.json()
}

const NPL_STATUS_INFO: Record<string, { label: string; desc: string }> = {
  F: { label: 'Final', desc: 'Officially listed on the NPL as a priority cleanup site' },
  P: { label: 'Proposed', desc: 'Proposed for NPL listing; under public comment review' },
  D: { label: 'Deleted', desc: 'Removed from NPL after cleanup goals were met' },
}

function superfundPopup(props: Record<string, string | null>): string {
  const name = props.SITE_NAME || 'Unknown Site'
  const city = [props.CITY_NAME, props.STATE_CODE].filter(Boolean).join(', ')
  const status = props.NPL_STATUS_CODE || ''
  const npl = NPL_STATUS_INFO[status]
  const epaId = props.EPA_ID || ''
  const url = props.URL_ALIAS_TXT
  const link = url
    ? `<a href="${url}" target="_blank" rel="noopener">View EPA Site Profile →</a>`
    : ''
  const statusHtml = npl
    ? `<div class="popup-row">
         <span class="popup-label">NPL Status</span>
         <span class="popup-badge">${npl.label}</span>
       </div>
       <div class="popup-npl-desc">${npl.desc}</div>`
    : status
      ? `<div class="popup-row"><span class="popup-label">NPL Status</span><span class="popup-badge">${status}</span></div>`
      : ''
  return `
    <div class="superfund-popup">
      <div class="popup-header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7b1fa2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <strong>${name}</strong>
      </div>
      <div class="popup-body">
        ${city ? `<div class="popup-row"><span class="popup-label">Location</span><span>${city}</span></div>` : ''}
        ${epaId ? `<div class="popup-row"><span class="popup-label">EPA ID</span><span class="popup-mono">${epaId}</span></div>` : ''}
        ${statusHtml}
      </div>
      ${link ? `<div class="popup-footer">${link}</div>` : ''}
    </div>
  `
}

function MapPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const address = searchParams.get('address') || ''
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const baseLayerRef = useRef<L.TileLayer | null>(null)
  const noiseLayerRef = useRef<L.TileLayer | null>(null)
  const airportLayerRef = useRef<L.LayerGroup | null>(null)
  const airportLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const airportKnownIdsRef = useRef<Set<string>>(new Set())
  const superfundLayerRef = useRef<L.GeoJSON | null>(null)
  const superfundLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const transitLayerRef = useRef<L.LayerGroup | null>(null)
  const transitLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const transitLastZoomRef = useRef<number>(0)
  const schoolLayerRef = useRef<L.LayerGroup | null>(null)
  const schoolLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const heliportLayerRef = useRef<L.LayerGroup | null>(null)
  const heliportLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const heliportKnownIdsRef = useRef<Set<string>>(new Set())
  const trafficLayerRef = useRef<L.TileLayer | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [noiseVisible, setNoiseVisible] = useState(false)
  const [superfundVisible, setSuperfundVisible] = useState(false)
  const [superfundLoading, setSuperfundLoading] = useState(false)
  const [transitVisible, setTransitVisible] = useState(false)
  const [transitLoading, setTransitLoading] = useState(false)
  const [schoolsVisible, setSchoolsVisible] = useState(false)
  const [schoolsLoading, setSchoolsLoading] = useState(false)
  const [heliportsVisible, setHeliportsVisible] = useState(false)
  const [trafficVisible, setTrafficVisible] = useState(false)
  const [activeBaseMap, setActiveBaseMap] = useState<BaseMapId>('street')

  const loadAirportLabels = useCallback(async (map: L.Map, layer: L.LayerGroup) => {
    const bounds = map.getBounds()
    const loaded = airportLoadedBoundsRef.current
    if (loaded && loaded.contains(bounds)) return

    try {
      const padded = bounds.pad(1.0)
      const s = padded.getSouth(), w = padded.getWest()
      const n = padded.getNorth(), e = padded.getEast()
      const bbox = `${s},${w},${n},${e}`
      const query = `[out:json][timeout:15];(
        node["aeroway"="aerodrome"]["iata"](${bbox});
        way["aeroway"="aerodrome"]["iata"](${bbox});
        relation["aeroway"="aerodrome"]["iata"](${bbox});
        node["aeroway"="aerodrome"]["name"~"[Ee]xecutive"](${bbox});
        way["aeroway"="aerodrome"]["name"~"[Ee]xecutive"](${bbox});
        relation["aeroway"="aerodrome"]["name"~"[Ee]xecutive"](${bbox});
      );out body center;`

      const res = await fetch(OVERPASS_API_ALT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'LandRecon/1.0',
          'Accept': 'application/json',
        },
        body: `data=${encodeURIComponent(query)}`,
      })
      if (!res.ok) return
      const data = await res.json()
      if (!data.elements || data.elements.length === 0) return

      const known = airportKnownIdsRef.current
      let added = 0
      for (const el of data.elements) {
        const id = `${el.type}-${el.id}`
        if (known.has(id)) continue

        const lat = el.lat ?? el.center?.lat
        const lon = el.lon ?? el.center?.lon
        if (lat == null || lon == null) continue
        const tags = el.tags || {}
        const name = tags.name || tags.official_name || ''
        const iata = tags.iata || ''
        if (!name && !iata) continue
        const nameLower = name.toLowerCase()
        if (nameLower.includes('heliport') || nameLower.includes('helipad')) continue
        const label = iata ? `${iata} — ${name}` : name

        const icon = L.divIcon({
          className: 'airport-label',
          html: `<div class="airport-label-wrapper"><span class="airport-label-text">✈ ${label}</span><span class="airport-label-pin"></span></div>`,
          iconSize: [1, 1],
          iconAnchor: [0, 0],
        })
        L.marker([lat, lon], { icon, interactive: false }).addTo(layer)
        known.add(id)
      }

      airportLoadedBoundsRef.current= loaded ? loaded.extend(padded.getSouthWest()).extend(padded.getNorthEast()) : padded
    } catch (err) {
      console.warn('Airport label fetch failed:', err)
    }
  }, [])

  const loadHeliportLabels = useCallback(async (map: L.Map, layer: L.LayerGroup) => {
    const bounds = map.getBounds()
    const loaded = heliportLoadedBoundsRef.current
    if (loaded && loaded.contains(bounds)) return

    try {
      const padded = bounds.pad(1.0)
      const s = padded.getSouth(), w = padded.getWest()
      const n = padded.getNorth(), e = padded.getEast()
      const bbox = `${s},${w},${n},${e}`
      const query = `[out:json][timeout:15];(
        node["aeroway"="helipad"](${bbox});
        way["aeroway"="helipad"](${bbox});
        relation["aeroway"="helipad"](${bbox});
        node["aeroway"="heliport"](${bbox});
        way["aeroway"="heliport"](${bbox});
        relation["aeroway"="heliport"](${bbox});
      );out body center;`

      const res = await fetch(OVERPASS_API_ALT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'LandRecon/1.0',
          'Accept': 'application/json',
        },
        body: `data=${encodeURIComponent(query)}`,
      })
      if (!res.ok) return
      const data = await res.json()
      if (!data.elements || data.elements.length === 0) return

      const known = heliportKnownIdsRef.current
      for (const el of data.elements) {
        const id = `${el.type}-${el.id}`
        if (known.has(id)) continue

        const lat = el.lat ?? el.center?.lat
        const lon = el.lon ?? el.center?.lon
        if (lat == null || lon == null) continue
        const tags = el.tags || {}
        const name = tags.name || tags.official_name || 'Helipad'
        const label = name

        const icon = L.divIcon({
          className: 'heliport-label',
          html: `<div class="heliport-label-wrapper"><span class="heliport-label-text">🚁 ${label}</span><span class="heliport-label-pin"></span></div>`,
          iconSize: [1, 1],
          iconAnchor: [0, 0],
        })
        L.marker([lat, lon], { icon, interactive: false }).addTo(layer)
        known.add(id)
      }

      heliportLoadedBoundsRef.current = loaded ? loaded.extend(padded.getSouthWest()).extend(padded.getNorthEast()) : padded
    } catch (err) {
      console.warn('Heliport label fetch failed:', err)
    }
  }, [])

  const loadSuperfundData = useCallback(async (map: L.Map, layer: L.GeoJSON) => {
    const bounds = map.getBounds()

    // Skip if we already loaded data covering the current view
    const loaded = superfundLoadedBoundsRef.current
    if (loaded && loaded.contains(bounds)) return

    setSuperfundLoading(true)
    try {
      // Fetch a padded area so small pans don't trigger new requests
      const padded = bounds.pad(0.5)
      const geojson = await fetchSuperfundFeatures(padded)
      layer.clearLayers()
      layer.addData(geojson)
      superfundLoadedBoundsRef.current = padded
    } catch (err) {
      console.error('Failed to load Superfund data:', err)
    } finally {
      setSuperfundLoading(false)
    }
  }, [])

  const loadTransitData = useCallback(async (map: L.Map, layer: L.LayerGroup) => {
    const bounds = map.getBounds()
    const zoom = map.getZoom()
    const loaded = transitLoadedBoundsRef.current
    const lastZoom = transitLastZoomRef.current
    const crossedThreshold = (zoom >= 12 && lastZoom < 12) || (zoom < 12 && lastZoom >= 12)
    if (loaded && loaded.contains(bounds) && !crossedThreshold) return

    setTransitLoading(true)
    try {
      const padded = bounds.pad(0.3)

      // Load CATS GTFS data (cached after first load) + OSM stops in parallel
      const [catsStops, catsRoutes, osmStops] = await Promise.all([
        fetchCatsStops(),
        fetchCatsRoutes(),
        fetchTransitStops(padded, zoom).catch(() => [] as TransitStop[]),
      ])

      layer.clearLayers()

      // Draw CATS route lines first (under stops)
      for (const route of catsRoutes) {
        // Check if any point of route is in view
        const inView = route.coords.some(
          ([lat, lon]) => padded.contains([lat, lon])
        )
        if (!inView) continue
        const color = TRANSIT_COLORS[route.type]
        L.polyline(route.coords, {
          color,
          weight: route.type === 'bus' ? 2 : 3,
          opacity: route.type === 'bus' ? 0.4 : 0.5,
          smoothFactor: 1,
        })
          .bindPopup(`<strong>${route.short ? route.short + ' — ' : ''}${route.name}</strong>`)
          .addTo(layer)
      }

      // Add CATS stops in view
      const catsInView = catsStops.filter((s) => padded.contains([s.lat, s.lon]))
      const seen = new Set<string>()
      for (const stop of catsInView) {
        const key = `${stop.lat.toFixed(4)},${stop.lon.toFixed(4)}`
        if (seen.has(key)) continue
        seen.add(key)
        L.circleMarker([stop.lat, stop.lon], {
          radius: 5,
          fillColor: TRANSIT_COLORS.bus,
          color: '#fff',
          weight: 2,
          opacity: 1,
          fillOpacity: 0.85,
        })
          .bindPopup(transitPopup({ lat: stop.lat, lon: stop.lon, name: stop.name, type: 'bus' }), { maxWidth: 260 })
          .addTo(layer)
      }

      // Add OSM stops not already covered by CATS (rail, subway, tram, plus any extra)
      for (const stop of osmStops) {
        const key = `${stop.lat.toFixed(4)},${stop.lon.toFixed(4)}`
        if (seen.has(key)) continue
        seen.add(key)
        const color = TRANSIT_COLORS[stop.type]
        const radius = stop.type === 'bus' ? 5 : 7
        L.circleMarker([stop.lat, stop.lon], {
          radius,
          fillColor: color,
          color: '#fff',
          weight: 2,
          opacity: 1,
          fillOpacity: 0.85,
        })
          .bindPopup(transitPopup(stop), { maxWidth: 260 })
          .addTo(layer)
      }

      transitLoadedBoundsRef.current = padded
      transitLastZoomRef.current = zoom
    } catch (err) {
      console.error('Failed to load transit data:', err)
    } finally {
      setTransitLoading(false)
    }
  }, [])

  const loadSchoolData = useCallback(async (map: L.Map, layer: L.LayerGroup) => {
    const bounds = map.getBounds()
    const loaded = schoolLoadedBoundsRef.current
    if (loaded && loaded.contains(bounds)) return

    setSchoolsLoading(true)
    try {
      const padded = bounds.pad(0.5)
      const schools = await fetchSchools(padded)
      // Build all markers before touching the layer to avoid flicker
      const newMarkers: L.CircleMarker[] = []
      for (const school of schools) {
        const color = SCHOOL_COLORS[school.category]
        const marker = L.circleMarker([school.lat, school.lon], {
          radius: 6,
          fillColor: color,
          color: '#fff',
          weight: 2,
          opacity: 1,
          fillOpacity: 0.85,
        }).bindPopup(schoolPopup(school), { maxWidth: 280 })
        newMarkers.push(marker)
      }
      // Swap: clear old, add new in one batch
      layer.clearLayers()
      for (const m of newMarkers) m.addTo(layer)
      schoolLoadedBoundsRef.current = padded
    } catch (err) {
      console.error('Failed to load school data:', err)
    } finally {
      setSchoolsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!address) {
      navigate('/')
      return
    }

    if (!mapContainer.current) return

    const abortController = new AbortController()
    const geocodeUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=us`

    fetch(geocodeUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'LandRecon/1.0' },
      signal: abortController.signal,
    })
      .then((res) => res.json())
      .then((data) => {
        if (!data || data.length === 0) {
          setStatus('error')
          setErrorMsg('Address not found. Please try a different address.')
          return
        }

        const lat = parseFloat(data[0].lat)
        const lng = parseFloat(data[0].lon)

        const map = L.map(mapContainer.current!, {
          center: [lat, lng],
          zoom: 14,
          zoomControl: false,
        })

        const baseLayer = L.tileLayer(BASE_MAPS.street.url, {
          attribution: BASE_MAPS.street.attribution,
          maxZoom: BASE_MAPS.street.maxZoom,
        }).addTo(map)

        baseLayerRef.current = baseLayer

        L.control.zoom({ position: 'topright' }).addTo(map)

        L.marker([lat, lng]).addTo(map)

        // Create noise layer (not added to map until toggled on)
        noiseLayerRef.current = L.tileLayer(NOISE_TILE_URL, {
          opacity: 0.7,
          maxZoom: 19,
          attribution: 'Noise: FAA/BTS Aviation Noise 2020',
          errorTileUrl: '',
        })

        // Create airport label layer (shown with noise layer)
        airportLayerRef.current = L.layerGroup()

        // Create Superfund layer (not added to map until toggled on)
        superfundLayerRef.current = L.geoJSON(undefined, {
          style: () => SUPERFUND_STYLE,
          onEachFeature: (_feature, layer) => {
            const props = (_feature as GeoJSON.Feature).properties || {}
            layer.bindPopup(superfundPopup(props), { maxWidth: 280 })
            layer.on('mouseover', (e) => {
              (e.target as L.Path).setStyle(SUPERFUND_HOVER_STYLE)
            })
            layer.on('mouseout', (e) => {
              superfundLayerRef.current?.resetStyle(e.target as L.Path)
            })
          },
        })

        // Create transit layer (not added to map until toggled on)
        transitLayerRef.current = L.layerGroup()

        // Create schools layer (not added to map until toggled on)
        schoolLayerRef.current = L.layerGroup()

        // Create heliport label layer (not added to map until toggled on)
        heliportLayerRef.current = L.layerGroup()

        // Create traffic flow layer (not added to map until toggled on)
        trafficLayerRef.current = L.tileLayer(TRAFFIC_TILE_URL, {
          opacity: 0.7,
          maxZoom: 22,
          attribution: '&copy; <a href="https://developer.tomtom.com/">TomTom</a> Traffic',
          errorTileUrl: '',
        })

        mapRef.current = map
        setStatus('ready')

        setTimeout(() => map.invalidateSize(), 0)
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setStatus('error')
        setErrorMsg('Failed to geocode the address.')
      })

    return () => {
      abortController.abort()
      baseLayerRef.current = null
      noiseLayerRef.current = null
      airportLayerRef.current = null
      airportLoadedBoundsRef.current = null
      airportKnownIdsRef.current.clear()
      superfundLayerRef.current = null
      superfundLoadedBoundsRef.current = null
      transitLayerRef.current = null
      transitLoadedBoundsRef.current = null
      schoolLayerRef.current = null
      schoolLoadedBoundsRef.current = null
      heliportLayerRef.current = null
      heliportLoadedBoundsRef.current = null
      heliportKnownIdsRef.current.clear()
      trafficLayerRef.current = null
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [address, navigate])

  const switchBaseMap = (id: BaseMapId) => {
    const map = mapRef.current
    const current = baseLayerRef.current
    if (!map || !current || id === activeBaseMap) return

    const config = BASE_MAPS[id]
    map.removeLayer(current)
    const newLayer = L.tileLayer(config.url, {
      attribution: config.attribution,
      maxZoom: config.maxZoom,
    }).addTo(map)
    newLayer.bringToBack()
    baseLayerRef.current = newLayer
    setActiveBaseMap(id)
  }

  const toggleNoise = () => {
    const map = mapRef.current
    const layer = noiseLayerRef.current
    const airportLayer = airportLayerRef.current
    if (!map || !layer) return

    if (noiseVisible) {
      map.removeLayer(layer)
      if (airportLayer) map.removeLayer(airportLayer)
      map.off('moveend', handleAirportMove)
    } else {
      layer.addTo(map)
      if (airportLayer) {
        airportLayer.addTo(map)
        airportLoadedBoundsRef.current = null
        airportKnownIdsRef.current.clear()
        airportLayer.clearLayers()
        loadAirportLabels(map, airportLayer)
        map.on('moveend', handleAirportMove)
      }
    }
    setNoiseVisible(!noiseVisible)
  }

  const handleAirportMove = useCallback(() => {
    const map = mapRef.current
    const layer = airportLayerRef.current
    if (map && layer) {
      loadAirportLabels(map, layer)
    }
  }, [loadAirportLabels])

  const toggleHeliports = () => {
    const map = mapRef.current
    const layer = heliportLayerRef.current
    if (!map || !layer) return

    if (heliportsVisible) {
      map.removeLayer(layer)
      map.off('moveend', handleHeliportMove)
    } else {
      layer.addTo(map)
      heliportLoadedBoundsRef.current = null
      heliportKnownIdsRef.current.clear()
      layer.clearLayers()
      loadHeliportLabels(map, layer)
      map.on('moveend', handleHeliportMove)
    }
    setHeliportsVisible(!heliportsVisible)
  }

  const handleHeliportMove = useCallback(() => {
    const map = mapRef.current
    const layer = heliportLayerRef.current
    if (map && layer) {
      loadHeliportLabels(map, layer)
    }
  }, [loadHeliportLabels])

  const toggleSuperfund = () => {
    const map = mapRef.current
    const layer = superfundLayerRef.current
    if (!map || !layer) return

    if (superfundVisible) {
      map.removeLayer(layer)
      map.off('moveend', handleSuperfundMove)
    } else {
      layer.addTo(map)
      superfundLoadedBoundsRef.current = null
      loadSuperfundData(map, layer)
      map.on('moveend', handleSuperfundMove)
    }
    setSuperfundVisible(!superfundVisible)
  }

  const handleSuperfundMove = useCallback(() => {
    const map = mapRef.current
    const layer = superfundLayerRef.current
    if (map && layer) {
      loadSuperfundData(map, layer)
    }
  }, [loadSuperfundData])

  const toggleTransit = () => {
    const map = mapRef.current
    const layer = transitLayerRef.current
    if (!map || !layer) return

    if (transitVisible) {
      map.removeLayer(layer)
      map.off('moveend', handleTransitMove)
    } else {
      layer.addTo(map)
      transitLoadedBoundsRef.current = null
      loadTransitData(map, layer)
      map.on('moveend', handleTransitMove)
    }
    setTransitVisible(!transitVisible)
  }

  const handleTransitMove = useCallback(() => {
    const map = mapRef.current
    const layer = transitLayerRef.current
    if (map && layer) {
      loadTransitData(map, layer)
    }
  }, [loadTransitData])

  const toggleSchools = () => {
    const map = mapRef.current
    const layer = schoolLayerRef.current
    if (!map || !layer) return

    if (schoolsVisible) {
      map.removeLayer(layer)
      map.off('moveend', handleSchoolsMove)
    } else {
      layer.addTo(map)
      schoolLoadedBoundsRef.current = null
      loadSchoolData(map, layer)
      map.on('moveend', handleSchoolsMove)
    }
    setSchoolsVisible(!schoolsVisible)
  }

  const handleSchoolsMove = useCallback(() => {
    const map = mapRef.current
    const layer = schoolLayerRef.current
    if (map && layer) {
      loadSchoolData(map, layer)
    }
  }, [loadSchoolData])

  const toggleTraffic = () => {
    const map = mapRef.current
    const layer = trafficLayerRef.current
    if (!map || !layer) return

    if (trafficVisible) {
      map.removeLayer(layer)
    } else {
      layer.addTo(map)
    }
    setTrafficVisible(!trafficVisible)
  }

  return (
    <div className="map-page">
      <header className="map-header">
        <button className="back-button" onClick={() => navigate('/')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
          Back
        </button>
        <div className="header-address" title={address}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
            <circle cx="12" cy="10" r="3" />
          </svg>
          {address}
        </div>
      </header>

      <div className="map-area">
        <div className="map-container" ref={mapContainer} />
        {status === 'loading' && (
          <div className="map-overlay">
            <div className="spinner" />
            <p>Loading map…</p>
          </div>
        )}
        {status === 'error' && (
          <div className="map-overlay error">
            <p>{errorMsg}</p>
            <button className="retry-button" onClick={() => navigate('/')}>
              Try another address
            </button>
          </div>
        )}
      </div>

      <aside className="layer-panel">
        <h2 className="panel-title">Base Map</h2>
        <div className="basemap-switcher">
          {(Object.entries(BASE_MAPS) as [BaseMapId, typeof BASE_MAPS[BaseMapId]][]).map(([id, cfg]) => (
            <button
              key={id}
              className={`basemap-btn ${id === activeBaseMap ? 'active' : ''}`}
              onClick={() => switchBaseMap(id)}
              disabled={status !== 'ready'}
            >
              {cfg.label}
            </button>
          ))}
        </div>

        <h2 className="panel-title overlay-title">Layers</h2>

        <label className="layer-toggle">
          <input
            type="checkbox"
            checked={noiseVisible}
            onChange={toggleNoise}
            disabled={status !== 'ready'}
          />
          <span className="layer-label">Airport Noise</span>
        </label>
        {noiseVisible && (
          <div className="noise-legend">
            <div className="legend-bar">
              {LEGEND_STOPS.map((stop, i) => (
                <div
                  key={i}
                  className="legend-segment"
                  style={{ background: stop.color }}
                />
              ))}
            </div>
            <div className="legend-labels">
              <span>{LEGEND_STOPS[0].db} dB</span>
              <span>{LEGEND_STOPS[LEGEND_STOPS.length - 1].db} dB</span>
            </div>
          </div>
        )}

        <label className="layer-toggle">
          <input
            type="checkbox"
            checked={heliportsVisible}
            onChange={toggleHeliports}
            disabled={status !== 'ready'}
          />
          <span className="layer-label">Heliports</span>
        </label>

        <label className="layer-toggle">
          <input
            type="checkbox"
            checked={superfundVisible}
            onChange={toggleSuperfund}
            disabled={status !== 'ready'}
          />
          <span className="layer-label">
            Superfund Sites
            {superfundLoading && <span className="layer-loading"> ⏳</span>}
          </span>
        </label>
        {superfundVisible && (
          <div className="superfund-legend">
            <div className="legend-swatch-row">
              <span className="legend-swatch" />
              <span>NPL Site Boundary</span>
            </div>
          </div>
        )}

        <label className="layer-toggle">
          <input
            type="checkbox"
            checked={transitVisible}
            onChange={toggleTransit}
            disabled={status !== 'ready'}
          />
          <span className="layer-label">
            Public Transit
            {transitLoading && <span className="layer-loading"> ⏳</span>}
          </span>
        </label>
        {transitVisible && (
          <div className="transit-legend">
            {Object.entries(TRANSIT_COLORS).map(([type, color]) => (
              <div key={type} className="legend-swatch-row">
                <span className="legend-dot" style={{ background: color }} />
                <span>{TRANSIT_LABELS[type as TransitStop['type']]}</span>
              </div>
            ))}
          </div>
        )}

        <label className="layer-toggle">
          <input
            type="checkbox"
            checked={schoolsVisible}
            onChange={toggleSchools}
            disabled={status !== 'ready'}
          />
          <span className="layer-label">
            Schools
            {schoolsLoading && <span className="layer-loading"> ⏳</span>}
          </span>
        </label>
        {schoolsVisible && (
          <div className="school-legend">
            {(Object.entries(SCHOOL_COLORS) as [SchoolCategory, string][]).map(([cat, color]) => (
              <div key={cat} className="legend-swatch-row">
                <span className="legend-dot" style={{ background: color }} />
                <span>{SCHOOL_LABELS[cat]}</span>
              </div>
            ))}
          </div>
        )}

        <label className="layer-toggle">
          <input
            type="checkbox"
            checked={trafficVisible}
            onChange={toggleTraffic}
            disabled={status !== 'ready'}
          />
          <span className="layer-label">Traffic Flow</span>
        </label>
        {trafficVisible && (
          <div className="traffic-legend">
            <div className="legend-bar">
              <div className="legend-segment" style={{ background: '#00b050' }} />
              <div className="legend-segment" style={{ background: '#ffff00' }} />
              <div className="legend-segment" style={{ background: '#ff8000' }} />
              <div className="legend-segment" style={{ background: '#ff0000' }} />
              <div className="legend-segment" style={{ background: '#800000' }} />
            </div>
            <div className="legend-labels">
              <span>Free flow</span>
              <span>Congested</span>
            </div>
            <div className="traffic-note">Real-time data only</div>
          </div>
        )}
      </aside>
    </div>
  )
}

export default MapPage
