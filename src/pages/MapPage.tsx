import { useEffect, useRef, useState, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
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

const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY || 'AIzaSyCO9_Y8RuzXOHw6C87_Gbh-ZOUroIUQ3Io'

// Debug logging — enable in console: localStorage.setItem('LR_DEBUG','1'); location.reload()
declare const __BUILD_VERSION__: string
const LR_DEBUG = typeof localStorage !== 'undefined' && localStorage.getItem('LR_DEBUG') === '1'
function dbg(tag: string, ...args: unknown[]) { if (LR_DEBUG) console.debug(`[LR:${tag}]`, ...args) }
if (LR_DEBUG) console.info(`%c[LandRecon] Debug mode ON — build ${__BUILD_VERSION__}`, 'color:#0ea5e9;font-weight:bold')

const GOOGLE_NO_POI = [
  { featureType: 'poi', elementType: 'all', stylers: [{ visibility: 'off' }] },
]

type BaseMapId = 'street' | 'satellite'

const googleSessionCache = new Map<string, { token: string; expiry: number }>()

async function getGoogleTileSession(mapType: string, styles?: Record<string, unknown>[]): Promise<string> {
  const key = `${mapType}:${JSON.stringify(styles || [])}`
  const cached = googleSessionCache.get(key)
  if (cached && cached.expiry > Date.now() / 1000 + 300) {
    dbg('tiles', 'Using cached session for', mapType)
    return cached.token
  }

  dbg('tiles', 'Creating new tile session:', mapType, styles ? 'with styles' : 'no styles')
  const body: Record<string, unknown> = { mapType, language: 'en-US', region: 'US' }
  if (styles?.length) body.styles = styles

  const res = await fetch(
    `https://tile.googleapis.com/v1/createSession?key=${GOOGLE_MAPS_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  )
  if (!res.ok) throw new Error(`Google Tiles API: ${res.status}`)
  const data = await res.json()
  dbg('tiles', 'Session created, expires:', new Date(parseInt(data.expiry) * 1000).toISOString())
  googleSessionCache.set(key, { token: data.session, expiry: parseInt(data.expiry) })
  return data.session
}

interface BaseMapDef {
  label: string
  mapType: string
  maxZoom: number
  styles?: Record<string, unknown>[]
}

const BASE_MAPS: Record<BaseMapId, BaseMapDef> = {
  street: { label: 'Street', mapType: 'roadmap', maxZoom: 21, styles: GOOGLE_NO_POI },
  satellite: { label: 'Satellite', mapType: 'satellite', maxZoom: 21 },
}

async function createBaseLayer(id: BaseMapId): Promise<L.TileLayer> {
  const cfg = BASE_MAPS[id]
  const session = await getGoogleTileSession(cfg.mapType, cfg.styles)
  return L.tileLayer(
    `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${session}&key=${GOOGLE_MAPS_KEY}`,
    { attribution: '&copy; Google Maps', maxZoom: cfg.maxZoom },
  )
}

const SUPERFUND_API =
  'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/FAC_Superfund_Site_Boundaries_EPA_Public/FeatureServer/0/query'

const SUPERFUND_FIELDS = [
  'SITE_NAME', 'EPA_ID', 'NPL_STATUS_CODE', 'CITY_NAME',
  'STATE_CODE', 'SITE_FEATURE_TYPE', 'URL_ALIAS_TXT',
].join(',')

const LEGEND_STOPS = LEGEND_BANDS

const SUPERFUND_STYLE: L.PathOptions = {
  color: '#DC267F',
  weight: 3,
  opacity: 1,
  fillColor: '#DC267F',
  fillOpacity: 0.25,
  dashArray: '6, 4',
}

const SUPERFUND_HOVER_STYLE: L.PathOptions = {
  weight: 5,
  fillOpacity: 0.45,
  color: '#E8559A',
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
  public: '#0072B2',
  charter: '#009E73',
  'private-religious': '#CC79A7',
  'private-other': '#E69F00',
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
    fetchOverpass(osmQuery, { label: 'schools' }).then((d) => d ?? { elements: [] }),
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
  opts: { timeoutMs?: number; signal?: AbortSignal; label?: string } = {},
): Promise<T | null> {
  const { timeoutMs = 20000, signal: externalSignal, label } = opts
  const tag = label ? `overpass:${label}` : 'overpass'
  const body = `data=${encodeURIComponent(query)}`
  let lastErr: unknown = null
  for (const url of OVERPASS_ENDPOINTS) {
    if (externalSignal?.aborted) break
    for (let attempt = 0; attempt < 2; attempt++) {
      if (externalSignal?.aborted) break
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt))
      dbg(tag, `${url} attempt ${attempt + 1}`)
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
  rail: '#0072B2',
  subway: '#D55E00',
  tram: '#009E73',
  bus: '#E69F00',
}

const TRANSIT_LABELS: Record<TransitStop['type'], string> = {
  rail: 'Rail Stations',
  subway: 'Subway Stations',
  tram: 'Tram Stops',
  bus: 'Bus Stops',
}


const TRANSIT_QUERIES: Record<TransitStop['type'], string[]> = {
  rail: ['train stations', 'rail stations'],
  subway: ['subway stations', 'light rail stations'],
  tram: ['tram stops', 'streetcar stops'],
  bus: ['bus stations', 'bus stops'],
}

async function fetchTransitFromGoogle(
  center: { lat: number; lng: number },
  radiusM: number,
  type: TransitStop['type'],
): Promise<TransitStop[]> {
  const queries = TRANSIT_QUERIES[type]
  dbg('transit', `Fetching ${type} (${queries.length} queries) radius=${Math.round(radiusM)}m center=${center.lat.toFixed(4)},${center.lng.toFixed(4)}`)
  const allPlaces: TransitStop[] = []
  const seen = new Set<string>()
  await Promise.all(
    queries.map(async (query) => {
      try {
        const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': GOOGLE_MAPS_KEY,
            'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.formattedAddress',
          },
          body: JSON.stringify({
            textQuery: query,
            locationBias: {
              circle: {
                center: { latitude: center.lat, longitude: center.lng },
                radius: radiusM,
              },
            },
            maxResultCount: 20,
          }),
        })
        if (!res.ok) {
          dbg('transit', `Query "${query}" failed: ${res.status}`)
          return
        }
        const data = await res.json()
        const count = (data.places || []).length
        dbg('transit', `Query "${query}" → ${count} results`)
        for (const p of data.places || []) {
          if (seen.has(p.id)) continue
          seen.add(p.id)
          const loc = p.location
          if (!loc) continue
          allPlaces.push({
            lat: loc.latitude,
            lon: loc.longitude,
            name: p.displayName?.text || '',
            type,
          })
        }
      } catch { /* ignore */ }
    })
  )
  dbg('transit', `${type} total unique: ${allPlaces.length}`)
  return allPlaces
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
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#DC267F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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

const SHARE_LAYER_IDS = ['noise', 'superfund', 'transit', 'schools', 'traffic', 'costco', 'datacenters', 'ems'] as const

interface DataCenter {
  name: string
  address: string
  city: string
  state: string
  lat: number
  lng: number
  status: string
  operator: string
  mw: string
  sizerank: string
}

const DC_STATUS_COLORS: Record<string, string> = {
  'Operating': '#009E73',
  'Proposed': '#56B4E9',
  'Approved/Permitted/Under construction': '#E69F00',
  'Expanding': '#CC79A7',
  'Suspended': '#6b7280',
}

const DC_STATUSES = Object.keys(DC_STATUS_COLORS) as string[]

const DC_STATUS_LABELS: Record<string, string> = {
  'Operating': 'Operating',
  'Proposed': 'Proposed',
  'Approved/Permitted/Under construction': 'Under Construction',
  'Expanding': 'Expanding',
  'Suspended': 'Suspended',
}

const DATA_CENTER_ANALYSIS_RADIUS_MI = 10
type ShareLayerId = typeof SHARE_LAYER_IDS[number]

const EMS_TYPES = ['fire_station', 'hospital', 'police'] as const
type EmsType = typeof EMS_TYPES[number]
const EMS_COLORS: Record<EmsType, string> = {
  fire_station: '#D55E00',
  hospital: '#0072B2',
  police: '#332288',
}
const EMS_LABELS: Record<EmsType, string> = {
  fire_station: 'Fire Stations',
  hospital: 'Hospitals',
  police: 'Police Stations',
}
const EMS_ICONS: Record<EmsType, string> = {
  fire_station: '🚒',
  hospital: '🏥',
  police: '🚔',
}
const EMS_QUERIES: Record<EmsType, string[]> = {
  fire_station: ['fire stations'],
  hospital: ['hospitals', 'emergency rooms'],
  police: ['police stations'],
}

const COSTCO_ANALYSIS_RADIUS_MI = 100
const COSTCO_GREEN_RADIUS_MI = 30
const SCHOOLS_DEFAULT = false

function getExpFlag(key: string, fallback: boolean): boolean {
  const v = localStorage.getItem(key)
  return v === null ? fallback : v === '1'
}

function costcoSeverity(distMi: number): 'good' | 'warning' | 'danger' {
  if (distMi <= COSTCO_GREEN_RADIUS_MI) return 'good'
  if (distMi <= 50) return 'warning'
  return 'danger'
}

function noiseSeverity(db: number): 'warning' | 'danger' {
  if (db < 65) return 'warning'
  return 'danger'
}

function superfundSeverity(sites: { status: string }[]): 'clear' | 'warning' | 'danger' {
  if (sites.length === 0) return 'clear'
  const hasActive = sites.some(s => s.status !== 'Deleted')
  return hasActive ? 'danger' : 'warning'
}

function dataCenterSeverity(count: number): 'clear' | 'warning' | 'danger' {
  if (count === 0) return 'clear'
  if (count <= 2) return 'warning'
  return 'danger'
}

type SeverityLevel = 'clear' | 'good' | 'warning' | 'danger'

function computeLocationGrade(results: {
  noiseLevel: number | null
  superfunds: { status: string }[]
  costco: { distanceMi: number } | null
  costcoError: boolean
  dataCenters: unknown[]
}): { letter: string; color: string; severity: SeverityLevel; pct: number } {
  const scores: number[] = []

  // Noise: 0 = none, 1 = moderate (55-65), 2 = high (65+)
  if (!results.noiseLevel) scores.push(0)
  else if (results.noiseLevel < 65) scores.push(1)
  else scores.push(2)

  // Superfund
  const sfSev = superfundSeverity(results.superfunds)
  scores.push(sfSev === 'clear' ? 0 : sfSev === 'warning' ? 1 : 2)

  // Costco
  if (!results.costco) scores.push(results.costcoError ? 1 : 2)
  else {
    const cs = costcoSeverity(results.costco.distanceMi)
    scores.push(cs === 'good' ? 0 : cs === 'warning' ? 1 : 2)
  }

  // Data centers
  const dcSev = dataCenterSeverity(results.dataCenters.length)
  scores.push(dcSev === 'clear' ? 0 : dcSev === 'warning' ? 1 : 2)

  const total = scores.reduce((a, b) => a + b, 0)
  const max = scores.length * 2

  const pct = 1 - total / max
  if (pct >= 0.9) return { letter: 'A', color: '#4caf50', severity: 'clear', pct }
  if (pct >= 0.75) return { letter: 'B', color: '#8bc34a', severity: 'good', pct }
  if (pct >= 0.5) return { letter: 'C', color: '#ffb300', severity: 'warning', pct }
  if (pct >= 0.25) return { letter: 'D', color: '#ff7043', severity: 'warning', pct }
  return { letter: 'F', color: '#ef5350', severity: 'danger', pct }
}

function createClusterGroup(color?: string): L.MarkerClusterGroup {
  return L.markerClusterGroup({
    maxClusterRadius: 40,
    disableClusteringAtZoom: 14,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    chunkedLoading: true,
    ...(color ? {
      iconCreateFunction: (cluster: L.MarkerCluster) => {
        const count = cluster.getChildCount()
        return L.divIcon({
          html: `<div class="cluster-icon" style="background:${color}">${count}</div>`,
          className: 'marker-cluster-custom',
          iconSize: L.point(34, 34),
        })
      },
    } : {}),
  })
}

function makeDotIcon(color: string, size: number): L.DivIcon {
  return L.divIcon({
    className: 'cluster-dot',
    html: `<div style="background:${color};width:${size}px;height:${size}px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.15)"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
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
  const schoolLayerRef = useRef<L.LayerGroup | null>(null)
  const schoolLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const costcoLayerRef = useRef<L.LayerGroup | null>(null)
  const costcoLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const costcoKnownIdsRef = useRef<Set<string>>(new Set())
  const trafficLayerRef = useRef<L.TileLayer | null>(null)
  const dataCenterLayerRef = useRef<L.LayerGroup | null>(null)
  const dataCenterSubLayersRef = useRef<Record<string, L.LayerGroup> | null>(null)
  const dataCenterDataRef = useRef<DataCenter[] | null>(null)
  const [dcSubVisible, setDcSubVisible] = useState<Record<string, boolean>>(
    Object.fromEntries(DC_STATUSES.map((s) => [s, true]))
  )
  const dcSubVisibleRef = useRef(dcSubVisible)
  const emsLayerRef = useRef<L.LayerGroup | null>(null)
  const emsSubLayersRef = useRef<Record<EmsType, L.LayerGroup> | null>(null)
  const emsLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const emsKnownIdsRef = useRef<Set<string>>(new Set())
  const [emsSubVisible, setEmsSubVisible] = useState<Record<EmsType, boolean>>({
    fire_station: true, hospital: true, police: true,
  })
  const emsSubVisibleRef = useRef(emsSubVisible)
  const targetLocationRef = useRef<L.LatLng | null>(null)
  const transitPreloadedRef = useRef(false)
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
  const [costcoVisible, setCostcoVisible] = useState(false)
  const [trafficVisible, setTrafficVisible] = useState(false)
  const [dataCenterVisible, setDataCenterVisible] = useState(false)
  const [emsVisible, setEmsVisible] = useState(false)
  const [emsLoading, setEmsLoading] = useState(false)
  const [activeBaseMap, setActiveBaseMap] = useState<BaseMapId>('street')
  const [analysisResults, setAnalysisResults] = useState<{
    loading: boolean
    noiseLevel: number | null
    noiseAirport: string | null
    noiseAirportCode: string | null
    superfunds: { name: string; distanceMi: number; status: string; url: string; lat: number; lng: number }[]
    costco: { osmId: string; name: string; city: string; address: string; distanceMi: number; lat: number; lng: number } | null
    costcoNearby: { osmId: string; name: string; city: string; address: string; distanceMi: number; lat: number; lng: number }[]
    costcoError: boolean
    dataCenters: { name: string; city: string; state: string; distanceMi: number; status: string; operator: string; mw: string; sizerank: string; lat: number; lng: number }[]
  }>({ loading: true, noiseLevel: null, noiseAirport: null, noiseAirportCode: null, superfunds: [], costco: null, costcoNearby: [], costcoError: false, dataCenters: [] })
  const [analysisProgress, setAnalysisProgress] = useState<Record<string, 'pending' | 'done'>>({})
  const [analysisDetail, setAnalysisDetail] = useState<'noise' | 'superfunds' | 'costco' | 'datacenters' | null>(null)

  const [shareModalOpen, setShareModalOpen] = useState(false)
  const [shareLoading, setShareLoading] = useState(false)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [shareLongUrl, setShareLongUrl] = useState<string | null>(null)
  const [shareError, setShareError] = useState<string | null>(null)
  const [shareCopied, setShareCopied] = useState(false)

  // Saved analyses for comparison
  type SavedAnalysis = {
    address: string
    date: string
    grade: string
    gradeColor: string
    pct: number
    noiseLevel: number | null
    noiseAirport: string | null
    superfundCount: number
    superfundActive: number
    costcoMi: number | null
    dataCenterCount: number
  }
  const [savedAnalyses, setSavedAnalyses] = useState<SavedAnalysis[]>(() => {
    try { return JSON.parse(localStorage.getItem('lr_saved_analyses') ?? '[]') } catch { return [] }
  })
  const [showCompare, setShowCompare] = useState(false)

  const saveCurrentAnalysis = useCallback(() => {
    if (analysisResults.loading) return
    const grade = computeLocationGrade(analysisResults)
    const entry: SavedAnalysis = {
      address: document.querySelector('.analysis-address-display')?.textContent ?? 'Unknown',
      date: new Date().toLocaleDateString(),
      grade: grade.letter,
      gradeColor: grade.color,
      pct: grade.pct,
      noiseLevel: analysisResults.noiseLevel,
      noiseAirport: analysisResults.noiseAirport,
      superfundCount: analysisResults.superfunds.length,
      superfundActive: analysisResults.superfunds.filter(s => s.status !== 'Deleted').length,
      costcoMi: analysisResults.costco?.distanceMi ?? null,
      dataCenterCount: analysisResults.dataCenters.length,
    }
    const next = [entry, ...savedAnalyses].slice(0, 5)
    setSavedAnalyses(next)
    localStorage.setItem('lr_saved_analyses', JSON.stringify(next))
  }, [analysisResults, savedAnalyses])

  const removeSavedAnalysis = useCallback((idx: number) => {
    const next = savedAnalyses.filter((_, i) => i !== idx)
    setSavedAnalyses(next)
    localStorage.setItem('lr_saved_analyses', JSON.stringify(next))
  }, [savedAnalyses])

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

  // Mobile bottom sheet drag state
  const sheetRef = useRef<HTMLElement>(null)
  const sheetDragRef = useRef<{ startY: number; startH: number } | null>(null)
  const [sheetHeight, setSheetHeight] = useState<number | null>(null)
  const SHEET_SNAP_PEEK = 15  // vh
  const SHEET_SNAP_HALF = 50
  const SHEET_SNAP_FULL = 85

  const handleSheetTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    sheetDragRef.current = { startY: touch.clientY, startH: sheetHeight ?? SHEET_SNAP_HALF }
  }, [sheetHeight])

  const handleSheetTouchMove = useCallback((e: React.TouchEvent) => {
    const drag = sheetDragRef.current
    if (!drag) return
    const dy = drag.startY - e.touches[0].clientY
    const dvh = (dy / window.innerHeight) * 100
    const newH = Math.max(SHEET_SNAP_PEEK, Math.min(SHEET_SNAP_FULL, drag.startH + dvh))
    setSheetHeight(newH)
  }, [])

  const handleSheetTouchEnd = useCallback(() => {
    const drag = sheetDragRef.current
    if (!drag) return
    sheetDragRef.current = null
    const h = sheetHeight ?? SHEET_SNAP_HALF
    // Snap to closest
    const snaps = [SHEET_SNAP_PEEK, SHEET_SNAP_HALF, SHEET_SNAP_FULL]
    const closest = snaps.reduce((a, b) => Math.abs(b - h) < Math.abs(a - h) ? b : a)
    if (closest <= SHEET_SNAP_PEEK) {
      setAnalysisPanelOpen(false)
      setSheetHeight(null)
    } else {
      setSheetHeight(closest)
    }
  }, [sheetHeight])

  // Experimental feature flags (persisted in localStorage)
  const [expMenuOpen, setExpMenuOpen] = useState(false)
  const expMenuRef = useRef<HTMLDivElement>(null)
  const [SCHOOLS_ENABLED, setSchoolsEnabled] = useState(() => getExpFlag('lr_exp_schools', SCHOOLS_DEFAULT))
  const [debugEnabled, setDebugEnabled] = useState(() => getExpFlag('LR_DEBUG', false))

  const toggleExpFlag = (key: string, current: boolean, setter: (v: boolean) => void) => {
    const next = !current
    localStorage.setItem(key, next ? '1' : '0')
    setter(next)
  }

  // Close secret menu on outside click
  useEffect(() => {
    if (!expMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (expMenuRef.current && !expMenuRef.current.contains(e.target as Node)) setExpMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [expMenuOpen])

  // Show FAB tooltip hints once on mobile, dismiss on first tap
  const buildShareUrl = useCallback((): string => {
    const params = new URLSearchParams()
    if (address) params.set('address', address)
    const active: ShareLayerId[] = []
    if (noiseVisible) active.push('noise')
    if (superfundVisible) active.push('superfund')
    if (transitVisible) active.push('transit')
    if (schoolsVisible) active.push('schools')
    if (trafficVisible) active.push('traffic')
    if (costcoVisible) active.push('costco')
    if (dataCenterVisible) active.push('datacenters')
    if (emsVisible) active.push('ems')
    if (active.length > 0) params.set('layers', active.join(','))
    if (activeBaseMap !== 'street') params.set('base', activeBaseMap)
    return `${window.location.origin}/map?${params.toString()}`
  }, [address, noiseVisible, superfundVisible, transitVisible, schoolsVisible, trafficVisible, costcoVisible, dataCenterVisible, emsVisible, activeBaseMap])

  const handleShare = useCallback(() => {
    const url = buildShareUrl()
    setShareModalOpen(true)
    setShareLoading(false)
    setShareError(null)
    setShareCopied(false)
    setShareLongUrl(url)
    setShareUrl(url)
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
      dbg('geocode', 'Fetching suggestions for:', query)
      try {
        const url = `https://api.tomtom.com/search/2/search/${encodeURIComponent(query)}.json?key=${TOMTOM_API_KEY}&countrySet=US&typeahead=true&limit=5&language=en-US`
        const res = await fetch(url)
        const data = await res.json()
        const results: TomTomSuggestion[] = data.results || []
        dbg('geocode', `Got ${results.length} suggestions`)
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
    if (loaded && loaded.contains(bounds)) { dbg('airports', 'Skipping — bounds already loaded'); return }
    dbg('airports', 'Loading airport labels…')

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

      const data = await fetchOverpass(query, { label: 'airports' })
      if (!data?.elements || data.elements.length === 0) { dbg('airports', 'No airports found'); return }

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


  const loadCostcoLabels = useCallback(async (map: L.Map, layer: L.LayerGroup) => {
    const bounds = map.getBounds()
    const loaded = costcoLoadedBoundsRef.current
    if (loaded && loaded.contains(bounds)) { dbg('costco', 'Skipping — bounds already loaded'); return }
    dbg('costco', 'Loading Costco locations…')

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

      const data = await fetchOverpass(query, { label: 'costco' })
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
        const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ')
        const tooltipParts = ['Costco']
        if (locality) tooltipParts[0] = `Costco — ${locality}`
        if (street) tooltipParts.push(street)
        const tooltip = tooltipParts.join('<br/>')

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
    const loaded = superfundLoadedBoundsRef.current
    if (loaded && loaded.contains(bounds)) { dbg('superfund', 'Skipping — bounds already loaded'); return }
    dbg('superfund', 'Loading Superfund sites…')

    setSuperfundLoading(true)
    try {
      const padded = bounds.pad(0.5)
      const geojson = await fetchSuperfundFeatures(padded)
      dbg('superfund', `Got ${geojson.features?.length || 0} features`)
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
    const loaded = transitLoadedBoundsRef.current
    if (loaded && loaded.contains(bounds)) { dbg('transit', 'Skipping — bounds already loaded'); return }
    dbg('transit', 'Loading transit data…')

    setTransitLoading(true)
    try {
      // On first load, preload the full 50km radius around the target location
      // instead of just the visible viewport
      const target = targetLocationRef.current
      const isPreload = !transitPreloadedRef.current && target
      const searchCenter = isPreload ? target : map.getCenter()
      const radiusM = isPreload
        ? 50000
        : Math.min(Math.max(searchCenter.distanceTo(bounds.pad(0.3).getNorthEast()), 16093), 50000)

      if (isPreload) {
        dbg('transit', `Preloading full 50km radius around target (${target.lat.toFixed(4)}, ${target.lng.toFixed(4)})`)
        transitPreloadedRef.current = true
      }

      const googleStops = await Promise.all(
        (['rail', 'subway', 'tram', 'bus'] as const).map((t) =>
          fetchTransitFromGoogle({ lat: searchCenter.lat, lng: searchCenter.lng }, radiusM, t).catch(() => [] as TransitStop[])
        ),
      )

      let subLayers = transitSubLayersRef.current
      if (!subLayers) {
        subLayers = {
          rail: createClusterGroup(TRANSIT_COLORS.rail),
          subway: createClusterGroup(TRANSIT_COLORS.subway),
          tram: createClusterGroup(TRANSIT_COLORS.tram),
          bus: createClusterGroup(TRANSIT_COLORS.bus),
        }
        transitSubLayersRef.current = subLayers
        for (const t of Object.keys(subLayers) as TransitStop['type'][]) {
          if (transitSubVisibleRef.current[t]) {
            subLayers[t].addTo(layer)
          }
        }
      }
      for (const t of Object.keys(subLayers) as TransitStop['type'][]) {
        subLayers[t].clearLayers()
      }

      const seen = new Set<string>()
      for (const stops of googleStops) {
        for (const stop of stops) {
          const key = `${stop.lat.toFixed(4)},${stop.lon.toFixed(4)}`
          if (seen.has(key)) continue
          seen.add(key)
          const color = TRANSIT_COLORS[stop.type]
          const size = stop.type === 'bus' ? 10 : 14
          L.marker([stop.lat, stop.lon], { icon: makeDotIcon(color, size) })
            .bindPopup(transitPopup(stop), { maxWidth: 260 })
            .addTo(subLayers[stop.type])
        }
      }

      // Store the actual coverage area (circle from search center, not padded bounds)
      // so zooming out beyond the searched radius triggers a reload
      const covDeg = radiusM / 111320
      transitLoadedBoundsRef.current = L.latLngBounds(
        [searchCenter.lat - covDeg, searchCenter.lng - covDeg * 1.3],
        [searchCenter.lat + covDeg, searchCenter.lng + covDeg * 1.3],
      )
      dbg('transit', `Rendered ${seen.size} unique transit stops (radius=${Math.round(radiusM)}m, center=${searchCenter.lat.toFixed(4)},${searchCenter.lng.toFixed(4)})`)
    } catch (err) {
      console.error('Failed to load transit data:', err)
    } finally {
      setTransitLoading(false)
    }
  }, [])

  const loadSchoolData = useCallback(async (map: L.Map, layer: L.LayerGroup) => {
    const center = map.getCenter()
    const radiusDeg = 5 / 69
    const bounds = L.latLngBounds(
      [center.lat - radiusDeg, center.lng - radiusDeg * 1.3],
      [center.lat + radiusDeg, center.lng + radiusDeg * 1.3]
    )
    const loaded = schoolLoadedBoundsRef.current
    if (loaded && loaded.contains(bounds)) { dbg('schools', 'Skipping — bounds already loaded'); return }
    dbg('schools', 'Loading school data…')

    setSchoolsLoading(true)
    try {
      const schools = await fetchSchools(bounds)
      dbg('schools', `Got ${schools.length} schools`)
      // Build all markers before touching the layer to avoid flicker
      const newMarkers: L.Marker[] = []
      for (const school of schools) {
        const color = SCHOOL_COLORS[school.category]
        const marker = L.marker([school.lat, school.lon], {
          icon: makeDotIcon(color, 12),
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
    dbg('analysis', `Running analysis at ${lat.toFixed(5)}, ${lng.toFixed(5)}`)
    setAnalysisResults({ loading: true, noiseLevel: null, noiseAirport: null, noiseAirportCode: null, superfunds: [], costco: null, costcoNearby: [], costcoError: false, dataCenters: [] })

    const checks = ['noise', 'superfund', 'costco', 'datacenters'] as const
    const progress: Record<string, 'pending' | 'done'> = {}
    for (const c of checks) progress[c] = 'pending'
    setAnalysisProgress({ ...progress })
    const markDone = (key: string) => {
      progress[key] = 'done'
      setAnalysisProgress({ ...progress })
    }

    const location = L.latLng(lat, lng)
    const milesToMeters = 1609.34
    const TIMEOUT = 10000

    // Run all checks in parallel with timeouts
    const [noiseResult, superfundResult, costcoResult, dataCenterResult] = await Promise.allSettled([
      // Check noise via PMTiles vector query, then find nearest airport
      (async () => {
        try {
        const band = await queryNoiseLevelAtPoint(NOISE_PMTILES_URL, lat, lng)
        if (!band) return null
        const level = band.dbMin

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
        } finally { markDone('noise') }
      })(),

      // Check Superfund sites within 5 miles
      (async () => {
        try {
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
        const results: { name: string; distanceMi: number; status: string; url: string; lat: number; lng: number }[] = []
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
              lat: cLat,
              lng: cLon,
            })
          }
        }
        results.sort((a, b) => a.distanceMi - b.distanceMi)
        return results
        } finally { markDone('superfund') }
      })(),

      // Find every Costco within COSTCO_ANALYSIS_RADIUS_MI
      (async () => {
        try {
        type CostcoHit = { osmId: string; name: string; city: string; address: string; distanceMi: number; lat: number; lng: number }
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
        const data = await fetchOverpass(query, { timeoutMs: 35000, signal: AbortSignal.timeout(35000), label: 'analysis-costco' })
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
          const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ')
          hits.push({
            osmId: id,
            name: tags.name || 'Costco',
            city: locality,
            address: street,
            distanceMi: Math.round(distMi * 10) / 10,
            lat: elLat,
            lng: elLon,
          })
        }
        hits.sort((a, b) => a.distanceMi - b.distanceMi)
        return { nearest: hits[0] ?? null, nearby: hits }
        } finally { markDone('costco') }
      })(),

      // Data centers within radius (static JSON)
      (async () => {
        try {
        let data = dataCenterDataRef.current
        if (!data) {
          const res = await fetch('/data/data-centers.json')
          data = (await res.json()) as DataCenter[]
          dataCenterDataRef.current = data
        }
        const radiusM = DATA_CENTER_ANALYSIS_RADIUS_MI * milesToMeters
        const nearby: { name: string; city: string; state: string; distanceMi: number; status: string; operator: string; mw: string; sizerank: string; lat: number; lng: number }[] = []
        for (const dc of data) {
          const dist = location.distanceTo(L.latLng(dc.lat, dc.lng))
          if (dist <= radiusM) {
            nearby.push({
              name: dc.name,
              city: dc.city,
              state: dc.state,
              distanceMi: Math.round(dist / milesToMeters * 10) / 10,
              status: dc.status,
              operator: dc.operator,
              mw: dc.mw,
              sizerank: dc.sizerank,
              lat: dc.lat,
              lng: dc.lng,
            })
          }
        }
        nearby.sort((a, b) => a.distanceMi - b.distanceMi)
        return nearby
        } finally { markDone('datacenters') }
      })(),
    ])

    const noiseData = noiseResult.status === 'fulfilled' ? noiseResult.value : null
    const noiseLevel = noiseData?.level ?? null
    const noiseAirport = noiseData?.airport ?? null
    const noiseAirportCode = noiseData?.code ?? null
    const superfunds = superfundResult.status === 'fulfilled' ? superfundResult.value : []
    const costcoData = costcoResult.status === 'fulfilled' ? costcoResult.value : { nearest: null, nearby: [] }
    const costco = costcoData.nearest
    const costcoNearby = costcoData.nearby
    const costcoError = costcoResult.status === 'rejected'
    const dataCenters = dataCenterResult.status === 'fulfilled' ? dataCenterResult.value : []

    dbg('analysis', 'Results:', {
      noise: noiseLevel != null ? `${noiseLevel} dB` : 'none',
      superfunds: superfunds.length,
      costco: costco ? `${costco.distanceMi.toFixed(1)} mi` : 'none',
      dataCenters: dataCenters.length,
    })
    setAnalysisResults({ loading: false, noiseLevel, noiseAirport, noiseAirportCode, superfunds, costco, costcoNearby, costcoError, dataCenters })
  }, [])

  useEffect(() => {
    if (!address) {
      navigate('/')
      return
    }

    if (!mapContainer.current) return

    setStatus('loading')
    setErrorMsg('')
    dbg('init', 'Geocoding address:', address)
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
        dbg('init', `Geocoded to ${lat}, ${lng}`)
        targetLocationRef.current = L.latLng(lat, lng)

        const map = L.map(mapContainer.current!, {
          center: [lat, lng],
          zoom: 14,
          zoomControl: false,
        })

        createBaseLayer('street').then((baseLayer) => {
          dbg('init', 'Base layer created (Google Tiles)')
          baseLayer.addTo(map)
          baseLayerRef.current = baseLayer
        }).catch((err) => {
          console.error('Google Tiles API failed:', err)
          dbg('init', 'Falling back to direct Google tile URL')
          const fallback = L.tileLayer(
            `https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&key=${GOOGLE_MAPS_KEY}`,
            { attribution: '&copy; Google Maps', maxZoom: 21, subdomains: '0123' },
          ).addTo(map)
          baseLayerRef.current = fallback
        })

        L.control.zoom({ position: 'topright' }).addTo(map)

        if (LR_DEBUG) console.log(`[LR:map] Initial zoom level: ${map.getZoom()}`)
        map.on('zoomend', () => {
          if (LR_DEBUG) console.log(`[LR:map] Zoom level: ${map.getZoom()}`)
        })

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
        schoolLayerRef.current = createClusterGroup()

        // Create Costco label layer (not added to map until toggled on)
        costcoLayerRef.current = L.layerGroup()

        dataCenterLayerRef.current = L.layerGroup()

        emsLayerRef.current = L.layerGroup()

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
      costcoLayerRef.current = null
      costcoLoadedBoundsRef.current = null
      costcoKnownIdsRef.current.clear()
      trafficLayerRef.current = null
      dataCenterLayerRef.current = null
      dataCenterSubLayersRef.current = null
      dataCenterDataRef.current = null
      emsLayerRef.current = null
      emsSubLayersRef.current = null
      emsLoadedBoundsRef.current = null
      emsKnownIdsRef.current.clear()
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [address, navigate])

  const switchBaseMap = async (id: BaseMapId) => {
    const map = mapRef.current
    const current = baseLayerRef.current
    if (!map || !current || id === activeBaseMap) return
    dbg('basemap', `Switching to ${id}`)

    try {
      const newLayer = await createBaseLayer(id)
      map.removeLayer(current)
      newLayer.addTo(map)
      newLayer.bringToBack()
      baseLayerRef.current = newLayer
      setActiveBaseMap(id)
    } catch (e) {
      console.error('Failed to switch base map:', e)
    }
  }

  const toggleNoise = () => {
    const map = mapRef.current
    const layer = noiseLayerRef.current as L.GridLayer | null
    const airportLayer = airportLayerRef.current
    if (!map || !layer) return
    dbg('toggle', `noise → ${noiseVisible ? 'OFF' : 'ON'}`)

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
    dbg('toggle', `costco → ${costcoVisible ? 'OFF' : 'ON'}`)

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

  const loadDataCenters = useCallback(async (map: L.Map, layer: L.LayerGroup) => {
    dbg('datacenters', 'Loading data centers…')
    let data = dataCenterDataRef.current
    if (!data) {
      try {
        const res = await fetch('/data/data-centers.json')
        data = (await res.json()) as DataCenter[]
        dataCenterDataRef.current = data
        dbg('datacenters', `Loaded ${data.length} data centers from JSON`)
      } catch (err) {
        console.warn('Data center fetch failed:', err)
        return
      }
    }

    let subLayers = dataCenterSubLayersRef.current
    if (!subLayers) {
      subLayers = {} as Record<string, L.LayerGroup>
      for (const s of DC_STATUSES) {
        subLayers[s] = createClusterGroup(DC_STATUS_COLORS[s])
      }
      dataCenterSubLayersRef.current = subLayers
      for (const s of DC_STATUSES) {
        if (dcSubVisibleRef.current[s]) {
          subLayers[s].addTo(layer)
        }
      }
    }

    for (const s of DC_STATUSES) subLayers[s].clearLayers()

    const bounds = map.getBounds().pad(0.3)
    for (const dc of data) {
      if (!bounds.contains([dc.lat, dc.lng])) continue
      const sub = subLayers[dc.status]
      if (!sub) continue
      const color = DC_STATUS_COLORS[dc.status] || '#6b7280'
      const icon = L.divIcon({
        className: 'dc-label',
        html: `<div class="dc-pin" style="background:${color}">🏢</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      })
      const lines = [dc.name || 'Data Center']
      if (dc.operator) lines[0] += ` (${dc.operator})`
      if (dc.city || dc.state) lines.push([dc.city, dc.state].filter(Boolean).join(', '))
      if (dc.address) lines.push(dc.address)
      lines.push(`Status: ${dc.status}`)
      if (dc.mw) lines.push(`Capacity: ${dc.mw} MW`)
      if (dc.sizerank && dc.sizerank !== 'Unknown') lines.push(dc.sizerank)
      L.marker([dc.lat, dc.lng], { icon })
        .bindTooltip(lines.join('<br/>'), { direction: 'top', offset: [0, -14] })
        .addTo(sub)
    }
  }, [])

  const handleDataCenterMove = useCallback(() => {
    const map = mapRef.current
    const layer = dataCenterLayerRef.current
    if (map && layer) loadDataCenters(map, layer)
  }, [loadDataCenters])

  const toggleDataCenters = () => {
    const map = mapRef.current
    const layer = dataCenterLayerRef.current
    if (!map || !layer) return
    dbg('toggle', `datacenters → ${dataCenterVisible ? 'OFF' : 'ON'}`)
    if (dataCenterVisible) {
      map.removeLayer(layer)
      map.off('moveend', handleDataCenterMove)
      layer.clearLayers()
      dataCenterSubLayersRef.current = null
    } else {
      layer.addTo(map)
      loadDataCenters(map, layer)
      map.on('moveend', handleDataCenterMove)
    }
    setDataCenterVisible(!dataCenterVisible)
  }

  const toggleDcSub = (statusKey: string) => {
    const parentLayer = dataCenterLayerRef.current
    const subLayers = dataCenterSubLayersRef.current
    if (!parentLayer || !subLayers) return

    const nowVisible = !dcSubVisible[statusKey]
    const next = { ...dcSubVisible, [statusKey]: nowVisible }
    setDcSubVisible(next)
    dcSubVisibleRef.current = next

    if (nowVisible) {
      subLayers[statusKey].addTo(parentLayer)
    } else {
      parentLayer.removeLayer(subLayers[statusKey])
    }
  }

  const loadEmsData = useCallback(async (map: L.Map, layer: L.LayerGroup) => {
    const bounds = map.getBounds()
    const loaded = emsLoadedBoundsRef.current
    if (loaded && loaded.contains(bounds)) { dbg('ems', 'Skipping — bounds already loaded'); return }
    dbg('ems', 'Loading EMS data…')

    setEmsLoading(true)
    try {
      const padded = bounds.pad(0.5)
      const center = map.getCenter()
      const minRadiusM = 16093
      const ne = padded.getNorthEast()
      const radiusM = Math.min(Math.max(center.distanceTo(ne), minRadiusM), 50000)
      dbg('ems', `Search radius=${Math.round(radiusM)}m center=${center.lat.toFixed(4)},${center.lng.toFixed(4)}`)

      let subLayers = emsSubLayersRef.current
      if (!subLayers) {
        subLayers = {} as Record<EmsType, L.LayerGroup>
        for (const t of EMS_TYPES) subLayers[t] = createClusterGroup(EMS_COLORS[t])
        emsSubLayersRef.current = subLayers
        for (const t of EMS_TYPES) {
          if (emsSubVisibleRef.current[t]) subLayers[t].addTo(layer)
        }
      }

      const known = emsKnownIdsRef.current
      const queryPairs = EMS_TYPES.flatMap((type) =>
        EMS_QUERIES[type].map((q) => ({ type, query: q }))
      )
      const results = await Promise.all(
        queryPairs.map(async ({ type, query }) => {
          try {
            const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': GOOGLE_MAPS_KEY,
                'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.formattedAddress,places.types',
              },
              body: JSON.stringify({
                textQuery: query,
                locationBias: {
                  circle: {
                    center: { latitude: center.lat, longitude: center.lng },
                    radius: radiusM,
                  },
                },
                maxResultCount: 20,
              }),
            })
            if (!res.ok) {
              console.warn(`EMS ${type} (${query}) search failed:`, res.status)
              return []
            }
            const data = await res.json()
            return (data.places || []).map((p: Record<string, unknown>) => ({ ...p, _emsType: type }))
          } catch (err) {
            console.warn(`EMS ${type} (${query}) search error:`, err)
            return []
          }
        })
      )

      for (const places of results) {
        for (const place of places) {
          const id = place.id as string
          if (!id || known.has(id)) continue
          const loc = place.location as { latitude: number; longitude: number } | undefined
          if (!loc) continue
          const name = (place.displayName as { text: string })?.text || ''
          const address = (place.formattedAddress as string) || ''
          const type = place._emsType as EmsType
          const placeTypes = (place.types as string[]) || []

          // Filter out mismatched results (e.g. USPS in police results)
          if (type === 'police' && !placeTypes.includes('police')) continue
          if (type === 'fire_station' && !placeTypes.includes('fire_station')) continue

          const sub = subLayers[type]
          if (!sub) continue

          const color = EMS_COLORS[type]
          const emoji = EMS_ICONS[type]
          const icon = L.divIcon({
            className: 'ems-label',
            html: `<div class="ems-pin" style="background:${color}">${emoji}</div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          })
          const tooltip = [name, address].filter(Boolean).join('<br/>')
          L.marker([loc.latitude, loc.longitude], { icon })
            .bindTooltip(tooltip, { direction: 'top', offset: [0, -14] })
            .addTo(sub)
          known.add(id)
        }
      }

      emsLoadedBoundsRef.current = loaded
        ? loaded.extend(padded.getSouthWest()).extend(padded.getNorthEast())
        : padded
      dbg('ems', `Total known EMS places: ${known.size}`)
    } catch (err) {
      console.warn('EMS data fetch failed:', err)
    } finally {
      setEmsLoading(false)
    }
  }, [])

  const handleEmsMove = useCallback(() => {
    const map = mapRef.current
    const layer = emsLayerRef.current
    if (map && layer) loadEmsData(map, layer)
  }, [loadEmsData])

  const toggleEms = () => {
    const map = mapRef.current
    const layer = emsLayerRef.current
    if (!map || !layer) return
    dbg('toggle', `ems → ${emsVisible ? 'OFF' : 'ON'}`)
    if (emsVisible) {
      map.removeLayer(layer)
      map.off('moveend', handleEmsMove)
      layer.clearLayers()
      emsSubLayersRef.current = null
      emsLoadedBoundsRef.current = null
      emsKnownIdsRef.current.clear()
    } else {
      layer.addTo(map)
      loadEmsData(map, layer)
      map.on('moveend', handleEmsMove)
    }
    setEmsVisible(!emsVisible)
  }

  const toggleEmsSub = (type: EmsType) => {
    const parentLayer = emsLayerRef.current
    const subLayers = emsSubLayersRef.current
    if (!parentLayer || !subLayers) return

    const nowVisible = !emsSubVisible[type]
    const next = { ...emsSubVisible, [type]: nowVisible }
    setEmsSubVisible(next)
    emsSubVisibleRef.current = next

    if (nowVisible) {
      subLayers[type].addTo(parentLayer)
    } else {
      parentLayer.removeLayer(subLayers[type])
    }
  }

  const toggleSuperfund = () => {
    const map = mapRef.current
    const layer = superfundLayerRef.current
    if (!map || !layer) return
    dbg('toggle', `superfund → ${superfundVisible ? 'OFF' : 'ON'}`)

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
    dbg('toggle', `transit → ${transitVisible ? 'OFF' : 'ON'}`)

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
    dbg('toggle', `schools → ${schoolsVisible ? 'OFF' : 'ON'}`)

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
    dbg('toggle', `traffic → ${trafficVisible ? 'OFF' : 'ON'}`)

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
    if (requested.has('traffic')) toggleTraffic()
    if (requested.has('costco')) toggleCostco()
    if (requested.has('datacenters')) toggleDataCenters()
    if (requested.has('ems')) toggleEms()
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
    // Costco results are stored but the layer is NOT auto-enabled.
    // The user can toggle it on manually from the layers panel.

    if (analysisResults.dataCenters.length > 0 && !dataCenterVisible) {
      const layer = dataCenterLayerRef.current
      if (layer) {
        layer.addTo(map)
        loadDataCenters(map, layer)
        map.on('moveend', handleDataCenterMove)
        setDataCenterVisible(true)
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
        <div className="map-header-logo-wrapper" ref={expMenuRef}>
          <img
            src={logo}
            alt=""
            className="map-header-logo"
            onClick={() => setExpMenuOpen((v) => !v)}
            style={{ cursor: 'pointer' }}
          />
          {expMenuOpen && (
            <div className="exp-menu">
              <div className="exp-menu-title">Experimental</div>
              <label className="exp-menu-item">
                <input type="checkbox" checked={SCHOOLS_ENABLED} onChange={() => { toggleExpFlag('lr_exp_schools', SCHOOLS_ENABLED, setSchoolsEnabled) }} />
                <span>Schools</span>
              </label>
              <label className="exp-menu-item">
                <input type="checkbox" checked={debugEnabled} onChange={() => { toggleExpFlag('LR_DEBUG', debugEnabled, setDebugEnabled) }} />
                <span>Debug Logging</span>
              </label>
              <div className="exp-menu-hint">Changes take effect on reload</div>
            </div>
          )}
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
        onClick={() => { setLayerPanelOpen(true); setAnalysisPanelOpen(false) }}
        aria-label="Open layers"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></svg>
        <span className="fab-label">Layers</span>
      </button>
      <button
        className="analysis-toggle-btn"
        onClick={() => { setAnalysisPanelOpen(true); setLayerPanelOpen(false); setSheetHeight(null) }}
        aria-label="Open analysis"
      >
        <span className="fab-label">Analysis</span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>
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

        {/* ── Transportation ── */}
        <details className="layer-group">
          <summary className="layer-group-heading">Transportation</summary>
          <div className="layer-group-body">
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
          </div>
        </details>

        {/* ── Services ── */}
        <details className="layer-group">
          <summary className="layer-group-heading">Services</summary>
          <div className="layer-group-body">
            <label className="layer-toggle">
              <input
                type="checkbox"
                checked={emsVisible}
                onChange={toggleEms}
                disabled={status !== 'ready'}
              />
              <span className="layer-label">
                Emergency Services
                {emsLoading && <span className="layer-loading"> ⏳</span>}
              </span>
            </label>
            {emsVisible && (
              <div className="dc-legend">
                {EMS_TYPES.map((t) => (
                  <label key={t} className="transit-sub-toggle">
                    <input
                      type="checkbox"
                      checked={emsSubVisible[t]}
                      onChange={() => toggleEmsSub(t)}
                    />
                    <span className="legend-dot" style={{ background: EMS_COLORS[t], opacity: emsSubVisible[t] ? 1 : 0.35 }} />
                    <span style={{ opacity: emsSubVisible[t] ? 1 : 0.5 }}>{EMS_LABELS[t]}</span>
                  </label>
                ))}
              </div>
            )}

            <label className="layer-toggle">
              <input
                type="checkbox"
                checked={costcoVisible}
                onChange={toggleCostco}
                disabled={status !== 'ready'}
              />
              <span className="layer-label">Costco</span>
            </label>

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
              </>
            )}
          </div>
        </details>

        {/* ── Environmental ── */}
        <details className="layer-group">
          <summary className="layer-group-heading">Environmental</summary>
          <div className="layer-group-body">
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
                checked={dataCenterVisible}
                onChange={toggleDataCenters}
                disabled={status !== 'ready'}
              />
              <span className="layer-label">Data Centers</span>
            </label>
            {dataCenterVisible && (
              <div className="dc-legend">
                {DC_STATUSES.map((s) => (
                  <label key={s} className="transit-sub-toggle">
                    <input
                      type="checkbox"
                      checked={dcSubVisible[s]}
                      onChange={() => toggleDcSub(s)}
                    />
                    <span className="legend-dot" style={{ background: DC_STATUS_COLORS[s], opacity: dcSubVisible[s] ? 1 : 0.35 }} />
                    <span style={{ opacity: dcSubVisible[s] ? 1 : 0.5 }}>{DC_STATUS_LABELS[s]}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </details>
      </aside>

      {/* Location Analysis Panel */}
      <aside
        ref={sheetRef}
        className={`analysis-panel${analysisPanelOpen ? ' mobile-open' : ''}`}
        style={analysisPanelOpen && sheetHeight != null ? { maxHeight: `${sheetHeight}vh` } as React.CSSProperties : undefined}
      >
        <div
          className="analysis-drag-handle"
          onTouchStart={handleSheetTouchStart}
          onTouchMove={handleSheetTouchMove}
          onTouchEnd={handleSheetTouchEnd}
        >
          <div className="analysis-drag-bar" />
        </div>
        <div className="analysis-header">
          <h2>Location Analysis</h2>
          <div className="analysis-header-actions">
            <button
              className="analysis-action-btn"
              onClick={() => {
                const loc = targetLocationRef.current
                if (loc) runLocationAnalysis(loc.lat, loc.lng)
              }}
              disabled={status !== 'ready' || analysisResults.loading}
              title="Re-analyze this location"
              aria-label="Re-analyze"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
            <button
              className="analysis-action-btn"
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
            </button>
            <button
              className="analysis-action-btn"
              onClick={() => window.print()}
              disabled={analysisResults.loading}
              title="Print / export summary"
              aria-label="Print"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="6 9 6 2 18 2 18 9" />
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                <rect x="6" y="14" width="12" height="8" />
              </svg>
            </button>
            <button
              className="analysis-action-btn"
              onClick={saveCurrentAnalysis}
              disabled={analysisResults.loading}
              title="Save for comparison"
              aria-label="Save"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
            </button>
            {savedAnalyses.length > 0 && (
              <button
                className="analysis-action-btn"
                onClick={() => setShowCompare(!showCompare)}
                title={`Compare (${savedAnalyses.length} saved)`}
                aria-label="Compare"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="18" y1="20" x2="18" y2="10" />
                  <line x1="12" y1="20" x2="12" y2="4" />
                  <line x1="6" y1="20" x2="6" y2="14" />
                </svg>
                <span className="compare-badge">{savedAnalyses.length}</span>
              </button>
            )}
            <button
              className="analysis-close"
              onClick={() => setAnalysisPanelOpen(false)}
              aria-label="Close analysis"
            >×</button>
          </div>
        </div>
        {!analysisResults.loading && (() => {
          const grade = computeLocationGrade(analysisResults)
          return (
            <div className="analysis-score-bar">
              <div className="analysis-grade" style={{ background: grade.color }}>{grade.letter}</div>
              <div className="analysis-score-label">
                <strong>Location Score</strong>
                <span>{grade.letter === 'A' ? 'Excellent' : grade.letter === 'B' ? 'Good' : grade.letter === 'C' ? 'Fair' : grade.letter === 'D' ? 'Poor' : 'Critical'}</span>
              </div>
            </div>
          )
        })()}
        <div className="analysis-print-header">
          <h1>LandRecon — Location Analysis</h1>
          <p>{address}</p>
          <p className="analysis-print-date">{new Date().toLocaleDateString()}</p>
        </div>
        {showCompare && savedAnalyses.length > 0 && (
          <div className="analysis-compare">
            <h3 className="compare-title">Saved Comparisons</h3>
            <div className="compare-table">
              <div className="compare-row compare-header-row">
                <span className="compare-cell compare-addr">Location</span>
                <span className="compare-cell">Grade</span>
                <span className="compare-cell">Noise</span>
                <span className="compare-cell">Superfund</span>
                <span className="compare-cell">Costco</span>
                <span className="compare-cell">Data Ctrs</span>
                <span className="compare-cell compare-actions"></span>
              </div>
              {savedAnalyses.map((sa, i) => (
                <div className="compare-row" key={i}>
                  <span className="compare-cell compare-addr" title={sa.address}>{sa.address}</span>
                  <span className="compare-cell"><span className="compare-grade" style={{ background: sa.gradeColor }}>{sa.grade}</span></span>
                  <span className="compare-cell">{sa.noiseLevel != null ? `${sa.noiseLevel} dB` : '—'}</span>
                  <span className="compare-cell">{sa.superfundCount === 0 ? '✅ None' : `${sa.superfundActive} active`}</span>
                  <span className="compare-cell">{sa.costcoMi != null ? `${sa.costcoMi.toFixed(1)} mi` : '—'}</span>
                  <span className="compare-cell">{sa.dataCenterCount}</span>
                  <span className="compare-cell compare-actions">
                    <button className="compare-del" onClick={() => removeSavedAnalysis(i)} title="Remove">×</button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="analysis-content">
          {analysisResults.loading ? (
            <div className="analysis-skeleton">
              {[
                { key: 'noise', icon: '✈️', label: 'Airport Noise' },
                { key: 'superfund', icon: '☢️', label: 'Superfund Sites' },
                { key: 'costco', icon: '🛒', label: 'Costco' },
                { key: 'datacenters', icon: '🏢', label: 'Data Centers' },
              ].map(({ key, icon, label }) => (
                <div key={key} className={`analysis-card skeleton ${analysisProgress[key] === 'done' ? 'skeleton-done' : ''}`}>
                  <div className="analysis-item">
                    <div className="analysis-icon">{analysisProgress[key] === 'done' ? '✓' : icon}</div>
                    <div className="analysis-detail">
                      <strong>{label}</strong>
                      <p>{analysisProgress[key] === 'done' ? 'Complete' : 'Checking…'}</p>
                    </div>
                    {analysisProgress[key] !== 'done' && <div className="skeleton-spinner" />}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <>
              {/* Noise */}
              <div className={`analysis-card ${analysisResults.noiseLevel ? noiseSeverity(analysisResults.noiseLevel) : 'clear'}`}>
                <div
                  className="analysis-item clickable"
                  onClick={() => setAnalysisDetail(analysisDetail === 'noise' ? null : 'noise')}
                >
                  <div className="analysis-icon">{analysisResults.noiseLevel ? '✈️' : '✅'}</div>
                  <div className="analysis-detail">
                    <strong>Airport Noise</strong>
                    <p>{analysisResults.noiseLevel ? `~${analysisResults.noiseLevel} dB DNL` : 'No airport noise detected'}</p>
                  </div>
                  <div className={`analysis-chevron${analysisDetail === 'noise' ? ' expanded' : ''}`}>›</div>
                </div>
                {analysisDetail === 'noise' && (
                  <div className="analysis-expand">
                    {analysisResults.noiseLevel ? (
                      <>
                        {analysisResults.noiseAirport && (
                          <p className="analysis-expand-sub">
                            {analysisResults.noiseAirport}{analysisResults.noiseAirportCode ? ` (${analysisResults.noiseAirportCode})` : ''}
                          </p>
                        )}
                        <p className="analysis-expand-level">Estimated: ~{analysisResults.noiseLevel} dB DNL</p>
                        <div className="analysis-expand-rec">
                          <strong>Recommendation</strong>
                          <p>
                            Locations at 55 dB DNL or higher are considered significantly impacted by aircraft noise.
                            We recommend repeat visits at different times of day — including early morning,
                            evening, and weekends — to assess whether the noise level is acceptable.
                          </p>
                        </div>
                      </>
                    ) : (
                      <p className="analysis-expand-level">This location is not within any mapped airport noise contour.</p>
                    )}
                  </div>
                )}
              </div>

              {/* Superfund */}
              <div className={`analysis-card ${superfundSeverity(analysisResults.superfunds)}`}>
                <div
                  className="analysis-item clickable"
                  onClick={() => setAnalysisDetail(analysisDetail === 'superfunds' ? null : 'superfunds')}
                >
                  <div className="analysis-icon">{analysisResults.superfunds.length > 0 ? '☢️' : '✅'}</div>
                  <div className="analysis-detail">
                    <strong>Superfund Sites</strong>
                    <p>{analysisResults.superfunds.length > 0
                      ? `${analysisResults.superfunds.length} within 5 mi`
                      : 'No Superfund sites within 5 miles'}</p>
                  </div>
                  <div className={`analysis-chevron${analysisDetail === 'superfunds' ? ' expanded' : ''}`}>›</div>
                </div>
                {analysisDetail === 'superfunds' && (
                  <div className="analysis-expand">
                    {analysisResults.superfunds.length > 0 ? (
                      <>
                        <ul className="analysis-expand-list">
                          {analysisResults.superfunds.map((s, i) => (
                            <li key={i}>
                              <div className="analysis-flyto-row">
                                <div>
                                  <strong>{s.name}</strong> — {s.distanceMi} mi
                                  <span className={`analysis-status ${s.status === 'Deleted' ? 'status-cleared' : 'status-active'}`}>
                                    {s.status}
                                  </span>
                                </div>
                                <button className="analysis-flyto-btn" onClick={() => mapRef.current?.flyTo([s.lat, s.lng], 15)} title="Fly to location">📍</button>
                              </div>
                              {s.url && (
                                <a href={s.url} target="_blank" rel="noopener noreferrer" className="analysis-epa-link">
                                  EPA Profile →
                                </a>
                              )}
                            </li>
                          ))}
                        </ul>
                        <div className="analysis-expand-rec">
                          <strong>Recommendation</strong>
                          <p>
                            Sites marked "Deleted" have been cleaned up and removed from the NPL.
                            For active sites, research using the EPA links above.
                          </p>
                        </div>
                      </>
                    ) : (
                      <p className="analysis-expand-level">No EPA Superfund sites found within 5 miles of this address.</p>
                    )}
                  </div>
                )}
              </div>

              {/* Costco */}
              <div className={`analysis-card ${analysisResults.costco ? costcoSeverity(analysisResults.costco.distanceMi) : analysisResults.costcoError ? 'warning' : 'danger'}`}>
                <div
                  className="analysis-item clickable"
                  onClick={() => setAnalysisDetail(analysisDetail === 'costco' ? null : 'costco')}
                >
                  <div className="analysis-icon">🛒</div>
                  <div className="analysis-detail">
                    <strong>Nearest Costco</strong>
                    <p>{analysisResults.costco
                      ? `${analysisResults.costco.distanceMi} mi${analysisResults.costco.city ? ` — ${analysisResults.costco.city}` : ''}`
                      : analysisResults.costcoError ? 'Search timed out' : `None within ${COSTCO_ANALYSIS_RADIUS_MI} mi`}</p>
                  </div>
                  <div className={`analysis-chevron${analysisDetail === 'costco' ? ' expanded' : ''}`}>›</div>
                </div>
                {analysisDetail === 'costco' && (
                  <div className="analysis-expand">
                    {analysisResults.costco ? (() => {
                      const dist = analysisResults.costco.distanceMi
                      const sev = costcoSeverity(dist)
                      return (
                        <>
                          <p className="analysis-expand-sub">{analysisResults.costco.city || 'Costco Wholesale'}</p>
                          <p className={`analysis-expand-level ${sev}`}>{dist} miles from this address</p>
                          <div className="analysis-costco-actions">
                            <button className="analysis-flyto-link" onClick={() => mapRef.current?.flyTo([analysisResults.costco!.lat, analysisResults.costco!.lng], 15)}>
                              📍 Show on map
                            </button>
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
                          </div>
                          <div className="analysis-expand-rec">
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
                                  $1.50 hot dog in the parking lot.
                                </p>
                              </>
                            )}
                            {sev === 'danger' && (
                              <>
                                <strong>Real talk for a second.</strong>
                                <p>
                                  {dist} miles. To a Costco. Do you actually want to live that
                                  far away from a building full of free samples and reasonably
                                  priced tires? Is this house really worth a {Math.round(dist * 2)}-mile
                                  round trip every time you need a flat of paper towels?
                                </p>
                              </>
                            )}
                          </div>
                          <div className="analysis-expand-rec">
                            <strong>Distance bands</strong>
                            <p>
                              <span className="analysis-band good">≤ 30 mi</span> blissful · {' '}
                              <span className="analysis-band warning">31–50 mi</span> tolerable · {' '}
                              <span className="analysis-band danger">51–100 mi</span> reconsider
                            </p>
                          </div>
                        </>
                      )
                    })() : analysisResults.costcoError ? (
                      <p className="analysis-expand-level warning">
                        Costco search timed out. The Overpass server may be busy — try again later.
                      </p>
                    ) : (
                      <>
                        <p className="analysis-expand-level danger">
                          No Costco found within {COSTCO_ANALYSIS_RADIUS_MI} miles.
                        </p>
                        <div className="analysis-expand-rec">
                          <strong>⚠️ Are you sure about this?</strong>
                          <p>
                            There is <em>no Costco</em> within {COSTCO_ANALYSIS_RADIUS_MI} miles.
                            You will have to survive on normal-sized packages of toilet paper.
                            Sourcing a 48-pack of muffins will require <em>logistics</em>.
                          </p>
                        </div>
                        <div className="analysis-expand-rec">
                          <strong>Distance bands</strong>
                          <p>
                            <span className="analysis-band good">≤ 30 mi</span> blissful · {' '}
                            <span className="analysis-band warning">31–50 mi</span> tolerable · {' '}
                            <span className="analysis-band danger">51–100 mi</span> reconsider
                          </p>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Data Centers */}
              <div className={`analysis-card ${dataCenterSeverity(analysisResults.dataCenters.length)}`}>
                <div
                  className="analysis-item clickable"
                  onClick={() => setAnalysisDetail(analysisDetail === 'datacenters' ? null : 'datacenters')}
                >
                  <div className="analysis-icon">{analysisResults.dataCenters.length > 0 ? '🏢' : '✅'}</div>
                  <div className="analysis-detail">
                    <strong>Data Centers</strong>
                    <p>{analysisResults.dataCenters.length > 0
                      ? `${analysisResults.dataCenters.length} within ${DATA_CENTER_ANALYSIS_RADIUS_MI} mi`
                      : 'No data centers nearby'}</p>
                  </div>
                  <div className={`analysis-chevron${analysisDetail === 'datacenters' ? ' expanded' : ''}`}>›</div>
                </div>
                {analysisDetail === 'datacenters' && (
                  <div className="analysis-expand">
                    {analysisResults.dataCenters.length > 0 ? (
                      <>
                        <div className="analysis-expand-rec">
                          <strong>Why this matters</strong>
                          <p>
                            Data centers can impact surrounding areas through increased traffic,
                            noise from cooling systems, and strain on local power and water resources.
                          </p>
                        </div>
                        <ul className="analysis-expand-list">
                          {analysisResults.dataCenters.map((dc, i) => (
                            <li key={i} className="dc-analysis-item">
                              <div className="dc-analysis-header">
                                <span className="dc-status-dot" style={{ background: DC_STATUS_COLORS[dc.status] || '#6b7280' }} />
                                <strong>{dc.name || 'Unknown Facility'}</strong>
                                <span className="dc-distance">{dc.distanceMi} mi</span>
                                <button className="analysis-flyto-btn" onClick={() => mapRef.current?.flyTo([dc.lat, dc.lng], 15)} title="Fly to location">📍</button>
                              </div>
                              <div className="dc-analysis-meta">
                                {dc.operator && <span>{dc.operator}</span>}
                                {(dc.city || dc.state) && <span>{[dc.city, dc.state].filter(Boolean).join(', ')}</span>}
                                <span>{dc.status}</span>
                                {dc.mw && <span>{dc.mw} MW</span>}
                                {dc.sizerank && dc.sizerank !== 'Unknown' && <span>{dc.sizerank}</span>}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <p className="analysis-expand-level">No data centers found within {DATA_CENTER_ANALYSIS_RADIUS_MI} miles.</p>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </aside>

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
