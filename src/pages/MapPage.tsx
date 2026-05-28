import { useEffect, useRef, useState, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import './MapPage.css'
import logo from '../assets/landrecon-logo.webp'
import GuidedTour from '../components/GuidedTour'
import { pushRecentSearch, updateRecentSearchGrade } from '../utils/recentSearches'
import { debounce, quantizeCoord } from '../utils/perf'
import { LEGEND_BANDS } from '../noise/legend'
import type { DistrictLayerId } from '../utils/districtsLayer'
import { DISTRICT_LAYER_LABELS, marginToColor, loadDistrictLayer } from '../utils/districtsLayer'

// The heavy noise module (PMTiles + protomaps-leaflet + vector-tile) is
// dynamic-imported on first use so it stays out of the initial MapPage chunk.
type AirportNoiseModule = typeof import('../noise/airportNoise')
let airportNoiseModulePromise: Promise<AirportNoiseModule> | null = null
function loadAirportNoiseModule(): Promise<AirportNoiseModule> {
  if (!airportNoiseModulePromise) {
    airportNoiseModulePromise = import('../noise/airportNoise')
  }
  return airportNoiseModulePromise
}

const NOISE_PMTILES_URL =
  import.meta.env.VITE_NOISE_PMTILES_URL || '/data/airport-noise.pmtiles'

// TomTom Traffic Flow tile layer (real-time)
const TOMTOM_API_KEY = import.meta.env.VITE_TOMTOM_API_KEY || ''
const TRAFFIC_TILE_URL = `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${TOMTOM_API_KEY}`

const GOOGLE_MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY || ''
if (!GOOGLE_MAPS_KEY && typeof window !== 'undefined') {
  console.warn(
    '[LandRecon] VITE_GOOGLE_MAPS_KEY is not set — basemaps, transit, ER, and Costco lookups will fail. ' +
    'Add it to .env for local dev or to the GOOGLE_MAPS_KEY GitHub Secret for deploys.',
  )
}

// Debug logging — enable in console: localStorage.setItem('LR_DEBUG','1'); location.reload()
declare const __BUILD_VERSION__: string
const LR_DEBUG = typeof localStorage !== 'undefined' && localStorage.getItem('LR_DEBUG') === '1'
function dbg(tag: string, ...args: unknown[]) { if (LR_DEBUG) console.debug(`[LR:${tag}]`, ...args) }
if (LR_DEBUG) console.info(`%c[LandRecon] Debug mode ON — build ${__BUILD_VERSION__}`, 'color:#0ea5e9;font-weight:bold')

const GOOGLE_NO_POI = [
  { featureType: 'poi', elementType: 'all', stylers: [{ visibility: 'off' }] },
]

type BaseMapId = 'street' | 'satellite'

type GoogleSessionEntry = { token: string; expiry: number }
const SESSION_STORAGE_PREFIX = 'lr_gtile_session:'
const googleSessionCache = new Map<string, GoogleSessionEntry>()

function readPersistedSession(key: string): GoogleSessionEntry | null {
  if (typeof sessionStorage === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_PREFIX + key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as GoogleSessionEntry
    if (typeof parsed?.token !== 'string' || typeof parsed?.expiry !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

function writePersistedSession(key: string, entry: GoogleSessionEntry) {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(SESSION_STORAGE_PREFIX + key, JSON.stringify(entry))
  } catch {
    // sessionStorage may be full or disabled; not fatal
  }
}

async function getGoogleTileSession(mapType: string, styles?: Record<string, unknown>[]): Promise<string> {
  const key = `${mapType}:${JSON.stringify(styles || [])}`
  const now = Date.now() / 1000 + 300
  let cached = googleSessionCache.get(key)
  if (!cached) {
    const persisted = readPersistedSession(key)
    if (persisted) {
      googleSessionCache.set(key, persisted)
      cached = persisted
    }
  }
  if (cached && cached.expiry > now) {
    dbg('tiles', 'Using cached session for', mapType)
    return cached.token
  }

  dbg('tiles', 'Creating new tile session:', mapType, styles ? 'with styles' : 'no styles')
  const body: Record<string, unknown> = { mapType, language: 'en-US', region: 'US' }
  if (styles?.length) body.styles = styles

  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(
        `https://tile.googleapis.com/v1/createSession?key=${GOOGLE_MAPS_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      )
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Google Tiles API ${res.status}: ${text.slice(0, 200)}`)
      }
      const data = await res.json()
      dbg('tiles', 'Session created, expires:', new Date(parseInt(data.expiry) * 1000).toISOString())
      const entry: GoogleSessionEntry = { token: data.session, expiry: parseInt(data.expiry) }
      googleSessionCache.set(key, entry)
      writePersistedSession(key, entry)
      return data.session
    } catch (e) {
      lastErr = e
      if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Google Tiles session failed')
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

// Fetch nearby Costco Wholesale warehouses via Google Places Text Search.
// We previously queried Overpass/OSM but OSM coverage of Costco brand tags
// is uneven — many real warehouses are missing the brand or shop tags and
// were silently excluded, producing results like "nearest is 24mi away"
// when there's actually one much closer. Google Places matches what users
// see when they search "costco" on maps.google.com.
type CostcoPlace = { id: string; name: string; addr: string; lat: number; lng: number }
async function fetchCostcosViaPlaces(opts: {
  circle?: { lat: number; lng: number; radiusM: number }
  rectangle?: { south: number; west: number; north: number; east: number }
  signal?: AbortSignal
}): Promise<CostcoPlace[]> {
  if (!GOOGLE_MAPS_KEY) return []
  const body: Record<string, unknown> = {
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

  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.formattedAddress',
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  if (!res.ok) throw new Error(`Places searchText: ${res.status}`)
  const data = await res.json()
  const out: CostcoPlace[] = []
  for (const p of data.places || []) {
    const loc = p.location
    if (!loc) continue
    const name = (p.displayName?.text || 'Costco').trim()
    // The store warehouse always matches /costco/. Filter out adjacent
    // Costco Gas, Costco Tire Center, Costco Pharmacy, etc. so they don't
    // count as separate locations.
    if (!/costco/i.test(name)) continue
    if (/\b(gas|fuel|tire|pharmacy|optical|food court|hearing|liquor)\b/i.test(name)) continue
    out.push({
      id: p.id,
      name,
      addr: p.formattedAddress || '',
      lat: loc.latitude,
      lng: loc.longitude,
    })
  }
  return out
}

// Split "123 Main St, Springfield, IL 62701, USA" into street + locality.
function parseCostcoAddress(addr: string): { street: string; locality: string } {
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

// Per-tab cache of completed analyses keyed by quantized coordinates
// (~110 m precision). Re-running for an address near a prior one returns
// instantly with no Google/EPA/ArcGIS calls.
const ANALYSIS_CACHE_PREFIX = 'lr_analysis_v2:'
const ANALYSIS_CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes

// Developer todo list, shown via the hidden Experimental menu. DEV_TODOS
// below is the initial seed used the first time the modal is opened; after
// that the canonical list lives in localStorage (under DEV_TODOS_ITEMS_KEY)
// so add/delete from the UI persists across sessions. Per-item checkbox
// state is stored separately under DEV_TODOS_CHECKS_KEY.
interface DevTodo { id: string; label: string; note?: string }
const DEV_TODOS: DevTodo[] = [
  { id: 'crowd-tune', label: 'Tune Crowd Magnets filters once we see more sample addresses' },
  { id: 'secret-mounts', label: 'Switch VITE_* keys to Docker --secret mounts (kill the SecretsUsedInArgOrEnv warnings)' },
  { id: 'buildx-v6', label: 'Bump docker/build-push-action@v5 → @v6 to reduce "unknown blob" flakes' },
  { id: 'mobile-polish', label: 'Mobile: verify analysis panel + layer panel ergonomics on small screens' },
  { id: 'grade-rebalance', label: 'Revisit Location Grade weights now that Crowd Magnets is included' },
]
const DEV_TODOS_ITEMS_KEY = 'lr_dev_todos_items'
const DEV_TODOS_CHECKS_KEY = 'lr_dev_todos'
const DEV_TODOS_API = '/api/dev-todos'

function readDevTodoItems(): DevTodo[] {
  try {
    const raw = localStorage.getItem(DEV_TODOS_ITEMS_KEY)
    if (!raw) return DEV_TODOS
    const parsed = JSON.parse(raw) as DevTodo[]
    if (!Array.isArray(parsed)) return DEV_TODOS
    return parsed.filter((t) => t && typeof t.id === 'string' && typeof t.label === 'string')
  } catch { return DEV_TODOS }
}
function writeDevTodoItems(items: DevTodo[]) {
  try { localStorage.setItem(DEV_TODOS_ITEMS_KEY, JSON.stringify(items)) } catch { /* ignore */ }
}
function readDevTodoChecks(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(DEV_TODOS_CHECKS_KEY)
    return raw ? JSON.parse(raw) as Record<string, boolean> : {}
  } catch { return {} }
}
function writeDevTodoChecks(state: Record<string, boolean>) {
  try { localStorage.setItem(DEV_TODOS_CHECKS_KEY, JSON.stringify(state)) } catch { /* ignore */ }
}

async function fetchDevTodosFromServer(signal?: AbortSignal): Promise<{ items: DevTodo[]; checks: Record<string, boolean> } | null> {
  try {
    const res = await fetch(DEV_TODOS_API, { signal, cache: 'no-store' })
    if (!res.ok) return null
    const data = await res.json()
    const items = Array.isArray(data?.items)
      ? data.items.filter((t: unknown): t is DevTodo =>
          !!t && typeof (t as DevTodo).id === 'string' && typeof (t as DevTodo).label === 'string')
      : []
    const checks = data?.checks && typeof data.checks === 'object' ? data.checks as Record<string, boolean> : {}
    return { items, checks }
  } catch { return null }
}
async function saveDevTodosToServer(payload: { items: DevTodo[]; checks: Record<string, boolean> }): Promise<boolean> {
  try {
    const res = await fetch(DEV_TODOS_API, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return res.ok
  } catch { return false }
}

interface CachedAnalysisPayload {
  ts: number
  data: {
    noiseLevel: number | null
    noiseAirport: string | null
    noiseAirportCode: string | null
    superfunds: unknown[]
    costco: unknown
    costcoNearby: unknown[]
    costcoNearestBeyond: unknown
    costcoError: boolean
    dataCenters: unknown[]
    nearestER: unknown
    erError: boolean
    crowdMagnets: unknown[]
  }
}

function analysisCacheKey(lat: number, lng: number): string {
  return `${ANALYSIS_CACHE_PREFIX}${quantizeCoord(lat)},${quantizeCoord(lng)}`
}

function readAnalysisCache(lat: number, lng: number): CachedAnalysisPayload['data'] | null {
  if (typeof sessionStorage === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(analysisCacheKey(lat, lng))
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedAnalysisPayload
    if (Date.now() - parsed.ts > ANALYSIS_CACHE_TTL_MS) return null
    return parsed.data
  } catch {
    return null
  }
}

function writeAnalysisCache(lat: number, lng: number, data: CachedAnalysisPayload['data']) {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(
      analysisCacheKey(lat, lng),
      JSON.stringify({ ts: Date.now(), data } satisfies CachedAnalysisPayload),
    )
  } catch {
    // Storage is full or disabled; not fatal — analysis still ran.
  }
}


const SUPERFUND_API =
  'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/FAC_Superfund_Site_Boundaries_EPA_Public/FeatureServer/0/query'

const SUPERFUND_FIELDS = [
  'SITE_NAME', 'EPA_ID', 'NPL_STATUS_CODE', 'CITY_NAME',
  'STATE_CODE', 'SITE_FEATURE_TYPE', 'URL_ALIAS_TXT',
].join(',')

const LEGEND_STOPS = LEGEND_BANDS

const SUPERFUND_ICON = L.divIcon({
  className: 'superfund-marker',
  html: `<div class="superfund-marker-inner" aria-hidden="true">☢️</div>`,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  popupAnchor: [0, -16],
})

type GeoJSONCoord = number[]
type GeoJSONRing = GeoJSONCoord[]

function superfundFeatureToPoint(
  feat: GeoJSON.Feature,
): GeoJSON.Feature<GeoJSON.Point> | null {
  const geom = feat.geometry
  if (!geom) return null
  let lat: number | undefined
  let lon: number | undefined
  if (geom.type === 'Point') {
    const [x, y] = geom.coordinates
    lon = x
    lat = y
  } else if (geom.type === 'Polygon') {
    const ring = geom.coordinates[0] as GeoJSONRing | undefined
    if (ring && ring.length) {
      lon = ring.reduce((s, c) => s + c[0], 0) / ring.length
      lat = ring.reduce((s, c) => s + c[1], 0) / ring.length
    }
  } else if (geom.type === 'MultiPolygon') {
    const ring = geom.coordinates[0]?.[0] as GeoJSONRing | undefined
    if (ring && ring.length) {
      lon = ring.reduce((s, c) => s + c[0], 0) / ring.length
      lat = ring.reduce((s, c) => s + c[1], 0) / ring.length
    }
  }
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null
  }
  return {
    type: 'Feature',
    properties: feat.properties || {},
    geometry: { type: 'Point', coordinates: [lon, lat] },
  }
}

function superfundFeaturesToPoints(
  fc: GeoJSON.FeatureCollection,
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const features: GeoJSON.Feature<GeoJSON.Point>[] = []
  for (const f of fc.features || []) {
    const pt = superfundFeatureToPoint(f)
    if (pt) features.push(pt)
  }
  return { type: 'FeatureCollection', features }
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

const SHARE_LAYER_IDS = ['noise', 'superfund', 'transit', 'traffic', 'costco', 'datacenters', 'ems', 'crowd'] as const

type LayerStateSnapshot = {
  noise: boolean
  superfund: boolean
  transit: boolean
  traffic: boolean
  costco: boolean
  datacenters: boolean
  ems: boolean
  crowd: boolean
}

const LAYER_OFF: LayerStateSnapshot = {
  noise: false, superfund: false, transit: false, traffic: false,
  costco: false, datacenters: false, ems: false, crowd: false,
}

interface LayerPreset {
  id: 'family' | 'quiet' | 'commute' | 'clear'
  label: string
  desc: string
  state: LayerStateSnapshot
}

const LAYER_PRESETS: readonly LayerPreset[] = [
  {
    id: 'family',
    label: 'Family',
    desc: 'Transit, emergency services, and Costco',
    state: { ...LAYER_OFF, transit: true, ems: true, costco: true },
  },
  {
    id: 'quiet',
    label: 'Quiet',
    desc: 'Airport noise, live traffic, and data centers (avoid noisy areas)',
    state: { ...LAYER_OFF, noise: true, traffic: true, datacenters: true },
  },
  {
    id: 'commute',
    label: 'Commute',
    desc: 'Public transit + live traffic',
    state: { ...LAYER_OFF, transit: true, traffic: true },
  },
  {
    id: 'clear',
    label: 'Clear',
    desc: 'Turn off every overlay',
    state: { ...LAYER_OFF },
  },
] as const

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

const DATA_CENTER_ANALYSIS_RADIUS_MI = 3
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

const CROWD_TYPES = ['stadium', 'concert', 'park', 'raceway', 'themepark'] as const
type CrowdType = typeof CROWD_TYPES[number]
const CROWD_COLORS: Record<CrowdType, string> = {
  stadium: '#D55E00',
  concert: '#CC79A7',
  park: '#009E73',
  raceway: '#332288',
  themepark: '#E69F00',
}
const CROWD_LABELS: Record<CrowdType, string> = {
  stadium: 'Stadiums',
  concert: 'Concert Venues',
  park: 'National Parks',
  raceway: 'Racetracks',
  themepark: 'Theme Parks',
}
const CROWD_ICONS: Record<CrowdType, string> = {
  stadium: '🏟️',
  concert: '🎵',
  park: '🌲',
  raceway: '🏁',
  themepark: '🎢',
}
const CROWD_LABEL_SINGULAR: Record<CrowdType, string> = {
  stadium: 'Stadium',
  concert: 'Concert Venue',
  park: 'National Park',
  raceway: 'Racetrack',
  themepark: 'Theme Park',
}
const CROWD_ANALYSIS_RADIUS_MI = 2

interface CrowdMagnet {
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

function classifyCrowdElement(tags: Record<string, string>): CrowdType | null {
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

async function fetchCrowdMagnets(bounds: L.LatLngBounds, signal?: AbortSignal): Promise<CrowdMagnet[]> {
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

const COSTCO_ANALYSIS_RADIUS_MI = 100
const COSTCO_GREEN_RADIUS_MI = 30
const ER_ANALYSIS_RADIUS_MI = 15

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

function crowdMagnetsSeverity(count: number): 'clear' | 'warning' | 'danger' {
  if (count === 0) return 'clear'
  if (count <= 2) return 'warning'
  return 'danger'
}

function erSeverity(distMi: number | null): 'clear' | 'good' | 'warning' | 'danger' {
  if (distMi === null) return 'danger'
  if (distMi <= 10) return 'clear'
  if (distMi <= 15) return 'warning'
  return 'danger'
}

type SeverityLevel = 'clear' | 'good' | 'warning' | 'danger'

function computeLocationGrade(results: {
  noiseLevel: number | null
  superfunds: { status: string }[]
  costco: { distanceMi: number } | null
  costcoError: boolean
  costcoLoading?: boolean
  dataCenters: unknown[]
  nearestER: { distanceMi: number } | null
  crowdMagnets: unknown[]
}): { letter: string; color: string; severity: SeverityLevel; pct: number; breakdown: { label: string; icon: string; score: number; max: number; detail: string }[] } {
  const breakdown: { label: string; icon: string; score: number; max: number; detail: string }[] = []

  // Noise: 0 = none, 1 = moderate (<65), 2 = high (65+)
  let noiseScore = 0
  let noiseDetail = 'No airport noise detected'
  if (results.noiseLevel) {
    if (results.noiseLevel < 65) { noiseScore = 1; noiseDetail = `~${results.noiseLevel} dB DNL (moderate)` }
    else { noiseScore = 2; noiseDetail = `~${results.noiseLevel} dB DNL (high)` }
  }
  breakdown.push({ label: 'Airport Noise', icon: '✈️', score: noiseScore, max: 2, detail: noiseDetail })

  // Superfund
  const sfSev = superfundSeverity(results.superfunds)
  const sfScore = sfSev === 'clear' ? 0 : sfSev === 'warning' ? 1 : 2
  const sfDetail = results.superfunds.length === 0 ? 'None within 5 mi'
    : `${results.superfunds.length} site${results.superfunds.length > 1 ? 's' : ''} (${results.superfunds.filter(s => s.status !== 'Deleted').length} active)`
  breakdown.push({ label: 'Superfund Sites', icon: '☢️', score: sfScore, max: 2, detail: sfDetail })

  // Costco (skipped while still loading so the grade doesn't get artificially penalized)
  if (!results.costcoLoading) {
    let costcoScore: number
    let costcoDetail: string
    if (!results.costco) {
      costcoScore = results.costcoError ? 1 : 2
      costcoDetail = results.costcoError ? 'Search timed out' : 'None within range'
    } else {
      const cs = costcoSeverity(results.costco.distanceMi)
      costcoScore = cs === 'good' ? 0 : cs === 'warning' ? 1 : 2
      costcoDetail = `${results.costco.distanceMi} mi away`
    }
    breakdown.push({ label: 'Nearest Costco', icon: '🛒', score: costcoScore, max: 2, detail: costcoDetail })
  }

  // Data centers
  const dcSev = dataCenterSeverity(results.dataCenters.length)
  const dcScore = dcSev === 'clear' ? 0 : dcSev === 'warning' ? 1 : 2
  const dcDetail = results.dataCenters.length === 0 ? 'None nearby' : `${results.dataCenters.length} nearby`
  breakdown.push({ label: 'Data Centers', icon: '🏢', score: dcScore, max: 2, detail: dcDetail })

  // Crowd magnets
  const cmCount = results.crowdMagnets.length
  const cmSev = crowdMagnetsSeverity(cmCount)
  const cmScore = cmSev === 'clear' ? 0 : cmSev === 'warning' ? 1 : 2
  const cmDetail = cmCount === 0
    ? `None within ${CROWD_ANALYSIS_RADIUS_MI} mi`
    : `${cmCount} within ${CROWD_ANALYSIS_RADIUS_MI} mi`
  breakdown.push({ label: 'Crowd Magnets', icon: '🎟️', score: cmScore, max: 2, detail: cmDetail })

  // Emergency Room
  const erDist = results.nearestER?.distanceMi ?? null
  const erSev = erSeverity(erDist)
  const erScore = erSev === 'clear' ? 0 : erSev === 'good' ? 0 : erSev === 'warning' ? 1 : 2
  const erDetail = erDist !== null ? `${erDist} mi away` : 'None found within search area'
  breakdown.push({ label: 'Emergency Room', icon: '🏥', score: erScore, max: 2, detail: erDetail })

  const total = breakdown.reduce((a, b) => a + b.score, 0)
  const max = breakdown.reduce((a, b) => a + b.max, 0)

  const pct = 1 - total / max
  if (pct >= 0.9) return { letter: 'A', color: '#4caf50', severity: 'clear', pct, breakdown }
  if (pct >= 0.75) return { letter: 'B', color: '#8bc34a', severity: 'good', pct, breakdown }
  if (pct >= 0.5) return { letter: 'C', color: '#ffb300', severity: 'warning', pct, breakdown }
  if (pct >= 0.25) return { letter: 'D', color: '#ff7043', severity: 'warning', pct, breakdown }
  return { letter: 'F', color: '#ef5350', severity: 'danger', pct, breakdown }
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
  const crowdLayerRef = useRef<L.LayerGroup | null>(null)
  const crowdSubLayersRef = useRef<Record<CrowdType, L.LayerGroup> | null>(null)
  const crowdLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const crowdKnownIdsRef = useRef<Set<string>>(new Set())
  const [crowdSubVisible, setCrowdSubVisible] = useState<Record<CrowdType, boolean>>({
    stadium: true, concert: true, park: true, raceway: true, themepark: true,
  })
  const crowdSubVisibleRef = useRef(crowdSubVisible)
  const targetLocationRef = useRef<L.LatLng | null>(null)
  const homeMarkerRef = useRef<L.Marker | null>(null)
  const highlightMarkerRef = useRef<L.Marker | null>(null)
  const transitPreloadedRef = useRef(false)
  const initialUrlStateAppliedRef = useRef(false)
  // Monotonic counter so an in-flight analysis can detect that the user has
  // since kicked off a newer one and silently discard its (now-stale) results.
  const analysisRunIdRef = useRef(0)
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
  const [costcoVisible, setCostcoVisible] = useState(false)
  const [trafficVisible, setTrafficVisible] = useState(false)
  const [dataCenterVisible, setDataCenterVisible] = useState(false)
  const [emsVisible, setEmsVisible] = useState(false)
  const [emsLoading, setEmsLoading] = useState(false)
  const [crowdVisible, setCrowdVisible] = useState(false)
  const [crowdLoading, setCrowdLoading] = useState(false)
  // Voting districts — experimental layer set; each chamber loads lazily on
  // first toggle and is cached on the L.Map afterward.
  const districtLayerRefs = useRef<Record<DistrictLayerId, L.GeoJSON | null>>({
    cd118: null, sldu: null, sldl: null,
  })
  const [districtVisible, setDistrictVisible] = useState<Record<DistrictLayerId, boolean>>({
    cd118: false, sldu: false, sldl: false,
  })
  const [districtLoading, setDistrictLoading] = useState<Record<DistrictLayerId, boolean>>({
    cd118: false, sldu: false, sldl: false,
  })
  const [districtAvailable, setDistrictAvailable] = useState<Record<DistrictLayerId, boolean | null>>({
    cd118: null, sldu: null, sldl: null,
  })
  const [activeBaseMap, setActiveBaseMap] = useState<BaseMapId>('street')
  const [analysisResults, setAnalysisResults] = useState<{
    loading: boolean
    noiseLevel: number | null
    noiseAirport: string | null
    noiseAirportCode: string | null
    superfunds: { name: string; distanceMi: number; status: string; url: string; lat: number; lng: number }[]
    costco: { osmId: string; name: string; city: string; address: string; distanceMi: number; lat: number; lng: number } | null
    costcoNearby: { osmId: string; name: string; city: string; address: string; distanceMi: number; lat: number; lng: number }[]
    costcoNearestBeyond: { osmId: string; name: string; city: string; address: string; distanceMi: number; lat: number; lng: number } | null
    costcoError: boolean
    costcoLoading: boolean
    dataCenters: { name: string; city: string; state: string; distanceMi: number; status: string; operator: string; mw: string; sizerank: string; lat: number; lng: number }[]
    nearestER: { name: string; address: string; distanceMi: number; lat: number; lng: number } | null
    erError: boolean
    crowdMagnets: { id: string; name: string; type: CrowdType; distanceMi: number; lat: number; lng: number }[]
  }>({ loading: true, noiseLevel: null, noiseAirport: null, noiseAirportCode: null, superfunds: [], costco: null, costcoNearby: [], costcoNearestBeyond: null, costcoError: false, costcoLoading: true, dataCenters: [], nearestER: null, erError: false, crowdMagnets: [] })
  const [analysisProgress, setAnalysisProgress] = useState<Record<string, 'pending' | 'done'>>({})
  const [analysisDetail, setAnalysisDetail] = useState<'noise' | 'superfunds' | 'costco' | 'datacenters' | 'er' | 'score' | 'crowd' | null>(null)

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
  const [showScoreBreakdown, setShowScoreBreakdown] = useState(false)

  const saveCurrentAnalysis = useCallback(() => {
    if (analysisResults.loading || analysisResults.costcoLoading) return
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
  const [devTodosOpen, setDevTodosOpen] = useState(false)
  const [devTodoItems, setDevTodoItems] = useState<DevTodo[]>(() => readDevTodoItems())
  const [devTodoChecks, setDevTodoChecks] = useState<Record<string, boolean>>(() => readDevTodoChecks())
  const [newDevTodoText, setNewDevTodoText] = useState('')
  const [devTodoSync, setDevTodoSync] = useState<'idle' | 'loading' | 'saving' | 'offline'>('idle')
  const devTodoSaveTimer = useRef<number | null>(null)

  // Push the current items + checks to the server, debounced so a burst of
  // edits collapses into a single PUT. Falls back to localStorage-only mode
  // if the server can't be reached (e.g. running the SPA outside the
  // container, or sidecar down).
  const persistDevTodos = useCallback((items: DevTodo[], checks: Record<string, boolean>) => {
    if (devTodoSaveTimer.current != null) window.clearTimeout(devTodoSaveTimer.current)
    devTodoSaveTimer.current = window.setTimeout(async () => {
      setDevTodoSync('saving')
      const ok = await saveDevTodosToServer({ items, checks })
      setDevTodoSync(ok ? 'idle' : 'offline')
    }, 400)
  }, [])

  // When the modal opens, refresh from the server. If the server is
  // reachable, its data is the source of truth and we also mirror it to
  // localStorage for next-load speed + offline fallback.
  useEffect(() => {
    if (!devTodosOpen) return
    let cancelled = false
    setDevTodoSync('loading')
    fetchDevTodosFromServer().then((data) => {
      if (cancelled) return
      if (data) {
        setDevTodoItems(data.items.length > 0 ? data.items : DEV_TODOS)
        setDevTodoChecks(data.checks)
        writeDevTodoItems(data.items.length > 0 ? data.items : DEV_TODOS)
        writeDevTodoChecks(data.checks)
        setDevTodoSync('idle')
      } else {
        setDevTodoSync('offline')
      }
    })
    return () => { cancelled = true }
  }, [devTodosOpen])

  const toggleDevTodo = (id: string) => {
    setDevTodoChecks((prev) => {
      const next = { ...prev, [id]: !prev[id] }
      writeDevTodoChecks(next)
      persistDevTodos(devTodoItems, next)
      return next
    })
  }
  const addDevTodo = () => {
    const label = newDevTodoText.trim()
    if (!label) return
    const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    setDevTodoItems((prev) => {
      const next = [...prev, { id, label }]
      writeDevTodoItems(next)
      persistDevTodos(next, devTodoChecks)
      return next
    })
    setNewDevTodoText('')
  }
  const deleteDevTodo = (id: string) => {
    const nextChecks = { ...devTodoChecks }
    delete nextChecks[id]
    setDevTodoItems((prev) => {
      const next = prev.filter((t) => t.id !== id)
      writeDevTodoItems(next)
      writeDevTodoChecks(nextChecks)
      persistDevTodos(next, nextChecks)
      return next
    })
    setDevTodoChecks(nextChecks)
  }
  const remainingDevTodos = devTodoItems.filter((t) => !devTodoChecks[t.id]).length
  const [debugEnabled, setDebugEnabled] = useState(() => getExpFlag('LR_DEBUG', false))
  const [baseMapSwitcherEnabled, setBaseMapSwitcherEnabled] = useState(() => getExpFlag('lr_exp_basemap', false))
  const [compareEnabled, setCompareEnabled] = useState(() => getExpFlag('lr_exp_compare', false))
  const [presetsEnabled, setPresetsEnabled] = useState(() => getExpFlag('lr_exp_presets', false))
  const [votingDistrictsEnabled, setVotingDistrictsEnabled] = useState(() => getExpFlag('lr_exp_districts', false))
  // Bumped to remount the GuidedTour and replay it from step 1.
  const [tourReplayKey, setTourReplayKey] = useState(0)

  const replayTour = () => {
    try { localStorage.removeItem('lr_tour_done') } catch { /* ignore */ }
    setExpMenuOpen(false)
    setTourReplayKey((k) => k + 1)
  }

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

  // Global Escape: close topmost open overlay (modal > popout > expansion > panels > exp menu)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (devTodosOpen) {
        setDevTodosOpen(false)
        return
      }
      if (shareModalOpen) {
        setShareModalOpen(false)
        return
      }
      if (analysisDetail) {
        const wasScore = analysisDetail === 'score'
        setAnalysisDetail(null)
        if (wasScore) setShowScoreBreakdown(false)
        return
      }
      if (expMenuOpen) {
        setExpMenuOpen(false)
        return
      }
      if (layerPanelOpen) {
        setLayerPanelOpen(false)
        return
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [shareModalOpen, analysisDetail, expMenuOpen, layerPanelOpen, devTodosOpen])

  // Show FAB tooltip hints once on mobile, dismiss on first tap
  const buildShareUrl = useCallback((): string => {
    const params = new URLSearchParams()
    if (address) params.set('address', address)
    const active: ShareLayerId[] = []
    if (noiseVisible) active.push('noise')
    if (superfundVisible) active.push('superfund')
    if (transitVisible) active.push('transit')
    if (trafficVisible) active.push('traffic')
    if (costcoVisible) active.push('costco')
    if (dataCenterVisible) active.push('datacenters')
    if (emsVisible) active.push('ems')
    if (crowdVisible) active.push('crowd')
    if (active.length > 0) params.set('layers', active.join(','))
    if (activeBaseMap !== 'street') params.set('base', activeBaseMap)
    return `${window.location.origin}/map?${params.toString()}`
  }, [address, noiseVisible, superfundVisible, transitVisible, trafficVisible, costcoVisible, dataCenterVisible, emsVisible, crowdVisible, activeBaseMap])

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

  const savedMapViewRef = useRef<{ center: L.LatLng; zoom: number } | null>(null)

  // Compute fitBounds padding that accounts for the report panel / detail
  // popout overlaying the right (or bottom on mobile) edge of the map.
  // Without this the requested address or the item can land behind a panel.
  const computeFitPadding = useCallback((): { topLeft: L.PointTuple; bottomRight: L.PointTuple } => {
    const map = mapRef.current
    const base = 60
    if (!map) return { topLeft: [base, base], bottomRight: [base, base] }
    const mapRect = map.getContainer().getBoundingClientRect()
    let padTop = base, padLeft = base, padBottom = base, padRight = base
    const panels: Element[] = [
      ...Array.from(document.querySelectorAll('.analysis-popout')),
      ...Array.from(document.querySelectorAll('.analysis-panel')),
    ]
    for (const el of panels) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      // Skip panels that don't actually overlap the map (e.g. hidden mobile sheet)
      if (r.right <= mapRect.left || r.left >= mapRect.right) continue
      if (r.bottom <= mapRect.top || r.top >= mapRect.bottom) continue
      // Classify the panel by the map edge it sits closest to, then reserve
      // padding on that edge equal to the panel's intrusion + a 16px gap.
      const distRight = mapRect.right - r.right
      const distBottom = mapRect.bottom - r.bottom
      const distLeft = r.left - mapRect.left
      const distTop = r.top - mapRect.top
      const minDist = Math.min(distRight, distBottom, distLeft, distTop)
      if (minDist === distRight) {
        padRight = Math.max(padRight, mapRect.right - r.left + 16)
      } else if (minDist === distBottom) {
        padBottom = Math.max(padBottom, mapRect.bottom - r.top + 16)
      } else if (minDist === distLeft) {
        padLeft = Math.max(padLeft, r.right - mapRect.left + 16)
      } else {
        padTop = Math.max(padTop, r.bottom - mapRect.top + 16)
      }
    }
    // Guard against padding so large it can't fit anything.
    padRight = Math.min(padRight, Math.max(base, mapRect.width - 80))
    padBottom = Math.min(padBottom, Math.max(base, mapRect.height - 80))
    padLeft = Math.min(padLeft, Math.max(base, mapRect.width - 80))
    padTop = Math.min(padTop, Math.max(base, mapRect.height - 80))
    return { topLeft: [padLeft, padTop], bottomRight: [padRight, padBottom] }
  }, [])

  const flyToWithAddress = useCallback((lat: number, lng: number) => {
    const map = mapRef.current
    if (!map) return
    const home = targetLocationRef.current
    if (!savedMapViewRef.current) {
      savedMapViewRef.current = { center: map.getCenter(), zoom: map.getZoom() }
    }
    if (home) {
      const bounds = L.latLngBounds([[home.lat, home.lng], [lat, lng]])
      const { topLeft, bottomRight } = computeFitPadding()
      map.flyToBounds(bounds, {
        paddingTopLeft: topLeft,
        paddingBottomRight: bottomRight,
        maxZoom: 15,
        duration: 0.5,
      })
    } else {
      map.flyTo([lat, lng], 15, { duration: 0.5 })
    }
  }, [computeFitPadding])

  // When the detail flyout closes, restore the pre-flyout view (saved on
  // the first "show on map" click inside the flyout) and tear down any
  // highlight pin. If the user never clicked "show on map", saved view is
  // null and the map is left exactly where it is.
  useEffect(() => {
    if (analysisDetail !== null) return
    const saved = savedMapViewRef.current
    savedMapViewRef.current = null
    if (highlightMarkerRef.current) {
      highlightMarkerRef.current.remove()
      highlightMarkerRef.current = null
    }
    if (saved && mapRef.current) {
      mapRef.current.flyTo(saved.center, saved.zoom, { duration: 0.5 })
    }
  }, [analysisDetail])

  const showHighlightPin = useCallback((lat: number, lng: number, _label: string) => {
    if (!mapRef.current) return
    if (highlightMarkerRef.current) {
      highlightMarkerRef.current.remove()
    }
    const icon = L.divIcon({
      className: 'highlight-pin',
      html: `<div class="highlight-pin-inner">🏥</div>`,
      iconSize: [48, 48],
      iconAnchor: [24, 24],
    })
    highlightMarkerRef.current = L.marker([lat, lng], { icon }).addTo(mapRef.current)
    flyToWithAddress(lat, lng)
  }, [flyToWithAddress])

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

  const [locating, setLocating] = useState(false)

  const useMyLocation = useCallback(() => {
    if (!('geolocation' in navigator)) return
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords
          let resolved: string | null = null
          if (TOMTOM_API_KEY) {
            const url = `https://api.tomtom.com/search/2/reverseGeocode/${latitude},${longitude}.json?key=${TOMTOM_API_KEY}&radius=100`
            const res = await fetch(url)
            const data = await res.json()
            resolved = data?.addresses?.[0]?.address?.freeformAddress ?? null
          }
          setLocating(false)
          submitAddressChange(resolved || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`)
        } catch {
          setLocating(false)
        }
      },
      () => setLocating(false),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
    )
  }, [submitAddressChange])

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
      const places = await fetchCostcosViaPlaces({
        rectangle: {
          south: padded.getSouth(),
          west: padded.getWest(),
          north: padded.getNorth(),
          east: padded.getEast(),
        },
        signal: AbortSignal.timeout(15000),
      })
      if (places.length === 0) {
        costcoLoadedBoundsRef.current = loaded ? loaded.extend(padded.getSouthWest()).extend(padded.getNorthEast()) : padded
        return
      }

      const known = costcoKnownIdsRef.current
      for (const p of places) {
        if (known.has(p.id)) continue

        const { street, locality } = parseCostcoAddress(p.addr)
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
        L.marker([p.lat, p.lng], { icon }).bindTooltip(tooltip, { direction: 'top', offset: [0, -16] }).addTo(layer)
        known.add(p.id)
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
      layer.addData(superfundFeaturesToPoints(geojson))
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

  const runLocationAnalysis = useCallback(async (lat: number, lng: number, opts?: { force?: boolean }) => {
    dbg('analysis', `Running analysis at ${lat.toFixed(5)}, ${lng.toFixed(5)}${opts?.force ? ' (forced)' : ''}`)
    const runId = ++analysisRunIdRef.current
    const isLatestRun = () => analysisRunIdRef.current === runId

    // Cache hit: hand back the previously-computed report instantly and skip
    // all the network calls below. Re-analyze (force=true) bypasses the cache.
    const cached = opts?.force ? null : readAnalysisCache(lat, lng)
    if (cached) {
      dbg('analysis', 'Cache hit — restoring without re-fetching')
      const allDone: Record<string, 'pending' | 'done'> = {}
      for (const c of ['noise', 'superfund', 'costco', 'datacenters', 'er', 'crowd']) allDone[c] = 'done'
      setAnalysisProgress(allDone)
      setAnalysisResults({
        loading: false,
        noiseLevel: cached.noiseLevel,
        noiseAirport: cached.noiseAirport,
        noiseAirportCode: cached.noiseAirportCode,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        superfunds: cached.superfunds as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        costco: cached.costco as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        costcoNearby: cached.costcoNearby as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        costcoNearestBeyond: (cached.costcoNearestBeyond ?? null) as any,
        costcoError: cached.costcoError,
        costcoLoading: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dataCenters: cached.dataCenters as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        nearestER: cached.nearestER as any,
        erError: cached.erError,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        crowdMagnets: (cached.crowdMagnets ?? []) as any,
      })
      return
    }

    setAnalysisResults({ loading: true, noiseLevel: null, noiseAirport: null, noiseAirportCode: null, superfunds: [], costco: null, costcoNearby: [], costcoNearestBeyond: null, costcoError: false, costcoLoading: true, dataCenters: [], nearestER: null, erError: false, crowdMagnets: [] })

    const checks = ['noise', 'superfund', 'costco', 'datacenters', 'er', 'crowd'] as const
    const progress: Record<string, 'pending' | 'done'> = {}
    for (const c of checks) progress[c] = 'pending'
    setAnalysisProgress({ ...progress })
    const markDone = (key: string) => {
      if (!isLatestRun()) return
      progress[key] = 'done'
      setAnalysisProgress({ ...progress })
    }

    const location = L.latLng(lat, lng)
    const milesToMeters = 1609.34
    const TIMEOUT = 10000

    // Costco runs independently from the other categories. The Google Places
    // lookup is usually quick but the report shouldn't wait on it: we let it
    // complete in the background and merge its result in via a second
    // setAnalysisResults once it lands.
    type CostcoHit = { osmId: string; name: string; city: string; address: string; distanceMi: number; lat: number; lng: number }
    const costcoPromise = (async () => {
      try {
        const radiusM = COSTCO_ANALYSIS_RADIUS_MI * milesToMeters
        const places = await fetchCostcosViaPlaces({
          circle: { lat, lng, radiusM },
          signal: AbortSignal.timeout(15000),
        })
        const seen = new Set<string>()
        const hits: CostcoHit[] = []
        let nearestBeyond: CostcoHit | null = null
        for (const p of places) {
          if (seen.has(p.id)) continue
          seen.add(p.id)
          const dist = location.distanceTo(L.latLng(p.lat, p.lng))
          const distMi = dist / milesToMeters
          const { street, locality } = parseCostcoAddress(p.addr)
          const hit: CostcoHit = {
            osmId: p.id,
            name: p.name,
            city: locality,
            address: street,
            distanceMi: Math.round(distMi * 10) / 10,
            lat: p.lat,
            lng: p.lng,
          }
          if (distMi <= COSTCO_ANALYSIS_RADIUS_MI) {
            hits.push(hit)
          } else if (!nearestBeyond || distMi < nearestBeyond.distanceMi) {
            nearestBeyond = hit
          }
        }
        hits.sort((a, b) => a.distanceMi - b.distanceMi)
        return { nearest: hits[0] ?? null, nearby: hits, nearestBeyond }
      } finally { markDone('costco') }
    })()

    // Run the other checks in parallel with timeouts. We *don't* await Costco
    // here so the report can render as soon as these four resolve.
    const [noiseResult, superfundResult, dataCenterResult, erResult, crowdResult] = await Promise.allSettled([
      // Check noise via PMTiles vector query, then find nearest airport
      (async () => {
        try {
        const { queryNoiseLevelAtPoint } = await loadAirportNoiseModule()
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

      // Emergency Room proximity via Google Places
      (async () => {
        try {
        type ERHit = { name: string; address: string; distanceMi: number; lat: number; lng: number }
        const radiusM = ER_ANALYSIS_RADIUS_MI * milesToMeters
        const queries = ['emergency room', 'hospital emergency department']
        const seen = new Set<string>()
        const hits: ERHit[] = []
        await Promise.all(queries.map(async (query) => {
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
                    center: { latitude: lat, longitude: lng },
                    radius: radiusM,
                  },
                },
                maxResultCount: 10,
              }),
              signal: AbortSignal.timeout(TIMEOUT),
            })
            if (!res.ok) return
            const data = await res.json()
            for (const p of data.places || []) {
              if (seen.has(p.id)) continue
              seen.add(p.id)
              const loc = p.location
              if (!loc) continue
              const dist = location.distanceTo(L.latLng(loc.latitude, loc.longitude))
              const distMi = Math.round(dist / milesToMeters * 10) / 10
              if (distMi <= ER_ANALYSIS_RADIUS_MI) {
                hits.push({
                  name: p.displayName?.text || 'Emergency Room',
                  address: p.formattedAddress || '',
                  distanceMi: distMi,
                  lat: loc.latitude,
                  lng: loc.longitude,
                })
              }
            }
          } catch { /* ignore individual query failure */ }
        }))
        hits.sort((a, b) => a.distanceMi - b.distanceMi)
        return hits[0] ?? null
        } finally { markDone('er') }
      })(),

      // Crowd magnets within 5mi (OSM Overpass)
      (async () => {
        try {
          const radiusDeg = (CROWD_ANALYSIS_RADIUS_MI * milesToMeters) / 111320
          const bbox = L.latLngBounds(
            [lat - radiusDeg, lng - radiusDeg * 1.5],
            [lat + radiusDeg, lng + radiusDeg * 1.5],
          )
          const items = await fetchCrowdMagnets(bbox, AbortSignal.timeout(TIMEOUT))
          const hits: { id: string; name: string; type: CrowdType; distanceMi: number; lat: number; lng: number }[] = []
          for (const m of items) {
            const dist = location.distanceTo(L.latLng(m.lat, m.lng))
            const distMi = Math.round(dist / milesToMeters * 10) / 10
            if (distMi <= CROWD_ANALYSIS_RADIUS_MI) {
              hits.push({ id: m.id, name: m.name, type: m.type, distanceMi: distMi, lat: m.lat, lng: m.lng })
            }
          }
          hits.sort((a, b) => a.distanceMi - b.distanceMi)
          return hits
        } catch {
          return []
        } finally { markDone('crowd') }
      })(),
    ])

    const noiseData = noiseResult.status === 'fulfilled' ? noiseResult.value : null
    const noiseLevel = noiseData?.level ?? null
    const noiseAirport = noiseData?.airport ?? null
    const noiseAirportCode = noiseData?.code ?? null
    const superfunds = superfundResult.status === 'fulfilled' ? superfundResult.value : []
    const dataCenters = dataCenterResult.status === 'fulfilled' ? dataCenterResult.value : []
    const nearestER = erResult.status === 'fulfilled' ? erResult.value : null
    const erError = erResult.status === 'rejected'
    const crowdMagnets = crowdResult.status === 'fulfilled' ? crowdResult.value : []

    dbg('analysis', 'Primary results in (Costco still in-flight):', {
      noise: noiseLevel != null ? `${noiseLevel} dB` : 'none',
      superfunds: superfunds.length,
      dataCenters: dataCenters.length,
      nearestER: nearestER ? `${nearestER.distanceMi} mi` : 'none',
      crowdMagnets: crowdMagnets.length,
    })
    if (!isLatestRun()) {
      dbg('analysis', 'Stale run — discarding primary results')
      return
    }
    setAnalysisResults({
      loading: false,
      noiseLevel, noiseAirport, noiseAirportCode,
      superfunds,
      costco: null, costcoNearby: [], costcoNearestBeyond: null, costcoError: false, costcoLoading: true,
      dataCenters,
      nearestER, erError,
      crowdMagnets,
    })

    costcoPromise.then((data) => {
      dbg('analysis', 'Costco result:', data.nearest ? `${data.nearest.distanceMi.toFixed(1)} mi` : 'none')
      if (!isLatestRun()) {
        dbg('analysis', 'Stale run — discarding Costco result')
        return
      }
      setAnalysisResults((prev) => ({
        ...prev,
        costco: data.nearest,
        costcoNearby: data.nearby,
        costcoNearestBeyond: data.nearestBeyond,
        costcoError: false,
        costcoLoading: false,
      }))
      writeAnalysisCache(lat, lng, {
        noiseLevel, noiseAirport, noiseAirportCode,
        superfunds,
        costco: data.nearest,
        costcoNearby: data.nearby,
        costcoNearestBeyond: data.nearestBeyond,
        costcoError: false,
        dataCenters,
        nearestER, erError,
        crowdMagnets,
      })
    }).catch((err) => {
      dbg('analysis', 'Costco failed:', err)
      if (!isLatestRun()) return
      setAnalysisResults((prev) => ({
        ...prev,
        costco: null,
        costcoNearby: [],
        costcoNearestBeyond: null,
        costcoError: true,
        costcoLoading: false,
      }))
    })
  }, [])

  const retryCostco = useCallback(async () => {
    const target = targetLocationRef.current
    if (!target) return
    setAnalysisResults((prev) => ({
      ...prev,
      costcoError: false,
      costcoLoading: true,
    }))
    const lat = target.lat
    const lng = target.lng
    const milesToMeters = 1609.34
    try {
      const places = await fetchCostcosViaPlaces({
        circle: { lat, lng, radiusM: COSTCO_ANALYSIS_RADIUS_MI * milesToMeters },
        signal: AbortSignal.timeout(15000),
      })
      const seen = new Set<string>()
      const hits: { osmId: string; name: string; city: string; address: string; distanceMi: number; lat: number; lng: number }[] = []
      let nearestBeyond: { osmId: string; name: string; city: string; address: string; distanceMi: number; lat: number; lng: number } | null = null
      for (const p of places) {
        if (seen.has(p.id)) continue
        seen.add(p.id)
        const dist = target.distanceTo(L.latLng(p.lat, p.lng))
        const distMi = dist / milesToMeters
        const { street, locality } = parseCostcoAddress(p.addr)
        const hit = {
          osmId: p.id,
          name: p.name,
          city: locality,
          address: street,
          distanceMi: Math.round(distMi * 10) / 10,
          lat: p.lat,
          lng: p.lng,
        }
        if (distMi <= COSTCO_ANALYSIS_RADIUS_MI) {
          hits.push(hit)
        } else if (!nearestBeyond || distMi < nearestBeyond.distanceMi) {
          nearestBeyond = hit
        }
      }
      hits.sort((a, b) => a.distanceMi - b.distanceMi)
      setAnalysisResults((prev) => ({
        ...prev,
        costco: hits[0] ?? null,
        costcoNearby: hits,
        costcoNearestBeyond: nearestBeyond,
        costcoError: false,
        costcoLoading: false,
      }))
    } catch (err) {
      dbg('analysis', 'Costco retry failed:', err)
      setAnalysisResults((prev) => ({
        ...prev,
        costco: null,
        costcoNearby: [],
        costcoNearestBeyond: null,
        costcoError: true,
        costcoLoading: false,
      }))
    }
  }, [])

  // Retry the full location analysis (used by the inline error overlay).
  const retryAnalysis = useCallback(() => {
    const target = targetLocationRef.current
    if (target) {
      setStatus('ready')
      setErrorMsg('')
      runLocationAnalysis(target.lat, target.lng)
    } else {
      // No geocoded location yet — re-trigger the address effect by setting
      // status back to loading; the geocode will retry via React's normal
      // effect re-run on remount of the error overlay state.
      setStatus('loading')
      setErrorMsg('')
    }
  }, [runLocationAnalysis])

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
        pushRecentSearch(address)
        targetLocationRef.current = L.latLng(lat, lng)

        const houseIcon = L.divIcon({
          className: 'location-pin',
          html: `<div class="location-pin-icon">🏠</div>`,
          iconSize: [36, 36],
          iconAnchor: [18, 18],
        })

        if (mapRef.current) {
          // Map already exists — just update the home marker, fly to the new
          // location, and clear loaded-bounds refs so layer move handlers
          // refetch for the new viewport. Layer toggle React state stays put.
          const map = mapRef.current
          if (homeMarkerRef.current) {
            homeMarkerRef.current.remove()
            homeMarkerRef.current = null
          }
          if (highlightMarkerRef.current) {
            highlightMarkerRef.current.remove()
            highlightMarkerRef.current = null
          }
          homeMarkerRef.current = L.marker([lat, lng], { icon: houseIcon })
            .bindTooltip(address, { direction: 'top', offset: [0, -18], className: 'location-tooltip' })
            .addTo(map)
          // Reset loaded-bounds so layers refetch when we land at the new viewport.
          airportLoadedBoundsRef.current = null
          airportKnownIdsRef.current.clear()
          superfundLoadedBoundsRef.current = null
          transitLoadedBoundsRef.current = null
          costcoLoadedBoundsRef.current = null
          costcoKnownIdsRef.current.clear()
          emsLoadedBoundsRef.current = null
          emsKnownIdsRef.current.clear()
          crowdLoadedBoundsRef.current = null
          crowdKnownIdsRef.current.clear()
          map.flyTo([lat, lng], 13, { duration: 0.5 })
          setStatus('ready')
          runLocationAnalysis(lat, lng)
          setTimeout(() => map.invalidateSize(), 0)
          return
        }

        const map = L.map(mapContainer.current!, {
          center: [lat, lng],
          zoom: 13,
          zoomControl: false,
          preferCanvas: true,
        })

        createBaseLayer('street').then((baseLayer) => {
          dbg('init', 'Base layer created (Google Tiles)')
          baseLayer.addTo(map)
          baseLayerRef.current = baseLayer
        }).catch((err) => {
          // No fallback: the legacy mt.google.com endpoint doesn't honor style
          // customizations and would silently bring POIs back. Better to leave
          // the map without a base layer and log the actual error so it's
          // diagnosable. Most common cause: missing VITE_GOOGLE_MAPS_KEY.
          console.error('[LandRecon] Failed to create Google Maps tile session.', err)
          if (!GOOGLE_MAPS_KEY) {
            console.error('[LandRecon] VITE_GOOGLE_MAPS_KEY is empty in this build — base tiles cannot load.')
          }
        })

        L.control.zoom({ position: 'topright' }).addTo(map)

        if (LR_DEBUG) console.log(`[LR:map] Initial zoom level: ${map.getZoom()}`)
        map.on('zoomend', () => {
          if (LR_DEBUG) console.log(`[LR:map] Zoom level: ${map.getZoom()}`)
        })

        homeMarkerRef.current = L.marker([lat, lng], { icon: houseIcon })
          .bindTooltip(address, { direction: 'top', offset: [0, -18], className: 'location-tooltip' })
          .addTo(map)

        // Defer noise layer creation until the user toggles it on — the
        // PMTiles + protomaps-leaflet deps are loaded in toggleNoise instead
        // of pre-paying the cost on map init.
        noiseLayerRef.current = null

        // Create airport label layer (shown with noise layer)
        airportLayerRef.current = L.layerGroup()

        // Create Superfund layer (not added to map until toggled on)
        superfundLayerRef.current = L.geoJSON(undefined, {
          pointToLayer: (_feat, latlng) => L.marker(latlng, { icon: SUPERFUND_ICON, riseOnHover: true }),
          onEachFeature: (_feature, layer) => {
            const props = (_feature as GeoJSON.Feature).properties || {}
            layer.bindPopup(superfundPopup(props), { maxWidth: 280 })
          },
        })

        // Create transit layer (not added to map until toggled on)
        transitLayerRef.current = L.layerGroup()

        // Create Costco label layer (not added to map until toggled on)
        costcoLayerRef.current = L.layerGroup()

        dataCenterLayerRef.current = L.layerGroup()

        emsLayerRef.current = L.layerGroup()

        crowdLayerRef.current = L.layerGroup()

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
    }
  }, [address, navigate])

  // Tear the map down only on actual unmount, not on every address change.
  // This keeps layer toggle state and zoom intact when the user changes the
  // analyzed address from the header.
  useEffect(() => {
    return () => {
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
      crowdLayerRef.current = null
      crowdSubLayersRef.current = null
      crowdLoadedBoundsRef.current = null
      crowdKnownIdsRef.current.clear()
      homeMarkerRef.current = null
      highlightMarkerRef.current = null
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [])

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

  const toggleNoise = async () => {
    const map = mapRef.current
    const airportLayer = airportLayerRef.current
    if (!map) return
    dbg('toggle', `noise → ${noiseVisible ? 'OFF' : 'ON'}`)

    // Lazily create the noise layer on first toggle so the PMTiles +
    // protomaps-leaflet deps don't sit in the initial MapPage chunk.
    if (!noiseLayerRef.current) {
      const { createNoiseLayer } = await loadAirportNoiseModule()
      noiseLayerRef.current = createNoiseLayer(NOISE_PMTILES_URL, { opacity: 0.7 })
    }
    const layer = noiseLayerRef.current as L.GridLayer

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

  const handleAirportMove = useCallback(
    debounce(() => {
      const map = mapRef.current
      const layer = airportLayerRef.current
      if (map && layer) {
        loadAirportLabels(map, layer)
      }
    }, 250),
    [loadAirportLabels],
  )

  const handleCostcoMove = useCallback(
    debounce(() => {
      const map = mapRef.current
      const layer = costcoLayerRef.current
      if (map && layer) {
        loadCostcoLabels(map, layer)
      }
    }, 250),
    [loadCostcoLabels],
  )

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

  const handleDataCenterMove = useCallback(
    debounce(() => {
      const map = mapRef.current
      const layer = dataCenterLayerRef.current
      if (map && layer) loadDataCenters(map, layer)
    }, 250),
    [loadDataCenters],
  )

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

  const handleEmsMove = useCallback(
    debounce(() => {
      const map = mapRef.current
      const layer = emsLayerRef.current
      if (map && layer) loadEmsData(map, layer)
    }, 250),
    [loadEmsData],
  )

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

  const loadCrowdData = useCallback(async (map: L.Map, layer: L.LayerGroup) => {
    const bounds = map.getBounds()
    const loaded = crowdLoadedBoundsRef.current
    if (loaded && loaded.contains(bounds)) { dbg('crowd', 'Skipping — bounds already loaded'); return }
    dbg('crowd', 'Loading crowd magnet data…')

    setCrowdLoading(true)
    try {
      const padded = bounds.pad(0.5)

      let subLayers = crowdSubLayersRef.current
      if (!subLayers) {
        subLayers = {} as Record<CrowdType, L.LayerGroup>
        for (const t of CROWD_TYPES) subLayers[t] = L.layerGroup()
        crowdSubLayersRef.current = subLayers
        for (const t of CROWD_TYPES) {
          if (crowdSubVisibleRef.current[t]) subLayers[t].addTo(layer)
        }
      }

      const known = crowdKnownIdsRef.current
      const items = await fetchCrowdMagnets(padded)
      for (const m of items) {
        if (known.has(m.id)) continue
        const sub = subLayers[m.type]
        if (!sub) continue
        const color = CROWD_COLORS[m.type]
        const emoji = CROWD_ICONS[m.type]
        const icon = L.divIcon({
          className: 'crowd-label',
          html: `<div class="crowd-pin" style="background:${color}">${emoji}</div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        })
        L.marker([m.lat, m.lng], { icon })
          .bindTooltip(m.name, { direction: 'top', offset: [0, -14] })
          .addTo(sub)
        known.add(m.id)
      }

      crowdLoadedBoundsRef.current = loaded
        ? loaded.extend(padded.getSouthWest()).extend(padded.getNorthEast())
        : padded
      dbg('crowd', `Total known crowd magnets: ${known.size}`)
    } catch (err) {
      console.warn('Crowd magnet fetch failed:', err)
    } finally {
      setCrowdLoading(false)
    }
  }, [])

  const handleCrowdMove = useCallback(
    debounce(() => {
      const map = mapRef.current
      const layer = crowdLayerRef.current
      if (map && layer) loadCrowdData(map, layer)
    }, 250),
    [loadCrowdData],
  )

  const toggleCrowd = () => {
    const map = mapRef.current
    const layer = crowdLayerRef.current
    if (!map || !layer) return
    dbg('toggle', `crowd → ${crowdVisible ? 'OFF' : 'ON'}`)
    if (crowdVisible) {
      map.removeLayer(layer)
      map.off('moveend', handleCrowdMove)
      layer.clearLayers()
      crowdSubLayersRef.current = null
      crowdLoadedBoundsRef.current = null
      crowdKnownIdsRef.current.clear()
    } else {
      layer.addTo(map)
      loadCrowdData(map, layer)
      map.on('moveend', handleCrowdMove)
    }
    setCrowdVisible(!crowdVisible)
  }

  const toggleCrowdSub = (type: CrowdType) => {
    const parentLayer = crowdLayerRef.current
    const subLayers = crowdSubLayersRef.current
    if (!parentLayer || !subLayers) return

    const nowVisible = !crowdSubVisible[type]
    const next = { ...crowdSubVisible, [type]: nowVisible }
    setCrowdSubVisible(next)
    crowdSubVisibleRef.current = next

    if (nowVisible) {
      subLayers[type].addTo(parentLayer)
    } else {
      parentLayer.removeLayer(subLayers[type])
    }
  }

  const toggleDistrict = async (id: DistrictLayerId) => {
    const map = mapRef.current
    if (!map) return
    const isOn = districtVisible[id]
    dbg('toggle', `district[${id}] → ${isOn ? 'OFF' : 'ON'}`)

    if (isOn) {
      const layer = districtLayerRefs.current[id]
      if (layer) map.removeLayer(layer)
      setDistrictVisible((v) => ({ ...v, [id]: false }))
      return
    }

    // Optimistic: flip the visible state on so the checkbox reflects intent.
    setDistrictVisible((v) => ({ ...v, [id]: true }))
    setDistrictLoading((v) => ({ ...v, [id]: true }))
    try {
      const cached = districtLayerRefs.current[id]
      if (cached) {
        dbg('districts', `Re-attaching cached ${id} layer`)
        cached.addTo(map)
      } else {
        dbg('districts', `Loading ${id} boundary + results…`)
        const { layer, resultsCount, featureCount } = await loadDistrictLayer(id)
        dbg('districts', `Loaded ${id}: ${featureCount} features, ${resultsCount} results`)
        districtLayerRefs.current[id] = layer
        setDistrictAvailable((v) => ({ ...v, [id]: resultsCount > 0 }))
        layer.addTo(map)
      }
    } catch (err) {
      dbg('districts', `Failed to load ${id}:`, err)
      console.warn(`Failed to load ${id} district layer:`, err)
      setDistrictVisible((v) => ({ ...v, [id]: false }))
    } finally {
      setDistrictLoading((v) => ({ ...v, [id]: false }))
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

  const handleSuperfundMove = useCallback(
    debounce(() => {
      const map = mapRef.current
      const layer = superfundLayerRef.current
      if (map && layer) {
        loadSuperfundData(map, layer)
      }
    }, 250),
    [loadSuperfundData],
  )

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

  const handleTransitMove = useCallback(
    debounce(() => {
      const map = mapRef.current
      const layer = transitLayerRef.current
      if (map && layer) {
        loadTransitData(map, layer)
      }
    }, 250),
    [loadTransitData],
  )

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

  const currentLayerSnapshot: LayerStateSnapshot = {
    noise: noiseVisible,
    superfund: superfundVisible,
    transit: transitVisible,
    traffic: trafficVisible,
    costco: costcoVisible,
    datacenters: dataCenterVisible,
    ems: emsVisible,
    crowd: crowdVisible,
  }

  const activeLayerPresetId = LAYER_PRESETS.find((preset) => {
    const s = preset.state
    return s.noise === currentLayerSnapshot.noise
      && s.superfund === currentLayerSnapshot.superfund
      && s.transit === currentLayerSnapshot.transit
      && s.traffic === currentLayerSnapshot.traffic
      && s.costco === currentLayerSnapshot.costco
      && s.datacenters === currentLayerSnapshot.datacenters
      && s.ems === currentLayerSnapshot.ems
      && s.crowd === currentLayerSnapshot.crowd
  })?.id ?? null

  const applyLayerPreset = (presetId: LayerPreset['id']) => {
    const preset = LAYER_PRESETS.find((p) => p.id === presetId)
    if (!preset) return
    dbg('preset', `applying "${preset.label}"`)
    const setLayer = (current: boolean, toggle: () => void, desired: boolean) => {
      if (current !== desired) toggle()
    }
    setLayer(noiseVisible, toggleNoise, preset.state.noise)
    setLayer(superfundVisible, toggleSuperfund, preset.state.superfund)
    setLayer(transitVisible, toggleTransit, preset.state.transit)
    setLayer(trafficVisible, toggleTraffic, preset.state.traffic)
    setLayer(costcoVisible, toggleCostco, preset.state.costco)
    setLayer(dataCenterVisible, toggleDataCenters, preset.state.datacenters)
    setLayer(emsVisible, toggleEms, preset.state.ems)
    setLayer(crowdVisible, toggleCrowd, preset.state.crowd)
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
    if (requested.has('traffic')) toggleTraffic()
    if (requested.has('costco')) toggleCostco()
    if (requested.has('datacenters')) toggleDataCenters()
    if (requested.has('ems')) toggleEms()
    if (requested.has('crowd')) toggleCrowd()
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
      const airportLayer = airportLayerRef.current
      const noiseDeg = (5 * milesToMeters) / 111320
      const noiseBounds = L.latLngBounds(
        [center.lat - noiseDeg, center.lng - noiseDeg * 1.5],
        [center.lat + noiseDeg, center.lng + noiseDeg * 1.5]
      )
      // The noise layer is created lazily on first need. If it hasn't been
      // built yet, fetch the heavy module first, then add it.
      const enableNoise = async () => {
        if (!noiseLayerRef.current) {
          const { createNoiseLayer } = await loadAirportNoiseModule()
          noiseLayerRef.current = createNoiseLayer(NOISE_PMTILES_URL, { opacity: 0.7 })
        }
        const layer = noiseLayerRef.current as L.GridLayer
        // Constrain noise tiles to the area around the location.
        // protomaps-leaflet's `leafletLayer` extends L.GridLayer, so the
        // GridLayer `bounds` option still filters which tiles get fetched.
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
      void enableNoise()
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
          where: "NPL_STATUS_CODE <> 'D'",
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
          .then((geojson: GeoJSON.FeatureCollection | null) => {
            if (!geojson?.features) return
            const points = superfundFeaturesToPoints(geojson)
            const within: GeoJSON.Feature<GeoJSON.Point>[] = []
            for (const pt of points.features) {
              const [lon, lat] = pt.geometry.coordinates
              if (center.distanceTo(L.latLng(lat, lon)) <= 5 * milesToMeters) {
                within.push(pt)
              }
            }
            layer.clearLayers()
            layer.addData({ type: 'FeatureCollection', features: within } as GeoJSON.FeatureCollection)
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

  // Stamp the computed grade onto the Recent search entry so the home page
  // can show it as a badge next to the address.
  useEffect(() => {
    if (analysisResults.loading || analysisResults.costcoLoading) return
    if (!address) return
    const g = computeLocationGrade(analysisResults)
    updateRecentSearchGrade(address, g.letter, g.color)
  }, [address, analysisResults])

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
                placeholder="Street address, city, state"
                autoComplete="off"
                aria-label="Analyze a different address"
              />
              <button
                type="button"
                className="header-address-locate"
                onClick={useMyLocation}
                disabled={locating}
                title="Use my current location"
                aria-label="Use my current location"
              >
                {locating ? (
                  <span className="header-address-locate-spinner" aria-hidden="true" />
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <circle cx="12" cy="12" r="3" />
                    <line x1="12" y1="2" x2="12" y2="5" />
                    <line x1="12" y1="19" x2="12" y2="22" />
                    <line x1="2" y1="12" x2="5" y2="12" />
                    <line x1="19" y1="12" x2="22" y2="12" />
                  </svg>
                )}
              </button>
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
                <input type="checkbox" checked={debugEnabled} onChange={() => { toggleExpFlag('LR_DEBUG', debugEnabled, setDebugEnabled) }} />
                <span>Debug Logging</span>
              </label>
              <label className="exp-menu-item">
                <input type="checkbox" checked={baseMapSwitcherEnabled} onChange={() => { toggleExpFlag('lr_exp_basemap', baseMapSwitcherEnabled, setBaseMapSwitcherEnabled) }} />
                <span>Base Map Selector</span>
              </label>
              <label className="exp-menu-item">
                <input type="checkbox" checked={compareEnabled} onChange={() => { toggleExpFlag('lr_exp_compare', compareEnabled, setCompareEnabled) }} />
                <span>Compare Locations</span>
              </label>
              <label className="exp-menu-item">
                <input type="checkbox" checked={presetsEnabled} onChange={() => { toggleExpFlag('lr_exp_presets', presetsEnabled, setPresetsEnabled) }} />
                <span>Layer Presets</span>
              </label>
              <label className="exp-menu-item">
                <input type="checkbox" checked={votingDistrictsEnabled} onChange={() => { toggleExpFlag('lr_exp_districts', votingDistrictsEnabled, setVotingDistrictsEnabled) }} />
                <span>Voting Districts</span>
              </label>
              <button type="button" className="exp-menu-action" onClick={replayTour}>
                ▶ Replay guided tour
              </button>
              <button
                type="button"
                className="exp-menu-action"
                onClick={() => { setExpMenuOpen(false); setDevTodosOpen(true) }}
              >
                📋 To Do{remainingDevTodos > 0 ? ` (${remainingDevTodos})` : ''}
              </button>
              <div className="exp-menu-hint">Changes take effect on reload</div>
            </div>
          )}
        </div>
      </header>

      <div className="map-area">
        <div className="map-container" ref={mapContainer} />
        {status === 'ready' && analysisResults.loading && (() => {
          const checks = ['noise', 'superfund', 'costco', 'datacenters', 'er', 'crowd'] as const
          const done = checks.filter((k) => analysisProgress[k] === 'done').length
          const total = checks.length
          const pct = Math.round((done / total) * 100)
          return (
            <div
              className="analysis-progress-strip"
              role="status"
              aria-live="polite"
              aria-label={`Analyzing area, ${done} of ${total} categories ready`}
            >
              <div className="analysis-progress-strip-fill" style={{ width: `${pct}%` }} />
              <span className="analysis-progress-strip-text">
                Analyzing area · <strong>{done}</strong> of {total} ready
              </span>
            </div>
          )
        })()}
        {status === 'loading' && (
          <div className="map-overlay">
            <div className="spinner" />
            <p>Loading map…</p>
          </div>
        )}
        {status === 'error' && (
          <div className="map-overlay error">
            <p>{errorMsg}</p>
            <div className="map-error-actions">
              <button
                className="retry-button"
                onClick={retryAnalysis}
              >
                Retry
              </button>
              <button
                className="retry-button retry-button-secondary"
                onClick={startEditingAddress}
              >
                Edit address
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Mobile floating action buttons */}
      <button
        className="layer-toggle-btn"
        onClick={() => { setLayerPanelOpen(true); setAnalysisPanelOpen(false) }}
        aria-label="Open Show on Map panel"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></svg>
        <span className="fab-label">Show on Map</span>
      </button>
      <button
        className="analysis-toggle-btn"
        onClick={() => { setAnalysisPanelOpen(true); setLayerPanelOpen(false); setSheetHeight(null) }}
        aria-label="Open analysis"
      >
        <span className="fab-label">Report</span>
        {analysisResults.loading && (() => {
          const checks = ['noise', 'superfund', 'costco', 'datacenters', 'er', 'crowd'] as const
          const done = checks.filter((k) => analysisProgress[k] === 'done').length
          return (
            <span className="fab-progress-badge" aria-label={`${done} of ${checks.length} ready`}>
              {done}/{checks.length}
            </span>
          )
        })()}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>
      </button>

      {/* Mobile backdrop */}
      {(layerPanelOpen || analysisPanelOpen) && (
        <div className="mobile-panel-backdrop" onClick={() => { setLayerPanelOpen(false); setAnalysisPanelOpen(false) }} />
      )}

      <aside className={`layer-panel${layerPanelOpen ? ' mobile-open' : ''}`}>
        <button className="panel-close-btn" onClick={() => setLayerPanelOpen(false)} aria-label="Close Show on Map panel">×</button>
        {baseMapSwitcherEnabled && (
          <>
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
          </>
        )}

        <h2 className={`panel-title${baseMapSwitcherEnabled ? ' overlay-title' : ''}`}>Show on Map</h2>

        {presetsEnabled && (
          <div className="layer-presets" role="group" aria-label="Layer presets">
            {LAYER_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`layer-preset-btn${activeLayerPresetId === preset.id ? ' active' : ''}`}
                onClick={() => applyLayerPreset(preset.id)}
                disabled={status !== 'ready'}
                title={preset.desc}
                aria-pressed={activeLayerPresetId === preset.id}
              >
                {preset.label}
              </button>
            ))}
          </div>
        )}

        {/* ── Getting around ── */}
        <details className="layer-group">
          <summary className="layer-group-heading">🚦 Getting around</summary>
          <div className="layer-group-body">
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

        {/* ── Nearby & daily ── */}
        <details className="layer-group">
          <summary className="layer-group-heading">🛒 Nearby & daily</summary>
          <div className="layer-group-body">
            <label className="layer-toggle">
              <input
                type="checkbox"
                checked={costcoVisible}
                onChange={toggleCostco}
                disabled={status !== 'ready'}
              />
              <span className="layer-label">Costco</span>
            </label>
          </div>
        </details>

        {/* ── Things to know ── */}
        <details className="layer-group">
          <summary className="layer-group-heading">🤔 Things to know</summary>
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
                  <span className="legend-pin" aria-hidden="true">☢️</span>
                  <span>NPL Superfund Site</span>
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

            <label className="layer-toggle">
              <input
                type="checkbox"
                checked={crowdVisible}
                onChange={toggleCrowd}
                disabled={status !== 'ready'}
              />
              <span className="layer-label">
                Crowd Magnets
                {crowdLoading && <span className="layer-loading"> ⏳</span>}
              </span>
            </label>
            {crowdVisible && (
              <div className="dc-legend">
                {CROWD_TYPES.map((t) => (
                  <label key={t} className="transit-sub-toggle">
                    <input
                      type="checkbox"
                      checked={crowdSubVisible[t]}
                      onChange={() => toggleCrowdSub(t)}
                    />
                    <span className="legend-dot" style={{ background: CROWD_COLORS[t], opacity: crowdSubVisible[t] ? 1 : 0.35 }} />
                    <span style={{ opacity: crowdSubVisible[t] ? 1 : 0.5 }}>{CROWD_ICONS[t]} {CROWD_LABELS[t]}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </details>

        {/* ── Voting districts (experimental) ── */}
        {votingDistrictsEnabled && (
          <details className="layer-group" open>
            <summary className="layer-group-heading">🗳️ Voting districts</summary>
            <div className="layer-group-body">
              {(['cd118', 'sldu', 'sldl'] as DistrictLayerId[]).map((id) => (
                <label key={id} className="layer-toggle">
                  <input
                    type="checkbox"
                    checked={districtVisible[id]}
                    onChange={() => toggleDistrict(id)}
                    disabled={status !== 'ready' || districtLoading[id]}
                  />
                  <span className="layer-label">
                    {DISTRICT_LAYER_LABELS[id]}
                    {districtLoading[id] && <span className="layer-loading"> ⏳</span>}
                    {districtAvailable[id] === false && (
                      <span className="layer-loading" title="Boundary loaded but no result data on file"> · outline only</span>
                    )}
                  </span>
                </label>
              ))}
              {(districtVisible.cd118 || districtVisible.sldu || districtVisible.sldl) && (
                <div className="district-legend">
                  <div className="district-legend-bar">
                    {[-40, -25, -15, -5, 0, 5, 15, 25, 40].map((m) => (
                      <div
                        key={m}
                        className="legend-segment"
                        style={{ background: marginToColor(m) }}
                      />
                    ))}
                  </div>
                  <div className="legend-labels">
                    <span>R +40</span>
                    <span>D +40</span>
                  </div>
                  <div className="district-attribution">
                    Data: MIT Election Lab · U.S. Census
                  </div>
                </div>
              )}
            </div>
          </details>
        )}
      </aside>

      {/* Neighborhood Report Panel */}
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
          <h2>Neighborhood Report</h2>
          <div className="analysis-header-actions">
            <button
              className="analysis-action-btn"
              onClick={() => {
                const loc = targetLocationRef.current
                if (loc) runLocationAnalysis(loc.lat, loc.lng, { force: true })
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
            {compareEnabled && (
              <button
                className="analysis-action-btn"
                onClick={saveCurrentAnalysis}
                disabled={analysisResults.loading || analysisResults.costcoLoading}
                title="Save for comparison"
                aria-label="Save"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" />
                  <polyline points="7 3 7 8 15 8" />
                </svg>
              </button>
            )}
            {compareEnabled && savedAnalyses.length > 0 && (
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
            <>
              <div className="analysis-score-bar" onClick={() => { setShowScoreBreakdown(!showScoreBreakdown); setAnalysisDetail(showScoreBreakdown ? null : 'score') }} style={{ cursor: 'pointer' }} title="Click for score breakdown">
                <div className={`analysis-chevron${showScoreBreakdown ? ' expanded' : ''}`}>‹</div>
                <div className="analysis-grade" style={{ background: grade.color }}>{grade.letter}</div>
                <div className="analysis-score-label">
                  <strong>Location Score</strong>
                  <span>{grade.letter === 'A' ? 'Excellent' : grade.letter === 'B' ? 'Good' : grade.letter === 'C' ? 'Fair' : grade.letter === 'D' ? 'Poor' : 'Critical'} — {Math.round(grade.pct * 100)}%</span>
                </div>
              </div>
            </>
          )
        })()}
        <div className="analysis-print-header">
          <h1>LandRecon — Neighborhood Report</h1>
          <p>{address}</p>
          <p className="analysis-print-date">{new Date().toLocaleDateString()}</p>
        </div>
        {compareEnabled && showCompare && savedAnalyses.length > 0 && (
          <div className="analysis-compare">
            <h3 className="compare-title">Saved Comparisons</h3>
            {savedAnalyses.map((sa, i) => (
              <div className="compare-card" key={i}>
                <div className="compare-card-header">
                  <span className="compare-grade" style={{ background: sa.gradeColor }}>{sa.grade}</span>
                  <span className="compare-card-addr" title={sa.address}>{sa.address}</span>
                  <button className="compare-del" onClick={() => removeSavedAnalysis(i)} title="Remove" aria-label={`Remove ${sa.address} from comparison`}>×</button>
                </div>
                <div className="compare-card-stats">
                  <span>✈️ {sa.noiseLevel != null ? `${sa.noiseLevel} dB` : 'None'}</span>
                  <span>☢️ {sa.superfundCount === 0 ? 'None' : `${sa.superfundActive} active`}</span>
                  <span>🛒 {sa.costcoMi != null ? `${sa.costcoMi.toFixed(1)} mi` : '—'}</span>
                  <span>🏢 {sa.dataCenterCount} nearby</span>
                </div>
                <div className="compare-card-date">{sa.date}</div>
              </div>
            ))}
          </div>
        )}
        <div className="analysis-content">
          {(() => {
            const pNoise = analysisProgress.noise !== 'done'
            return (
              <div className={`analysis-card ${pNoise ? 'pending' : (analysisResults.noiseLevel ? noiseSeverity(analysisResults.noiseLevel) : 'clear')}`}>
                <div
                  className={`analysis-item${pNoise ? '' : ' clickable'}`}
                  onClick={() => {
                    if (pNoise) return
                    if (analysisDetail === 'noise') setAnalysisDetail(null)
                    else setAnalysisDetail('noise')
                  }}
                  aria-busy={pNoise || undefined}
                >
                  <div className={`analysis-chevron${analysisDetail === 'noise' ? ' expanded' : ''}${pNoise ? ' hidden' : ''}`}>‹</div>
                  <div className="analysis-icon">✈️</div>
                  <div className="analysis-detail">
                    <strong>Airport Noise</strong>
                    <p>{pNoise ? 'Checking…' : (analysisResults.noiseLevel ? `~${analysisResults.noiseLevel} dB DNL` : 'No airport noise detected')}</p>
                  </div>
                  {pNoise && <div className="analysis-card-spinner" aria-hidden="true" />}
                </div>
              </div>
            )
          })()}

          {(() => {
            const pSF = analysisProgress.superfund !== 'done'
            return (
              <div className={`analysis-card ${pSF ? 'pending' : superfundSeverity(analysisResults.superfunds)}`}>
                <div
                  className={`analysis-item${pSF ? '' : ' clickable'}`}
                  onClick={() => {
                    if (pSF) return
                    if (analysisDetail === 'superfunds') setAnalysisDetail(null)
                    else setAnalysisDetail('superfunds')
                  }}
                  aria-busy={pSF || undefined}
                >
                  <div className={`analysis-chevron${analysisDetail === 'superfunds' ? ' expanded' : ''}${pSF ? ' hidden' : ''}`}>‹</div>
                  <div className="analysis-icon">☢️</div>
                  <div className="analysis-detail">
                    <strong>Superfund Sites</strong>
                    <p>{pSF ? 'Checking…' : (analysisResults.superfunds.length > 0
                      ? `${analysisResults.superfunds.length} within 5 mi`
                      : 'No Superfund sites within 5 miles')}</p>
                  </div>
                  {pSF && <div className="analysis-card-spinner" aria-hidden="true" />}
                </div>
              </div>
            )
          })()}

          {(() => {
            const pDC = analysisProgress.datacenters !== 'done'
            return (
              <div className={`analysis-card ${pDC ? 'pending' : dataCenterSeverity(analysisResults.dataCenters.length)}`}>
                <div
                  className={`analysis-item${pDC ? '' : ' clickable'}`}
                  onClick={() => {
                    if (pDC) return
                    if (analysisDetail === 'datacenters') setAnalysisDetail(null)
                    else setAnalysisDetail('datacenters')
                  }}
                  aria-busy={pDC || undefined}
                >
                  <div className={`analysis-chevron${analysisDetail === 'datacenters' ? ' expanded' : ''}${pDC ? ' hidden' : ''}`}>‹</div>
                  <div className="analysis-icon">🏢</div>
                  <div className="analysis-detail">
                    <strong>Data Centers</strong>
                    <p>{pDC ? 'Checking…' : (analysisResults.dataCenters.length > 0
                      ? `${analysisResults.dataCenters.length} within ${DATA_CENTER_ANALYSIS_RADIUS_MI} mi`
                      : 'No data centers nearby')}</p>
                  </div>
                  {pDC && <div className="analysis-card-spinner" aria-hidden="true" />}
                </div>
              </div>
            )
          })()}

          {(() => {
            const pCrowd = analysisProgress.crowd !== 'done'
            return (
              <div className={`analysis-card ${pCrowd ? 'pending' : crowdMagnetsSeverity(analysisResults.crowdMagnets.length)}`}>
                <div
                  className={`analysis-item${pCrowd ? '' : ' clickable'}`}
                  onClick={() => {
                    if (pCrowd) return
                    if (analysisDetail === 'crowd') setAnalysisDetail(null)
                    else setAnalysisDetail('crowd')
                  }}
                  aria-busy={pCrowd || undefined}
                >
                  <div className={`analysis-chevron${analysisDetail === 'crowd' ? ' expanded' : ''}${pCrowd ? ' hidden' : ''}`}>‹</div>
                  <div className="analysis-icon">🎟️</div>
                  <div className="analysis-detail">
                    <strong>Crowd Magnets</strong>
                    <p>{pCrowd ? 'Checking…' : (analysisResults.crowdMagnets.length > 0
                      ? `${analysisResults.crowdMagnets.length} within ${CROWD_ANALYSIS_RADIUS_MI} mi`
                      : `None within ${CROWD_ANALYSIS_RADIUS_MI} mi`)}</p>
                  </div>
                  {pCrowd && <div className="analysis-card-spinner" aria-hidden="true" />}
                </div>
              </div>
            )
          })()}

          {(() => {
            const pER = analysisProgress.er !== 'done'
            return (
              <div className={`analysis-card ${pER ? 'pending' : (analysisResults.nearestER ? (erSeverity(analysisResults.nearestER.distanceMi) === 'clear' || erSeverity(analysisResults.nearestER.distanceMi) === 'good' ? 'clear' : erSeverity(analysisResults.nearestER.distanceMi)) : 'danger')}`}>
                <div
                  className={`analysis-item${pER ? '' : ' clickable'}`}
                  onClick={() => {
                    if (pER) return
                    if (analysisDetail === 'er') setAnalysisDetail(null)
                    else setAnalysisDetail('er')
                  }}
                  aria-busy={pER || undefined}
                >
                  <div className={`analysis-chevron${analysisDetail === 'er' ? ' expanded' : ''}${pER ? ' hidden' : ''}`}>‹</div>
                  <div className="analysis-icon">🏥</div>
                  <div className="analysis-detail">
                    <strong>Emergency Room</strong>
                    <p>{pER ? 'Checking…' : (analysisResults.nearestER
                      ? `${analysisResults.nearestER.distanceMi} mi — ${analysisResults.nearestER.name}`
                      : analysisResults.erError ? 'Search failed' : 'None found nearby')}</p>
                  </div>
                  {pER && <div className="analysis-card-spinner" aria-hidden="true" />}
                </div>
              </div>
            )
          })()}

          {/* Costco — runs in the background after everything else, so it lives at the bottom */}
          <div className={`analysis-card ${analysisResults.costcoLoading ? 'pending' : analysisResults.costco ? costcoSeverity(analysisResults.costco.distanceMi) : analysisResults.costcoError ? 'clear' : 'danger'}`}>
            <div
              className={`analysis-item${analysisResults.costcoLoading ? '' : ' clickable'}`}
              onClick={() => {
                if (analysisResults.costcoLoading) return
                if (analysisDetail === 'costco') setAnalysisDetail(null)
                else setAnalysisDetail('costco')
              }}
              aria-busy={analysisResults.costcoLoading || undefined}
            >
              <div className={`analysis-chevron${analysisDetail === 'costco' ? ' expanded' : ''}${analysisResults.costcoLoading ? ' hidden' : ''}`}>‹</div>
              <div className="analysis-icon">🛒</div>
              <div className="analysis-detail">
                <strong>Nearest Costco</strong>
                <p>{analysisResults.costcoLoading
                  ? 'Searching nearby Costcos…'
                  : analysisResults.costco
                  ? `${analysisResults.costco.distanceMi} mi${analysisResults.costco.city ? ` — ${analysisResults.costco.city}` : ''}`
                  : analysisResults.costcoError
                  ? 'Search failed'
                  : analysisResults.costcoNearestBeyond
                  ? `Closest is ${analysisResults.costcoNearestBeyond.distanceMi} mi (outside ${COSTCO_ANALYSIS_RADIUS_MI} mi)`
                  : `None within ${COSTCO_ANALYSIS_RADIUS_MI} mi`}</p>
              </div>
              {analysisResults.costcoLoading && <div className="analysis-card-spinner" aria-hidden="true" />}
              {analysisResults.costcoError && !analysisResults.costcoLoading && (
                <button
                  type="button"
                  className="analysis-card-retry"
                  onClick={(e) => { e.stopPropagation(); retryCostco() }}
                  aria-label="Retry Costco search"
                >Retry</button>
              )}
            </div>
          </div>
        </div>
      </aside>

      {/* Detail popout — positioned to the left of analysis panel */}
      {analysisDetail && !analysisResults.loading && (
        <aside className="analysis-popout" role="dialog" aria-modal="false" aria-label="Analysis detail">
          <div className="analysis-popout-header">
            <strong>
              {analysisDetail === 'score' ? '📊 Score Breakdown' :
               analysisDetail === 'noise' ? '✈️ Airport Noise' :
               analysisDetail === 'superfunds' ? '☢️ Superfund Sites' :
               analysisDetail === 'costco' ? '🛒 Nearest Costco' :
               analysisDetail === 'er' ? '🏥 Emergency Room' :
               '🏢 Data Centers'}
            </strong>
            <button className="analysis-popout-close" onClick={() => {
              const wasScore = analysisDetail === 'score'
              setAnalysisDetail(null)
              if (wasScore) setShowScoreBreakdown(false)
            }} aria-label="Close detail">×</button>
          </div>
          <div className="analysis-popout-body">
            {analysisDetail === 'score' && (() => {
              const grade = computeLocationGrade(analysisResults)
              const gradeDescriptions: Record<string, string> = {
                A: 'This location has minimal environmental or infrastructure concerns. All categories show favorable conditions, making it well-suited for residential or commercial use without significant risk factors.',
                B: 'This location is generally favorable with only minor concerns in one or two categories. Any flagged issues are moderate and unlikely to significantly impact quality of life or property value.',
                C: 'This location has a mix of favorable and concerning factors. One or more categories show moderate issues that warrant further investigation before making a decision.',
                D: 'This location has notable concerns across multiple categories. Several environmental or infrastructure factors may negatively affect quality of life, property value, or health.',
                F: 'This location has significant concerns across most categories. Multiple high-severity issues were detected that could substantially impact livability, safety, or long-term value.'
              }
              return (
                <>
                  <div className="score-breakdown-grade-summary">
                    <div className="score-breakdown-grade-badge" style={{ background: grade.color }}>{grade.letter}</div>
                    <div className="score-breakdown-grade-info">
                      <strong>{Math.round(grade.pct * 100)}% — {grade.letter === 'A' ? 'Excellent' : grade.letter === 'B' ? 'Good' : grade.letter === 'C' ? 'Fair' : grade.letter === 'D' ? 'Poor' : 'Critical'}</strong>
                      <p>{gradeDescriptions[grade.letter]}</p>
                    </div>
                  </div>
                  <div className="score-breakdown-divider" />
                  {grade.breakdown.map((b) => {
                    const barColor = b.score === 0 ? '#4caf50' : b.score === 1 ? '#ffb300' : '#ef5350'
                    const statusLabel = b.score === 0 ? 'No concerns' : b.score === 1 ? 'Minor concern' : 'Notable concern'
                    const explanations: Record<string, Record<number, string>> = {
                      'Airport Noise': {
                        0: 'This location is outside all mapped airport noise contours, meaning aircraft noise is unlikely to be a concern.',
                        1: 'This location falls within a moderate airport noise contour. You may notice aircraft during peak hours, but it is generally manageable for most residents.',
                        2: 'This location is within a high noise zone (65+ dB DNL). Expect frequent, noticeable aircraft noise that may affect outdoor activities and sleep quality.'
                      },
                      'Superfund Sites': {
                        0: 'No EPA Superfund sites were found within 5 miles. This area is clear of known hazardous waste cleanup activity.',
                        1: 'A small number of Superfund sites are nearby. Residual risk may be limited, but due diligence is recommended.',
                        2: 'One or more active Superfund sites are within 5 miles. Active sites may pose environmental or health risks and could affect property values.'
                      },
                      'Nearest Costco': {
                        0: 'A Costco is right there. You magnificent, bulk-buying genius — rotisserie chickens practically deliver themselves at this distance.',
                        1: 'Costco exists, but it\'s a bit of a drive. You\'ll need a playlist, a snack, and the quiet determination of someone who refuses to pay retail for paper towels.',
                        2: 'No Costco in sight. You\'ll be buying toilet paper like a regular person — one sad, normal-sized pack at a time. Our condolences.'
                      },
                      'Data Centers': {
                        0: 'No data centers were detected nearby. This area is clear of associated concerns like noise from cooling systems or heavy truck traffic.',
                        1: 'A few data centers are nearby. Minor impacts from generator testing, backup diesel operations, or increased traffic are possible.',
                        2: 'Multiple data centers are near this location. Expect potential noise from industrial cooling, periodic generator testing, and increased commercial vehicle traffic.'
                      },
                      'Emergency Room': {
                        0: 'An emergency room is within close range. Quick access to emergency medical care is a significant safety advantage for this location.',
                        1: 'An emergency room is at moderate distance. Response times may be longer during peak traffic, but access is still reasonable.',
                        2: 'No emergency room was found nearby. Longer travel times to emergency care could be a concern, especially for families or elderly residents.'
                      }
                    }
                    return (
                      <div className="score-breakdown-row" key={b.label}>
                        <div className="score-breakdown-label">
                          <span>{b.icon}</span>
                          <span>{b.label}</span>
                          <span className="score-breakdown-status" style={{ color: barColor }}>{statusLabel}</span>
                        </div>
                        <div className="score-breakdown-bar-track">
                          <div className="score-breakdown-bar-fill" style={{ width: `${((b.max - b.score) / b.max) * 100}%`, background: barColor }} />
                        </div>
                        <p className="score-breakdown-detail">{b.detail}</p>
                        <p className="score-breakdown-explanation">{explanations[b.label]?.[b.score] || ''}</p>
                      </div>
                    )
                  })}
                </>
              )
            })()}
            {analysisDetail === 'noise' && (
              <>
                {analysisResults.noiseLevel ? (
                  <>
                    {analysisResults.noiseAirport && (
                      <p className="analysis-expand-sub">
                        {analysisResults.noiseAirport}{analysisResults.noiseAirportCode ? ` (${analysisResults.noiseAirportCode})` : ''}
                      </p>
                    )}
                    <p className="analysis-expand-level">Estimated: ~{analysisResults.noiseLevel} dB DNL</p>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        Aircraft noise is measured in DNL (Day-Night Average Sound Level) and affects sleep quality, outdoor enjoyment, and long-term health.
                        {analysisResults.noiseLevel >= 65
                          ? ' At this level, the FAA considers the area "significantly impacted." Expect frequent and noticeable aircraft noise throughout the day.'
                          : analysisResults.noiseLevel >= 55
                          ? ' This area falls within the moderate impact zone. Noise may be noticeable during peak flight hours and could affect outdoor conversations.'
                          : ' This area is within a mapped noise contour but at a relatively low level. Occasional aircraft noise may be audible.'}
                      </p>
                    </div>
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
                  <>
                    <p className="analysis-expand-level clear">This location is not within any mapped airport noise contour.</p>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        Airport noise can significantly affect quality of life, property values, and health.
                        This location is outside all mapped noise contours — a positive indicator for peaceful living.
                      </p>
                    </div>
                  </>
                )}
              </>
            )}

            {analysisDetail === 'superfunds' && (
              <>
                {analysisResults.superfunds.length > 0 ? (
                  <>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        EPA Superfund sites are locations contaminated with hazardous waste that pose risks to human health and the environment.
                        Active sites may have ongoing contamination of soil, groundwater, or air, which can affect property values and health.
                      </p>
                    </div>
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
                            <button
                              className="analysis-flyto-btn"
                              onClick={() => flyToWithAddress(s.lat, s.lng)}
                              title="Fly to location"
                              aria-label={`Fly to ${s.name}`}
                            >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <circle cx="12" cy="12" r="9" />
                                <line x1="22" y1="12" x2="18" y2="12" />
                                <line x1="6" y1="12" x2="2" y2="12" />
                                <line x1="12" y1="6" x2="12" y2="2" />
                                <line x1="12" y1="22" x2="12" y2="18" />
                                <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
                              </svg>
                            </button>
                          </div>
                          {s.url && (
                            <a href={s.url} target="_blank" rel="noopener noreferrer" className="analysis-epa-link">
                              EPA Site Profile →
                            </a>
                          )}
                        </li>
                      ))}
                    </ul>
                    <div className="analysis-expand-rec">
                      <strong>Recommendation</strong>
                      <p>
                        Research these sites using the EPA links above to understand the contamination history,
                        current cleanup status, and any health advisories.
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="analysis-expand-level clear">No EPA Superfund sites found within 5 miles of this address.</p>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        Superfund sites can contaminate local soil, groundwater, and air — posing health risks and reducing property values.
                        The absence of any sites nearby is a positive indicator for this location.
                      </p>
                    </div>
                  </>
                )}
              </>
            )}

            {analysisDetail === 'costco' && (
              <>
                {analysisResults.costcoLoading ? (
                  <p className="analysis-expand-level" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className="analysis-card-spinner" aria-hidden="true" style={{ margin: 0 }} />
                    Still searching for nearby Costcos…
                  </p>
                ) : analysisResults.costco ? (() => {
                  const dist = analysisResults.costco.distanceMi
                  const sev = costcoSeverity(dist)
                  return (
                    <>
                      <p className="analysis-expand-sub">{analysisResults.costco.city || 'Costco Wholesale'}</p>
                      {analysisResults.costco.address && (
                        <p style={{ fontSize: '0.78rem', color: '#888', margin: '4px 0 8px' }}>{analysisResults.costco.address}</p>
                      )}
                      <p className={`analysis-expand-level ${sev}`}>{dist} miles from this address</p>
                      <div className="analysis-costco-actions">
                        <button className="analysis-flyto-link" onClick={() => { if (!costcoVisible) toggleCostco(); flyToWithAddress(analysisResults.costco!.lat, analysisResults.costco!.lng) }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                            <circle cx="12" cy="10" r="3" />
                          </svg>
                          Show on map
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
                  <>
                    <p className="analysis-expand-level warning">
                      Costco search failed. Google Places may be busy or rate-limited.
                    </p>
                    <button
                      type="button"
                      className="analysis-expand-retry"
                      onClick={retryCostco}
                    >
                      Retry Costco search
                    </button>
                  </>
                ) : analysisResults.costcoNearestBeyond ? (
                  <>
                    <p className="analysis-expand-level warning">
                      Closest Costco is <strong>{analysisResults.costcoNearestBeyond.distanceMi} mi</strong> away
                      {analysisResults.costcoNearestBeyond.city ? ` in ${analysisResults.costcoNearestBeyond.city}` : ''} —
                      outside the {COSTCO_ANALYSIS_RADIUS_MI}-mile range.
                    </p>
                    <div className="analysis-expand-rec">
                      <strong>⚠️ Bulk shopping will be a trek</strong>
                      <p>
                        Stocking up is doable but you're committing to a serious drive. Budget the gas, the time,
                        and a sturdy cooler if you're hauling frozen goods home.
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
              </>
            )}

            {analysisDetail === 'datacenters' && (
              <>
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
                            <button
                              className="analysis-flyto-btn"
                              onClick={() => flyToWithAddress(dc.lat, dc.lng)}
                              title="Fly to location"
                              aria-label={`Fly to ${dc.name || 'data center'}`}
                            >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <circle cx="12" cy="12" r="9" />
                                <line x1="22" y1="12" x2="18" y2="12" />
                                <line x1="6" y1="12" x2="2" y2="12" />
                                <line x1="12" y1="6" x2="12" y2="2" />
                                <line x1="12" y1="22" x2="12" y2="18" />
                                <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
                              </svg>
                            </button>
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
                  <>
                    <p className="analysis-expand-level clear">No data centers found within {DATA_CENTER_ANALYSIS_RADIUS_MI} miles.</p>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        Data centers can impact surrounding areas through increased traffic,
                        noise from cooling systems, and strain on local power and water resources.
                        The absence of any nearby is a positive indicator for this location.
                      </p>
                    </div>
                  </>
                )}
              </>
            )}

            {analysisDetail === 'crowd' && (
              <>
                {analysisResults.crowdMagnets.length > 0 ? (
                  <>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        Stadiums, concert venues, parks, theme parks, and racetracks can
                        generate significant crowd noise and event-day traffic surges nearby.
                      </p>
                    </div>
                    <ul className="analysis-expand-list">
                      {analysisResults.crowdMagnets.map((m) => (
                        <li key={m.id} className="dc-analysis-item">
                          <div className="dc-analysis-header">
                            <span className="dc-status-dot" style={{ background: CROWD_COLORS[m.type] }} />
                            <strong>{CROWD_ICONS[m.type]} {m.name}</strong>
                            <span className="dc-distance">{m.distanceMi} mi</span>
                            <button
                              className="analysis-flyto-btn"
                              onClick={() => flyToWithAddress(m.lat, m.lng)}
                              title="Fly to location"
                              aria-label={`Fly to ${m.name}`}
                            >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <circle cx="12" cy="12" r="9" />
                                <line x1="22" y1="12" x2="18" y2="12" />
                                <line x1="6" y1="12" x2="2" y2="12" />
                                <line x1="12" y1="6" x2="12" y2="2" />
                                <line x1="12" y1="22" x2="12" y2="18" />
                                <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
                              </svg>
                            </button>
                          </div>
                          <div className="dc-analysis-meta">
                            <span>{CROWD_LABEL_SINGULAR[m.type]}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <>
                    <p className="analysis-expand-level clear">No crowd magnets found within {CROWD_ANALYSIS_RADIUS_MI} miles.</p>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        Stadiums, concert venues, parks, theme parks, and racetracks can
                        generate significant crowd noise and event-day traffic surges nearby.
                        The absence of any nearby is a positive indicator for this location.
                      </p>
                    </div>
                  </>
                )}
              </>
            )}

            {analysisDetail === 'er' && (
              <>
                {analysisResults.nearestER ? (() => {
                  const dist = analysisResults.nearestER.distanceMi
                  const sev = erSeverity(dist)
                  return (
                    <>
                      <p className="analysis-expand-sub">{analysisResults.nearestER.name}</p>
                      {analysisResults.nearestER.address && (
                        <p style={{ fontSize: '0.78rem', color: '#888', margin: '4px 0 8px' }}>{analysisResults.nearestER.address}</p>
                      )}
                      <p className={`analysis-expand-level ${sev}`}>{dist} miles from this address</p>
                      <div className="analysis-costco-actions">
                        <button className="analysis-flyto-link" onClick={() => showHighlightPin(analysisResults.nearestER!.lat, analysisResults.nearestER!.lng, analysisResults.nearestER!.name)}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                            <circle cx="12" cy="10" r="3" />
                          </svg>
                          Show on map
                        </button>
                        <a
                          className="costco-directions-link"
                          href={`https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(address || '')}&destination=${analysisResults.nearestER.lat},${analysisResults.nearestER.lng}&travelmode=driving`}
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
                        <strong>Why this matters</strong>
                        <p>
                          Proximity to an emergency room can be critical in life-threatening situations.
                          {sev === 'clear' || sev === 'good'
                            ? ' This location has good access to emergency medical care.'
                            : sev === 'warning'
                            ? ' At this distance, travel time to the ER may be a factor during emergencies.'
                            : ' The nearest ER is far away — consider this carefully if quick emergency access is important to you.'}
                        </p>
                      </div>
                      <div className="analysis-expand-rec">
                        <strong>Distance bands</strong>
                        <p>
                          <span className="analysis-band good">≤ 10 mi</span> good · {' '}
                          <span className="analysis-band warning">11–15 mi</span> caution · {' '}
                          <span className="analysis-band danger">&gt; 15 mi</span> concern
                        </p>
                      </div>
                    </>
                  )
                })() : (
                  <>
                    <p className="analysis-expand-level danger">
                      No emergency rooms found within {ER_ANALYSIS_RADIUS_MI} miles.
                    </p>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        Proximity to an emergency room can be critical in life-threatening situations.
                        No hospitals or emergency departments were found within the search radius.
                        This could significantly impact response times in a medical emergency.
                      </p>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </aside>
      )}

      {shareModalOpen && (
        <div className="analysis-detail-overlay" onClick={closeShareModal}>
          <div className="analysis-detail-popup share-popup" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="share-modal-title">
            <button className="analysis-detail-close" onClick={closeShareModal} aria-label="Close">×</button>
            <h3 id="share-modal-title">Share Results</h3>
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

      {devTodosOpen && (
        <div className="analysis-detail-overlay" onClick={() => setDevTodosOpen(false)}>
          <div className="analysis-detail-popup dev-todos-popup" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="dev-todos-title">
            <button className="analysis-detail-close" onClick={() => setDevTodosOpen(false)} aria-label="Close">×</button>
            <h3 id="dev-todos-title">📋 To Do</h3>
            <p className="dev-todos-summary">
              {devTodoItems.length === 0
                ? 'No items yet — add one below.'
                : remainingDevTodos === 0
                ? 'All caught up — nice.'
                : `${remainingDevTodos} of ${devTodoItems.length} remaining`}
            </p>
            <ul className="dev-todos-list">
              {devTodoItems.map((t) => {
                const done = !!devTodoChecks[t.id]
                return (
                  <li key={t.id} className={`dev-todo-item${done ? ' done' : ''}`}>
                    <label>
                      <input type="checkbox" checked={done} onChange={() => toggleDevTodo(t.id)} />
                      <span className="dev-todo-label">{t.label}</span>
                    </label>
                    {t.note && <div className="dev-todo-note">{t.note}</div>}
                    <button
                      type="button"
                      className="dev-todo-delete"
                      onClick={() => deleteDevTodo(t.id)}
                      aria-label={`Delete "${t.label}"`}
                      title="Delete"
                    >
                      ×
                    </button>
                  </li>
                )
              })}
            </ul>
            <form
              className="dev-todos-add"
              onSubmit={(e) => { e.preventDefault(); addDevTodo() }}
            >
              <input
                type="text"
                value={newDevTodoText}
                onChange={(e) => setNewDevTodoText(e.target.value)}
                placeholder="Add a new todo…"
                aria-label="New todo text"
                maxLength={200}
              />
              <button type="submit" disabled={!newDevTodoText.trim()}>Add</button>
            </form>
            <div className="dev-todos-hint">
              {devTodoSync === 'loading' && 'Loading from server…'}
              {devTodoSync === 'saving' && 'Saving…'}
              {devTodoSync === 'offline' && 'Server unreachable — saved to this browser only.'}
            </div>
          </div>
        </div>
      )}

      {status === 'ready' && (
        <GuidedTour
          key={tourReplayKey}
          storageKey="lr_tour_done"
          forceShow={tourReplayKey > 0}
          delay={tourReplayKey > 0 ? 100 : 2000}
          steps={[
            {
              selector: '.header-address-wrapper',
              title: '📍 Change Address',
              content: 'Click here to search a different U.S. address. Start typing and pick from the suggestions to instantly analyze a new location.',
              position: 'bottom',
            },
            {
              selector: '.layer-panel',
              title: '🗺️ Show on Map',
              content: 'Toggle map layers on and off — airport noise contours, Superfund sites, Costco locations, data centers, traffic, and more.',
              position: 'right',
            },
            {
              selector: '.analysis-panel',
              title: '📊 Neighborhood Report',
              content: 'This panel shows a summary of what was found at this address. Each category card is clickable — tap one to see detailed findings in a flyout.',
              position: 'left',
            },
            {
              selector: '.analysis-score-bar',
              title: '🏆 Location Score',
              content: 'Your overall location grade based on all categories combined. Click it to see a full breakdown explaining how each factor contributed to the score.',
              position: 'left',
            },
            {
              selector: '.analysis-card',
              title: '🔍 Category Details',
              content: 'Click any category card to open a detailed flyout to the left with findings, recommendations, and links. The chevron indicates it\'s expandable.',
              position: 'left',
            },
            {
              selector: '.map-container',
              title: '🌍 Interactive Map',
              content: 'Explore the map freely — zoom, pan, and click on markers for more info. Layer data updates automatically as you navigate.',
              position: 'top',
            },
          ]}
        />
      )}

    </div>
  )
}

export default MapPage
