import { useEffect, useRef, useState, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './MapPage.css'
import logo from '../assets/landrecon-logo.webp'
import {
  createNoiseLayer,
  queryNoiseLevelAtPoint,
  LEGEND_BANDS,
} from '../noise/airportNoise'

const NOISE_PMTILES_URL =
  import.meta.env.VITE_NOISE_PMTILES_URL || '/data/airport-noise.pmtiles'

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

const LEGEND_STOPS = LEGEND_BANDS

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
    fetchOverpass(osmQuery).then((d) => d ?? { elements: [] }),
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

// Overpass requests are routed through a same-origin nginx proxy (see
// nginx.conf and vite.config.ts) that injects a non-Mozilla User-Agent.
// overpass-api.de returns 406 to generic browser UAs, and the browser's
// CORS preflight UA cannot be overridden from JavaScript, so the proxy
// is required.
const OVERPASS_ENDPOINTS = ['/overpass', '/overpass2']

interface OverpassElement {
  type?: string
  id?: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
  geometry?: { lat: number; lon: number }[]
  members?: { type: string; ref: number }[]
}

interface OverpassResponse {
  elements?: OverpassElement[]
  [key: string]: unknown
}

async function fetchOverpass<T = OverpassResponse>(
  query: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T | null> {
  const { timeoutMs = 20000, signal: externalSignal } = opts
  const body = `data=${encodeURIComponent(query)}`
  let lastErr: unknown = null
  for (const url of OVERPASS_ENDPOINTS) {
    if (externalSignal?.aborted) break
    // Retry up to 2 times on 504/429 for each endpoint
    for (let attempt = 0; attempt < 2; attempt++) {
      if (externalSignal?.aborted) break
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt))
      const ctrl = new AbortController()
      const onExternalAbort = () => ctrl.abort()
      externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
          body,
          signal: ctrl.signal,
        })
        if (res.status === 504 || res.status === 429) {
          lastErr = new Error(`Overpass HTTP ${res.status} at ${url}`)
          continue
        }
        if (!res.ok) {
          lastErr = new Error(`Overpass HTTP ${res.status} at ${url}`)
          break // non-retryable error, try next endpoint
        }
        return (await res.json()) as T
      } catch (err) {
        lastErr = err
        break // network error, try next endpoint
      } finally {
        clearTimeout(timer)
        externalSignal?.removeEventListener('abort', onExternalAbort)
      }
    }
  }
  console.warn('Overpass: all endpoints failed', lastErr)
  return null
}

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

// @ts-ignore: reserved for future use
async function fetchTransitRoutes(bounds: L.LatLngBounds): Promise<TransitRoute[]> {
  const s = bounds.getSouth(), w = bounds.getWest()
  const n = bounds.getNorth(), e = bounds.getEast()
  const bbox = `${s},${w},${n},${e}`
  const query = `[out:json][timeout:25];(
    relation["route"="tram"](${bbox});
    relation["route"="subway"](${bbox});
    relation["route"="light_rail"](${bbox});
  );out body;way(r);out geom;`

  const data = await fetchOverpass(query)
  if (!data?.elements) return []

  const ways = new Map<number, [number, number][]>()
  for (const el of data.elements) {
    if (el.type === 'way' && el.geometry && el.id != null) {
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

  const data = await fetchOverpass(query)
  if (!data?.elements) return []

  // Deduplicate by proximity (some stops have overlapping nodes)
  const seen = new Set<string>()
  const stops: TransitStop[] = []
  for (const el of data.elements) {
    if (el.lat == null || el.lon == null) continue
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
    where: "NPL_STATUS_CODE <> 'D'",
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

const SHARE_LAYER_IDS = ['noise', 'superfund', 'transit', 'schools', 'heliports', 'traffic', 'costco'] as const
type ShareLayerId = typeof SHARE_LAYER_IDS[number]

const COSTCO_ANALYSIS_RADIUS_MI = 100
const COSTCO_GREEN_RADIUS_MI = 30
const HELIPORTS_ENABLED = false
const SCHOOLS_ENABLED = false

function costcoSeverity(distMi: number): 'good' | 'warning' | 'danger' {
  if (distMi <= COSTCO_GREEN_RADIUS_MI) return 'good'
  if (distMi <= 50) return 'warning'
  return 'danger'
}

async function shortenUrl(longUrl: string, timeoutMs = 6000): Promise<string> {
  const api = `https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`
  const res = await fetch(api, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`shortener returned HTTP ${res.status}`)
  const text = (await res.text()).trim()
  if (!/^https?:\/\//i.test(text)) throw new Error('shortener returned non-URL response')
  return text
}

interface TomTomSuggestion {
  id: string
  type: string
  address: {
    streetNumber?: string
    streetName?: string
    municipality?: string
    countrySubdivision?: string
    postalCode?: string
    freeformAddress?: string
  }
  position?: { lat: number; lon: number }
}

function formatTomTomAddress(s: TomTomSuggestion): string {
  const a = s.address
  if (!a) return ''
  const street = [a.streetNumber, a.streetName].filter(Boolean).join(' ')
  const parts = [street, a.municipality, a.countrySubdivision].filter(Boolean)
  if (a.postalCode) parts.push(a.postalCode)
  return parts.join(', ') || a.freeformAddress || ''
}

function MapPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const address = searchParams.get('address') || ''
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const baseLayerRef = useRef<L.TileLayer | null>(null)
  const noiseLayerRef = useRef<L.Layer | null>(null)
  const airportLayerRef = useRef<L.LayerGroup | null>(null)
  const airportLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const airportKnownIdsRef = useRef<Set<string>>(new Set())
  const superfundLayerRef = useRef<L.GeoJSON | null>(null)
  const superfundLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const transitLayerRef = useRef<L.LayerGroup | null>(null)
  const transitSubLayersRef = useRef<Record<TransitStop['type'], L.LayerGroup> | null>(null)
  const transitLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const transitLastZoomRef = useRef<number>(0)
  const schoolLayerRef = useRef<L.LayerGroup | null>(null)
  const schoolLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const heliportLayerRef = useRef<L.LayerGroup | null>(null)
  const heliportLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const heliportKnownIdsRef = useRef<Set<string>>(new Set())
  const costcoLayerRef = useRef<L.LayerGroup | null>(null)
  const costcoLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const costcoKnownIdsRef = useRef<Set<string>>(new Set())
  const trafficLayerRef = useRef<L.TileLayer | null>(null)
  const initialUrlStateAppliedRef = useRef(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [noiseVisible, setNoiseVisible] = useState(false)
  const [superfundVisible, setSuperfundVisible] = useState(false)
  const [superfundLoading, setSuperfundLoading] = useState(false)
  const [transitVisible, setTransitVisible] = useState(false)
  const [transitLoading, setTransitLoading] = useState(false)
  const [transitSubVisible, setTransitSubVisible] = useState<Record<TransitStop['type'], boolean>>({
    rail: true, subway: true, tram: true, bus: true,
  })
  const transitSubVisibleRef = useRef(transitSubVisible)
  const [schoolsVisible, setSchoolsVisible] = useState(false)
  const [schoolsLoading, setSchoolsLoading] = useState(false)
  const [heliportsVisible, setHeliportsVisible] = useState(false)
  const [costcoVisible, setCostcoVisible] = useState(false)
  const [trafficVisible, setTrafficVisible] = useState(false)
  const [activeBaseMap, setActiveBaseMap] = useState<BaseMapId>('street')
  const [analysisResults, setAnalysisResults] = useState<{
    loading: boolean
    noiseLevel: number | null
    noiseAirport: string | null
    noiseAirportCode: string | null
    heliports: { name: string; distanceMi: number }[]
    superfunds: { name: string; distanceMi: number; status: string; url: string }[]
    costco: { osmId: string; name: string; city: string; distanceMi: number; lat: number; lng: number } | null
    costcoNearby: { osmId: string; name: string; city: string; distanceMi: number; lat: number; lng: number }[]
    costcoError: boolean
  }>({ loading: true, noiseLevel: null, noiseAirport: null, noiseAirportCode: null, heliports: [], superfunds: [], costco: null, costcoNearby: [], costcoError: false })
  const [analysisDetail, setAnalysisDetail] = useState<'noise' | 'heliports' | 'superfunds' | 'costco' | null>(null)

  const [shareModalOpen, setShareModalOpen] = useState(false)
  const [shareLoading, setShareLoading] = useState(false)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [shareLongUrl, setShareLongUrl] = useState<string | null>(null)
  const [shareError, setShareError] = useState<string | null>(null)
  const [shareCopied, setShareCopied] = useState(false)

  const [editingAddress, setEditingAddress] = useState(false)
  const [addressInputValue, setAddressInputValue] = useState('')
  const [addressSuggestions, setAddressSuggestions] = useState<TomTomSuggestion[]>([])
  const [showAddressSuggestions, setShowAddressSuggestions] = useState(false)
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1)
  const addressDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const addressWrapperRef = useRef<HTMLDivElement>(null)
  const addressInputRef = useRef<HTMLInputElement>(null)

  const [layerPanelOpen, setLayerPanelOpen] = useState(false)
  const [analysisPanelOpen, setAnalysisPanelOpen] = useState(false)
  const [showFabHints, setShowFabHints] = useState(false)

  // Show FAB tooltip hints once on mobile, dismiss on first tap
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    if (!mq.matches) return
    if (localStorage.getItem('lr_fab_hints_seen')) return
    const showTimer = setTimeout(() => setShowFabHints(true), 800)
    return () => clearTimeout(showTimer)
  }, [])

  const buildShareUrl = useCallback((): string => {
    const params = new URLSearchParams()
    if (address) params.set('address', address)
    const active: ShareLayerId[] = []
    if (noiseVisible) active.push('noise')
    if (superfundVisible) active.push('superfund')
    if (transitVisible) active.push('transit')
    if (schoolsVisible) active.push('schools')
    if (heliportsVisible) active.push('heliports')
    if (trafficVisible) active.push('traffic')
    if (costcoVisible) active.push('costco')
    if (active.length > 0) params.set('layers', active.join(','))
    if (activeBaseMap !== 'street') params.set('base', activeBaseMap)
    return `${window.location.origin}/map?${params.toString()}`
  }, [address, noiseVisible, superfundVisible, transitVisible, schoolsVisible, heliportsVisible, trafficVisible, costcoVisible, activeBaseMap])

  const handleShare = useCallback(async () => {
    const longUrl = buildShareUrl()
    setShareModalOpen(true)
    setShareLoading(true)
    setShareError(null)
    setShareCopied(false)
    setShareLongUrl(longUrl)
    setShareUrl(null)
    try {
      const short = await shortenUrl(longUrl)
      setShareUrl(short)
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Could not shorten URL')
      setShareUrl(longUrl)
    } finally {
      setShareLoading(false)
    }
  }, [buildShareUrl])

  const handleCopyShare = useCallback(async () => {
    const value = shareUrl || shareLongUrl
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setShareCopied(true)
      setTimeout(() => setShareCopied(false), 2000)
    } catch {
      setShareError('Clipboard access denied — please copy manually.')
    }
  }, [shareUrl, shareLongUrl])

  const closeShareModal = useCallback(() => {
    setShareModalOpen(false)
    setShareCopied(false)
    setShareError(null)
  }, [])

  const cancelEditingAddress = useCallback(() => {
    setEditingAddress(false)
    setAddressSuggestions([])
    setShowAddressSuggestions(false)
    setActiveSuggestionIndex(-1)
    if (addressDebounceRef.current) {
      clearTimeout(addressDebounceRef.current)
      addressDebounceRef.current = null
    }
  }, [])

  const startEditingAddress = useCallback(() => {
    setAddressInputValue(address)
    setAddressSuggestions([])
    setShowAddressSuggestions(false)
    setActiveSuggestionIndex(-1)
    setEditingAddress(true)
  }, [address])

  const fetchAddressSuggestions = useCallback((query: string) => {
    if (addressDebounceRef.current) clearTimeout(addressDebounceRef.current)
    if (query.length < 3) {
      setAddressSuggestions([])
      setShowAddressSuggestions(false)
      return
    }
    addressDebounceRef.current = setTimeout(async () => {
      try {
        const url = `https://api.tomtom.com/search/2/search/${encodeURIComponent(query)}.json?key=${TOMTOM_API_KEY}&countrySet=US&typeahead=true&limit=5&language=en-US`
        const res = await fetch(url)
        const data = await res.json()
        const results: TomTomSuggestion[] = data.results || []
        setAddressSuggestions(results)
        setShowAddressSuggestions(results.length > 0)
        setActiveSuggestionIndex(-1)
      } catch {
        setAddressSuggestions([])
        setShowAddressSuggestions(false)
      }
    }, 300)
  }, [])

  const submitAddressChange = useCallback((newAddress: string) => {
    const trimmed = newAddress.trim()
    if (!trimmed) {
      cancelEditingAddress()
      return
    }
    if (trimmed === address) {
      cancelEditingAddress()
      return
    }
    const params = new URLSearchParams(searchParams)
    params.set('address', trimmed)
    cancelEditingAddress()
    navigate(`/map?${params.toString()}`)
  }, [address, searchParams, navigate, cancelEditingAddress])

  const selectAddressSuggestion = useCallback((suggestion: TomTomSuggestion) => {
    submitAddressChange(formatTomTomAddress(suggestion))
  }, [submitAddressChange])

  const handleAddressKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (showAddressSuggestions && addressSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveSuggestionIndex((prev) => (prev < addressSuggestions.length - 1 ? prev + 1 : 0))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveSuggestionIndex((prev) => (prev > 0 ? prev - 1 : addressSuggestions.length - 1))
        return
      }
      if (e.key === 'Enter' && activeSuggestionIndex >= 0) {
        e.preventDefault()
        selectAddressSuggestion(addressSuggestions[activeSuggestionIndex])
        return
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      submitAddressChange(addressInputValue)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEditingAddress()
    }
  }, [showAddressSuggestions, addressSuggestions, activeSuggestionIndex, addressInputValue, selectAddressSuggestion, submitAddressChange, cancelEditingAddress])

  useEffect(() => {
    if (!editingAddress) return
    const handleClickOutside = (e: MouseEvent) => {
      if (addressWrapperRef.current && !addressWrapperRef.current.contains(e.target as Node)) {
        cancelEditingAddress()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [editingAddress, cancelEditingAddress])

  useEffect(() => {
    if (editingAddress && addressInputRef.current) {
      addressInputRef.current.focus()
      addressInputRef.current.select()
    }
  }, [editingAddress])

  useEffect(() => {
    return () => {
      if (addressDebounceRef.current) clearTimeout(addressDebounceRef.current)
    }
  }, [])

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

      const data = await fetchOverpass(query)
      if (!data?.elements || data.elements.length === 0) return

      const known = airportKnownIdsRef.current
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
          html: `<div class="airport-pin">✈</div>`,
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        })
        L.marker([lat, lon], { icon }).bindTooltip(label, { direction: 'top', offset: [0, -16] }).addTo(layer)
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

      const data = await fetchOverpass(query)
      if (!data?.elements || data.elements.length === 0) return

      const known = heliportKnownIdsRef.current
      for (const el of data.elements) {
        const id = `${el.type}-${el.id}`
        if (known.has(id)) continue

        const lat = el.lat ?? el.center?.lat
        const lon = el.lon ?? el.center?.lon
        if (lat == null || lon == null) continue
        const tags = el.tags || {}
        const name = tags.name || tags.official_name || tags.description || ''
        if (!name) continue
        const label = name

        const icon = L.divIcon({
          className: 'heliport-label',
          html: `<div class="heliport-pin">🚁</div>`,
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        })
        L.marker([lat, lon], { icon }).bindTooltip(label, { direction: 'top', offset: [0, -16] }).addTo(layer)
        known.add(id)
      }

      heliportLoadedBoundsRef.current = loaded ? loaded.extend(padded.getSouthWest()).extend(padded.getNorthEast()) : padded
    } catch (err) {
      console.warn('Heliport label fetch failed:', err)
    }
  }, [])

  const loadCostcoLabels = useCallback(async (map: L.Map, layer: L.LayerGroup) => {
    const bounds = map.getBounds()
    const loaded = costcoLoadedBoundsRef.current
    if (loaded && loaded.contains(bounds)) return

    try {
      const padded = bounds.pad(1.0)
      const s = padded.getSouth(), w = padded.getWest()
      const n = padded.getNorth(), e = padded.getEast()
      const bbox = `${s},${w},${n},${e}`
      const query = `[out:json][timeout:15];(
        node["brand"="Costco"]["shop"](${bbox});
        way["brand"="Costco"]["shop"](${bbox});
        relation["brand"="Costco"]["shop"](${bbox});
        node["brand:wikidata"="Q715583"]["shop"](${bbox});
        way["brand:wikidata"="Q715583"]["shop"](${bbox});
        relation["brand:wikidata"="Q715583"]["shop"](${bbox});
      );out body center;`

      const data = await fetchOverpass(query)
      if (!data?.elements || data.elements.length === 0) {
        costcoLoadedBoundsRef.current = loaded ? loaded.extend(padded.getSouthWest()).extend(padded.getNorthEast()) : padded
        return
      }

      const known = costcoKnownIdsRef.current
      for (const el of data.elements) {
        const id = `${el.type}-${el.id}`
        if (known.has(id)) continue

        const elLat = el.lat ?? el.center?.lat
        const elLon = el.lon ?? el.center?.lon
        if (elLat == null || elLon == null) continue
        const tags = el.tags || {}
        const city = tags['addr:city'] || ''
        const state = tags['addr:state'] || ''
        const branch = tags.branch || ''
        const locality = branch || [city, state].filter(Boolean).join(', ')
        const tooltip = locality ? `Costco — ${locality}` : 'Costco'

        const icon = L.divIcon({
          className: 'costco-label',
          html: `<div class="costco-pin">C</div>`,
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        })
        L.marker([elLat, elLon], { icon }).bindTooltip(tooltip, { direction: 'top', offset: [0, -16] }).addTo(layer)
        known.add(id)
      }

      costcoLoadedBoundsRef.current = loaded ? loaded.extend(padded.getSouthWest()).extend(padded.getNorthEast()) : padded
    } catch (err) {
      console.warn('Costco label fetch failed:', err)
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

      // Clear all sublayers
      let subLayers = transitSubLayersRef.current
      if (!subLayers) {
        subLayers = {
          rail: L.layerGroup(),
          subway: L.layerGroup(),
          tram: L.layerGroup(),
          bus: L.layerGroup(),
        }
        transitSubLayersRef.current = subLayers
        // Add only currently-visible sublayers to the parent group
        for (const t of Object.keys(subLayers) as TransitStop['type'][]) {
          if (transitSubVisibleRef.current[t]) {
            subLayers[t].addTo(layer)
          }
        }
      }
      for (const t of Object.keys(subLayers) as TransitStop['type'][]) {
        subLayers[t].clearLayers()
      }

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
          .addTo(subLayers[route.type])
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
          .addTo(subLayers.bus)
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
          .addTo(subLayers[stop.type])
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
    const center = map.getCenter()
    // 5 mile radius in degrees (approx)
    const radiusDeg = 5 / 69
    const bounds = L.latLngBounds(
      [center.lat - radiusDeg, center.lng - radiusDeg * 1.3],
      [center.lat + radiusDeg, center.lng + radiusDeg * 1.3]
    )
    const loaded = schoolLoadedBoundsRef.current
    if (loaded && loaded.contains(bounds)) return

    setSchoolsLoading(true)
    try {
      const schools = await fetchSchools(bounds)
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
        }).bindTooltip(school.name, { direction: 'top', offset: [0, -6], className: 'location-tooltip' })
        newMarkers.push(marker)
      }
      // Swap: clear old, add new in one batch
      layer.clearLayers()
      for (const m of newMarkers) m.addTo(layer)
      schoolLoadedBoundsRef.current = bounds
    } catch (err) {
      console.error('Failed to load school data:', err)
    } finally {
      setSchoolsLoading(false)
    }
  }, [])

  const runLocationAnalysis = useCallback(async (lat: number, lng: number) => {
    setAnalysisResults({ loading: true, noiseLevel: null, noiseAirport: null, noiseAirportCode: null, heliports: [], superfunds: [], costco: null, costcoNearby: [], costcoError: false })

    const location = L.latLng(lat, lng)
    const milesToMeters = 1609.34
    const TIMEOUT = 10000

    // Run all checks in parallel with timeouts
    const [noiseResult, heliportResult, superfundResult, costcoResult] = await Promise.allSettled([
      // Check noise via PMTiles vector query, then find nearest airport
      (async () => {
        const band = await queryNoiseLevelAtPoint(NOISE_PMTILES_URL, lat, lng)
        if (!band) return null
        // `level` retains the legacy contract used by the analysis UI:
        // the lower edge of the dB band containing the point.
        const level = band.dbMin

        // Find the nearest airport
        let airportName: string | null = null
        let airportCode: string | null = null
        try {
          const radiusDeg = (15 * milesToMeters) / 111320
          const bbox = `${lat - radiusDeg},${lng - radiusDeg * 1.5},${lat + radiusDeg},${lng + radiusDeg * 1.5}`
          const query = `[out:json][timeout:15];(
            node["aeroway"="aerodrome"](${bbox});
            way["aeroway"="aerodrome"](${bbox});
            relation["aeroway"="aerodrome"](${bbox});
          );out body center;`
          const res = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'LandRecon/1.0' },
            body: `data=${encodeURIComponent(query)}`,
            signal: AbortSignal.timeout(15000),
          })
          if (res.ok) {
            const data = await res.json()
            let minDist = Infinity
            for (const el of data.elements || []) {
              const elLat = el.lat ?? el.center?.lat
              const elLon = el.lon ?? el.center?.lon
              if (elLat == null || elLon == null) continue
              const dist = location.distanceTo(L.latLng(elLat, elLon))
              if (dist < minDist) {
                minDist = dist
                airportName = el.tags?.name || el.tags?.official_name || 'Unknown Airport'
                airportCode = el.tags?.iata || el.tags?.['iata:code'] || el.tags?.ref || null
              }
            }
          }
        } catch {
          // Airport name lookup failed
        }

        return { level, airport: airportName, code: airportCode }
      })(),

      // Check heliports within 3 miles
      (async () => {
        if (!HELIPORTS_ENABLED) return [] as { name: string; distanceMi: number }[]
        const radiusDeg = (3 * milesToMeters) / 111320
        const bbox = `${lat - radiusDeg},${lng - radiusDeg * 1.3},${lat + radiusDeg},${lng + radiusDeg * 1.3}`
        const query = `[out:json][timeout:10];(
          node["aeroway"="helipad"](${bbox});
          way["aeroway"="helipad"](${bbox});
          node["aeroway"="heliport"](${bbox});
          way["aeroway"="heliport"](${bbox});
        );out body center;`
        const data = await fetchOverpass(query, { timeoutMs: TIMEOUT, signal: AbortSignal.timeout(TIMEOUT) })
        if (!data?.elements) return []
        const results: { name: string; distanceMi: number }[] = []
        for (const el of data.elements) {
          const elLat = el.lat ?? el.center?.lat
          const elLon = el.lon ?? el.center?.lon
          if (elLat == null || elLon == null) continue
          const dist = location.distanceTo(L.latLng(elLat, elLon))
          const distMi = dist / milesToMeters
          if (distMi <= 3) {
            const name = el.tags?.name || el.tags?.official_name || el.tags?.operator || el.tags?.description || ''
            if (!name) continue
            results.push({ name, distanceMi: Math.round(distMi * 10) / 10 })
          }
        }
        results.sort((a, b) => a.distanceMi - b.distanceMi)
        return results
      })(),

      // Check Superfund sites within 5 miles
      (async () => {
        const radiusDeg = (5 * milesToMeters) / 111320
        const env = `${lng - radiusDeg * 1.3},${lat - radiusDeg},${lng + radiusDeg * 1.3},${lat + radiusDeg}`
        const params = new URLSearchParams({
          where: "NPL_STATUS_CODE <> 'D'",
          outFields: 'SITE_NAME,NPL_STATUS_CODE,URL_ALIAS_TXT',
          geometry: env,
          geometryType: 'esriGeometryEnvelope',
          spatialRel: 'esriSpatialRelIntersects',
          inSR: '4326',
          outSR: '4326',
          returnCentroid: 'true',
          f: 'json',
          resultRecordCount: '50',
        })
        const res = await fetch(`${SUPERFUND_API}?${params}`, {
          signal: AbortSignal.timeout(TIMEOUT),
        })
        if (!res.ok) return []
        const data = await res.json()
        const results: { name: string; distanceMi: number; status: string; url: string }[] = []
        for (const feat of data.features || []) {
          const centroid = feat.centroid || feat.geometry
          if (!centroid) continue
          const cLat = centroid.y ?? centroid.coordinates?.[1]
          const cLon = centroid.x ?? centroid.coordinates?.[0]
          if (cLat == null || cLon == null) continue
          const dist = location.distanceTo(L.latLng(cLat, cLon))
          const distMi = dist / milesToMeters
          if (distMi <= 5) {
            const statusCode = feat.attributes?.NPL_STATUS_CODE || ''
            const statusLabel = statusCode === 'F' ? 'Final' : statusCode === 'P' ? 'Proposed' : statusCode === 'D' ? 'Deleted' : statusCode
            const urlAlias = feat.attributes?.URL_ALIAS_TXT || ''
            results.push({
              name: feat.attributes?.SITE_NAME || 'Unknown',
              distanceMi: Math.round(distMi * 10) / 10,
              status: statusLabel,
              url: urlAlias,
            })
          }
        }
        results.sort((a, b) => a.distanceMi - b.distanceMi)
        return results
      })(),

      // Find every Costco within COSTCO_ANALYSIS_RADIUS_MI (so we can drop
      // them all on the auto-enabled layer) and pick the nearest one for the
      // analysis card.
      (async () => {
        type CostcoHit = { osmId: string; name: string; city: string; distanceMi: number; lat: number; lng: number }
        const radiusDeg = (COSTCO_ANALYSIS_RADIUS_MI * milesToMeters) / 111320
        const bbox = `${lat - radiusDeg},${lng - radiusDeg * 1.3},${lat + radiusDeg},${lng + radiusDeg * 1.3}`
        const query = `[out:json][timeout:30];(
          node["brand"="Costco"]["shop"](${bbox});
          way["brand"="Costco"]["shop"](${bbox});
          relation["brand"="Costco"]["shop"](${bbox});
          node["brand:wikidata"="Q715583"]["shop"](${bbox});
          way["brand:wikidata"="Q715583"]["shop"](${bbox});
          relation["brand:wikidata"="Q715583"]["shop"](${bbox});
        );out body center;`
        const data = await fetchOverpass(query, { timeoutMs: 35000, signal: AbortSignal.timeout(35000) })
        if (!data?.elements) return { nearest: null as CostcoHit | null, nearby: [] as CostcoHit[] }
        const seen = new Set<string>()
        const hits: CostcoHit[] = []
        for (const el of data.elements) {
          const id = `${el.type}-${el.id}`
          if (seen.has(id)) continue
          seen.add(id)
          const elLat = el.lat ?? el.center?.lat
          const elLon = el.lon ?? el.center?.lon
          if (elLat == null || elLon == null) continue
          const dist = location.distanceTo(L.latLng(elLat, elLon))
          const distMi = dist / milesToMeters
          if (distMi > COSTCO_ANALYSIS_RADIUS_MI) continue
          const tags = el.tags || {}
          const city = tags['addr:city'] || ''
          const state = tags['addr:state'] || ''
          const branch = tags.branch || ''
          const locality = branch || [city, state].filter(Boolean).join(', ')
          hits.push({
            osmId: id,
            name: tags.name || 'Costco',
            city: locality,
            distanceMi: Math.round(distMi * 10) / 10,
            lat: elLat,
            lng: elLon,
          })
        }
        hits.sort((a, b) => a.distanceMi - b.distanceMi)
        return { nearest: hits[0] ?? null, nearby: hits }
      })(),
    ])

    const noiseData = noiseResult.status === 'fulfilled' ? noiseResult.value : null
    const noiseLevel = noiseData?.level ?? null
    const noiseAirport = noiseData?.airport ?? null
    const noiseAirportCode = noiseData?.code ?? null
    const heliports = heliportResult.status === 'fulfilled' ? heliportResult.value : []
    const superfunds = superfundResult.status === 'fulfilled' ? superfundResult.value : []
    const costcoData = costcoResult.status === 'fulfilled' ? costcoResult.value : { nearest: null, nearby: [] }
    const costco = costcoData.nearest
    const costcoNearby = costcoData.nearby
    const costcoError = costcoResult.status === 'rejected'

    setAnalysisResults({ loading: false, noiseLevel, noiseAirport, noiseAirportCode, heliports, superfunds, costco, costcoNearby, costcoError })
  }, [])

  useEffect(() => {
    if (!address) {
      navigate('/')
      return
    }

    if (!mapContainer.current) return

    setStatus('loading')
    setErrorMsg('')
    const abortController = new AbortController()
    const geocodeUrl = `https://api.tomtom.com/search/2/geocode/${encodeURIComponent(address)}.json?key=${TOMTOM_API_KEY}&countrySet=US&limit=1`

    fetch(geocodeUrl, {
      signal: abortController.signal,
    })
      .then((res) => res.json())
      .then((data) => {
        const results = data.results
        if (!results || results.length === 0) {
          setStatus('error')
          setErrorMsg('Address not found. Please try a different address.')
          return
        }

        const lat = results[0].position.lat
        const lng = results[0].position.lon

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

        const houseIcon = L.divIcon({
          className: 'location-pin',
          html: `<div class="location-pin-icon">🏠</div>`,
          iconSize: [36, 36],
          iconAnchor: [18, 18],
        })
        L.marker([lat, lng], { icon: houseIcon }).bindTooltip(address, { direction: 'top', offset: [0, -18], className: 'location-tooltip' }).addTo(map)

        // Create noise layer (not added to map until toggled on)
        noiseLayerRef.current = createNoiseLayer(NOISE_PMTILES_URL, { opacity: 0.7 })

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

        // Create Costco label layer (not added to map until toggled on)
        costcoLayerRef.current = L.layerGroup()

        // Create traffic flow layer (not added to map until toggled on)
        trafficLayerRef.current = L.tileLayer(TRAFFIC_TILE_URL, {
          opacity: 0.7,
          maxZoom: 22,
          attribution: '&copy; <a href="https://developer.tomtom.com/">TomTom</a> Traffic',
          errorTileUrl: '',
        })

        mapRef.current = map
        setStatus('ready')

        // Run location analysis
        runLocationAnalysis(lat, lng)

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
      transitSubLayersRef.current = null
      transitLoadedBoundsRef.current = null
      schoolLayerRef.current = null
      schoolLoadedBoundsRef.current = null
      heliportLayerRef.current = null
      heliportLoadedBoundsRef.current = null
      heliportKnownIdsRef.current.clear()
      costcoLayerRef.current = null
      costcoLoadedBoundsRef.current = null
      costcoKnownIdsRef.current.clear()
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
    const layer = noiseLayerRef.current as L.GridLayer | null
    const airportLayer = airportLayerRef.current
    if (!map || !layer) return

    if (noiseVisible) {
      map.removeLayer(layer)
      if (airportLayer) map.removeLayer(airportLayer)
      map.off('moveend', handleAirportMove)
    } else {
      // Clear any analysis-constrained bounds
      delete (layer.options as L.GridLayerOptions).bounds
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

  const handleCostcoMove = useCallback(() => {
    const map = mapRef.current
    const layer = costcoLayerRef.current
    if (map && layer) {
      loadCostcoLabels(map, layer)
    }
  }, [loadCostcoLabels])

  const toggleCostco = () => {
    const map = mapRef.current
    const layer = costcoLayerRef.current
    if (!map || !layer) return

    if (costcoVisible) {
      map.removeLayer(layer)
      map.off('moveend', handleCostcoMove)
    } else {
      layer.addTo(map)
      costcoLoadedBoundsRef.current = null
      costcoKnownIdsRef.current.clear()
      layer.clearLayers()
      loadCostcoLabels(map, layer)
      map.on('moveend', handleCostcoMove)
    }
    setCostcoVisible(!costcoVisible)
  }

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
      // Sync sublayer visibility with current sub-toggle state
      const subLayers = transitSubLayersRef.current
      if (subLayers) {
        for (const t of Object.keys(subLayers) as TransitStop['type'][]) {
          subLayers[t].clearLayers()
        }
      }
      loadTransitData(map, layer)
      map.on('moveend', handleTransitMove)
    }
    setTransitVisible(!transitVisible)
  }

  const toggleTransitSub = (type: TransitStop['type']) => {
    const map = mapRef.current
    const parentLayer = transitLayerRef.current
    const subLayers = transitSubLayersRef.current
    if (!map || !parentLayer || !subLayers) return

    const nowVisible = !transitSubVisible[type]
    const next = { ...transitSubVisible, [type]: nowVisible }
    setTransitSubVisible(next)
    transitSubVisibleRef.current = next

    if (nowVisible) {
      subLayers[type].addTo(parentLayer)
      // Reload to populate the sublayer if it was emptied
      transitLoadedBoundsRef.current = null
      loadTransitData(map, parentLayer)
    } else {
      parentLayer.removeLayer(subLayers[type])
    }
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
    } else {
      layer.addTo(map)
      schoolLoadedBoundsRef.current = null
      loadSchoolData(map, layer)
    }
    setSchoolsVisible(!schoolsVisible)
  }

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

  // Restore layer + base-map state from URL params (one-shot, when map becomes ready)
  useEffect(() => {
    if (status !== 'ready') return
    if (initialUrlStateAppliedRef.current) return
    initialUrlStateAppliedRef.current = true

    const baseParam = searchParams.get('base') as BaseMapId | null
    if (baseParam && baseParam !== activeBaseMap && BASE_MAPS[baseParam]) {
      switchBaseMap(baseParam)
    }

    const layersParam = searchParams.get('layers')
    if (!layersParam) return
    const requested = new Set(layersParam.split(',').map((s) => s.trim()))
    if (requested.has('noise')) toggleNoise()
    if (requested.has('superfund')) toggleSuperfund()
    if (requested.has('transit')) toggleTransit()
    if (requested.has('schools') && SCHOOLS_ENABLED) toggleSchools()
    if (requested.has('heliports') && HELIPORTS_ENABLED) toggleHeliports()
    if (requested.has('traffic')) toggleTraffic()
    if (requested.has('costco')) toggleCostco()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  // Auto-enable layers when analysis finds warnings and zoom to show issues
  useEffect(() => {
    if (analysisResults.loading) return
    const map = mapRef.current
    if (!map) return

    const center = map.getCenter()
    const milesToMeters = 1609.34
    let maxRadiusMeters = 0

    if (analysisResults.noiseLevel && !noiseVisible) {
      const layer = noiseLayerRef.current as L.GridLayer | null
      const airportLayer = airportLayerRef.current
      if (layer) {
        // Constrain noise tiles to the area around the location.
        // protomaps-leaflet's `leafletLayer` extends L.GridLayer, so the
        // GridLayer `bounds` option still filters which tiles get fetched.
        const noiseDeg = (5 * milesToMeters) / 111320
        const noiseBounds = L.latLngBounds(
          [center.lat - noiseDeg, center.lng - noiseDeg * 1.5],
          [center.lat + noiseDeg, center.lng + noiseDeg * 1.5]
        )
        ;(layer.options as L.GridLayerOptions).bounds = noiseBounds
        layer.addTo(map)
        if (airportLayer) {
          airportLayer.addTo(map)
          airportLoadedBoundsRef.current = null
          airportKnownIdsRef.current.clear()
          airportLayer.clearLayers()
          // Only load airports within the noise area
          const origGetBounds = map.getBounds.bind(map)
          map.getBounds = () => noiseBounds
          loadAirportLabels(map, airportLayer)
          map.getBounds = origGetBounds
          map.on('moveend', handleAirportMove)
        }
        setNoiseVisible(true)
      }
      // Noise corridors typically extend ~3-5 miles from airport
      maxRadiusMeters = Math.max(maxRadiusMeters, 5 * milesToMeters)
    }

    if (analysisResults.heliports.length > 0 && !heliportsVisible) {
      const layer = heliportLayerRef.current
      if (layer) {
        layer.addTo(map)
        heliportLoadedBoundsRef.current = null
        heliportKnownIdsRef.current.clear()
        layer.clearLayers()
        // Only show the specific heliports found by analysis (within 3mi)
        // Re-query with tight bounds matching the 3mi radius
        const radiusDeg = (3 * milesToMeters) / 111320
        const constrainedBounds = L.latLngBounds(
          [center.lat - radiusDeg, center.lng - radiusDeg * 1.3],
          [center.lat + radiusDeg, center.lng + radiusDeg * 1.3]
        )
        // Load only within 3mi and filter by distance
        const s = constrainedBounds.getSouth(), w = constrainedBounds.getWest()
        const n = constrainedBounds.getNorth(), e = constrainedBounds.getEast()
        const bbox = `${s},${w},${n},${e}`
        const query = `[out:json][timeout:15];(
          node["aeroway"="helipad"](${bbox});
          way["aeroway"="helipad"](${bbox});
          relation["aeroway"="helipad"](${bbox});
          node["aeroway"="heliport"](${bbox});
          way["aeroway"="heliport"](${bbox});
          relation["aeroway"="heliport"](${bbox});
        );out body center;`
        fetchOverpass(query).then(data => {
          if (!data?.elements) return
          const known = heliportKnownIdsRef.current
          for (const el of data.elements) {
            const id = `${el.type}-${el.id}`
            if (known.has(id)) continue
            const elLat = el.lat ?? el.center?.lat
            const elLon = el.lon ?? el.center?.lon
            if (elLat == null || elLon == null) continue
            // Filter to 3mi radius
            const dist = center.distanceTo(L.latLng(elLat, elLon))
            if (dist > 3 * milesToMeters) continue
            const tags = el.tags || {}
            const name = tags.name || tags.official_name || tags.operator || tags.description || ''
            if (!name) continue
            const icon = L.divIcon({
              className: 'heliport-label',
              html: `<div class="heliport-pin">🚁</div>`,
              iconSize: [32, 32],
              iconAnchor: [16, 16],
            })
            L.marker([elLat, elLon], { icon }).bindTooltip(name, { direction: 'top', offset: [0, -16] }).addTo(layer)
            known.add(id)
          }
          heliportLoadedBoundsRef.current = constrainedBounds
        }).catch(() => {})
        // Don't attach moveend — keep constrained to 3mi
        setHeliportsVisible(true)
      }
      const farthest = analysisResults.heliports[analysisResults.heliports.length - 1]
      if (farthest) {
        maxRadiusMeters = Math.max(maxRadiusMeters, farthest.distanceMi * milesToMeters * 1.2)
      }
    }

    if (analysisResults.superfunds.length > 0 && !superfundVisible) {
      const layer = superfundLayerRef.current
      if (layer) {
        layer.addTo(map)
        superfundLoadedBoundsRef.current = null
        // Only load superfund sites within 5mi radius with distance filter
        const radiusDeg = (5 * milesToMeters) / 111320
        const constrainedBounds = L.latLngBounds(
          [center.lat - radiusDeg, center.lng - radiusDeg * 1.3],
          [center.lat + radiusDeg, center.lng + radiusDeg * 1.3]
        )
        const env = `${constrainedBounds.getWest()},${constrainedBounds.getSouth()},${constrainedBounds.getEast()},${constrainedBounds.getNorth()}`
        const params = new URLSearchParams({
          where: '1=1',
          outFields: SUPERFUND_FIELDS,
          geometry: env,
          geometryType: 'esriGeometryEnvelope',
          spatialRel: 'esriSpatialRelIntersects',
          inSR: '4326',
          outSR: '4326',
          f: 'geojson',
          resultRecordCount: '100',
        })
        fetch(`${SUPERFUND_API}?${params}`)
          .then(res => res.ok ? res.json() : null)
          .then(geojson => {
            if (!geojson?.features) return
            // Filter features to 5mi radius
            const filtered = {
              ...geojson,
              features: geojson.features.filter((feat: any) => {
                const coords = feat.geometry?.coordinates
                if (!coords) return false
                // For polygons, use centroid approximation (first ring avg)
                let fLat: number, fLon: number
                if (feat.geometry.type === 'Point') {
                  fLon = coords[0]; fLat = coords[1]
                } else if (feat.geometry.type === 'Polygon') {
                  const ring = coords[0]
                  fLon = ring.reduce((s: number, c: number[]) => s + c[0], 0) / ring.length
                  fLat = ring.reduce((s: number, c: number[]) => s + c[1], 0) / ring.length
                } else if (feat.geometry.type === 'MultiPolygon') {
                  const ring = coords[0][0]
                  fLon = ring.reduce((s: number, c: number[]) => s + c[0], 0) / ring.length
                  fLat = ring.reduce((s: number, c: number[]) => s + c[1], 0) / ring.length
                } else {
                  return true
                }
                const dist = center.distanceTo(L.latLng(fLat, fLon))
                return dist <= 5 * milesToMeters
              }),
            }
            layer.clearLayers()
            layer.addData(filtered)
            superfundLoadedBoundsRef.current = constrainedBounds
          })
          .catch(() => {})
        // Don't attach moveend — keep constrained to 5mi
        setSuperfundVisible(true)
      }
      const farthest = analysisResults.superfunds[analysisResults.superfunds.length - 1]
      if (farthest) {
        maxRadiusMeters = Math.max(maxRadiusMeters, farthest.distanceMi * milesToMeters * 1.2)
      }
    }

    // Auto-enable the Costco layer whenever any Costco was found in the
    // analysis radius. Drop a marker for each so they're all visible
    // immediately. We intentionally do NOT extend the auto-zoom for Costcos
    // — they're informational, not warnings, so keep the local view tight.
    if (analysisResults.costcoNearby.length > 0 && !costcoVisible) {
      const layer = costcoLayerRef.current
      if (layer) {
        layer.addTo(map)
        costcoLoadedBoundsRef.current = null
        costcoKnownIdsRef.current.clear()
        layer.clearLayers()
        for (const c of analysisResults.costcoNearby) {
          const icon = L.divIcon({
            className: 'costco-label',
            html: `<div class="costco-pin">C</div>`,
            iconSize: [32, 32],
            iconAnchor: [16, 16],
          })
          const tooltip = c.city ? `Costco — ${c.city}` : 'Costco'
          L.marker([c.lat, c.lng], { icon })
            .bindTooltip(tooltip, { direction: 'top', offset: [0, -16] })
            .addTo(layer)
          costcoKnownIdsRef.current.add(c.osmId)
        }
        loadCostcoLabels(map, layer)
        map.on('moveend', handleCostcoMove)
        setCostcoVisible(true)
      }
    }

    // Zoom out to show the farthest issue
    if (maxRadiusMeters > 0) {
      const degOffset = maxRadiusMeters / 111320
      const bounds = L.latLngBounds(
        [center.lat - degOffset, center.lng - degOffset * 1.3],
        [center.lat + degOffset, center.lng + degOffset * 1.3]
      )
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisResults.loading])

  return (
    <div className="map-page">
      <header className="map-header">
        <button
          className="map-home-button"
          onClick={() => navigate('/')}
          title="Home"
          aria-label="Home"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12l9-9 9 9" />
            <path d="M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10" />
          </svg>
          Home
        </button>
        <div className="header-address-wrapper" ref={addressWrapperRef}>
          {!editingAddress ? (
            <button
              type="button"
              className="header-address"
              onClick={startEditingAddress}
              title={`${address} — click to change`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
              <span className="header-address-text">{address}</span>
              <svg className="header-address-edit-hint" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
          ) : (
            <div className="header-address-edit">
              <svg className="header-address-edit-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
              <input
                ref={addressInputRef}
                type="text"
                className="header-address-input"
                value={addressInputValue}
                onChange={(e) => {
                  setAddressInputValue(e.target.value)
                  fetchAddressSuggestions(e.target.value)
                }}
                onKeyDown={handleAddressKeyDown}
                onFocus={() => addressSuggestions.length > 0 && setShowAddressSuggestions(true)}
                placeholder="Enter a U.S. address..."
                autoComplete="off"
              />
              {showAddressSuggestions && (
                <ul className="header-address-suggestions">
                  {addressSuggestions.map((s, i) => (
                    <li
                      key={s.id}
                      className={`header-address-suggestion ${i === activeSuggestionIndex ? 'active' : ''}`}
                      onMouseDown={() => selectAddressSuggestion(s)}
                      onMouseEnter={() => setActiveSuggestionIndex(i)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                        <circle cx="12" cy="10" r="3" />
                      </svg>
                      {formatTomTomAddress(s)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <div className="map-header-logo-wrapper" aria-hidden="true">
          <img src={logo} alt="" className="map-header-logo" />
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

      {/* Mobile floating action buttons */}
      <button
        className="layer-toggle-btn"
        onClick={() => { setLayerPanelOpen(true); setAnalysisPanelOpen(false); if (showFabHints) { setShowFabHints(false); localStorage.setItem('lr_fab_hints_seen', '1') } }}
        aria-label="Open layers"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></svg>
        {showFabHints && <span className="fab-hint fab-hint-right">Map Layers</span>}
      </button>
      <button
        className="analysis-toggle-btn"
        onClick={() => { setAnalysisPanelOpen(true); setLayerPanelOpen(false); if (showFabHints) { setShowFabHints(false); localStorage.setItem('lr_fab_hints_seen', '1') } }}
        aria-label="Open analysis"
      >
        {showFabHints && <span className="fab-hint fab-hint-left">Location Analysis</span>}
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>
      </button>

      {/* Mobile backdrop */}
      {(layerPanelOpen || analysisPanelOpen) && (
        <div className="mobile-panel-backdrop" onClick={() => { setLayerPanelOpen(false); setAnalysisPanelOpen(false) }} />
      )}

      <aside className={`layer-panel${layerPanelOpen ? ' mobile-open' : ''}`}>
        <button className="panel-close-btn" onClick={() => setLayerPanelOpen(false)} aria-label="Close layers">×</button>
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
              <span>{LEGEND_STOPS[0].dbMin} dB</span>
              <span>{LEGEND_STOPS[LEGEND_STOPS.length - 1].dbMin}+ dB</span>
            </div>
          </div>
        )}

        {HELIPORTS_ENABLED && (
          <label className="layer-toggle">
            <input
              type="checkbox"
              checked={heliportsVisible}
              onChange={toggleHeliports}
              disabled={status !== 'ready'}
            />
            <span className="layer-label">Heliports</span>
          </label>
        )}

        <label className="layer-toggle">
          <input
            type="checkbox"
            checked={costcoVisible}
            onChange={toggleCostco}
            disabled={status !== 'ready'}
          />
          <span className="layer-label">Costco Warehouses</span>
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
            {(Object.keys(TRANSIT_COLORS) as TransitStop['type'][]).map((type) => (
              <label key={type} className="transit-sub-toggle">
                <input
                  type="checkbox"
                  checked={transitSubVisible[type]}
                  onChange={() => toggleTransitSub(type)}
                />
                <span className="legend-dot" style={{ background: TRANSIT_COLORS[type], opacity: transitSubVisible[type] ? 1 : 0.35 }} />
                <span style={{ opacity: transitSubVisible[type] ? 1 : 0.5 }}>{TRANSIT_LABELS[type]}</span>
              </label>
            ))}
          </div>
        )}

        {SCHOOLS_ENABLED && (
          <>
            <label className="layer-toggle">
              <input
                type="checkbox"
                checked={schoolsVisible}
                onChange={toggleSchools}
                disabled={status !== 'ready'}
              />
              <span className="layer-label">
                Nearby Schools
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
          </>
        )}

        <label className="layer-toggle">
          <input
            type="checkbox"
            checked={trafficVisible}
            onChange={toggleTraffic}
            disabled={status !== 'ready'}
          />
          <span className="layer-label">Live Traffic</span>
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

      {/* Location Analysis Panel */}
      <aside className={`analysis-panel${analysisPanelOpen ? ' mobile-open' : ''}`}>
        <div className="analysis-header">
          <h2>Location Analysis</h2>
          <button
            className="analysis-close"
            onClick={() => setAnalysisPanelOpen(false)}
            aria-label="Close analysis"
          >×</button>
          <button
            className="share-button"
            onClick={handleShare}
            disabled={status !== 'ready'}
            title="Share this view as a short link"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
            </svg>
            Share
          </button>
        </div>
        <div className="analysis-content">
          {analysisResults.loading ? (
            <div className="analysis-loading"><div className="spinner" /><p>Analyzing location…</p></div>
          ) : (
            <>
              {analysisResults.noiseLevel && (
                <div className="analysis-item warning clickable" onClick={() => setAnalysisDetail('noise')}>
                  <div className="analysis-icon">⚠️</div>
                  <div className="analysis-detail">
                    <strong>Airport Noise Corridor</strong>
                    <p>~{analysisResults.noiseLevel} dB DNL — click for details</p>
                  </div>
                  <div className="analysis-chevron">›</div>
                </div>
              )}

              {HELIPORTS_ENABLED && analysisResults.heliports.length > 0 && (
                <div className="analysis-item warning clickable" onClick={() => setAnalysisDetail('heliports')}>
                  <div className="analysis-icon">⚠️</div>
                  <div className="analysis-detail">
                    <strong>Heliports within 3 miles</strong>
                    <p>{analysisResults.heliports.length} found — click for details</p>
                  </div>
                  <div className="analysis-chevron">›</div>
                </div>
              )}

              {analysisResults.superfunds.length > 0 && (
                <div className="analysis-item warning clickable" onClick={() => setAnalysisDetail('superfunds')}>
                  <div className="analysis-icon">⚠️</div>
                  <div className="analysis-detail">
                    <strong>Superfund Sites within 5 miles</strong>
                    <p>{analysisResults.superfunds.length} found — click for details</p>
                  </div>
                  <div className="analysis-chevron">›</div>
                </div>
              )}

              {analysisResults.costco ? (
                <div
                  className={`analysis-item ${costcoSeverity(analysisResults.costco.distanceMi)} clickable`}
                  onClick={() => setAnalysisDetail('costco')}
                >
                  <div className="analysis-icon">🛒</div>
                  <div className="analysis-detail">
                    <strong>Nearest Costco</strong>
                    <p>
                      {analysisResults.costco.distanceMi} mi
                      {analysisResults.costco.city ? ` — ${analysisResults.costco.city}` : ''} — click for details
                    </p>
                  </div>
                  <div className="analysis-chevron">›</div>
                </div>
              ) : (
                <div className={`analysis-item ${analysisResults.costcoError ? 'warning' : 'danger'}`}>
                  <div className="analysis-icon">🛒</div>
                  <div className="analysis-detail">
                    <strong>Nearest Costco</strong>
                    <p>{analysisResults.costcoError ? 'Search timed out — try again later' : `No Costco within ${COSTCO_ANALYSIS_RADIUS_MI} miles`}</p>
                  </div>
                </div>
              )}

              {!analysisResults.noiseLevel && (!HELIPORTS_ENABLED || analysisResults.heliports.length === 0) && analysisResults.superfunds.length === 0 && (
                <div className="analysis-item clear">
                  <div className="analysis-icon">✅</div>
                  <div className="analysis-detail">
                    <strong>No issues found</strong>
                    <p>Location is clear of airport noise corridors{HELIPORTS_ENABLED ? ', heliports,' : ''} and Superfund sites</p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </aside>

      {/* Analysis Detail Popup */}
      {analysisDetail && (
        <div className="analysis-detail-overlay" onClick={() => setAnalysisDetail(null)}>
          <div className="analysis-detail-popup" onClick={(e) => e.stopPropagation()}>
            <button className="analysis-detail-close" onClick={() => setAnalysisDetail(null)}>×</button>

            {analysisDetail === 'noise' && (
              <>
                <h3>Airport Noise Corridor</h3>
                {analysisResults.noiseAirport && (
                  <p className="analysis-detail-airport">
                    {analysisResults.noiseAirport}{analysisResults.noiseAirportCode ? ` (${analysisResults.noiseAirportCode})` : ''}
                  </p>
                )}
                <p className="analysis-detail-level">Estimated noise level: ~{analysisResults.noiseLevel} dB DNL</p>
                <div className="analysis-detail-rec">
                  <strong>Recommendation</strong>
                  <p>
                    Locations at 55 dB DNL or higher are considered significantly impacted by aircraft noise.
                    We recommend repeat visits to this location at different times of day — including early morning,
                    evening, and weekends — to assess whether the noise level is acceptable for your needs.
                    Flight patterns and frequency can vary significantly by time of day.
                  </p>
                </div>
              </>
            )}

            {HELIPORTS_ENABLED && analysisDetail === 'heliports' && (
              <>
                <h3>Nearby Heliports</h3>
                <ul className="analysis-detail-list">
                  {analysisResults.heliports.map((h, i) => (
                    <li key={i}><strong>{h.name}</strong> — {h.distanceMi} mi away</li>
                  ))}
                </ul>
                <div className="analysis-detail-rec">
                  <strong>Recommendation</strong>
                  <p>
                    Check helicopter flight paths in the area. Some heliports serve medical centers that use
                    helicopters for patient transport — these can operate at all hours and generate significant
                    low-altitude noise. People living near active heliports often report that helicopters are
                    louder and slower-moving than fixed-wing aircraft, making the noise more noticeable.
                  </p>
                </div>
              </>
            )}

            {analysisDetail === 'superfunds' && (
              <>
                <h3>Superfund Sites</h3>
                <ul className="analysis-detail-list">
                  {analysisResults.superfunds.map((s, i) => (
                    <li key={i}>
                      <strong>{s.name}</strong> — {s.distanceMi} mi away
                      <span className={`analysis-status ${s.status === 'Deleted' ? 'status-cleared' : 'status-active'}`}>
                        {s.status}
                      </span>
                      {s.url && (
                        <a href={s.url} target="_blank" rel="noopener noreferrer" className="analysis-epa-link">
                          EPA Site Profile →
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="analysis-detail-rec">
                  <strong>Recommendation</strong>
                  <p>
                    Sites marked as "Deleted" have been cleaned up and removed from the National Priorities List —
                    these are generally no longer a concern. For all other sites (Final, Proposed), we recommend
                    researching the site further using the EPA profile links above to understand the nature of
                    contamination, cleanup progress, and any potential impact on nearby properties.
                  </p>
                </div>
              </>
            )}

            {analysisDetail === 'costco' && (
              <>
                <h3>Nearest Costco</h3>
                {analysisResults.costco ? (
                  (() => {
                    const dist = analysisResults.costco.distanceMi
                    const sev = costcoSeverity(dist)
                    return (
                      <>
                        <p className="analysis-detail-airport">
                          {analysisResults.costco.city || 'Costco Wholesale'}
                        </p>
                        <p className={`analysis-detail-level ${sev}`}>
                          {dist} miles from this address
                        </p>
                        <a
                          className="costco-directions-link"
                          href={`https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(address || '')}&destination=${analysisResults.costco.lat},${analysisResults.costco.lng}&travelmode=driving`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M3 11l19-9-9 19-2-8-8-2z" />
                          </svg>
                          Driving directions →
                        </a>
                        <div className="analysis-detail-rec">
                          {sev === 'good' && (
                            <>
                              <strong>Congratulations.</strong>
                              <p>
                                You are about to be one of those insufferably happy people who
                                casually mention they "just popped over to Costco" on a Tuesday.
                                Studies (that I made up) show that residents within 30 miles of a
                                warehouse experience 73% more joy, own 4x more rotisserie
                                chickens, and have a deeply spiritual relationship with bulk
                                paper towels. You did this. You did this right.
                              </p>
                            </>
                          )}
                          {sev === 'warning' && (
                            <>
                              <strong>Acceptable. Barely.</strong>
                              <p>
                                {dist} miles. That is a <em>commitment</em>. Not a quick errand —
                                a planned expedition with a packing list, a playlist, and a snack
                                for the road. You'll do it, sure, but every trip will end with
                                you whispering "was the gas worth it?" while you eat a
                                $1.50 hot dog in the parking lot. People who live within
                                30 miles are objectively happier. Just so you know.
                              </p>
                            </>
                          )}
                          {sev === 'danger' && (
                            <>
                              <strong>Real talk for a second.</strong>
                              <p>
                                {dist} miles. To a Costco. Do you actually want to live that
                                far away from a building full of free samples and reasonably
                                priced tires? Is this house — this <em>specific</em> house —
                                really worth a {Math.round(dist * 2)}-mile round trip every time
                                you need a flat of paper towels and an inexplicable kayak? Take
                                a moment. Look at the listing. Look at the distance. Be honest
                                with yourself.
                              </p>
                            </>
                          )}
                        </div>
                        <div className="analysis-detail-rec">
                          <strong>Distance bands</strong>
                          <p>
                            <span className="analysis-band good">≤ 30 mi</span> blissful · {' '}
                            <span className="analysis-band warning">31–50 mi</span> tolerable · {' '}
                            <span className="analysis-band danger">51–100 mi</span> reconsider your life
                          </p>
                        </div>
                      </>
                    )
                  })()
                ) : analysisResults.costcoError ? (
                  <>
                    <p className="analysis-detail-level warning">
                      Costco search timed out. The Overpass server may be busy — please try again later.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="analysis-detail-level danger">
                      No Costco found within {COSTCO_ANALYSIS_RADIUS_MI} miles of this address.
                    </p>
                    <div className="analysis-detail-rec">
                      <strong>⚠️ Are you sure about this?</strong>
                      <p>
                        Listen. I'm not your realtor. I'm not your therapist. I'm just a website.
                        But before you sign anything, you should know that there is{' '}
                        <em>no Costco</em> within {COSTCO_ANALYSIS_RADIUS_MI} miles of this
                        address. None. Not one. You will have to leave your home, drive past
                        multiple regular grocery stores like a peasant, and somehow survive on
                        normal-sized packages of toilet paper. Sourcing a 48-pack of muffins
                        will require <em>logistics</em>. Children will grow up not knowing the
                        warm embrace of a food court churro. Pets will be denied the bulk
                        kibble lifestyle they deserve. Buying a house outside the normal
                        driving radius of a Costco is the kind of decision people quietly
                        regret for decades. Please take a moment. Are you sure? Are you
                        really, <em>really</em> sure?
                      </p>
                    </div>
                    <div className="analysis-detail-rec">
                      <strong>Distance bands</strong>
                      <p>
                        <span className="analysis-band good">≤ 30 mi</span> blissful · {' '}
                        <span className="analysis-band warning">31–50 mi</span> tolerable · {' '}
                        <span className="analysis-band danger">51–100 mi</span> reconsider your life
                      </p>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Share Results Modal */}
      {shareModalOpen && (
        <div className="analysis-detail-overlay" onClick={closeShareModal}>
          <div className="analysis-detail-popup share-popup" onClick={(e) => e.stopPropagation()}>
            <button className="analysis-detail-close" onClick={closeShareModal} aria-label="Close">×</button>
            <h3>Share Results</h3>
            {shareLoading ? (
              <div className="share-loading"><div className="spinner" /><p>Creating short link…</p></div>
            ) : (
              <>
                <p className="share-description">
                  Anyone with this link will see the same address and the layers you have active.
                </p>
                <input
                  className="share-modal-input"
                  type="text"
                  readOnly
                  value={shareUrl || shareLongUrl || ''}
                  onFocus={(e) => e.currentTarget.select()}
                />
                {shareError && (
                  <p className="share-error">Could not shorten URL ({shareError}); using the full link instead.</p>
                )}
                <div className="share-modal-actions">
                  <button className="share-copy-button" onClick={handleCopyShare}>
                    {shareCopied ? '✓ Copied!' : 'Copy link'}
                  </button>
                  {shareUrl && (
                    <a href={shareUrl} target="_blank" rel="noopener noreferrer" className="share-open-link">
                      Open in new tab →
                    </a>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default MapPage
