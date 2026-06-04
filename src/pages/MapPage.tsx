import { lazy, Suspense, useEffect, useRef, useState, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import './MapPage.css'
import logo from '../assets/landrecon-logo.webp'
import { fetchStopsInWorker, fetchTransitLinesInWorker, fetchBusLinesInWorker, fetchCamerasInWorker } from '../workers/overpassClient'
const GuidedTour = lazy(() => import('../components/GuidedTour'))
import { pushRecentSearch, updateRecentSearchGrade } from '../utils/recentSearches'
import { debounce, quantizeCoord } from '../utils/perf'
import { trackEvent } from '../utils/analytics'
import { cachedPlacesSearchText, type PlacesSearchTextBody } from '../utils/placesCache'
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

// FCC Broadband Data Collection (BDC) types + helpers. Data ships through
// the same-origin /api/broadband sidecar endpoint, so no CSP burn and the
// FCC API token never reaches the browser. See server/broadband.mjs and
// scripts/build-broadband-index.mjs for the bootstrap pipeline.
type BroadbandTech = { code: number; label: string }
type BroadbandProvider = { name: string; tech: number; down: number; up: number; br: string }
type BroadbandBlock = {
  blockFips: string
  county: string
  countyFips: string
  state: string
  stateName: string
  stateFips: string
}
type BroadbandSummary = {
  providerCount: number
  maxDownMbps: number | null
  maxUpMbps: number | null
  bestProvider: string | null
  hasFiber: boolean
  speedTier: 'gig' | 'fast' | 'served' | 'underserved' | null
  technologies: BroadbandTech[]
  providers: BroadbandProvider[] | null
}
type BroadbandResponse = {
  block: BroadbandBlock | null
  summary: BroadbandSummary | null
  source: string | null
  asOfDate: string | null
  attribution: string
}
function broadbandSeverity(tier: BroadbandSummary['speedTier'] | null | undefined): 'good' | 'warning' | 'danger' | 'clear' {
  if (tier === 'gig' || tier === 'fast') return 'good'
  if (tier === 'served') return 'warning'
  if (tier === 'underserved') return 'danger'
  return 'clear'
}
function formatBroadbandSpeed(mbps: number | null | undefined): string {
  if (mbps == null || !Number.isFinite(mbps) || mbps <= 0) return '—'
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(mbps % 1000 === 0 ? 0 : 1)} Gbps`
  return `${mbps} Mbps`
}
async function fetchBroadband(lat: number, lng: number, signal?: AbortSignal): Promise<BroadbandResponse | null> {
  try {
    const res = await fetch(`/api/broadband?lat=${lat}&lng=${lng}`, { signal })
    if (!res.ok) return null
    return await res.json() as BroadbandResponse
  } catch {
    return null
  }
}
const BROADBAND_TECH_LABELS: Record<number, string> = {
  0: 'Other',
  10: 'DSL',
  40: 'Cable',
  50: 'Fiber',
  60: 'GSO Satellite',
  61: 'LEO Satellite',
  70: 'Wireless (Unlicensed)',
  71: 'Wireless (Licensed)',
  72: 'Wireless (CBRS)',
}

// Per-tab cache of completed analyses keyed by quantized coordinates
// (~110 m precision). Re-running for an address near a prior one returns
// instantly with no Google/EPA/ArcGIS calls.
const ANALYSIS_CACHE_PREFIX = 'lr_analysis_v3:'
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

// ── FEMA National Flood Hazard Layer (NFHL) ────────────────────────────
// Public ArcGIS REST endpoint — no API key required. Layer 28 is the
// "S_FLD_HAZ_AR" polygon layer (Flood Hazard Zones). FEMA generalizes
// geometry server-side based on scale, so at low zoom this can still return
// huge payloads — we only fetch when the map is zoomed in enough to be
// useful at a property-level read.
const FLOOD_API =
  'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query'

const FLOOD_FIELDS = ['FLD_ZONE', 'ZONE_SUBTY', 'SFHA_TF', 'STATIC_BFE'].join(',')

const FLOOD_MIN_ZOOM = 11

// Color buckets keyed by FLD_ZONE code. Subtypes (e.g. "0.2 PCT ANNUAL
// CHANCE FLOOD HAZARD") are handled inline in floodStyle().
//   High-risk SFHA (1% annual chance): A, AE, AH, AO, AR, A99 → red
//   Coastal high hazard (V): V, VE → purple
//   Moderate (0.2% / "500-year") shaded X → amber
//   Minimal hazard (unshaded X) → gray
//   Undetermined (D) → mid-gray
//   Open water → blue
const FLOOD_ZONE_COLORS: Record<string, string> = {
  high: '#d62728',
  coastal: '#5d2e8c',
  moderate: '#f5c542',
  minimal: '#9ca3af',
  undetermined: '#6b7280',
  water: '#3b82f6',
}

const FLOOD_ZONE_LABELS: Record<keyof typeof FLOOD_ZONE_COLORS | string, string> = {
  high: 'High risk (1% annual / SFHA)',
  coastal: 'Coastal high hazard (V/VE)',
  moderate: 'Moderate (0.2% / 500-yr)',
  minimal: 'Minimal hazard',
  undetermined: 'Undetermined (zone D)',
  water: 'Open water',
}

function floodBucket(props: GeoJSON.GeoJsonProperties): keyof typeof FLOOD_ZONE_COLORS {
  const zone = String((props as Record<string, unknown> | null | undefined)?.FLD_ZONE || '').toUpperCase().trim()
  const sub = String((props as Record<string, unknown> | null | undefined)?.ZONE_SUBTY || '').toUpperCase().trim()
  if (zone === 'OPEN WATER' || zone === 'AREA NOT INCLUDED') return 'water'
  if (zone === 'V' || zone === 'VE') return 'coastal'
  if (['A', 'AE', 'AH', 'AO', 'AR', 'A99'].includes(zone)) return 'high'
  if (zone === 'X') {
    if (sub.includes('0.2 PCT') || sub.includes('500')) return 'moderate'
    return 'minimal'
  }
  if (zone === 'D') return 'undetermined'
  return 'minimal'
}

function floodZoneLabel(props: GeoJSON.GeoJsonProperties): string {
  const zone = String((props as Record<string, unknown> | null | undefined)?.FLD_ZONE || '').trim() || 'Unknown'
  const sub = String((props as Record<string, unknown> | null | undefined)?.ZONE_SUBTY || '').trim()
  return sub ? `Zone ${zone} — ${sub}` : `Zone ${zone}`
}

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

// fetchTransitFromOverpass / loadTransitLines / loadBusLines now offload
// the network fetch + JSON.parse + element classification to a Web Worker
// (see src/workers/overpassWorker.ts). The main thread only receives the
// parsed, typed payload and creates the Leaflet polylines / markers.

// ALPR (automatic license plate reader) cameras. Flock Safety gets its own
// color because it's the most-deployed brand and the namesake of the
// DeFlock crowdsourcing project that supplies most of the underlying OSM
// tags. Everything else (Motorola Vigilant, Genetec, Rekor, etc.) shares
// a single neutral color.
//
// Magenta + violet are deliberately picked outside the rest of the layer
// palette (Wong colorblind-safe set + traffic gradient) so a camera pin
// is never mistaken for transit, EMS, data centers, or crowd magnets.
const CAMERA_COLORS = { flock: '#db2777', other: '#7c3aed' } as const

// Daily CONUS snapshots of every Overpass dataset, hydrated by
// .github/workflows/snapshot-overpass.yml and served from Azure Blob with
// Content-Encoding: gzip (browser auto-decompresses). The client prefers
// each over its per-bbox live Overpass call whenever the map center is
// inside CONUS — collapses dozens of pan-driven 1–5s Overpass calls into
// one CDN-cached fetch held in module-scope memory for the page session.
const SNAPSHOT_BASE =
  'https://landreconstorage.blob.core.windows.net/snapshots'
const CONUS_BOUNDS: [[number, number], [number, number]] = [
  [24.5, -125.0],
  [49.4, -66.9],
]

interface SnapshotEnvelope {
  version: number
  generated_at: string
  region: string
  bbox: number[]
  count: number
}

interface CameraSnapshot extends SnapshotEnvelope { cameras: CameraRecord[] }
interface CrowdSnapshotPayload extends SnapshotEnvelope { magnets: CrowdMagnet[] }
interface TransitStopsSnapshot extends SnapshotEnvelope { stops: SnapshotTransitStop[] }
interface TransitLinesSnapshot extends SnapshotEnvelope { lines: SnapshotTransitLine[] }

interface SnapshotTransitStop { id: string; type: 'rail' | 'subway' | 'tram'; lat: number; lon: number; name: string }
interface SnapshotTransitLine { id: string; type: 'rail' | 'subway' | 'tram'; coords: number[] }

// Factory: returns a memoized snapshot fetcher with single-flight semantics.
// Multiple concurrent callers (e.g. layer toggle + URL replay) share one
// in-flight Promise; subsequent callers get the resolved cache instantly.
function makeSnapshotLoader<T>(filename: string, dbgLabel: string) {
  let cache: T | null = null
  let inFlight: Promise<T | null> | null = null
  return function load(): Promise<T | null> {
    if (cache) return Promise.resolve(cache)
    if (inFlight) return inFlight
    const t0 = performance.now()
    inFlight = (async () => {
      try {
        const res = await fetch(`${SNAPSHOT_BASE}/${filename}`, { cache: 'force-cache' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const snap = (await res.json()) as T
        cache = snap
        const meta = snap as unknown as SnapshotEnvelope
        dbg(dbgLabel, `Snapshot ${filename} loaded in ${(performance.now() - t0).toFixed(0)}ms — ${meta.count} records, generated ${meta.generated_at}`)
        return snap
      } catch (err) {
        dbg(dbgLabel, `Snapshot ${filename} fetch failed; will fall back to live Overpass:`, err)
        inFlight = null
        return null
      }
    })()
    return inFlight
  }
}

const loadCamerasSnapshot = makeSnapshotLoader<CameraSnapshot>('cameras-us.json', 'cameras')
const loadCrowdSnapshot = makeSnapshotLoader<CrowdSnapshotPayload>('crowd-us.json', 'crowd')
const loadTransitStopsSnapshot = makeSnapshotLoader<TransitStopsSnapshot>('transit-stops-us.json', 'transit')
const loadTransitLinesSnapshot = makeSnapshotLoader<TransitLinesSnapshot>('transit-lines-us.json', 'transit')

interface CameraRecord {
  id: string
  lat: number
  lon: number
  manufacturer: string
  operator: string
  direction: string
  isFlock: boolean
}

function cameraPopup(c: CameraRecord): string {
  const label = c.isFlock ? 'Flock Safety ALPR' : (c.manufacturer ? `${c.manufacturer} ALPR` : 'ALPR camera')
  const color = c.isFlock ? CAMERA_COLORS.flock : CAMERA_COLORS.other
  const rows: string[] = []
  if (c.operator) rows.push(`<div><strong>Operator:</strong> ${escapeHtml(c.operator)}</div>`)
  if (c.direction) rows.push(`<div><strong>Direction:</strong> ${escapeHtml(c.direction)}</div>`)
  const nodeId = c.id.replace(/^node\//, '')
  return `
    <div class="transit-popup">
      <div class="transit-popup-title" style="color:${color}">${label}</div>
      ${rows.join('')}
      <div class="camera-popup-source">
        Source: <a href="https://www.openstreetmap.org/node/${nodeId}" target="_blank" rel="noopener noreferrer">OSM node ${nodeId}</a>
        &middot; <a href="https://deflock.me/" target="_blank" rel="noopener noreferrer">DeFlock</a>
      </div>
    </div>
  `.trim()
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
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

async function fetchFloodFeatures(bounds: L.LatLngBounds): Promise<GeoJSON.FeatureCollection> {
  const bbox = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`
  const params = new URLSearchParams({
    where: '1=1',
    outFields: FLOOD_FIELDS,
    geometry: bbox,
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outSR: '4326',
    f: 'geojson',
    resultRecordCount: '1000',
  })
  const res = await fetch(`${FLOOD_API}?${params}`)
  return res.json()
}

// ── HIFLD Electric Power Transmission Lines ─────────────────────────────
// Public ArcGIS FeatureServer hosted by Esri on behalf of the Homeland
// Infrastructure Foundation-Level Data (HIFLD) Open program. ~88k feature
// polylines nationally — gated to zoom >= POWER_MIN_ZOOM to keep the fetch
// payload bounded.
const POWER_API =
  'https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Electric_Power_Transmission_Lines/FeatureServer/0/query'

const POWER_FIELDS = ['OWNER', 'VOLTAGE', 'VOLT_CLASS', 'TYPE', 'STATUS', 'SUB_1', 'SUB_2'].join(',')

const POWER_MIN_ZOOM = 10

// Color bands keyed by VOLT_CLASS value. The dataset uses these exact
// strings for the bucketing field; values like "NOT AVAILABLE" and "DC"
// fall through to a neutral gray and a distinct blue respectively.
const POWER_VOLT_COLORS: Record<string, string> = {
  'UNDER 100': '#fde725',
  '100-161': '#f7a51b',
  '220-287': '#ef4035',
  '345': '#c724b1',
  '500': '#7e1ce9',
  '735 AND ABOVE': '#3b0f7a',
  'DC': '#1f6feb',
  'NOT AVAILABLE': '#9ca3af',
}

const POWER_VOLT_ORDER: readonly string[] = [
  'UNDER 100', '100-161', '220-287', '345', '500', '735 AND ABOVE', 'DC', 'NOT AVAILABLE',
] as const

const POWER_VOLT_LABELS: Record<string, string> = {
  'UNDER 100': '< 100 kV',
  '100-161': '100–161 kV',
  '220-287': '220–287 kV',
  '345': '345 kV',
  '500': '500 kV',
  '735 AND ABOVE': '735 kV+',
  'DC': 'HVDC',
  'NOT AVAILABLE': 'Unknown',
}

function powerColor(props: GeoJSON.GeoJsonProperties): string {
  const cls = String((props as Record<string, unknown> | null | undefined)?.VOLT_CLASS || '').toUpperCase().trim()
  return POWER_VOLT_COLORS[cls] || POWER_VOLT_COLORS['NOT AVAILABLE']
}

async function fetchPowerLineFeatures(bounds: L.LatLngBounds): Promise<GeoJSON.FeatureCollection> {
  const bbox = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`
  const params = new URLSearchParams({
    where: '1=1',
    outFields: POWER_FIELDS,
    geometry: bbox,
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outSR: '4326',
    f: 'geojson',
    resultRecordCount: '2000',
  })
  const res = await fetch(`${POWER_API}?${params}`)
  return res.json()
}

// ── EPA FRS Industrial Facilities ───────────────────────────────────────
// EPA Facility Registry Service (FRS_INTERESTS MapServer). Each layer is
// a filtered point view of all FRS-registered facilities that participate
// EPA TRI Reporting Facilities — narrow industrial-hazard layer.
// We query a single MapServer layer that exposes facility-level rollups
// of toxic chemical releases from EPA's Toxics Release Inventory, with
// a clean INDUSTRY field that maps to NAICS prefixes. We filter to the
// three industry sectors that almost always indicate a heavy-emissions
// facility next door:
//   • 324 Petroleum  — oil refineries
//   • 325 Chemicals  — chemical plants
//   • 322 Paper      — paper / pulp mills
const INDUSTRIAL_API_BASE =
  'https://gispub.epa.gov/arcgis/rest/services/OEI/TRI_Reporting_Facilities/MapServer/0'
const INDUSTRIAL_FIELDS = [
  'EPA_REGISTRY_ID', 'TRI_FACILITY_ID', 'FACILITY_NAME', 'STREET_ADDRESS',
  'CITY', 'STATE', 'INDUSTRY', 'TOTAL_RELEASES_lb', 'REPORTING_YEAR',
].join(',')
// Scope the layer to a radius around the searched address rather than the
// viewport — refinery / chemical / paper-mill impact is meaningfully tied
// to the property the user is researching. 10 mi keeps the focus tight on
// the immediate neighborhood (most acute air-quality + nuisance reach).
const INDUSTRIAL_RADIUS_MI = 10

type IndustrialIndustryKey = 'PETROLEUM' | 'CHEMICALS' | 'PAPER'

interface IndustrialIndustryMeta {
  key: IndustrialIndustryKey
  // EPA INDUSTRY field literal (e.g. "324 Petroleum")
  industryValue: string
  label: string
  color: string
  icon: string
}

const INDUSTRIAL_INDUSTRIES: readonly IndustrialIndustryMeta[] = [
  { key: 'PETROLEUM', industryValue: '324 Petroleum', label: 'Oil refineries',  color: '#37474f', icon: '🛢️' },
  { key: 'CHEMICALS', industryValue: '325 Chemicals', label: 'Chemical plants', color: '#ef5350', icon: '⚗️' },
  { key: 'PAPER',     industryValue: '322 Paper',     label: 'Paper mills',     color: '#6d4c41', icon: '📄' },
] as const

const INDUSTRIAL_INDUSTRY_BY_VALUE = new Map(
  INDUSTRIAL_INDUSTRIES.map((m) => [m.industryValue, m]),
)

interface IndustrialFacility {
  registryId: string
  name: string
  address: string | null
  city: string | null
  state: string | null
  industry: IndustrialIndustryMeta
  totalReleasesLb: number | null
  reportingYear: string | null
  facUrl: string | null
  lat: number
  lng: number
  distanceMi: number
}

async function fetchIndustrialFacilities(
  center: L.LatLng,
  radiusMi: number,
): Promise<IndustrialFacility[]> {
  // Bounding box that fully contains a `radiusMi` circle around `center`.
  const dLat = radiusMi / 69.0
  const dLng = radiusMi / (69.0 * Math.max(Math.cos((center.lat * Math.PI) / 180), 0.01))
  const west = center.lng - dLng
  const east = center.lng + dLng
  const south = center.lat - dLat
  const north = center.lat + dLat
  const industryList = INDUSTRIAL_INDUSTRIES.map((m) => `'${m.industryValue}'`).join(',')
  const params = new URLSearchParams({
    where: `INDUSTRY IN (${industryList})`,
    outFields: INDUSTRIAL_FIELDS,
    geometry: `${west},${south},${east},${north}`,
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outSR: '4326',
    f: 'json',
    resultRecordCount: '2000',
  })
  const res = await fetch(`${INDUSTRIAL_API_BASE}/query?${params}`)
  if (!res.ok) return []
  const json = await res.json() as {
    features?: Array<{ attributes: Record<string, unknown>; geometry: { x: number; y: number } }>
  }
  const radiusM = radiusMi * 1609.34
  // Dedupe by EPA_REGISTRY_ID (or TRI_FACILITY_ID); keep most recent report.
  const byId = new Map<string, IndustrialFacility>()
  for (const f of json.features || []) {
    const attrs = f.attributes || {}
    const id = String(attrs.EPA_REGISTRY_ID || attrs.TRI_FACILITY_ID || '').trim()
    if (!id) continue
    const industryValue = String(attrs.INDUSTRY || '').trim()
    const industry = INDUSTRIAL_INDUSTRY_BY_VALUE.get(industryValue)
    if (!industry) continue
    const lat = Number(f.geometry?.y)
    const lng = Number(f.geometry?.x)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
    const distM = center.distanceTo(L.latLng(lat, lng))
    if (distM > radiusM) continue
    const year = attrs.REPORTING_YEAR ? String(attrs.REPORTING_YEAR).trim() : null
    const existing = byId.get(id)
    if (existing && existing.reportingYear && year && existing.reportingYear >= year) continue
    const releases = Number(attrs.TOTAL_RELEASES_lb)
    byId.set(id, {
      registryId: id,
      name: String(attrs.FACILITY_NAME || '').trim() || 'Unknown facility',
      address: attrs.STREET_ADDRESS ? String(attrs.STREET_ADDRESS).trim() : null,
      city: attrs.CITY ? String(attrs.CITY).trim() : null,
      state: attrs.STATE ? String(attrs.STATE).trim() : null,
      industry,
      totalReleasesLb: Number.isFinite(releases) ? releases : null,
      reportingYear: year,
      facUrl: attrs.EPA_REGISTRY_ID
        ? `https://echo.epa.gov/detailed-facility-report?fid=${String(attrs.EPA_REGISTRY_ID).trim()}`
        : null,
      lat,
      lng,
      distanceMi: distM / 1609.34,
    })
  }
  return Array.from(byId.values()).sort((a, b) => a.distanceMi - b.distanceMi)
}

// ── USFS Wildfire Hazard Potential (Classified) ─────────────────────────
// 270m raster, 5 classes (Very Low → Very High) + non-burnable + water.
// Hosted by the Imagery Information Products Program (IIPP) — the new
// home for what used to live on apps.fs.usda.gov. We request a single
// pre-symbolized PNG per viewport via the ImageServer's exportImage
// endpoint and overlay it via Leaflet's L.imageOverlay (re-fetched on
// moveend). The "WHP_CLS_2023_8bit" raster function bakes in the
// canonical USFS color ramp.
const WHP_BASE =
  'https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_RMRS_WildfireHazardPotentialClassified/ImageServer/exportImage'

const WHP_RENDERING_RULE = JSON.stringify({ rasterFunction: 'WHP_CLS_2023_8bit' })

// Min zoom where overlay reads usefully. Below this the 270m pixels
// degenerate into noise and the request size cap kicks in.
const WHP_MIN_ZOOM = 6
// Above this zoom the source raster (270m / pixel) is heavily upsampled
// and looks blocky. Keep the overlay attached but request the same image
// size — the browser will scale it. No additional fetch needed.
const WHP_MAX_USEFUL_ZOOM = 14

const WHP_CLASS_COLORS: Array<{ label: string; color: string }> = [
  { label: 'Very low',      color: '#1a9850' },
  { label: 'Low',           color: '#a6d96a' },
  { label: 'Moderate',      color: '#fee08b' },
  { label: 'High',          color: '#fc8d59' },
  { label: 'Very high',     color: '#d73027' },
  { label: 'Non-burnable',  color: '#bdbdbd' },
  { label: 'Water',         color: '#6baed6' },
]

// ── EPA AirNow Latest AQI Contours (combined Ozone + PM2.5) ─────────────
// Hourly-refreshed polygon contour layer hosted on EPA's public ArcGIS
// Online org. `gridcode` is the AQI category (1–6); "Combined" means the
// worst-of Ozone and PM2.5 at the contour location. Polygons are coarse
// and useful even at low zoom for visualizing regional smoke / dust /
// ozone events, so the gate is permissive.
const AQI_API =
  'https://services.arcgis.com/cJ9YHowT8TU7DUyn/ArcGIS/rest/services/AirNowLatestContoursCombined/FeatureServer/0/query'

const AQI_FIELDS = ['gridcode', 'Timestamp'].join(',')

const AQI_MIN_ZOOM = 4

// EPA standard AQI category colors (https://www.airnow.gov/aqi/aqi-basics/)
const AQI_CATEGORY_COLORS: Record<number, string> = {
  1: '#00e400',
  2: '#ffff00',
  3: '#ff7e00',
  4: '#ff0000',
  5: '#8f3f97',
  6: '#7e0023',
}

const AQI_CATEGORY_LABELS: Record<number, string> = {
  1: 'Good (0–50)',
  2: 'Moderate (51–100)',
  3: 'Unhealthy for sensitive (101–150)',
  4: 'Unhealthy (151–200)',
  5: 'Very unhealthy (201–300)',
  6: 'Hazardous (301+)',
}

function aqiCategory(props: GeoJSON.GeoJsonProperties): number {
  const raw = (props as Record<string, unknown> | null | undefined)?.gridcode
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return 1
  return Math.min(Math.max(Math.round(n), 1), 6)
}

function aqiColor(props: GeoJSON.GeoJsonProperties): string {
  return AQI_CATEGORY_COLORS[aqiCategory(props)] || AQI_CATEGORY_COLORS[1]
}

async function fetchAqiFeatures(bounds: L.LatLngBounds): Promise<GeoJSON.FeatureCollection> {
  const bbox = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`
  const params = new URLSearchParams({
    where: '1=1',
    outFields: AQI_FIELDS,
    geometry: bbox,
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outSR: '4326',
    f: 'geojson',
    resultRecordCount: '2000',
  })
  const res = await fetch(`${AQI_API}?${params}`)
  return res.json()
}

function buildWhpImageUrl(bounds: L.LatLngBounds, widthPx: number, heightPx: number): string {
  // ArcGIS exportImage accepts bbox in EPSG:4326 if bboxSR=4326 is set;
  // the service reprojects internally. Cap pixel dimensions so we don't
  // accidentally request a huge tile on a 4K display.
  const w = Math.min(Math.max(Math.round(widthPx), 256), 1600)
  const h = Math.min(Math.max(Math.round(heightPx), 256), 1600)
  const bbox = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`
  const params = new URLSearchParams({
    bbox,
    bboxSR: '4326',
    imageSR: '3857',
    size: `${w},${h}`,
    format: 'png32',
    f: 'image',
    transparent: 'true',
    renderingRule: WHP_RENDERING_RULE,
  })
  return `${WHP_BASE}?${params}`
}

const NPL_STATUS_INFO: Record<string, { label: string; desc: string }> = {
  F: { label: 'Final', desc: 'Officially listed on the NPL as a priority cleanup site' },
  P: { label: 'Proposed', desc: 'Proposed for NPL listing; under public comment review' },
  D: { label: 'Deleted', desc: 'Removed from NPL after cleanup goals were met' },
  R: { label: 'Removed', desc: 'Removed from proposed NPL listing' },
  W: { label: 'Withdrawn', desc: 'Proposed for NPL but later withdrawn before listing' },
  N: { label: 'Not on NPL', desc: 'Evaluated but not currently on the National Priorities List' },
  I: { label: 'Tribal Land', desc: 'Site located on or affecting tribal lands' },
}

// Easter egg: tag the address pin with a friendly name when the searched
// address matches a known location. Each entry's `match` predicate runs
// against a normalized lowercase version of the address.
const ADDRESS_NICKNAMES: { nickname: string; match: (norm: string) => boolean }[] = [
  {
    nickname: "Harlow's Place",
    // 50 East 16th Street, Chicago, IL 60616
    match: (n) =>
      /(^|\s)50(\s|$)/.test(n) &&
      /\b(e|east)\b/.test(n) &&
      /\b16(th)?\s*(st|street)\b/.test(n) &&
      (/\bchicago\b/.test(n) || /\b60616\b/.test(n)),
  },
  {
    nickname: "Ryder's Place",
    // 4245 Persimmon Road, Lancaster, SC 29720
    match: (n) =>
      /(^|\s)4245(\s|$)/.test(n) &&
      /\bpersimmon\b/.test(n) &&
      /\b(rd|road)\b/.test(n) &&
      (/\blancaster\b/.test(n) || /\b29720\b/.test(n)),
  },
]

function addressNickname(address: string): string | null {
  const norm = address.toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()
  for (const entry of ADDRESS_NICKNAMES) {
    if (entry.match(norm)) return entry.nickname
  }
  return null
}

function homeTooltipHtml(address: string): string {
  const escapeHtml = (s: string) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  const nickname = addressNickname(address)
  const addr = escapeHtml(address)
  if (!nickname) return addr
  return `<strong>${escapeHtml(nickname)}</strong><br/>${addr}`
}

// Superfund details are now rendered in the analysis flyout
// (analysisDetail === 'superfunds'), not in the map hover tooltip.
// The map tooltip is just the site name.



const SHARE_LAYER_IDS = ['noise', 'superfund', 'flood', 'wildfire', 'aqi', 'transit', 'traffic', 'costco', 'datacenters', 'power', 'ems', 'crowd', 'cameras', 'industrial'] as const

type LayerStateSnapshot = {
  noise: boolean
  superfund: boolean
  flood: boolean
  wildfire: boolean
  aqi: boolean
  transit: boolean
  traffic: boolean
  costco: boolean
  datacenters: boolean
  power: boolean
  ems: boolean
  crowd: boolean
  cameras: boolean
  industrial: boolean
}

const LAYER_OFF: LayerStateSnapshot = {
  noise: false, superfund: false, flood: false, wildfire: false, aqi: false, transit: false, traffic: false,
  costco: false, datacenters: false, power: false, ems: false, crowd: false, cameras: false, industrial: false,
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
const SUPERFUND_ANALYSIS_RADIUS_MI = 3

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
  broadband?: BroadbandResponse | null
  broadbandLoading?: boolean
}): { letter: string; color: string; severity: SeverityLevel; pct: number; breakdown: { label: string; icon: string; score: number; max: number; detail: string; tier: 'safety' | 'lifestyle' | 'convenience' }[] } {
  const breakdown: { label: string; icon: string; score: number; max: number; detail: string; tier: 'safety' | 'lifestyle' | 'convenience' }[] = []

  // Tiered weighting (introduced 2026-06-04):
  //   Safety     — Noise, Superfund, ER       — max 3 each
  //   Lifestyle  — Data Centers, Crowd, Bband — max 2 each
  //   Convenience — Costco                    — max 1
  // Total possible penalty = 16. A=≤10% / B=≤25% / C=≤50% / D=≤75% / F=>75%.

  // --- SAFETY (max 3) ---

  // Noise: 0 = none, 2 = moderate (<65), 3 = high (65+)
  let noiseScore = 0
  let noiseDetail = 'No airport noise detected'
  if (results.noiseLevel) {
    if (results.noiseLevel < 65) { noiseScore = 2; noiseDetail = `~${results.noiseLevel} dB DNL (moderate)` }
    else { noiseScore = 3; noiseDetail = `~${results.noiseLevel} dB DNL (high)` }
  }
  breakdown.push({ label: 'Airport Noise', icon: '✈️', score: noiseScore, max: 3, detail: noiseDetail, tier: 'safety' })

  // Superfund: clear=0, warning=2, danger=3
  const sfSev = superfundSeverity(results.superfunds)
  const sfScore = sfSev === 'clear' ? 0 : sfSev === 'warning' ? 2 : 3
  const sfDetail = results.superfunds.length === 0 ? `None within ${SUPERFUND_ANALYSIS_RADIUS_MI} mi`
    : `${results.superfunds.length} site${results.superfunds.length > 1 ? 's' : ''} (${results.superfunds.filter(s => s.status !== 'Deleted').length} active)`
  breakdown.push({ label: 'Superfund Sites', icon: '☢️', score: sfScore, max: 3, detail: sfDetail, tier: 'safety' })

  // Emergency Room: good/clear=0, warning=2, danger=3
  const erDist = results.nearestER?.distanceMi ?? null
  const erSev = erSeverity(erDist)
  const erScore = (erSev === 'clear' || erSev === 'good') ? 0 : erSev === 'warning' ? 2 : 3
  const erDetail = erDist !== null ? `${erDist} mi away` : 'None found within search area'
  breakdown.push({ label: 'Emergency Room', icon: '🏥', score: erScore, max: 3, detail: erDetail, tier: 'safety' })

  // --- LIFESTYLE (max 2) ---

  // Data centers: clear=0, warning=1, danger=2
  const dcSev = dataCenterSeverity(results.dataCenters.length)
  const dcScore = dcSev === 'clear' ? 0 : dcSev === 'warning' ? 1 : 2
  const dcDetail = results.dataCenters.length === 0 ? 'None nearby' : `${results.dataCenters.length} nearby`
  breakdown.push({ label: 'Data Centers', icon: '🏢', score: dcScore, max: 2, detail: dcDetail, tier: 'lifestyle' })

  // Crowd magnets: clear=0, warning=1, danger=2
  const cmCount = results.crowdMagnets.length
  const cmSev = crowdMagnetsSeverity(cmCount)
  const cmScore = cmSev === 'clear' ? 0 : cmSev === 'warning' ? 1 : 2
  const cmDetail = cmCount === 0
    ? `None within ${CROWD_ANALYSIS_RADIUS_MI} mi`
    : `${cmCount} within ${CROWD_ANALYSIS_RADIUS_MI} mi`
  breakdown.push({ label: 'Crowd Magnets', icon: '🎟️', score: cmScore, max: 2, detail: cmDetail, tier: 'lifestyle' })

  // Broadband: good/clear=0, warning=1, danger=2
  // Skip entirely while still loading (so the grade isn't artificially
  // penalized before broadband resolves). If broadband resolved but returned
  // no summary (block-only fallback or no data), include it as 0 with a
  // "data not available" note so it stays neutral.
  if (!results.broadbandLoading) {
    const bbSummary = results.broadband?.summary ?? null
    const bbSev = broadbandSeverity(bbSummary?.speedTier)
    const bbScore = (bbSev === 'clear' || bbSev === 'good') ? 0 : bbSev === 'warning' ? 1 : 2
    let bbDetail = 'No data available'
    if (bbSummary) {
      const speed = formatBroadbandSpeed(bbSummary.maxDownMbps)
      bbDetail = `${speed} down · ${bbSummary.providerCount} ${bbSummary.providerCount === 1 ? 'provider' : 'providers'}${bbSummary.hasFiber ? ' · fiber' : ''}`
    }
    breakdown.push({ label: 'Broadband', icon: '📶', score: bbScore, max: 2, detail: bbDetail, tier: 'lifestyle' })
  }

  // --- CONVENIENCE (max 1) ---

  // Costco: good=0, warning=0, danger=1. Only the worst case (no Costco
  // within range, or search timed out) costs a point. Skipped while loading
  // so the grade isn't artificially penalized.
  if (!results.costcoLoading) {
    let costcoScore = 0
    let costcoDetail: string
    if (!results.costco) {
      costcoScore = 1
      costcoDetail = results.costcoError ? 'Search timed out' : 'None within range'
    } else {
      const cs = costcoSeverity(results.costco.distanceMi)
      costcoScore = cs === 'danger' ? 1 : 0
      costcoDetail = `${results.costco.distanceMi} mi away`
    }
    breakdown.push({ label: 'Nearest Costco', icon: '🛒', score: costcoScore, max: 1, detail: costcoDetail, tier: 'convenience' })
  }

  const total = breakdown.reduce((a, b) => a + b.score, 0)
  const max = breakdown.reduce((a, b) => a + b.max, 0)

  const pct = max > 0 ? 1 - total / max : 1
  if (pct >= 0.9) return { letter: 'A', color: '#4caf50', severity: 'clear', pct, breakdown }
  if (pct >= 0.75) return { letter: 'B', color: '#8bc34a', severity: 'good', pct, breakdown }
  if (pct >= 0.5) return { letter: 'C', color: '#ffb300', severity: 'warning', pct, breakdown }
  if (pct >= 0.25) return { letter: 'D', color: '#ff7043', severity: 'warning', pct, breakdown }
  return { letter: 'F', color: '#ef5350', severity: 'danger', pct, breakdown }
}

// leaflet.markercluster is a side-effect plugin that extends the L.* namespace.
// Defer loading it until a layer that needs clustering is enabled, so it
// doesn't sit in the initial MapPage chunk for users who never toggle a
// cluster layer. The promise is cached so subsequent calls are free.
let markerClusterPromise: Promise<void> | null = null
function ensureMarkerCluster(): Promise<void> {
  if (!markerClusterPromise) {
    markerClusterPromise = import('leaflet.markercluster').then(() => undefined)
  }
  return markerClusterPromise
}

async function createClusterGroup(color?: string): Promise<L.MarkerClusterGroup> {
  await ensureMarkerCluster()
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

// Camera marker — a colored chip with a camera glyph. Larger than the
// transit dots so the icon is legible, but still small enough to cluster
// gracefully in dense areas (Atlanta returns 500+ in one bbox).
function makeCameraIcon(color: string, direction?: string): L.DivIcon {
  const size = 24
  const rotation = direction && /^-?\d+(\.\d+)?$/.test(direction) ? Number(direction) : null
  const arrow = rotation !== null
    ? `<span class="camera-pin-arrow" style="transform:rotate(${rotation}deg)"></span>`
    : ''
  return L.divIcon({
    className: 'camera-marker',
    html:
      `<div class="camera-pin" style="background:${color}">` +
      `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">` +
      `<path fill="#fff" d="M9.4 5l-1.5 2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2.9l-1.5-2H9.4zm2.6 4a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/>` +
      `</svg>` +
      arrow +
      `</div>`,
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
  const floodLayerRef = useRef<L.GeoJSON | null>(null)
  const floodLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const aqiLayerRef = useRef<L.GeoJSON | null>(null)
  const aqiLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const powerLineLayerRef = useRef<L.GeoJSON | null>(null)
  const powerLineLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const industrialLayerRef = useRef<L.LayerGroup | null>(null)
  // Tracks the L.LatLng we last fetched facilities for. When the searched
  // address changes (or the user re-enables the layer for a new target)
  // this ref is reset so loadIndustrialData refetches.
  const industrialFetchedKeyRef = useRef<string | null>(null)
  const wildfireLayerRef = useRef<L.ImageOverlay | null>(null)
  const wildfireRenderedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const transitLayerRef = useRef<L.LayerGroup | null>(null)
  const transitLineLayersRef = useRef<Record<'rail' | 'subway' | 'tram' | 'bus', L.LayerGroup> | null>(null)
  const transitLinesLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const transitLinesKnownIdsRef = useRef<Set<string>>(new Set())
  const transitLinesLoadingRef = useRef(false)
  const busLinesLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const busLinesKnownIdsRef = useRef<Set<string>>(new Set())
  const busLinesLoadingRef = useRef(false)
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
  // Analysis-highlight layer groups: one persistent L.layerGroup per category
  // that holds only the items the analysis explicitly called out. Lives on the
  // map independently of the user-toggleable main layers, so the "Map Layers"
  // checkboxes stay user-controlled while the analysis still gets a visual
  // representation. Re-populated on every successful analysis run.
  const superfundAnalysisLayerRef = useRef<L.LayerGroup | null>(null)
  const costcoAnalysisLayerRef = useRef<L.LayerGroup | null>(null)
  const dataCenterAnalysisLayerRef = useRef<L.LayerGroup | null>(null)
  const crowdAnalysisLayerRef = useRef<L.LayerGroup | null>(null)
  const nearestErMarkerRef = useRef<L.Marker | null>(null)
  const targetLocationRef = useRef<L.LatLng | null>(null)
  const homeMarkerRef = useRef<L.Marker | null>(null)
  const transitStopsKnownIdsRef = useRef<Set<string>>(new Set())
  const transitStopsLoadingRef = useRef(false)
  const transitBusStopsLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  // ALPR camera layer (Flock + other manufacturers) — sourced from OSM via
  // the DeFlock crowdsourcing project. Single cluster, no sub-types.
  const camerasLayerRef = useRef<L.LayerGroup | null>(null)
  const camerasLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const camerasKnownIdsRef = useRef<Set<string>>(new Set())
  const camerasLoadingRef = useRef(false)
  const initialUrlStateAppliedRef = useRef(false)
  // Monotonic counter so an in-flight analysis can detect that the user has
  // since kicked off a newer one and silently discard its (now-stale) results.
  const analysisRunIdRef = useRef(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [noiseVisible, setNoiseVisible] = useState(false)
  const [superfundVisible, setSuperfundVisible] = useState(false)
  const [superfundLoading, setSuperfundLoading] = useState(false)
  const [floodVisible, setFloodVisible] = useState(false)
  const [floodLoading, setFloodLoading] = useState(false)
  const [floodLowZoom, setFloodLowZoom] = useState(false)
  const [aqiVisible, setAqiVisible] = useState(false)
  const [aqiLoading, setAqiLoading] = useState(false)
  const [aqiLowZoom, setAqiLowZoom] = useState(false)
  const [aqiTimestamp, setAqiTimestamp] = useState<number | null>(null)
  const [powerLineVisible, setPowerLineVisible] = useState(false)
  const [powerLineLoading, setPowerLineLoading] = useState(false)
  const [powerLineLowZoom, setPowerLineLowZoom] = useState(false)
  const [industrialVisible, setIndustrialVisible] = useState(false)
  const [industrialLoading, setIndustrialLoading] = useState(false)
  const [industrialNeedsAddress, setIndustrialNeedsAddress] = useState(false)
  const [wildfireVisible, setWildfireVisible] = useState(false)
  const [wildfireLoading, setWildfireLoading] = useState(false)
  const [wildfireLowZoom, setWildfireLowZoom] = useState(false)
  const [transitVisible, setTransitVisible] = useState(false)
  const [transitLoading, setTransitLoading] = useState(false)
  const [transitStatus, setTransitStatus] = useState<{ kind: 'loading' | 'error'; text: string } | null>(null)
  const transitInitRunIdRef = useRef(0)
  const [transitSubVisible, setTransitSubVisible] = useState<Record<TransitStop['type'], boolean>>({
    rail: true, subway: true, tram: true, bus: false,
  })
  const transitSubVisibleRef = useRef(transitSubVisible)
  const [costcoVisible, setCostcoVisible] = useState(false)
  const [trafficVisible, setTrafficVisible] = useState(false)
  const [dataCenterVisible, setDataCenterVisible] = useState(false)
  const [emsVisible, setEmsVisible] = useState(false)
  const [emsLoading, setEmsLoading] = useState(false)
  const [crowdVisible, setCrowdVisible] = useState(false)
  const [crowdLoading, setCrowdLoading] = useState(false)
  const [camerasVisible, setCamerasVisible] = useState(false)
  const [camerasLoading, setCamerasLoading] = useState(false)
  const [camerasStatus, setCamerasStatus] = useState<{ kind: 'loading' | 'error' | 'empty'; text: string } | null>(null)
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
    superfunds: { name: string; distanceMi: number; status: string; statusCode: string; city: string; epaId: string; url: string; lat: number; lng: number }[]
    costco: { osmId: string; name: string; city: string; address: string; distanceMi: number; lat: number; lng: number } | null
    costcoNearby: { osmId: string; name: string; city: string; address: string; distanceMi: number; lat: number; lng: number }[]
    costcoNearestBeyond: { osmId: string; name: string; city: string; address: string; distanceMi: number; lat: number; lng: number } | null
    costcoError: boolean
    costcoLoading: boolean
    dataCenters: { name: string; city: string; state: string; distanceMi: number; status: string; operator: string; mw: string; sizerank: string; lat: number; lng: number }[]
    nearestER: { name: string; address: string; distanceMi: number; lat: number; lng: number } | null
    erError: boolean
    crowdMagnets: { id: string; name: string; type: CrowdType; distanceMi: number; lat: number; lng: number }[]
    broadband: BroadbandResponse | null
    broadbandLoading: boolean
  }>({ loading: true, noiseLevel: null, noiseAirport: null, noiseAirportCode: null, superfunds: [], costco: null, costcoNearby: [], costcoNearestBeyond: null, costcoError: false, costcoLoading: true, dataCenters: [], nearestER: null, erError: false, crowdMagnets: [], broadband: null, broadbandLoading: true })
  const [analysisProgress, setAnalysisProgress] = useState<Record<string, 'pending' | 'done'>>({})
  const [analysisDetail, setAnalysisDetail] = useState<'noise' | 'superfunds' | 'costco' | 'datacenters' | 'er' | 'score' | 'crowd' | 'broadband' | null>(null)

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
  const [analysisPanelOpen, setAnalysisPanelOpen] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia('(min-width: 769px)').matches
  })
  const [showAbout, setShowAbout] = useState(false)

  // Mobile bottom sheet drag state
  const sheetRef = useRef<HTMLElement>(null)
  const sheetDragRef = useRef<{ startY: number; startH: number } | null>(null)
  const [sheetHeight, setSheetHeight] = useState<number | null>(null)
  const SHEET_SNAP_PEEK = 15  // vh
  const SHEET_SNAP_HALF = 50
  const SHEET_SNAP_FULL = 85

  // Generic swipe-to-dismiss for the layer panel (single snap point at 0).
  // Translates the sheet down with the user's finger; on release, dismisses
  // if dragged past 25% of its own height or thrown with high velocity.
  const layerSheetRef = useRef<HTMLElement>(null)
  const layerDragRef = useRef<{ startY: number; startT: number } | null>(null)
  const handleLayerTouchStart = useCallback((e: React.TouchEvent) => {
    layerDragRef.current = { startY: e.touches[0].clientY, startT: Date.now() }
  }, [])
  const handleLayerTouchMove = useCallback((e: React.TouchEvent) => {
    const drag = layerDragRef.current
    if (!drag) return
    const dy = e.touches[0].clientY - drag.startY
    if (dy <= 0) {
      if (layerSheetRef.current) layerSheetRef.current.style.transform = ''
      return
    }
    if (layerSheetRef.current) {
      layerSheetRef.current.style.transition = 'none'
      layerSheetRef.current.style.transform = `translateY(${dy}px)`
    }
  }, [])
  const handleLayerTouchEnd = useCallback((e: React.TouchEvent) => {
    const drag = layerDragRef.current
    if (!drag) return
    const dy = e.changedTouches[0].clientY - drag.startY
    const dt = Date.now() - drag.startT
    const velocity = dy / Math.max(dt, 1) // px/ms downward
    const h = layerSheetRef.current?.getBoundingClientRect().height ?? 1
    layerDragRef.current = null
    if (layerSheetRef.current) {
      layerSheetRef.current.style.transition = ''
      layerSheetRef.current.style.transform = ''
    }
    if (dy > h * 0.25 || velocity > 0.6) {
      setLayerPanelOpen(false)
    }
  }, [])

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

  // The experimental menu is gated so casual visitors never see the trigger.
  // Two ways to unlock (persists in localStorage as `lr_exp_unlock`):
  //   1. Visit any URL with `?dev=1` once. `?dev=0` re-locks.
  //   2. Tap the (invisible) trigger spot 5 times within 2 seconds.
  // This is obscurity, not real security — any determined user can flip the
  // localStorage value in DevTools. The goal is to keep the menu invisible
  // to random visitors of the production site.
  const [expUnlocked, setExpUnlocked] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try {
      const params = new URLSearchParams(window.location.search)
      const dev = params.get('dev')
      if (dev === '1') {
        window.localStorage.setItem('lr_exp_unlock', '1')
        return true
      }
      if (dev === '0') {
        window.localStorage.removeItem('lr_exp_unlock')
        return false
      }
      return window.localStorage.getItem('lr_exp_unlock') === '1'
    } catch {
      return false
    }
  })
  const unlockTapsRef = useRef<{ count: number; firstAt: number }>({ count: 0, firstAt: 0 })

  // Strip the `dev` param from the URL after we've consumed it so it isn't
  // accidentally shared via the address bar / share sheet.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.has('dev')) {
      params.delete('dev')
      const qs = params.toString()
      const newUrl = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash
      window.history.replaceState({}, '', newUrl)
    }
  }, [])

  const handleExpTriggerClick = useCallback(() => {
    if (expUnlocked) {
      setExpMenuOpen((v) => !v)
      return
    }
    const now = Date.now()
    const state = unlockTapsRef.current
    if (now - state.firstAt > 2000) {
      state.count = 1
      state.firstAt = now
    } else {
      state.count += 1
    }
    if (state.count >= 5) {
      try { window.localStorage.setItem('lr_exp_unlock', '1') } catch { /* private mode */ }
      setExpUnlocked(true)
      setExpMenuOpen(true)
      state.count = 0
      state.firstAt = 0
      console.info('[LandRecon] Experimental menu unlocked. Visit /?dev=0 to re-lock.')
    }
  }, [expUnlocked])

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
      if (analysisPanelOpen) {
        setAnalysisPanelOpen(false)
        return
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [shareModalOpen, analysisDetail, expMenuOpen, layerPanelOpen, analysisPanelOpen, devTodosOpen])

  // Show FAB tooltip hints once on mobile, dismiss on first tap
  const buildShareUrl = useCallback((): string => {
    const params = new URLSearchParams()
    if (address) params.set('address', address)
    const active: ShareLayerId[] = []
    if (noiseVisible) active.push('noise')
    if (superfundVisible) active.push('superfund')
    if (floodVisible) active.push('flood')
    if (wildfireVisible) active.push('wildfire')
    if (aqiVisible) active.push('aqi')
    if (transitVisible) active.push('transit')
    if (trafficVisible) active.push('traffic')
    if (costcoVisible) active.push('costco')
    if (dataCenterVisible) active.push('datacenters')
    if (powerLineVisible) active.push('power')
    if (emsVisible) active.push('ems')
    if (crowdVisible) active.push('crowd')
    if (camerasVisible) active.push('cameras')
    if (industrialVisible) active.push('industrial')
    if (active.length > 0) params.set('layers', active.join(','))
    if (activeBaseMap !== 'street') params.set('base', activeBaseMap)
    return `${window.location.origin}/map?${params.toString()}`
  }, [address, noiseVisible, superfundVisible, floodVisible, wildfireVisible, aqiVisible, transitVisible, trafficVisible, costcoVisible, dataCenterVisible, powerLineVisible, emsVisible, crowdVisible, camerasVisible, industrialVisible, activeBaseMap])

  const handleShare = useCallback(() => {
    const url = buildShareUrl()
    setShareModalOpen(true)
    setShareLoading(false)
    setShareError(null)
    setShareCopied(false)
    setShareLongUrl(url)
    setShareUrl(url)
    trackEvent('share_click', {
      layer_count: [noiseVisible, superfundVisible, floodVisible, wildfireVisible, aqiVisible, transitVisible, trafficVisible, costcoVisible, dataCenterVisible, powerLineVisible, emsVisible, crowdVisible, camerasVisible, industrialVisible].filter(Boolean).length,
    })
  }, [buildShareUrl, noiseVisible, superfundVisible, floodVisible, wildfireVisible, aqiVisible, transitVisible, trafficVisible, costcoVisible, dataCenterVisible, powerLineVisible, emsVisible, crowdVisible, industrialVisible])

  // GA4: emit one `layer_toggle` event per layer that changed state since
  // the last render. Keeps the analytics call sites out of every toggle
  // handler and is robust to new toggle paths (presets, share-link replay).
  const prevLayerStateRef = useRef<Record<string, boolean>>({
    noise: noiseVisible,
    superfund: superfundVisible,
    flood: floodVisible,
    wildfire: wildfireVisible,
    aqi: aqiVisible,
    transit: transitVisible,
    traffic: trafficVisible,
    costco: costcoVisible,
    datacenters: dataCenterVisible,
    power: powerLineVisible,
    ems: emsVisible,
    crowd: crowdVisible,
    cameras: camerasVisible,
    industrial: industrialVisible,
  })
  useEffect(() => {
    const next: Record<string, boolean> = {
      noise: noiseVisible,
      superfund: superfundVisible,
      flood: floodVisible,
      wildfire: wildfireVisible,
      aqi: aqiVisible,
      transit: transitVisible,
      traffic: trafficVisible,
      costco: costcoVisible,
      datacenters: dataCenterVisible,
      power: powerLineVisible,
      ems: emsVisible,
      crowd: crowdVisible,
      cameras: camerasVisible,
      industrial: industrialVisible,
    }
    const prev = prevLayerStateRef.current
    for (const k of Object.keys(next)) {
      if (prev[k] !== next[k]) {
        trackEvent('layer_toggle', { layer: k, action: next[k] ? 'on' : 'off' })
      }
    }
    prevLayerStateRef.current = next
  }, [noiseVisible, superfundVisible, floodVisible, wildfireVisible, aqiVisible, transitVisible, trafficVisible, costcoVisible, dataCenterVisible, powerLineVisible, emsVisible, crowdVisible, camerasVisible, industrialVisible])

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

  // Native Web Share — only available on secure contexts with a system
  // share sheet (iOS Safari, most modern Android Chromes). Silently ignore
  // user-cancellation; report any other error as a fallback to copy.
  const handleNativeShare = useCallback(async () => {
    const value = shareUrl || shareLongUrl
    if (!value || typeof navigator.share !== 'function') return
    try {
      await navigator.share({
        title: 'Land Recon',
        text: address ? `Land Recon — ${address}` : 'Land Recon map view',
        url: value,
      })
      trackEvent('share_native', { result: 'success' })
    } catch (err) {
      // AbortError = user cancelled; don't surface that as an error.
      if (err instanceof Error && err.name !== 'AbortError') {
        trackEvent('share_native', { result: 'error' })
        setShareError('Native share failed — copy the link instead.')
      }
    }
  }, [shareUrl, shareLongUrl, address])

  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  const closeShareModal = useCallback(() => {
    setShareModalOpen(false)
    setShareCopied(false)
    setShareError(null)
  }, [])

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

  // Center the map on a single target — removed for now; the in-flyout
  // "Show on map" buttons it powered were taken out pending a cleaner mobile
  // UX (the analysis popout is fullscreen on phones, so flying the map
  // underneath an opaque sheet felt broken).

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
    dbg('geocode', 'useMyLocation: requesting browser position…')
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords
          dbg('geocode', `useMyLocation: got coords ${latitude.toFixed(4)},${longitude.toFixed(4)}`)
          let resolved: string | null = null
          if (TOMTOM_API_KEY) {
            // countrySet=US makes TomTom return zero addresses for
            // coordinates outside the US so we can fail fast instead of
            // resolving a foreign address that will then fail the main
            // (US-restricted) geocode anyway.
            const url = `https://api.tomtom.com/search/2/reverseGeocode/${latitude},${longitude}.json?key=${TOMTOM_API_KEY}&radius=100&countrySet=US`
            const res = await fetch(url)
            const data = await res.json()
            resolved = data?.addresses?.[0]?.address?.freeformAddress ?? null
            dbg('geocode', `useMyLocation: reverseGeocode(US) ${resolved ? 'resolved to "' + resolved + '"' : 'returned no US address'}`)
          }
          setLocating(false)
          if (!resolved) {
            dbg('geocode', 'useMyLocation: refusing — no US address at those coords')
            setErrorMsg('Land Recon currently supports US addresses only.')
            return
          }
          submitAddressChange(resolved)
        } catch (err) {
          dbg('geocode', 'useMyLocation: reverseGeocode threw', err)
          setLocating(false)
        }
      },
      (err) => {
        dbg('geocode', 'useMyLocation: geolocation rejected', err)
        setLocating(false)
      },
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
      dbg('costco', `Got ${places.length} warehouse(s) in current bounds`)
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

  // FEMA NFHL polygons. Only fetched when zoomed in past FLOOD_MIN_ZOOM —
  // the dataset is huge nationally and the API rejects/truncates very
  // large envelopes anyway. Loaded geometry is cached against a padded
  // bbox so panning within the cached extent skips re-fetch.
  const loadFloodData = useCallback(async (map: L.Map, layer: L.GeoJSON) => {
    if (map.getZoom() < FLOOD_MIN_ZOOM) {
      dbg('flood', `Skipping — zoom ${map.getZoom()} < ${FLOOD_MIN_ZOOM}`)
      setFloodLowZoom(true)
      layer.clearLayers()
      floodLoadedBoundsRef.current = null
      return
    }
    setFloodLowZoom(false)
    const bounds = map.getBounds()
    const loaded = floodLoadedBoundsRef.current
    if (loaded && loaded.contains(bounds)) { dbg('flood', 'Skipping — bounds already loaded'); return }
    dbg('flood', 'Loading FEMA flood zones…')

    setFloodLoading(true)
    try {
      const padded = bounds.pad(0.3)
      const geojson = await fetchFloodFeatures(padded)
      dbg('flood', `Got ${geojson.features?.length || 0} features`)
      layer.clearLayers()
      layer.addData(geojson)
      floodLoadedBoundsRef.current = padded
    } catch (err) {
      console.error('Failed to load FEMA flood zones:', err)
    } finally {
      setFloodLoading(false)
    }
  }, [])

  // EPA AirNow contour polygons (combined Ozone + PM2.5). Coarse hourly
  // contours that look great even at low zoom — useful for regional smoke
  // / dust events. Cached against a padded bbox so panning within the
  // cached extent skips re-fetch.
  const loadAqiData = useCallback(async (map: L.Map, layer: L.GeoJSON) => {
    if (map.getZoom() < AQI_MIN_ZOOM) {
      dbg('aqi', `Skipping — zoom ${map.getZoom()} < ${AQI_MIN_ZOOM}`)
      setAqiLowZoom(true)
      layer.clearLayers()
      aqiLoadedBoundsRef.current = null
      return
    }
    setAqiLowZoom(false)
    const bounds = map.getBounds()
    const loaded = aqiLoadedBoundsRef.current
    if (loaded && loaded.contains(bounds)) { dbg('aqi', 'Skipping — bounds already loaded'); return }
    dbg('aqi', 'Loading AirNow AQI contours…')

    setAqiLoading(true)
    try {
      const padded = bounds.pad(0.3)
      const geojson = await fetchAqiFeatures(padded)
      dbg('aqi', `Got ${geojson.features?.length || 0} features`)
      layer.clearLayers()
      layer.addData(geojson)
      aqiLoadedBoundsRef.current = padded
      // Pick the most recent Timestamp value off any feature; the contour
      // dataset is published as a single hourly snapshot so all features
      // share the same Timestamp, but be defensive.
      let latest: number | null = null
      for (const f of geojson.features || []) {
        const ts = (f.properties as Record<string, unknown> | null)?.Timestamp
        if (typeof ts === 'number' && (latest === null || ts > latest)) latest = ts
      }
      if (latest !== null) setAqiTimestamp(latest)
    } catch (err) {
      console.error('Failed to load AirNow AQI contours:', err)
    } finally {
      setAqiLoading(false)
    }
  }, [])

  // HIFLD transmission lines. Same gating pattern as flood — zoom check,
  // padded-bbox cache, fast-path skip when the new viewport is already
  // covered by the previously loaded extent.
  const loadPowerLineData = useCallback(async (map: L.Map, layer: L.GeoJSON) => {
    if (map.getZoom() < POWER_MIN_ZOOM) {
      dbg('power', `Skipping — zoom ${map.getZoom()} < ${POWER_MIN_ZOOM}`)
      setPowerLineLowZoom(true)
      layer.clearLayers()
      powerLineLoadedBoundsRef.current = null
      return
    }
    setPowerLineLowZoom(false)
    const bounds = map.getBounds()
    const loaded = powerLineLoadedBoundsRef.current
    if (loaded && loaded.contains(bounds)) { dbg('power', 'Skipping — bounds already loaded'); return }
    dbg('power', 'Loading transmission lines…')

    setPowerLineLoading(true)
    try {
      const padded = bounds.pad(0.3)
      const geojson = await fetchPowerLineFeatures(padded)
      dbg('power', `Got ${geojson.features?.length || 0} features`)
      layer.clearLayers()
      layer.addData(geojson)
      powerLineLoadedBoundsRef.current = padded
    } catch (err) {
      console.error('Failed to load HIFLD transmission lines:', err)
    } finally {
      setPowerLineLoading(false)
    }
  }, [])

  const loadIndustrialData = useCallback(async (layer: L.LayerGroup) => {
    const target = targetLocationRef.current
    if (!target) {
      dbg('industrial', 'Skipping — no searched address yet')
      setIndustrialNeedsAddress(true)
      layer.clearLayers()
      industrialFetchedKeyRef.current = null
      return
    }
    setIndustrialNeedsAddress(false)
    const key = `${target.lat.toFixed(5)},${target.lng.toFixed(5)}`
    if (industrialFetchedKeyRef.current === key) {
      dbg('industrial', 'Skipping — already loaded for this address')
      return
    }
    dbg('industrial', `Loading EPA TRI facilities within ${INDUSTRIAL_RADIUS_MI} mi of ${key}…`)

    setIndustrialLoading(true)
    try {
      const facilities = await fetchIndustrialFacilities(target, INDUSTRIAL_RADIUS_MI)
      dbg('industrial', `Got ${facilities.length} facilities`)
      layer.clearLayers()
      for (const f of facilities) {
        const icon = L.divIcon({
          className: 'industrial-label',
          html: `<div class="industrial-pin" style="background:${f.industry.color}">${f.industry.icon}</div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        })
        const marker = L.marker([f.lat, f.lng], { icon })
        const tooltipLines = [
          `<strong>${f.name}</strong>`,
          `${f.industry.label} · ${f.distanceMi.toFixed(1)} mi`,
        ]
        if (f.city || f.state) {
          tooltipLines.push([f.city, f.state].filter(Boolean).join(', '))
        }
        marker.bindTooltip(tooltipLines.join('<br/>'), { direction: 'top', offset: [0, -14] })
        const industryBadge = `<span style="display:inline-block;padding:1px 6px;border-radius:3px;background:${f.industry.color};color:#fff;font-size:11px;font-weight:600">${f.industry.label}</span>`
        const distanceBadge = `<span style="display:inline-block;padding:1px 6px;margin-left:4px;border-radius:3px;background:#eceff1;color:#37474f;font-size:11px;font-weight:600">${f.distanceMi.toFixed(1)} mi</span>`
        const addrParts = [f.address, [f.city, f.state].filter(Boolean).join(', ')].filter(Boolean)
        const addrHtml = addrParts.length ? `<div style="font-size:12px;color:#555;margin-top:4px">${addrParts.join('<br/>')}</div>` : ''
        const releaseHtml = (f.totalReleasesLb != null && f.reportingYear)
          ? `<div style="font-size:11px;color:#666;margin-top:4px">${f.totalReleasesLb.toLocaleString()} lb total TRI releases (${f.reportingYear})</div>`
          : ''
        const linkHtml = f.facUrl
          ? `<div style="margin-top:6px"><a href="${f.facUrl}" target="_blank" rel="noopener noreferrer" style="font-size:12px">EPA facility report ↗</a></div>`
          : ''
        marker.bindPopup(
          `<div style="min-width:200px;max-width:280px">
             <div style="font-weight:700;font-size:13px;margin-bottom:4px">${f.name}</div>
             <div>${industryBadge}${distanceBadge}</div>
             ${addrHtml}
             ${releaseHtml}
             ${linkHtml}
           </div>`,
          { maxWidth: 320 },
        )
        marker.addTo(layer)
      }
      industrialFetchedKeyRef.current = key
    } catch (err) {
      console.error('Failed to load EPA TRI industrial facilities:', err)
    } finally {
      setIndustrialLoading(false)
    }
  }, [])

  // USFS wildfire-hazard raster. Implemented as an L.ImageOverlay backed
  // by ImageServer.exportImage so we get the canonical USFS color ramp
  // baked into the PNG. We rebuild the overlay on every moveend — the
  // ArcGIS endpoint is CDN-cached so repeat viewports are essentially
  // free, and re-using a single ImageOverlay would require recomputing
  // its bounds anyway.
  const loadWildfireData = useCallback((map: L.Map) => {
    if (map.getZoom() < WHP_MIN_ZOOM) {
      dbg('wildfire', `Skipping — zoom ${map.getZoom()} < ${WHP_MIN_ZOOM}`)
      setWildfireLowZoom(true)
      if (wildfireLayerRef.current) {
        map.removeLayer(wildfireLayerRef.current)
        wildfireLayerRef.current = null
      }
      wildfireRenderedBoundsRef.current = null
      return
    }
    setWildfireLowZoom(false)

    const bounds = map.getBounds()
    const last = wildfireRenderedBoundsRef.current
    if (last && last.equals(bounds, 1e-6)) {
      dbg('wildfire', 'Skipping — bounds unchanged')
      return
    }

    const size = map.getSize()
    // Cap the request resolution above the source raster's useful zoom —
    // anything sharper is just upsampled pixel noise.
    const zoom = Math.min(map.getZoom(), WHP_MAX_USEFUL_ZOOM)
    const scale = zoom < map.getZoom() ? Math.pow(2, zoom - map.getZoom()) : 1
    const url = buildWhpImageUrl(bounds, size.x * scale, size.y * scale)

    setWildfireLoading(true)
    const overlay = L.imageOverlay(url, bounds, {
      opacity: 0.55,
      interactive: false,
      crossOrigin: 'anonymous',
      className: 'wildfire-overlay',
    })
    overlay.on('load', () => setWildfireLoading(false))
    overlay.on('error', () => {
      setWildfireLoading(false)
      dbg('wildfire', 'Image load failed')
    })

    if (wildfireLayerRef.current) {
      map.removeLayer(wildfireLayerRef.current)
    }
    overlay.addTo(map)
    wildfireLayerRef.current = overlay
    wildfireRenderedBoundsRef.current = bounds
  }, [])

  const loadTransitData = useCallback(async (map: L.Map, layer: L.LayerGroup): Promise<boolean> => {
    if (transitStopsLoadingRef.current) return true
    // Same gate as the line layer — at very low zoom the bbox is huge.
    if (map.getZoom() < 10) return true

    let bounds = map.getBounds().pad(0.3)
    const latSpan = bounds.getNorth() - bounds.getSouth()
    const lngSpan = bounds.getEast() - bounds.getWest()
    const MAX_SPAN_DEG = 0.4
    if (latSpan > MAX_SPAN_DEG || lngSpan > MAX_SPAN_DEG) {
      const c = map.getCenter()
      const half = MAX_SPAN_DEG / 2
      bounds = L.latLngBounds([c.lat - half, c.lng - half], [c.lat + half, c.lng + half])
    }

    const railLoaded = transitLoadedBoundsRef.current
    const busLoaded = transitBusStopsLoadedBoundsRef.current
    const needRail = !railLoaded || !railLoaded.contains(bounds)
    // Bus stops are very dense; only include them once the user has zoomed in
    // enough that the dots aren't a wall. The line layer uses the same gate.
    const needBus =
      transitSubVisibleRef.current.bus &&
      map.getZoom() >= 13 &&
      (!busLoaded || !busLoaded.contains(bounds))

    if (!needRail && !needBus) {
      dbg('transit', 'Skipping — bounds already loaded')
      return true
    }

    dbg('transit', `Loading transit stops (rail=${needRail}, bus=${needBus})…`)
    setTransitLoading(true)
    transitStopsLoadingRef.current = true
    let ok = true
    try {
      const sw = bounds.getSouthWest()
      const ne = bounds.getNorthEast()
      const bbox = `${sw.lat},${sw.lng},${ne.lat},${ne.lng}`

      // Rail/subway/tram: try snapshot first if in CONUS, fall back to live.
      // Bus: always live (snapshot intentionally excludes bus — too dense).
      const stops: Array<{ id: string; stop: { lat: number; lon: number; name: string; type: 'rail' | 'subway' | 'tram' | 'bus' } }> = []
      let railSource: 'snapshot' | 'live' | 'skipped' = 'skipped'
      if (needRail) {
        const center = map.getCenter()
        const conus = L.latLngBounds(CONUS_BOUNDS)
        let railStops: typeof stops = []
        if (conus.contains(center)) {
          const snap = await loadTransitStopsSnapshot()
          if (snap) {
            for (const s of snap.stops) {
              if (!bounds.contains([s.lat, s.lon] as L.LatLngTuple)) continue
              railStops.push({ id: s.id, stop: { lat: s.lat, lon: s.lon, name: s.name, type: s.type } })
            }
            railSource = 'snapshot'
            dbg('transit', `Stops snapshot match: ${railStops.length} rail/subway/tram in viewport (of ${snap.count} CONUS total)`)
          }
        }
        if (railSource !== 'snapshot') {
          railStops = await fetchStopsInWorker(bbox, { rail: true, bus: false })
          railSource = 'live'
        }
        stops.push(...railStops)
      }
      if (needBus) {
        const busStops = await fetchStopsInWorker(bbox, { rail: false, bus: true })
        stops.push(...busStops)
      }

      let subLayers = transitSubLayersRef.current
      if (!subLayers) {
        const [rail, subway, tram, bus] = await Promise.all([
          createClusterGroup(TRANSIT_COLORS.rail),
          createClusterGroup(TRANSIT_COLORS.subway),
          createClusterGroup(TRANSIT_COLORS.tram),
          createClusterGroup(TRANSIT_COLORS.bus),
        ])
        subLayers = { rail, subway, tram, bus }
        transitSubLayersRef.current = subLayers
        for (const t of Object.keys(subLayers) as TransitStop['type'][]) {
          if (transitSubVisibleRef.current[t]) {
            subLayers[t].addTo(layer)
          }
        }
      }

      const known = transitStopsKnownIdsRef.current
      let added = 0
      for (const { id, stop } of stops) {
        if (known.has(id)) continue
        known.add(id)
        const color = TRANSIT_COLORS[stop.type]
        const size = stop.type === 'bus' ? 10 : 14
        L.marker([stop.lat, stop.lon], { icon: makeDotIcon(color, size) })
          .bindPopup(transitPopup(stop), { maxWidth: 260 })
          .addTo(subLayers[stop.type])
        added++
      }

      if (needRail) {
        transitLoadedBoundsRef.current = railLoaded
          ? railLoaded.extend(bounds.getSouthWest()).extend(bounds.getNorthEast())
          : bounds
      }
      if (needBus) {
        transitBusStopsLoadedBoundsRef.current = busLoaded
          ? busLoaded.extend(bounds.getSouthWest()).extend(bounds.getNorthEast())
          : bounds
      }
      dbg('transit', `Added ${added} new stops (rail=${railSource}; total known: ${known.size})`)
    } catch (err) {
      console.error('Failed to load transit data:', err)
      ok = false
    } finally {
      transitStopsLoadingRef.current = false
      setTransitLoading(false)
    }
    return ok
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
      // Broadband isn't cached (server has its own 24h cache + lookup is cheap),
      // so it starts pending on cache hits and transitions to done when fetch lands.
      allDone['broadband'] = 'pending'
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
        broadband: null,
        broadbandLoading: true,
      })
      // Broadband is not stored in the cache (server has its own 24h cache
      // and the lookup is fast/cheap), so fire it independently on cache hits.
      fetchBroadband(lat, lng).then((bb) => {
        if (!isLatestRun()) {
          dbg('analysis', 'Stale run — discarding Broadband result (cache-hit path)')
          return
        }
        dbg('analysis', 'Broadband result:', bb?.summary
          ? `${bb.summary.providerCount} provider(s), max ${bb.summary.maxDownMbps ?? '?'} Mbps down`
          : bb?.block ? 'block-only (index not built)' : 'none')
        setAnalysisResults((prev) => ({ ...prev, broadband: bb, broadbandLoading: false }))
        setAnalysisProgress((prev) => ({ ...prev, broadband: 'done' }))
      }).catch((err) => {
        dbg('analysis', 'Broadband failed (cache-hit path):', err)
        if (!isLatestRun()) return
        setAnalysisResults((prev) => ({ ...prev, broadband: null, broadbandLoading: false }))
        setAnalysisProgress((prev) => ({ ...prev, broadband: 'done' }))
      })
      return
    }

    setAnalysisResults({ loading: true, noiseLevel: null, noiseAirport: null, noiseAirportCode: null, superfunds: [], costco: null, costcoNearby: [], costcoNearestBeyond: null, costcoError: false, costcoLoading: true, dataCenters: [], nearestER: null, erError: false, crowdMagnets: [], broadband: null, broadbandLoading: true })

    const checks = ['noise', 'superfund', 'costco', 'datacenters', 'er', 'crowd', 'broadband'] as const
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

      // Check Superfund sites within SUPERFUND_ANALYSIS_RADIUS_MI miles
      (async () => {
        try {
        const radiusDeg = (SUPERFUND_ANALYSIS_RADIUS_MI * milesToMeters) / 111320
        const env = `${lng - radiusDeg * 1.3},${lat - radiusDeg},${lng + radiusDeg * 1.3},${lat + radiusDeg}`
        const params = new URLSearchParams({
          where: "NPL_STATUS_CODE <> 'D'",
          outFields: 'SITE_NAME,NPL_STATUS_CODE,URL_ALIAS_TXT,CITY_NAME,STATE_CODE,EPA_ID',
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
        const results: { name: string; distanceMi: number; status: string; statusCode: string; city: string; epaId: string; url: string; lat: number; lng: number }[] = []
        for (const feat of data.features || []) {
          const centroid = feat.centroid || feat.geometry
          if (!centroid) continue
          const cLat = centroid.y ?? centroid.coordinates?.[1]
          const cLon = centroid.x ?? centroid.coordinates?.[0]
          if (cLat == null || cLon == null) continue
          const dist = location.distanceTo(L.latLng(cLat, cLon))
          const distMi = dist / milesToMeters
          if (distMi <= SUPERFUND_ANALYSIS_RADIUS_MI) {
            const statusCode = feat.attributes?.NPL_STATUS_CODE || ''
            const statusLabel = NPL_STATUS_INFO[statusCode]?.label || statusCode
            const urlAlias = feat.attributes?.URL_ALIAS_TXT || ''
            const cityName = feat.attributes?.CITY_NAME || ''
            const stateCode = feat.attributes?.STATE_CODE || ''
            const city = [cityName, stateCode].filter(Boolean).join(', ')
            results.push({
              name: feat.attributes?.SITE_NAME || 'Unknown',
              distanceMi: Math.round(distMi * 10) / 10,
              status: statusLabel,
              statusCode,
              city,
              epaId: feat.attributes?.EPA_ID || '',
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
        // Filter out urgent cares, walk-in clinics, and other non-ER facilities
        // that Google sometimes returns for these queries.
        const NON_ER_NAME_PATTERNS = [
          /urgent\s*care/i,
          /walk[-\s]*in/i,
          /minute\s*clinic/i,
          /immediate\s*care/i,
          /express\s*care/i,
          /quick\s*care/i,
          /minor\s*emergency/i,
          /family\s*practice/i,
          /pediatric\s*urgent/i,
          /redimed|fastmed|carenow|nextcare|patient\s*first|medexpress/i,
        ]
        const ER_NAME_HINTS = [/emergency/i, /\bER\b/, /hospital/i, /medical\s*center/i, /trauma/i]
        const isLikelyER = (name: string, types: string[], primaryType?: string) => {
          if (NON_ER_NAME_PATTERNS.some((re) => re.test(name))) return false
          if (types.includes('hospital') || primaryType === 'hospital') return true
          if (types.includes('emergency_room') || primaryType === 'emergency_room') return true
          // Some real ERs don't carry the hospital type but include "emergency"
          // or "hospital" in their name — accept those too.
          return ER_NAME_HINTS.some((re) => re.test(name))
        }
        await Promise.all(queries.map(async (query) => {
          try {
            const data = await cachedPlacesSearchText({
              body: {
                textQuery: query,
                locationBias: {
                  circle: {
                    center: { latitude: lat, longitude: lng },
                    radius: radiusM,
                  },
                },
                maxResultCount: 10,
              },
              fieldMask: 'places.id,places.displayName,places.location,places.formattedAddress,places.types,places.primaryType',
              apiKey: GOOGLE_MAPS_KEY,
              signal: AbortSignal.timeout(TIMEOUT),
            })
            if (!data) return
            for (const raw of (data.places || []) as Record<string, unknown>[]) {
              const id = raw.id as string
              if (!id || seen.has(id)) continue
              seen.add(id)
              const loc = raw.location as { latitude: number; longitude: number } | undefined
              if (!loc) continue
              const displayName = raw.displayName as { text?: string } | undefined
              const name = displayName?.text || 'Emergency Room'
              const types: string[] = Array.isArray(raw.types) ? (raw.types as string[]) : []
              const primaryType = raw.primaryType as string | undefined
              if (!isLikelyER(name, types, primaryType)) continue
              const dist = location.distanceTo(L.latLng(loc.latitude, loc.longitude))
              const distMi = Math.round(dist / milesToMeters * 10) / 10
              if (distMi <= ER_ANALYSIS_RADIUS_MI) {
                hits.push({
                  name,
                  address: (raw.formattedAddress as string) || '',
                  distanceMi: distMi,
                  lat: loc.latitude,
                  lng: loc.longitude,
                })
              }
            }
          } catch { /* ignore individual query failure */ }
        }))
        hits.sort((a, b) => a.distanceMi - b.distanceMi)
        dbg('er', `${hits.length} ER hits after filter; nearest=${hits[0]?.name ?? 'none'}`)
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
      broadband: null,
      broadbandLoading: true,
    })

    // FCC Broadband fetch runs independently of the other categories. Same
    // pattern as Costco — fire-and-forget, merge result when it lands.
    fetchBroadband(lat, lng).then((bb) => {
      if (!isLatestRun()) {
        dbg('analysis', 'Stale run — discarding Broadband result')
        return
      }
      dbg('analysis', 'Broadband result:', bb?.summary
        ? `${bb.summary.providerCount} provider(s), max ${bb.summary.maxDownMbps ?? '?'} Mbps down`
        : bb?.block ? 'block-only (index not built)' : 'none')
      setAnalysisResults((prev) => ({ ...prev, broadband: bb, broadbandLoading: false }))
      markDone('broadband')
    }).catch((err) => {
      dbg('analysis', 'Broadband failed:', err)
      if (!isLatestRun()) return
      setAnalysisResults((prev) => ({ ...prev, broadband: null, broadbandLoading: false }))
      markDone('broadband')
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
          setErrorMsg('Address not found. Make sure it’s a valid US address — Land Recon currently supports US addresses only.')
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
          homeMarkerRef.current = L.marker([lat, lng], { icon: houseIcon })
            .bindTooltip(homeTooltipHtml(address), { direction: 'top', offset: [0, -18], className: 'location-tooltip' })
            .addTo(map)
          // Reset loaded-bounds so layers refetch when we land at the new viewport.
          airportLoadedBoundsRef.current = null
          airportKnownIdsRef.current.clear()
          superfundLoadedBoundsRef.current = null
          floodLoadedBoundsRef.current = null
          aqiLoadedBoundsRef.current = null
          powerLineLoadedBoundsRef.current = null
          wildfireRenderedBoundsRef.current = null
          if (wildfireLayerRef.current) {
            map.removeLayer(wildfireLayerRef.current)
            wildfireLayerRef.current = null
          }
          transitLoadedBoundsRef.current = null
          transitBusStopsLoadedBoundsRef.current = null
          transitStopsKnownIdsRef.current.clear()
          transitLinesLoadedBoundsRef.current = null
          transitLinesKnownIdsRef.current.clear()
          busLinesLoadedBoundsRef.current = null
          busLinesKnownIdsRef.current.clear()
          if (transitSubLayersRef.current) {
            for (const t of Object.keys(transitSubLayersRef.current) as TransitStop['type'][]) {
              transitSubLayersRef.current[t].clearLayers()
            }
          }
          if (transitLineLayersRef.current) {
            for (const t of ['rail', 'subway', 'tram', 'bus'] as const) {
              transitLineLayersRef.current[t].clearLayers()
            }
          }
          costcoLoadedBoundsRef.current = null
          costcoKnownIdsRef.current.clear()
          emsLoadedBoundsRef.current = null
          emsKnownIdsRef.current.clear()
          crowdLoadedBoundsRef.current = null
          crowdKnownIdsRef.current.clear()
          // Address-scoped layer: clear cache and refetch for the new target.
          industrialFetchedKeyRef.current = null
          if (industrialVisible && industrialLayerRef.current) {
            loadIndustrialData(industrialLayerRef.current)
          }
          // Clear analysis-highlight pins from the previous address so the
          // map doesn't show stale markers while the new analysis runs.
          superfundAnalysisLayerRef.current?.clearLayers()
          costcoAnalysisLayerRef.current?.clearLayers()
          dataCenterAnalysisLayerRef.current?.clearLayers()
          crowdAnalysisLayerRef.current?.clearLayers()
          if (nearestErMarkerRef.current) {
            map.removeLayer(nearestErMarkerRef.current)
            nearestErMarkerRef.current = null
          }
          map.flyTo([lat, lng], 13, { duration: 0.5 })
          setStatus('ready')
          runLocationAnalysis(lat, lng)
          requestAnimationFrame(() => map.invalidateSize())
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
          .bindTooltip(homeTooltipHtml(address), { direction: 'top', offset: [0, -18], className: 'location-tooltip' })
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
            const name = (props.SITE_NAME as string | undefined) || 'Superfund Site'
            layer.bindTooltip(name, { direction: 'top', offset: [0, -16] })
          },
        })

        // Create FEMA flood-zone layer (polygons; not added to map until toggled on)
        floodLayerRef.current = L.geoJSON(undefined, {
          style: (feature) => {
            const bucket = floodBucket(feature?.properties ?? null)
            const color = FLOOD_ZONE_COLORS[bucket]
            return {
              color,
              weight: 1,
              opacity: 0.85,
              fillColor: color,
              fillOpacity: bucket === 'minimal' ? 0.18 : 0.4,
            }
          },
          onEachFeature: (feature, layer) => {
            const props = (feature as GeoJSON.Feature).properties || {}
            const label = floodZoneLabel(props)
            const bfeRaw = (props as Record<string, unknown>).STATIC_BFE
            const bfe = typeof bfeRaw === 'number' && bfeRaw > -9999 ? `<br/>Base flood elev: ${bfeRaw.toFixed(1)} ft` : ''
            layer.bindTooltip(`<strong>${label}</strong>${bfe}`, { direction: 'top', sticky: true })
          },
        })

        // Create HIFLD transmission-line layer (polylines; not added to map until toggled on)
        powerLineLayerRef.current = L.geoJSON(undefined, {
          style: (feature) => {
            const color = powerColor(feature?.properties ?? null)
            return {
              color,
              weight: 2,
              opacity: 0.85,
              lineCap: 'round',
            }
          },
          onEachFeature: (feature, layer) => {
            const props = (feature as GeoJSON.Feature).properties || {}
            const cls = String((props as Record<string, unknown>).VOLT_CLASS || '').trim().toUpperCase()
            const voltLabel = POWER_VOLT_LABELS[cls] || (props as Record<string, unknown>).VOLT_CLASS || 'Unknown'
            const owner = String((props as Record<string, unknown>).OWNER || 'Unknown owner').trim()
            const voltage = (props as Record<string, unknown>).VOLTAGE
            const voltageNote = typeof voltage === 'number' && voltage > 0 ? ` · ${voltage} kV` : ''
            layer.bindTooltip(`<strong>${voltLabel}${voltageNote}</strong><br/>${owner}`, { direction: 'top', sticky: true })
          },
        })

        // EPA FRS industrial-facility layer (circle markers; not added to map until toggled on)
        industrialLayerRef.current = L.layerGroup()

        // Create AirNow AQI layer (polygon contours; not added to map until toggled on)
        aqiLayerRef.current = L.geoJSON(undefined, {
          style: (feature) => {
            const color = aqiColor(feature?.properties ?? null)
            return {
              color,
              weight: 0,
              fillColor: color,
              fillOpacity: 0.35,
            }
          },
          onEachFeature: (feature, layer) => {
            const props = (feature as GeoJSON.Feature).properties || {}
            const cat = aqiCategory(props)
            const label = AQI_CATEGORY_LABELS[cat] || `Category ${cat}`
            layer.bindTooltip(`<strong>${label}</strong>`, { direction: 'top', sticky: true })
          },
        })

        // Create transit layer (not added to map until toggled on)
        transitLayerRef.current = L.layerGroup()

        // Transit line vector layers — one LayerGroup per sub-type. Lines are
        // fetched from Overpass on demand. For rail/subway/tram these are
        // dedicated track. For bus they are the road segments that bus route
        // relations traverse — drawn thin/dashed and gated to a higher zoom
        // so they don't overwhelm at city-wide views.
        transitLineLayersRef.current = {
          rail: L.layerGroup(),
          subway: L.layerGroup(),
          tram: L.layerGroup(),
          bus: L.layerGroup(),
        }

        // Create Costco label layer (not added to map until toggled on)
        costcoLayerRef.current = L.layerGroup()

        dataCenterLayerRef.current = L.layerGroup()

        emsLayerRef.current = L.layerGroup()

        crowdLayerRef.current = L.layerGroup()

        camerasLayerRef.current = L.layerGroup()

        // Analysis-highlight layer groups: added to the map immediately so
        // the analysis effect can drop pins into them without touching the
        // user-toggleable main layers above. Empty until analysis runs.
        superfundAnalysisLayerRef.current = L.layerGroup().addTo(map)
        costcoAnalysisLayerRef.current = L.layerGroup().addTo(map)
        dataCenterAnalysisLayerRef.current = L.layerGroup().addTo(map)
        crowdAnalysisLayerRef.current = L.layerGroup().addTo(map)

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

        requestAnimationFrame(() => map.invalidateSize())
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
    // Keep Leaflet in sync with the real container size. Mobile browsers
    // resize the visual viewport when the URL bar collapses, when the soft
    // keyboard appears, or on orientation change, and panel/sheet toggles
    // can resize the map area on desktop too. Without this, the initial
    // tile grid is the only thing that renders and the rest of the map
    // stays gray.
    const container = mapContainer.current
    let rafId = 0
    const scheduleInvalidate = () => {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        mapRef.current?.invalidateSize()
      })
    }
    const ro = typeof ResizeObserver !== 'undefined' && container
      ? new ResizeObserver(scheduleInvalidate)
      : null
    if (ro && container) ro.observe(container)
    window.addEventListener('resize', scheduleInvalidate)
    window.addEventListener('orientationchange', scheduleInvalidate)
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    vv?.addEventListener('resize', scheduleInvalidate)
    vv?.addEventListener('scroll', scheduleInvalidate)

    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      ro?.disconnect()
      window.removeEventListener('resize', scheduleInvalidate)
      window.removeEventListener('orientationchange', scheduleInvalidate)
      vv?.removeEventListener('resize', scheduleInvalidate)
      vv?.removeEventListener('scroll', scheduleInvalidate)

      baseLayerRef.current = null
      noiseLayerRef.current = null
      airportLayerRef.current = null
      airportLoadedBoundsRef.current = null
      airportKnownIdsRef.current.clear()
      superfundLayerRef.current = null
      superfundLoadedBoundsRef.current = null
      floodLayerRef.current = null
      floodLoadedBoundsRef.current = null
      aqiLayerRef.current = null
      aqiLoadedBoundsRef.current = null
      powerLineLayerRef.current = null
      powerLineLoadedBoundsRef.current = null
      industrialLayerRef.current = null
      industrialFetchedKeyRef.current = null
      wildfireLayerRef.current = null
      wildfireRenderedBoundsRef.current = null
      transitLayerRef.current = null
      transitLineLayersRef.current = null
      transitLinesLoadedBoundsRef.current = null
      transitLinesKnownIdsRef.current.clear()
      busLinesLoadedBoundsRef.current = null
      busLinesKnownIdsRef.current.clear()
      transitSubLayersRef.current = null
      transitLoadedBoundsRef.current = null
      transitBusStopsLoadedBoundsRef.current = null
      transitStopsKnownIdsRef.current.clear()
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
      camerasLayerRef.current = null
      camerasLoadedBoundsRef.current = null
      camerasKnownIdsRef.current.clear()
      superfundAnalysisLayerRef.current = null
      costcoAnalysisLayerRef.current = null
      dataCenterAnalysisLayerRef.current = null
      crowdAnalysisLayerRef.current = null
      nearestErMarkerRef.current = null
      homeMarkerRef.current = null
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

  // Auto-dismiss the transit error toast after a few seconds (loading toast
  // is cleared by the load completion path itself).
  useEffect(() => {
    if (transitStatus?.kind !== 'error') return
    const t = setTimeout(() => setTransitStatus(null), 6000)
    return () => clearTimeout(t)
  }, [transitStatus])

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

  const loadDataCenters = useCallback(async (
    map: L.Map,
    layer: L.LayerGroup,
    restrict?: { center: L.LatLng; radiusMi: number },
  ) => {
    dbg('datacenters', restrict ? `Loading data centers within ${restrict.radiusMi} mi…` : 'Loading data centers…')
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
        subLayers[s] = await createClusterGroup(DC_STATUS_COLORS[s])
      }
      dataCenterSubLayersRef.current = subLayers
      for (const s of DC_STATUSES) {
        if (dcSubVisibleRef.current[s]) {
          subLayers[s].addTo(layer)
        }
      }
    }

    for (const s of DC_STATUSES) subLayers[s].clearLayers()

    let inRange: (dc: DataCenter) => boolean
    if (restrict) {
      const radiusM = restrict.radiusMi * 1609.34
      inRange = (dc) => restrict.center.distanceTo(L.latLng(dc.lat, dc.lng)) <= radiusM
    } else {
      const bounds = map.getBounds().pad(0.3)
      inRange = (dc) => bounds.contains([dc.lat, dc.lng])
    }
    for (const dc of data) {
      if (!inRange(dc)) continue
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
        for (const t of EMS_TYPES) subLayers[t] = await createClusterGroup(EMS_COLORS[t])
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
            const data = await cachedPlacesSearchText({
              body: {
                textQuery: query,
                locationBias: {
                  circle: {
                    center: { latitude: center.lat, longitude: center.lng },
                    radius: radiusM,
                  },
                },
                maxResultCount: 20,
              },
              fieldMask: 'places.id,places.displayName,places.location,places.formattedAddress,places.types',
              apiKey: GOOGLE_MAPS_KEY,
            })
            if (!data) {
              console.warn(`EMS ${type} (${query}) search failed`)
              return []
            }
            return (data.places || []).map((p): Record<string, unknown> => ({ ...(p as Record<string, unknown>), _emsType: type }))
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

  // ── ALPR camera layer (Flock + others, sourced from OSM/DeFlock) ──
  // Same shape as loadTransitData but with a single cluster group and no
  // sub-types. Bbox-cached so panning within a previously-loaded area
  // doesn't re-query Overpass.
  const loadCamerasData = useCallback(async (map: L.Map, layer: L.LayerGroup): Promise<boolean> => {
    if (camerasLoadingRef.current) return true
    if (map.getZoom() < 10) {
      dbg('cameras', `Skipping — zoom ${map.getZoom()} below threshold (10)`)
      setCamerasStatus({ kind: 'empty', text: 'Zoom in to load cameras' })
      return true
    }

    let bounds = map.getBounds().pad(0.3)
    const latSpan = bounds.getNorth() - bounds.getSouth()
    const lngSpan = bounds.getEast() - bounds.getWest()
    const MAX_SPAN_DEG = 0.5
    if (latSpan > MAX_SPAN_DEG || lngSpan > MAX_SPAN_DEG) {
      const c = map.getCenter()
      const half = MAX_SPAN_DEG / 2
      bounds = L.latLngBounds([c.lat - half, c.lng - half], [c.lat + half, c.lng + half])
      dbg('cameras', `Bbox span exceeded ${MAX_SPAN_DEG}° — clamped to ${MAX_SPAN_DEG}° around center`)
    }

    const loaded = camerasLoadedBoundsRef.current
    if (loaded && loaded.contains(bounds)) { dbg('cameras', 'Skipping — bounds already loaded'); return true }

    dbg('cameras', 'Loading ALPR cameras…')
    camerasLoadingRef.current = true
    setCamerasLoading(true)
    setCamerasStatus({ kind: 'loading', text: 'Loading cameras…' })

    let ok = true
    try {
      const sw = bounds.getSouthWest()
      const ne = bounds.getNorthEast()
      const bbox = `${sw.lat},${sw.lng},${ne.lat},${ne.lng}`

      // Prefer the daily CONUS snapshot when the map center is inside the
      // contiguous US — collapses a per-bbox Overpass round-trip into one
      // page-lifetime fetch of a ~1–2 MB gzipped JSON served from CDN.
      // Falls back to live Overpass on snapshot fetch failure or whenever
      // the user is panning outside CONUS.
      const center = map.getCenter()
      const conus = L.latLngBounds(CONUS_BOUNDS)
      let cameras: CameraRecord[] = []
      let source: 'snapshot' | 'live' = 'live'

      if (conus.contains(center)) {
        const snap = await loadCamerasSnapshot()
        if (snap) {
          cameras = snap.cameras.filter((c) => bounds.contains([c.lat, c.lon] as L.LatLngTuple))
          source = 'snapshot'
          dbg('cameras', `Snapshot match: ${cameras.length} cameras in viewport (of ${snap.count} CONUS total)`)
        }
      }

      if (source === 'live') {
        cameras = await fetchCamerasInWorker(bbox)
        dbg('cameras', `Worker returned ${cameras.length} cameras for bbox=${bbox}`)
      }

      // Lazy-create the cluster on first load. Use the Flock magenta as the
      // cluster bubble color since it's the most visually obvious.
      let cluster = layer.getLayers()[0] as L.LayerGroup | undefined
      if (!cluster) {
        cluster = await createClusterGroup(CAMERA_COLORS.flock)
        cluster.addTo(layer)
        dbg('cameras', 'Created cluster group')
      }

      const known = camerasKnownIdsRef.current
      let added = 0
      let flockAdded = 0
      let withDirection = 0
      for (const cam of cameras) {
        if (known.has(cam.id)) continue
        known.add(cam.id)
        const color = cam.isFlock ? CAMERA_COLORS.flock : CAMERA_COLORS.other
        L.marker([cam.lat, cam.lon], { icon: makeCameraIcon(color, cam.direction) })
          .bindPopup(cameraPopup(cam), { maxWidth: 280 })
          .addTo(cluster)
        added++
        if (cam.isFlock) flockAdded++
        if (cam.direction && /^-?\d+(\.\d+)?$/.test(cam.direction)) withDirection++
      }

      camerasLoadedBoundsRef.current = loaded
        ? loaded.extend(bounds.getSouthWest()).extend(bounds.getNorthEast())
        : bounds
      dbg('cameras', `[${source}] Added ${added} new (${flockAdded} Flock, ${added - flockAdded} other, ${withDirection} with direction); total known: ${known.size}`)
      if (known.size === 0) {
        setCamerasStatus({ kind: 'empty', text: 'No mapped ALPR cameras in this area' })
      } else {
        setCamerasStatus(null)
      }
    } catch (err) {
      console.warn('Camera fetch failed:', err)
      dbg('cameras', 'Fetch failed:', err)
      setCamerasStatus({ kind: 'error', text: 'Failed to load cameras' })
      ok = false
    } finally {
      camerasLoadingRef.current = false
      setCamerasLoading(false)
    }
    return ok
  }, [])

  const handleCamerasMove = useCallback(
    debounce(() => {
      const map = mapRef.current
      const layer = camerasLayerRef.current
      if (map && layer) loadCamerasData(map, layer)
    }, 250),
    [loadCamerasData],
  )

  const toggleCameras = () => {
    const map = mapRef.current
    const layer = camerasLayerRef.current
    if (!map || !layer) return
    dbg('toggle', `cameras → ${camerasVisible ? 'OFF' : 'ON'}`)
    if (camerasVisible) {
      map.removeLayer(layer)
      map.off('moveend', handleCamerasMove)
      layer.clearLayers()
      camerasLoadedBoundsRef.current = null
      camerasKnownIdsRef.current.clear()
      setCamerasStatus(null)
    } else {
      layer.addTo(map)
      loadCamerasData(map, layer)
      map.on('moveend', handleCamerasMove)
    }
    setCamerasVisible(!camerasVisible)
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

      // Prefer the daily CONUS snapshot when in-CONUS; fall back to live
      // Overpass for the rest of the world (or on snapshot failure).
      const center = map.getCenter()
      const conus = L.latLngBounds(CONUS_BOUNDS)
      let items: CrowdMagnet[] = []
      let source: 'snapshot' | 'live' = 'live'
      if (conus.contains(center)) {
        const snap = await loadCrowdSnapshot()
        if (snap) {
          items = snap.magnets.filter((m) => padded.contains([m.lat, m.lng] as L.LatLngTuple))
          source = 'snapshot'
          dbg('crowd', `Snapshot match: ${items.length} magnets in viewport (of ${snap.count} CONUS total)`)
        }
      }
      if (source === 'live') {
        items = await fetchCrowdMagnets(padded)
      }

      const known = crowdKnownIdsRef.current
      let added = 0
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
        added++
      }

      crowdLoadedBoundsRef.current = loaded
        ? loaded.extend(padded.getSouthWest()).extend(padded.getNorthEast())
        : padded
      dbg('crowd', `[${source}] Added ${added} new (total known: ${known.size})`)
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

  const toggleFlood = () => {
    const map = mapRef.current
    const layer = floodLayerRef.current
    if (!map || !layer) return
    dbg('toggle', `flood → ${floodVisible ? 'OFF' : 'ON'}`)

    if (floodVisible) {
      map.removeLayer(layer)
      map.off('moveend', handleFloodMove)
      map.off('zoomend', handleFloodMove)
      setFloodLowZoom(false)
    } else {
      layer.addTo(map)
      floodLoadedBoundsRef.current = null
      loadFloodData(map, layer)
      map.on('moveend', handleFloodMove)
      map.on('zoomend', handleFloodMove)
    }
    setFloodVisible(!floodVisible)
  }

  const handleFloodMove = useCallback(
    debounce(() => {
      const map = mapRef.current
      const layer = floodLayerRef.current
      if (map && layer) {
        loadFloodData(map, layer)
      }
    }, 250),
    [loadFloodData],
  )

  const toggleAqi = () => {
    const map = mapRef.current
    const layer = aqiLayerRef.current
    if (!map || !layer) return
    dbg('toggle', `aqi → ${aqiVisible ? 'OFF' : 'ON'}`)

    if (aqiVisible) {
      map.removeLayer(layer)
      map.off('moveend', handleAqiMove)
      map.off('zoomend', handleAqiMove)
      setAqiLowZoom(false)
    } else {
      layer.addTo(map)
      aqiLoadedBoundsRef.current = null
      loadAqiData(map, layer)
      map.on('moveend', handleAqiMove)
      map.on('zoomend', handleAqiMove)
    }
    setAqiVisible(!aqiVisible)
  }

  const handleAqiMove = useCallback(
    debounce(() => {
      const map = mapRef.current
      const layer = aqiLayerRef.current
      if (map && layer) {
        loadAqiData(map, layer)
      }
    }, 250),
    [loadAqiData],
  )

  const togglePowerLines = () => {
    const map = mapRef.current
    const layer = powerLineLayerRef.current
    if (!map || !layer) return
    dbg('toggle', `power → ${powerLineVisible ? 'OFF' : 'ON'}`)

    if (powerLineVisible) {
      map.removeLayer(layer)
      map.off('moveend', handlePowerLineMove)
      map.off('zoomend', handlePowerLineMove)
      setPowerLineLowZoom(false)
    } else {
      layer.addTo(map)
      powerLineLoadedBoundsRef.current = null
      loadPowerLineData(map, layer)
      map.on('moveend', handlePowerLineMove)
      map.on('zoomend', handlePowerLineMove)
    }
    setPowerLineVisible(!powerLineVisible)
  }

  const handlePowerLineMove = useCallback(
    debounce(() => {
      const map = mapRef.current
      const layer = powerLineLayerRef.current
      if (map && layer) {
        loadPowerLineData(map, layer)
      }
    }, 250),
    [loadPowerLineData],
  )

  const toggleIndustrial = () => {
    const map = mapRef.current
    const layer = industrialLayerRef.current
    if (!map || !layer) return
    dbg('toggle', `industrial → ${industrialVisible ? 'OFF' : 'ON'}`)

    if (industrialVisible) {
      map.removeLayer(layer)
      setIndustrialNeedsAddress(false)
    } else {
      layer.addTo(map)
      industrialFetchedKeyRef.current = null
      loadIndustrialData(layer)
    }
    setIndustrialVisible(!industrialVisible)
  }

  const toggleWildfire = () => {
    const map = mapRef.current
    if (!map) return
    dbg('toggle', `wildfire → ${wildfireVisible ? 'OFF' : 'ON'}`)

    if (wildfireVisible) {
      if (wildfireLayerRef.current) {
        map.removeLayer(wildfireLayerRef.current)
        wildfireLayerRef.current = null
      }
      wildfireRenderedBoundsRef.current = null
      map.off('moveend', handleWildfireMove)
      map.off('zoomend', handleWildfireMove)
      setWildfireLowZoom(false)
      setWildfireLoading(false)
    } else {
      loadWildfireData(map)
      map.on('moveend', handleWildfireMove)
      map.on('zoomend', handleWildfireMove)
    }
    setWildfireVisible(!wildfireVisible)
  }

  const handleWildfireMove = useCallback(
    debounce(() => {
      const map = mapRef.current
      if (map) loadWildfireData(map)
    }, 300),
    [loadWildfireData],
  )

  // Fetch rail / subway / tram polylines from Overpass for the current
  // viewport (capped if the viewport is huge) and render them into the
  // per-type LayerGroups. Re-fetches incrementally as the user pans/zooms.
  const loadTransitLines = useCallback(async (map: L.Map): Promise<boolean> => {
    const layers = transitLineLayersRef.current
    if (!layers) return true
    if (transitLinesLoadingRef.current) return true
    // At very low zoom the bounding box becomes huge and Overpass would
    // return tens of thousands of ways — skip rather than hammer the API.
    if (map.getZoom() < 10) return true

    let bounds = map.getBounds().pad(0.5)
    const latSpan = bounds.getNorth() - bounds.getSouth()
    const lngSpan = bounds.getEast() - bounds.getWest()
    // Cap the fetch area at ~30km on a side so a zoomed-out view still
    // returns quickly with data around the current center.
    const MAX_SPAN_DEG = 0.4
    if (latSpan > MAX_SPAN_DEG || lngSpan > MAX_SPAN_DEG) {
      const c = map.getCenter()
      const half = MAX_SPAN_DEG / 2
      bounds = L.latLngBounds([c.lat - half, c.lng - half], [c.lat + half, c.lng + half])
    }

    const loaded = transitLinesLoadedBoundsRef.current
    if (loaded && loaded.contains(bounds)) return true

    const sw = bounds.getSouthWest()
    const ne = bounds.getNorthEast()
    const bbox = `${sw.lat},${sw.lng},${ne.lat},${ne.lng}`
    // Light rail / subway / tram are passenger by definition; for heavy rail
    // we only include ways that are members of a route=train relation
    // (commuter / intercity), which excludes freight-only mainlines, yards
    // and industrial spurs.
    dbg('transit', `Fetching commuter/subway/tram lines for bbox=${bbox}`)
    transitLinesLoadingRef.current = true
    let ok = true
    try {
      // Snapshot first if in CONUS; fall back to live Overpass for the rest
      // of the world or on snapshot failure. Snapshot ships coords in a
      // packed flat [lat, lon, lat, lon, ...] layout to roughly halve
      // gzip size — unflatten before handing to L.polyline.
      const center = map.getCenter()
      const conus = L.latLngBounds(CONUS_BOUNDS)
      let lines: Array<{ id: string; type: 'rail' | 'subway' | 'tram'; coords: [number, number][] }> = []
      let source: 'snapshot' | 'live' = 'live'
      if (conus.contains(center)) {
        const snap = await loadTransitLinesSnapshot()
        if (snap) {
          for (const l of snap.lines) {
            // Cheap bbox prefilter on the first coord to skip continents-away
            // lines without materializing pair arrays for every record.
            if (l.coords.length < 4) continue
            const lat0 = l.coords[0]
            const lon0 = l.coords[1]
            if (!bounds.contains([lat0, lon0] as L.LatLngTuple)) {
              // Cheap fast-path miss; check the midpoint too since long
              // intercity lines may exit and re-enter the viewport.
              const midIdx = (l.coords.length >> 2) * 2
              const latMid = l.coords[midIdx]
              const lonMid = l.coords[midIdx + 1]
              if (!bounds.contains([latMid, lonMid] as L.LatLngTuple)) continue
            }
            const pairs: [number, number][] = []
            for (let i = 0; i < l.coords.length; i += 2) {
              pairs.push([l.coords[i], l.coords[i + 1]])
            }
            lines.push({ id: l.id, type: l.type, coords: pairs })
          }
          source = 'snapshot'
          dbg('transit', `Lines snapshot match: ${lines.length} lines in viewport (of ${snap.count} CONUS total)`)
        }
      }
      if (source === 'live') {
        lines = await fetchTransitLinesInWorker(bbox)
      }

      const known = transitLinesKnownIdsRef.current
      let added = 0
      for (const line of lines) {
        if (known.has(line.id)) continue
        L.polyline(line.coords, {
          color: TRANSIT_COLORS[line.type],
          weight: line.type === 'rail' ? 3 : 2.5,
          opacity: 0.8,
          smoothFactor: 1.5,
        }).addTo(layers[line.type])
        known.add(line.id)
        added++
      }
      dbg('transit', `[${source}] Rendered ${added} new line segments (total known: ${known.size})`)
      transitLinesLoadedBoundsRef.current = loaded
        ? loaded.extend(bounds.getSouthWest()).extend(bounds.getNorthEast())
        : bounds
    } catch (err) {
      console.warn('Transit line fetch failed:', err)
      ok = false
    } finally {
      transitLinesLoadingRef.current = false
    }
    return ok
  }, [])

  const loadBusLines = useCallback(async (map: L.Map): Promise<boolean> => {
    const layers = transitLineLayersRef.current
    if (!layers) return true
    if (busLinesLoadingRef.current) return true
    // Bus lines ride on streets and would create a tangle at city-wide zoom;
    // only fetch when the user has zoomed in to a neighborhood-level view.
    if (map.getZoom() < 13) return true

    let bounds = map.getBounds().pad(0.25)
    const latSpan = bounds.getNorth() - bounds.getSouth()
    const lngSpan = bounds.getEast() - bounds.getWest()
    // Tighter cap than rail — bus relations have many member ways and a wide
    // bbox blows up the response size.
    const MAX_SPAN_DEG = 0.15
    if (latSpan > MAX_SPAN_DEG || lngSpan > MAX_SPAN_DEG) {
      const c = map.getCenter()
      const half = MAX_SPAN_DEG / 2
      bounds = L.latLngBounds([c.lat - half, c.lng - half], [c.lat + half, c.lng + half])
    }

    const loaded = busLinesLoadedBoundsRef.current
    if (loaded && loaded.contains(bounds)) return true

    const sw = bounds.getSouthWest()
    const ne = bounds.getNorthEast()
    const bbox = `${sw.lat},${sw.lng},${ne.lat},${ne.lng}`
    // Get road ways that are members of bus route relations in the bbox.
    dbg('transit', `Fetching bus route ways for bbox=${bbox}`)
    busLinesLoadingRef.current = true
    let ok = true
    try {
      const lines = await fetchBusLinesInWorker(bbox)
      const known = busLinesKnownIdsRef.current
      let added = 0
      for (const line of lines) {
        if (known.has(line.id)) continue
        L.polyline(line.coords, {
          color: TRANSIT_COLORS.bus,
          weight: 1.5,
          opacity: 0.5,
          dashArray: '4 4',
          smoothFactor: 1.5,
          interactive: false,
        }).addTo(layers.bus)
        known.add(line.id)
        added++
      }
      dbg('transit', `Rendered ${added} new bus segments (total known: ${known.size})`)
      busLinesLoadedBoundsRef.current = loaded
        ? loaded.extend(bounds.getSouthWest()).extend(bounds.getNorthEast())
        : bounds
    } catch (err) {
      console.warn('Bus line fetch failed:', err)
      ok = false
    } finally {
      busLinesLoadingRef.current = false
    }
    return ok
  }, [])

  const toggleTransit = () => {
    const map = mapRef.current
    const layer = transitLayerRef.current
    if (!map || !layer) return
    dbg('toggle', `transit → ${transitVisible ? 'OFF' : 'ON'}`)

    const lineLayers = transitLineLayersRef.current
    if (transitVisible) {
      // Invalidate any in-flight init so a late failure won't pop a toast
      // for a layer the user already turned off.
      transitInitRunIdRef.current++
      map.removeLayer(layer)
      if (lineLayers) {
        for (const t of ['rail', 'subway', 'tram', 'bus'] as const) {
          map.removeLayer(lineLayers[t])
        }
      }
      map.off('moveend', handleTransitMove)
      setTransitVisible(false)
      setTransitStatus(null)
      return
    }

    // ON branch
    layer.addTo(map)
    if (lineLayers) {
      for (const t of ['rail', 'subway', 'tram', 'bus'] as const) {
        if (transitSubVisibleRef.current[t]) lineLayers[t].addTo(map)
      }
    }
    map.on('moveend', handleTransitMove)
    setTransitVisible(true)
    setTransitStatus({ kind: 'loading', text: 'Loading transit data…' })

    const runId = ++transitInitRunIdRef.current
    const tasks: Promise<boolean>[] = [
      loadTransitData(map, layer),
      loadTransitLines(map),
    ]
    if (transitSubVisibleRef.current.bus) tasks.push(loadBusLines(map))

    Promise.all(tasks).then((results) => {
      // Stale callback — user has already toggled off or re-toggled.
      if (runId !== transitInitRunIdRef.current) return
      const allOk = results.every(Boolean)
      if (allOk) {
        setTransitStatus(null)
        return
      }
      // Initial load failed — revert the toggle so the user can retry.
      map.removeLayer(layer)
      if (lineLayers) {
        for (const t of ['rail', 'subway', 'tram', 'bus'] as const) {
          map.removeLayer(lineLayers[t])
        }
      }
      map.off('moveend', handleTransitMove)
      setTransitVisible(false)
      setTransitStatus({
        kind: 'error',
        text: "Couldn't load transit data. Please try again in a moment.",
      })
    })
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
      // loadTransitData will decide whether a fetch is actually needed
      // (e.g. bus may need a fetch even if rail bounds already cover the box).
      loadTransitData(map, parentLayer)
    } else {
      parentLayer.removeLayer(subLayers[type])
    }

    // Mirror the toggle on the corresponding line layer. Rail-based types
    // use dedicated track from loadTransitLines; bus uses road segments
    // from loadBusLines (gated to higher zoom).
    const lineLayers = transitLineLayersRef.current
    if (lineLayers) {
      if (nowVisible) {
        lineLayers[type].addTo(map)
        if (type === 'bus') loadBusLines(map)
        else loadTransitLines(map)
      } else {
        map.removeLayer(lineLayers[type])
      }
    }
  }

  const handleTransitMove = useCallback(
    debounce(() => {
      const map = mapRef.current
      const layer = transitLayerRef.current
      if (map && layer) {
        loadTransitData(map, layer)
        loadTransitLines(map)
        if (transitSubVisibleRef.current.bus) loadBusLines(map)
      }
    }, 250),
    [loadTransitData, loadTransitLines, loadBusLines],
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
    flood: floodVisible,
    wildfire: wildfireVisible,
    aqi: aqiVisible,
    transit: transitVisible,
    traffic: trafficVisible,
    costco: costcoVisible,
    datacenters: dataCenterVisible,
    power: powerLineVisible,
    ems: emsVisible,
    crowd: crowdVisible,
    cameras: camerasVisible,
    industrial: industrialVisible,
  }

  const activeLayerPresetId = LAYER_PRESETS.find((preset) => {
    const s = preset.state
    return s.noise === currentLayerSnapshot.noise
      && s.superfund === currentLayerSnapshot.superfund
      && s.flood === currentLayerSnapshot.flood
      && s.wildfire === currentLayerSnapshot.wildfire
      && s.aqi === currentLayerSnapshot.aqi
      && s.transit === currentLayerSnapshot.transit
      && s.traffic === currentLayerSnapshot.traffic
      && s.costco === currentLayerSnapshot.costco
      && s.datacenters === currentLayerSnapshot.datacenters
      && s.power === currentLayerSnapshot.power
      && s.ems === currentLayerSnapshot.ems
      && s.crowd === currentLayerSnapshot.crowd
      && s.cameras === currentLayerSnapshot.cameras
      && s.industrial === currentLayerSnapshot.industrial
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
    setLayer(floodVisible, toggleFlood, preset.state.flood)
    setLayer(wildfireVisible, toggleWildfire, preset.state.wildfire)
    setLayer(aqiVisible, toggleAqi, preset.state.aqi)
    setLayer(transitVisible, toggleTransit, preset.state.transit)
    setLayer(trafficVisible, toggleTraffic, preset.state.traffic)
    setLayer(costcoVisible, toggleCostco, preset.state.costco)
    setLayer(dataCenterVisible, toggleDataCenters, preset.state.datacenters)
    setLayer(powerLineVisible, togglePowerLines, preset.state.power)
    setLayer(emsVisible, toggleEms, preset.state.ems)
    setLayer(crowdVisible, toggleCrowd, preset.state.crowd)
    setLayer(camerasVisible, toggleCameras, preset.state.cameras)
    setLayer(industrialVisible, toggleIndustrial, preset.state.industrial)
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
    if (requested.has('flood')) toggleFlood()
    if (requested.has('wildfire')) toggleWildfire()
    if (requested.has('aqi')) toggleAqi()
    if (requested.has('transit')) toggleTransit()
    if (requested.has('traffic')) toggleTraffic()
    if (requested.has('costco')) toggleCostco()
    if (requested.has('datacenters')) toggleDataCenters()
    if (requested.has('power')) togglePowerLines()
    if (requested.has('ems')) toggleEms()
    if (requested.has('crowd')) toggleCrowd()
    if (requested.has('cameras')) toggleCameras()
    if (requested.has('industrial')) toggleIndustrial()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  // Drop "analysis highlight" pins on the map whenever analysis finishes.
  // These live in their own layer groups (added at map init) so they do NOT
  // flip the user-facing "Map Layers" toggles — those stay user-controlled.
  // We just visually surface the items the report is calling out.
  useEffect(() => {
    if (analysisResults.loading) return
    const map = mapRef.current
    if (!map) return

    // Superfund highlights — pin every site within the analysis radius.
    {
      const layer = superfundAnalysisLayerRef.current
      if (layer) {
        layer.clearLayers()
        for (const s of analysisResults.superfunds) {
          L.marker([s.lat, s.lng], { icon: SUPERFUND_ICON, riseOnHover: true })
            .bindTooltip(s.name, { direction: 'top', offset: [0, -16] })
            .addTo(layer)
        }
      }
    }

    // Costco highlights — the closest in-radius costcos, or the nearest
    // one beyond range if none are within the radius.
    {
      const layer = costcoAnalysisLayerRef.current
      if (layer) {
        layer.clearLayers()
        const auto = analysisResults.costcoNearby.length > 0
          ? analysisResults.costcoNearby
          : (analysisResults.costcoNearestBeyond ? [analysisResults.costcoNearestBeyond] : [])
        for (const c of auto) {
          const tooltipParts = [c.city ? `Costco — ${c.city}` : 'Costco']
          if (c.address) tooltipParts.push(c.address)
          const icon = L.divIcon({
            className: 'costco-label',
            html: `<div class="costco-pin">C</div>`,
            iconSize: [32, 32],
            iconAnchor: [16, 16],
          })
          L.marker([c.lat, c.lng], { icon })
            .bindTooltip(tooltipParts.join('<br/>'), { direction: 'top', offset: [0, -16] })
            .addTo(layer)
        }
      }
    }

    // Nearest ER — single standalone marker. Distinct from the EMS layer
    // (which is a separate user-toggleable thing), this is the one ER the
    // report is highlighting.
    if (analysisResults.nearestER) {
      const existing = nearestErMarkerRef.current
      if (existing) {
        map.removeLayer(existing)
        nearestErMarkerRef.current = null
      }
      const er = analysisResults.nearestER
      const icon = L.divIcon({
        className: 'er-label',
        html: `<div class="er-pin">🚑</div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      })
      const tooltipParts = [er.name]
      if (er.address) tooltipParts.push(er.address)
      const marker = L.marker([er.lat, er.lng], { icon })
        .bindTooltip(tooltipParts.join('<br/>'), { direction: 'top', offset: [0, -16] })
        .addTo(map)
      nearestErMarkerRef.current = marker
      dbg('er', `Auto-pinned nearest ER: ${er.name} (${er.distanceMi} mi)`)
    }

    // Data Center highlights — pin every facility within the analysis radius.
    {
      const layer = dataCenterAnalysisLayerRef.current
      if (layer) {
        layer.clearLayers()
        for (const dc of analysisResults.dataCenters) {
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
          lines.push(`Status: ${dc.status}`)
          if (dc.mw) lines.push(`Capacity: ${dc.mw} MW`)
          L.marker([dc.lat, dc.lng], { icon })
            .bindTooltip(lines.join('<br/>'), { direction: 'top', offset: [0, -14] })
            .addTo(layer)
        }
      }
    }

    // Crowd Magnet highlights — pin every magnet within the analysis radius.
    {
      const layer = crowdAnalysisLayerRef.current
      if (layer) {
        layer.clearLayers()
        for (const m of analysisResults.crowdMagnets) {
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
            .addTo(layer)
        }
      }
    }

    const center = map.getCenter()

    // Pan/zoom to encompass the address plus all analysis pins.
    // Strategy: build asymmetric bounds from actual pin positions and call
    // fitBounds with maxZoom = 14. That gives us:
    //   - zoom IN  up to z14 if everything fits at a tighter zoom
    //   - zoom OUT only as far as needed if pins don't fit at z14
    //   - re-centers as needed so the address and all pins are visible
    const targetBounds = L.latLngBounds([center, center])
    for (const s of analysisResults.superfunds) targetBounds.extend([s.lat, s.lng])
    for (const dc of analysisResults.dataCenters) targetBounds.extend([dc.lat, dc.lng])
    for (const m of analysisResults.crowdMagnets) targetBounds.extend([m.lat, m.lng])
    // Include the closest Costco (in-radius or nearest-beyond) so the
    // highlighted Costco pin is actually visible after the fit.
    const closestCostco = analysisResults.costco ?? analysisResults.costcoNearestBeyond
    if (closestCostco) targetBounds.extend([closestCostco.lat, closestCostco.lng])
    // Include the nearest ER pin so the auto-placed marker is in view.
    if (analysisResults.nearestER) {
      targetBounds.extend([analysisResults.nearestER.lat, analysisResults.nearestER.lng])
    }

    // Bail if no analysis pins/areas to fit (just the address).
    const sw = targetBounds.getSouthWest()
    const ne = targetBounds.getNorthEast()
    if (sw.equals(ne)) return

    const { topLeft, bottomRight } = computeFitPadding()
    const currentZoom = map.getZoom()
    map.fitBounds(targetBounds, {
      paddingTopLeft: topLeft,
      paddingBottomRight: bottomRight,
      maxZoom: 14,
    })
    const newZoom = map.getZoom()
    dbg('analysis', `fit analysis pins; zoom ${currentZoom} → ${newZoom}`)
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
          <button
            type="button"
            className={`map-header-exp-trigger${expUnlocked ? '' : ' is-locked'}`}
            onClick={handleExpTriggerClick}
            aria-label={expUnlocked ? 'Experimental features' : ''}
            aria-haspopup={expUnlocked ? 'menu' : undefined}
            aria-expanded={expUnlocked ? expMenuOpen : undefined}
            aria-hidden={expUnlocked ? undefined : true}
            tabIndex={expUnlocked ? 0 : -1}
          >
            <img src={logo} alt="" className="map-header-logo" decoding="async" />
            <svg
              className="map-header-reticle"
              viewBox="0 0 64 64"
              aria-hidden="true"
              focusable="false"
            >
              <g fill="none" strokeLinecap="round">
                <g stroke="#3F4434" strokeWidth="9">
                  <circle cx="32" cy="32" r="19" />
                  <line x1="4" y1="32" x2="22" y2="32" />
                  <line x1="42" y1="32" x2="60" y2="32" />
                  <line x1="32" y1="4" x2="32" y2="22" />
                  <line x1="32" y1="42" x2="32" y2="60" />
                </g>
                <g stroke="#F2EAD0" strokeWidth="5">
                  <circle cx="32" cy="32" r="19" />
                  <line x1="4" y1="32" x2="22" y2="32" />
                  <line x1="42" y1="32" x2="60" y2="32" />
                  <line x1="32" y1="4" x2="32" y2="22" />
                  <line x1="32" y1="42" x2="32" y2="60" />
                </g>
              </g>
              <circle cx="32" cy="32" r="4" fill="#3F4434" />
              <circle cx="32" cy="32" r="2" fill="#F2EAD0" />
            </svg>
          </button>
          {expUnlocked && expMenuOpen && (
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
        {status === 'ready' && (() => {
          const checks = ['noise', 'superfund', 'costco', 'datacenters', 'er', 'crowd', 'broadband'] as const
          const done = checks.filter((k) => analysisProgress[k] === 'done').length
          const total = checks.length
          // Show the strip from the moment an analysis kicks off until every
          // category lands. Hidden before any analysis starts (progress empty)
          // and once everything's done. Note: Costco + Broadband resolve after
          // analysisResults.loading flips false, so we gate on progress, not
          // the loading flag.
          if (done >= total || Object.keys(analysisProgress).length === 0) return null
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

      {/* Transit loading / error toast — shown when the user enables Public
          Transit. Loading clears automatically on success; on failure the
          layer is auto-unchecked and an error message stays for a few seconds. */}
      {transitStatus && (
        <div
          className={`map-toast transit-status-toast transit-status-${transitStatus.kind}`}
          role={transitStatus.kind === 'error' ? 'alert' : 'status'}
        >
          {transitStatus.kind === 'loading' && <span className="transit-spinner" aria-hidden="true" />}
          {transitStatus.kind === 'error' && <span className="transit-status-icon" aria-hidden="true">⚠️</span>}
          <span className="map-toast-text">{transitStatus.text}</span>
          {transitStatus.kind === 'error' && (
            <button
              type="button"
              className="map-toast-dismiss"
              onClick={() => setTransitStatus(null)}
              aria-label="Dismiss"
            >
              ×
            </button>
          )}
        </div>
      )}

      {/* Floating action buttons (mobile bottom FABs + desktop open chips) */}
      {!layerPanelOpen && (
        <button
          className="layer-toggle-btn"
          onClick={() => {
            const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
            setLayerPanelOpen(true)
            if (isMobile) setAnalysisPanelOpen(false)
          }}
          aria-label="Open Map Layers panel"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></svg>
          <span className="fab-label">Map Layers</span>
        </button>
      )}
      {!analysisPanelOpen && (
        <button
          className="analysis-toggle-btn"
          onClick={() => {
            const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
            setAnalysisPanelOpen(true)
            if (isMobile) setLayerPanelOpen(false)
            setSheetHeight(null)
          }}
          aria-label="Open analysis"
        >
          <span className="fab-label">Report</span>
          {(() => {
            const checks = ['noise', 'superfund', 'costco', 'datacenters', 'er', 'crowd', 'broadband'] as const
            const done = checks.filter((k) => analysisProgress[k] === 'done').length
            if (done >= checks.length || Object.keys(analysisProgress).length === 0) return null
            return (
              <span className="fab-progress-badge" aria-label={`${done} of ${checks.length} ready`}>
                {done}/{checks.length}
              </span>
            )
          })()}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>
        </button>
      )}

      {/* Mobile backdrop */}
      {(layerPanelOpen || analysisPanelOpen) && (
        <div className="mobile-panel-backdrop" onClick={() => { setLayerPanelOpen(false); setAnalysisPanelOpen(false) }} />
      )}

      <aside ref={layerSheetRef} className={`layer-panel${layerPanelOpen ? ' is-open' : ''}`}>
        <div
          className="layer-drag-handle"
          onTouchStart={handleLayerTouchStart}
          onTouchMove={handleLayerTouchMove}
          onTouchEnd={handleLayerTouchEnd}
          aria-hidden="true"
        >
          <div className="layer-drag-bar" />
        </div>
        <button className="panel-close-btn" onClick={() => setLayerPanelOpen(false)} aria-label="Close Map Layers panel">×</button>
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

        <h2 className={`panel-title${baseMapSwitcherEnabled ? ' overlay-title' : ''}`}>Map Layers</h2>

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
                {transitLoading && <span className="transit-spinner transit-spinner-inline" aria-label="Loading" />}
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

        {/* ── Everyday amenities ── */}
        <details className="layer-group">
          <summary className="layer-group-heading">🏪 Day-to-day</summary>
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
          </div>
        </details>

        {/* ── Hazards & risk ── */}
        <details className="layer-group">
          <summary className="layer-group-heading">⚠️ Hazards & risk</summary>
          <div className="layer-group-body">
            <label className="layer-toggle">
              <input
                type="checkbox"
                checked={floodVisible}
                onChange={toggleFlood}
                disabled={status !== 'ready'}
              />
              <span className="layer-label">
                FEMA Flood Zones
                {floodLoading && <span className="layer-loading"> ⏳</span>}
              </span>
            </label>
            {floodVisible && (
              <div className="flood-legend">
                {floodLowZoom && (
                  <p className="flood-legend-hint">Zoom in to see flood zones.</p>
                )}
                {(['high', 'coastal', 'moderate', 'minimal', 'undetermined', 'water'] as const).map((bucket) => (
                  <div key={bucket} className="legend-swatch-row">
                    <span
                      className="legend-swatch flood"
                      style={{
                        background: FLOOD_ZONE_COLORS[bucket],
                        borderColor: FLOOD_ZONE_COLORS[bucket],
                        opacity: bucket === 'minimal' ? 0.6 : 1,
                      }}
                      aria-hidden="true"
                    />
                    <span>{FLOOD_ZONE_LABELS[bucket]}</span>
                  </div>
                ))}
              </div>
            )}

            <label className="layer-toggle">
              <input
                type="checkbox"
                checked={wildfireVisible}
                onChange={toggleWildfire}
                disabled={status !== 'ready'}
              />
              <span className="layer-label">
                Wildfire Hazard
                {wildfireLoading && <span className="layer-loading"> ⏳</span>}
              </span>
            </label>
            {wildfireVisible && (
              <div className="flood-legend">
                {wildfireLowZoom && (
                  <p className="flood-legend-hint">Zoom in to see wildfire hazard.</p>
                )}
                {WHP_CLASS_COLORS.map((cls) => (
                  <div key={cls.label} className="legend-swatch-row">
                    <span
                      className="legend-swatch flood"
                      style={{ background: cls.color, borderColor: cls.color }}
                      aria-hidden="true"
                    />
                    <span>{cls.label}</span>
                  </div>
                ))}
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
                checked={industrialVisible}
                onChange={toggleIndustrial}
                disabled={status !== 'ready'}
              />
              <span className="layer-label">
                Industrial Facilities
                {industrialLoading && <span className="layer-loading"> ⏳</span>}
              </span>
            </label>
            {industrialVisible && (
              <div className="flood-legend">
                {industrialNeedsAddress ? (
                  <p className="flood-legend-hint">Search an address to see industrial facilities.</p>
                ) : (
                  <p className="flood-legend-hint">Refineries, chemical plants &amp; paper mills within {INDUSTRIAL_RADIUS_MI} mi.</p>
                )}
                {INDUSTRIAL_INDUSTRIES.map((m) => (
                  <div key={m.key} className="legend-swatch-row">
                    <span
                      className="industrial-pin"
                      style={{
                        background: m.color,
                        width: 22,
                        height: 22,
                        fontSize: 12,
                        lineHeight: '22px',
                        display: 'inline-block',
                      }}
                      aria-hidden="true"
                    >{m.icon}</span>
                    <span>{m.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </details>

        {/* ── Livability ── */}
        <details className="layer-group">
          <summary className="layer-group-heading">🌱 Livability</summary>
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
                checked={aqiVisible}
                onChange={toggleAqi}
                disabled={status !== 'ready'}
              />
              <span className="layer-label">
                Air Quality (AQI)
                {aqiLoading && <span className="layer-loading"> ⏳</span>}
              </span>
            </label>
            {aqiVisible && (
              <div className="flood-legend">
                {aqiLowZoom && (
                  <p className="flood-legend-hint">Zoom in to see air-quality contours.</p>
                )}
                {([1, 2, 3, 4, 5, 6] as const).map((cat) => (
                  <div key={cat} className="legend-swatch-row">
                    <span
                      className="legend-swatch flood"
                      style={{ background: AQI_CATEGORY_COLORS[cat], borderColor: AQI_CATEGORY_COLORS[cat] }}
                      aria-hidden="true"
                    />
                    <span>{AQI_CATEGORY_LABELS[cat]}</span>
                  </div>
                ))}
                {aqiTimestamp && (
                  <p className="flood-legend-hint">
                    Updated {new Date(aqiTimestamp).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })} · EPA AirNow
                  </p>
                )}
              </div>
            )}
          </div>
        </details>

        {/* ── Development & infrastructure ── */}
        <details className="layer-group">
          <summary className="layer-group-heading">⚡ Infrastructure</summary>
          <div className="layer-group-body">
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
                checked={powerLineVisible}
                onChange={togglePowerLines}
                disabled={status !== 'ready'}
              />
              <span className="layer-label">
                Power Transmission Lines
                {powerLineLoading && <span className="layer-loading"> ⏳</span>}
              </span>
            </label>
            {powerLineVisible && (
              <div className="flood-legend">
                {powerLineLowZoom && (
                  <p className="flood-legend-hint">Zoom in to see transmission lines.</p>
                )}
                {POWER_VOLT_ORDER.map((cls) => (
                  <div key={cls} className="legend-swatch-row">
                    <span
                      className="legend-swatch power"
                      style={{ background: POWER_VOLT_COLORS[cls], borderColor: POWER_VOLT_COLORS[cls] }}
                      aria-hidden="true"
                    />
                    <span>{POWER_VOLT_LABELS[cls]}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </details>

        {/* ── People & oversight ── */}
        <details className="layer-group">
          <summary className="layer-group-heading">👥 People & oversight</summary>
          <div className="layer-group-body">
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

            <label className="layer-toggle">
              <input
                type="checkbox"
                checked={camerasVisible}
                onChange={toggleCameras}
                disabled={status !== 'ready'}
              />
              <span className="layer-label">
                ALPR Cameras
                {camerasLoading && <span className="layer-loading"> ⏳</span>}
              </span>
            </label>
            {camerasVisible && (
              <div className="dc-legend">
                <label className="transit-sub-toggle" style={{ pointerEvents: 'none' }}>
                  <span className="legend-dot" style={{ background: CAMERA_COLORS.flock }} />
                  <span>Flock Safety</span>
                </label>
                <label className="transit-sub-toggle" style={{ pointerEvents: 'none' }}>
                  <span className="legend-dot" style={{ background: CAMERA_COLORS.other }} />
                  <span>Other ALPR brands</span>
                </label>
                {camerasStatus && (
                  <div className="camera-status">
                    {camerasStatus.text}
                  </div>
                )}
                <div className="camera-attribution">
                  Source: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors via <a href="https://deflock.me/" target="_blank" rel="noopener noreferrer">DeFlock</a>. Coverage varies by region.
                </div>
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

      {/* Recon Report Panel */}
      <aside
        ref={sheetRef}
        className={`analysis-panel${analysisPanelOpen ? ' is-open' : ''}`}
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
          <h2>Recon Report</h2>
          <div className="analysis-header-actions">
            <button
              className="analysis-action-btn"
              onClick={() => setShowAbout(true)}
              title="About LandRecon"
              aria-label="About LandRecon"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            </button>
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
          <h1>LandRecon — Recon Report</h1>
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
                      ? `${analysisResults.superfunds.length} within ${SUPERFUND_ANALYSIS_RADIUS_MI} mi`
                      : `No Superfund sites within ${SUPERFUND_ANALYSIS_RADIUS_MI} miles`)}</p>
                  </div>
                  {pSF && <div className="analysis-card-spinner" aria-hidden="true" />}
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

          {/* Broadband at this address — FCC BDC */}
          {(() => {
            const bbLoading = analysisResults.broadbandLoading
            const bb = analysisResults.broadband
            const summary = bb?.summary || null
            const sev = bbLoading
              ? 'pending'
              : summary
                ? broadbandSeverity(summary.speedTier)
                : 'clear'
            const subtitle = bbLoading
              ? 'Looking up FCC providers…'
              : summary
                ? `${formatBroadbandSpeed(summary.maxDownMbps)} down · ${summary.providerCount} ${summary.providerCount === 1 ? 'provider' : 'providers'}${summary.hasFiber ? ' · Fiber' : ''}`
                : bb?.block
                  ? `${bb.block.county} County, ${bb.block.state} — index not yet built`
                  : 'Broadband data unavailable'
            return (
              <div className={`analysis-card ${sev}`}>
                <div
                  className={`analysis-item${bbLoading ? '' : ' clickable'}`}
                  onClick={() => {
                    if (bbLoading) return
                    if (analysisDetail === 'broadband') setAnalysisDetail(null)
                    else setAnalysisDetail('broadband')
                  }}
                  aria-busy={bbLoading || undefined}
                >
                  <div className={`analysis-chevron${analysisDetail === 'broadband' ? ' expanded' : ''}${bbLoading ? ' hidden' : ''}`}>‹</div>
                  <div className="analysis-icon">📶</div>
                  <div className="analysis-detail">
                    <strong>Broadband at this address</strong>
                    <p>{subtitle}</p>
                  </div>
                  {bbLoading && <div className="analysis-card-spinner" aria-hidden="true" />}
                </div>
              </div>
            )
          })()}

          {/* Costco — convenience tier, lowest weight, lives at the bottom of the report */}
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

      {showAbout && (
        <div className="about-overlay" onClick={() => setShowAbout(false)}>
          <div className="about-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="report-about-title">
            <div className="about-header">
              <h2 id="report-about-title">About LandRecon</h2>
              <button className="about-close" onClick={() => setShowAbout(false)} aria-label="Close About">×</button>
            </div>
            <div className="about-body">
              <p>
                LandRecon helps homebuyers and curious neighbors understand what's really around a property.
                Enter any U.S. address and instantly see airport noise levels, EPA Superfund sites, nearby
                data centers, retail proximity, and more — all scored and visualized on an interactive map.
              </p>
              <p>
                Our goal is to surface the hidden factors that affect where you live and work — the kind of
                details that don't show up in a typical listing but can make all the difference.
              </p>
              <h3>What we analyze</h3>
              <ul>
                <li>✈️ <strong>Airport Noise</strong> — FAA noise contour data mapped to your address</li>
                <li>☢️ <strong>Superfund Sites</strong> — EPA hazardous waste sites within 5 miles</li>
                <li>🛒 <strong>Retail Proximity</strong> — Distance to the nearest Costco (a surprisingly strong quality-of-life indicator)</li>
                <li>🏢 <strong>Data Centers</strong> — Nearby facilities that may bring noise, traffic, or infrastructure strain</li>
                <li>🏥 <strong>Emergency Rooms</strong> — Distance to the nearest hospital emergency department</li>
                <li>🎪 <strong>Crowd Magnets</strong> — Stadiums, arenas, and venues that drive seasonal traffic</li>
                <li>📶 <strong>Broadband</strong> — FCC-reported wired internet providers and speeds at the address</li>
              </ul>
              <h3>Optional map layers</h3>
              <p>
                Open the <strong>Map Layers</strong> panel to overlay wildfire risk, power transmission lines,
                FEMA flood zones, EPA industrial facilities, FCC broadband coverage, weather, air quality, and more on top of the map.
              </p>
              <h3>How scoring works</h3>
              <p>
                Categories are grouped into three tiers based on how much they affect daily life:
              </p>
              <ul>
                <li><strong>Safety</strong> (Airport Noise, Superfund, ER) — weighted heaviest</li>
                <li><strong>Lifestyle</strong> (Data Centers, Crowd Magnets, Broadband) — moderate weight</li>
                <li><strong>Convenience</strong> (Costco) — lightest weight</li>
              </ul>
              <p>
                Each category is evaluated and assigned a concern level. Tier weights are combined into
                an overall letter grade (A through F) so you can compare locations at a glance. Click
                the score bar for a full breakdown of how each factor contributed.
              </p>
              <p className="about-disclaimer">
                LandRecon is provided for informational purposes only. Data may not be complete or current.
                Always verify important findings through official sources before making decisions.
              </p>
            </div>
          </div>
        </div>
      )}
      {analysisDetail && !analysisResults.loading && (
        <aside className="analysis-popout" role="dialog" aria-modal="false" aria-label="Analysis detail">
          <div className="analysis-popout-header">
            <strong>
              {analysisDetail === 'score' ? '📊 Score Breakdown' :
               analysisDetail === 'noise' ? '✈️ Airport Noise' :
               analysisDetail === 'superfunds' ? '☢️ Superfund Sites' :
               analysisDetail === 'costco' ? '🛒 Nearest Costco' :
               analysisDetail === 'er' ? '🏥 Emergency Room' :
               analysisDetail === 'crowd' ? '🎟️ Crowd Magnets' :
               analysisDetail === 'broadband' ? '📶 Broadband at this Address' :
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
                    // Severity is derived from the score/max ratio so the
                    // visual stays correct regardless of which tier weight
                    // (1, 2, or 3) the row uses.
                    const ratio = b.max > 0 ? b.score / b.max : 0
                    const sevKey: 'clear' | 'warning' | 'danger' =
                      b.score === 0 ? 'clear' : ratio >= 0.9 ? 'danger' : 'warning'
                    const barColor = sevKey === 'clear' ? '#4caf50' : sevKey === 'warning' ? '#ffb300' : '#ef5350'
                    const statusLabel = sevKey === 'clear' ? 'No concerns' : sevKey === 'warning' ? 'Minor concern' : 'Notable concern'
                    const tierLabel = b.tier === 'safety' ? 'Safety' : b.tier === 'lifestyle' ? 'Lifestyle' : 'Convenience'
                    const explanations: Record<string, Record<'clear' | 'warning' | 'danger', string>> = {
                      'Airport Noise': {
                        clear: 'This location is outside all mapped airport noise contours, meaning aircraft noise is unlikely to be a concern.',
                        warning: 'This location falls within a moderate airport noise contour. You may notice aircraft during peak hours, but it is generally manageable for most residents.',
                        danger: 'This location is within a high noise zone (65+ dB DNL). Expect frequent, noticeable aircraft noise that may affect outdoor activities and sleep quality.'
                      },
                      'Superfund Sites': {
                        clear: `No EPA Superfund sites were found within ${SUPERFUND_ANALYSIS_RADIUS_MI} miles. This area is clear of known hazardous waste cleanup activity.`,
                        warning: 'A small number of Superfund sites are nearby. Residual risk may be limited, but due diligence is recommended.',
                        danger: `One or more active Superfund sites are within ${SUPERFUND_ANALYSIS_RADIUS_MI} miles. Active sites may pose environmental or health risks and could affect property values.`
                      },
                      'Emergency Room': {
                        clear: 'An emergency room is within close range. Quick access to emergency medical care is a significant safety advantage for this location.',
                        warning: 'An emergency room is at moderate distance. Response times may be longer during peak traffic, but access is still reasonable.',
                        danger: 'No emergency room was found nearby. Longer travel times to emergency care could be a concern, especially for families or elderly residents.'
                      },
                      'Data Centers': {
                        clear: 'No data centers were detected nearby. This area is clear of associated concerns like noise from cooling systems or heavy truck traffic.',
                        warning: 'A few data centers are nearby. Minor impacts from generator testing, backup diesel operations, or increased traffic are possible.',
                        danger: 'Multiple data centers are near this location. Expect potential noise from industrial cooling, periodic generator testing, and increased commercial vehicle traffic.'
                      },
                      'Crowd Magnets': {
                        clear: `No major venues, stadiums, or arenas were found within ${CROWD_ANALYSIS_RADIUS_MI} miles. Expect normal traffic patterns without event-driven surges.`,
                        warning: 'A nearby venue or attraction may bring seasonal traffic, event-night congestion, or noise during peak hours.',
                        danger: 'Multiple high-draw venues are close by. Expect significant event-driven traffic, parking pressure, and noise on game days, concert nights, or convention weekends.'
                      },
                      'Broadband': {
                        clear: 'Multiple providers offer high-speed (100+ Mbps) or gigabit service at this address. You should have plenty of options for fast, reliable internet.',
                        warning: 'Broadband is available but speeds are modest. Streaming and video calls work, but heavy households or remote workers may feel constrained.',
                        danger: 'This address is FCC-underserved (<25 Mbps down). Expect very limited wired options — consider fixed wireless, satellite, or cellular as alternatives.'
                      },
                      'Nearest Costco': {
                        clear: 'A Costco is within reasonable range. You magnificent, bulk-buying genius — rotisserie chickens practically deliver themselves at this distance.',
                        warning: 'A Costco is within reasonable range. You magnificent, bulk-buying genius — rotisserie chickens practically deliver themselves at this distance.',
                        danger: 'No Costco in sight. You\'ll be buying toilet paper like a regular person — one sad, normal-sized pack at a time. Our condolences.'
                      }
                    }
                    return (
                      <div className="score-breakdown-row" key={b.label}>
                        <div className="score-breakdown-label">
                          <span>{b.icon}</span>
                          <span>{b.label}</span>
                          <span className="score-breakdown-tier" title={`${tierLabel} tier · weighted up to ${b.max} pt${b.max === 1 ? '' : 's'}`}>{tierLabel}</span>
                          <span className="score-breakdown-status" style={{ color: barColor }}>{statusLabel}</span>
                        </div>
                        <div className="score-breakdown-bar-track">
                          <div className="score-breakdown-bar-fill" style={{ width: `${((b.max - b.score) / b.max) * 100}%`, background: barColor }} />
                        </div>
                        <p className="score-breakdown-detail">{b.detail}</p>
                        <p className="score-breakdown-explanation">{explanations[b.label]?.[sevKey] || ''}</p>
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
                      {analysisResults.superfunds.map((s, i) => {
                        const npl = NPL_STATUS_INFO[s.statusCode]
                        return (
                          <li key={i}>
                            <div>
                              <strong>{s.name}</strong> — {s.distanceMi} mi
                              <span className={`analysis-status ${s.status === 'Deleted' ? 'status-cleared' : 'status-active'}`}>
                                {s.status}
                              </span>
                            </div>
                            {(s.city || s.epaId) && (
                              <dl className="analysis-superfund-meta">
                                {s.city && (
                                  <>
                                    <dt>Location</dt>
                                    <dd>{s.city}</dd>
                                  </>
                                )}
                                {s.epaId && (
                                  <>
                                    <dt>EPA ID</dt>
                                    <dd className="mono">{s.epaId}</dd>
                                  </>
                                )}
                              </dl>
                            )}
                            {npl && (
                              <p className="analysis-superfund-npl-desc">{npl.desc}</p>
                            )}
                            {s.url && (
                              <a href={s.url} target="_blank" rel="noopener noreferrer" className="analysis-epa-link">
                                EPA Site Profile →
                              </a>
                            )}
                          </li>
                        )
                      })}
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
                    <p className="analysis-expand-level clear">No EPA Superfund sites found within {SUPERFUND_ANALYSIS_RADIUS_MI} miles of this address.</p>
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
                    <div className="analysis-expand-rec">
                      <strong>Status colors</strong>
                      <div className="analysis-dc-legend">
                        {DC_STATUSES.map((s) => (
                          <span key={s} className="analysis-dc-legend-item">
                            <span className="legend-dot" style={{ background: DC_STATUS_COLORS[s] }} />
                            {DC_STATUS_LABELS[s]}
                          </span>
                        ))}
                      </div>
                    </div>
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
                    <div className="analysis-expand-rec">
                      <strong>Status colors</strong>
                      <div className="analysis-dc-legend">
                        {DC_STATUSES.map((s) => (
                          <span key={s} className="analysis-dc-legend-item">
                            <span className="legend-dot" style={{ background: DC_STATUS_COLORS[s] }} />
                            {DC_STATUS_LABELS[s]}
                          </span>
                        ))}
                      </div>
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

            {analysisDetail === 'broadband' && (() => {
              const bb = analysisResults.broadband
              const summary = bb?.summary || null
              const block = bb?.block || null
              const tierLabel = (() => {
                const t = summary?.speedTier
                if (t === 'gig') return 'Gigabit available'
                if (t === 'fast') return '100+ Mbps available'
                if (t === 'served') return 'Served (25/3 Mbps minimum)'
                if (t === 'underserved') return 'Underserved (below 25/3 Mbps)'
                return ''
              })()
              const tierClass = broadbandSeverity(summary?.speedTier)
              return (
                <>
                  {summary ? (
                    <>
                      <p className={`analysis-expand-level ${tierClass}`}>{tierLabel}</p>
                      <div className="broadband-stats">
                        <div className="broadband-stat">
                          <span className="broadband-stat-label">Max download</span>
                          <strong>{formatBroadbandSpeed(summary.maxDownMbps)}</strong>
                        </div>
                        <div className="broadband-stat">
                          <span className="broadband-stat-label">Max upload</span>
                          <strong>{formatBroadbandSpeed(summary.maxUpMbps)}</strong>
                        </div>
                        <div className="broadband-stat">
                          <span className="broadband-stat-label">Providers</span>
                          <strong>{summary.providerCount}</strong>
                        </div>
                      </div>
                      {summary.technologies.length > 0 && (
                        <div className="broadband-tech-chips">
                          <span className="broadband-tech-chips-label">Available:</span>
                          {summary.technologies.map((t) => (
                            <span key={t.code} className={`broadband-tech-chip${t.code === 50 ? ' fiber' : ''}`}>
                              {t.label}
                            </span>
                          ))}
                        </div>
                      )}
                      {summary.providers && summary.providers.length > 0 && (
                        <ul className="analysis-expand-list broadband-providers">
                          {summary.providers.slice(0, 12).map((p, i) => (
                            <li key={`${p.name}|${p.tech}|${i}`} className="dc-analysis-item">
                              <div className="dc-analysis-header">
                                <span className="dc-status-dot" style={{ background: p.tech === 50 ? '#16a34a' : p.tech === 40 ? '#0ea5e9' : p.tech === 10 ? '#f59e0b' : p.tech === 61 ? '#6366f1' : '#9ca3af' }} />
                                <strong>{p.name}</strong>
                                <span className="dc-distance">{formatBroadbandSpeed(p.down)}</span>
                              </div>
                              <div className="dc-analysis-meta">
                                <span>{BROADBAND_TECH_LABELS[p.tech] || `Tech ${p.tech}`}</span>
                                <span> · {formatBroadbandSpeed(p.up)} up</span>
                                {p.br === 'B' && <span> · Business-only</span>}
                              </div>
                            </li>
                          ))}
                          {summary.providers.length > 12 && (
                            <li className="broadband-provider-more">+ {summary.providers.length - 12} more providers</li>
                          )}
                        </ul>
                      )}
                      <div className="analysis-expand-rec">
                        <strong>What this means</strong>
                        <p>
                          The FCC Broadband Data Collection shows the maximum <em>advertised</em>
                          speeds providers are willing to deliver to this census block. Real
                          throughput depends on plan tier, time of day, and last-mile build-out.
                          Fiber and cable are typically reliable; fixed wireless and DSL can vary
                          significantly. {summary.hasFiber ? 'Fiber availability is a strong positive — symmetric speeds, low latency, and meaningful future-proofing for streaming, remote work, and resale.' : 'Fiber is not yet built out here; expect cable, fixed wireless, or DSL as your primary options.'}
                        </p>
                      </div>
                      {bb?.asOfDate && (
                        <p style={{ fontSize: '0.7rem', color: '#888', marginTop: '10px' }}>
                          FCC BDC filing as of {bb.asOfDate} · Block {block?.blockFips}
                        </p>
                      )}
                    </>
                  ) : block ? (
                    <>
                      <p className="analysis-expand-level clear">
                        {block.county} County, {block.stateName}
                      </p>
                      <p style={{ fontSize: '0.85rem', color: '#ccc', marginTop: '12px' }}>
                        Census block <code>{block.blockFips}</code> resolved successfully, but the
                        per-block broadband index isn't built on this deployment yet.
                      </p>
                    </>
                  ) : (
                    <p className="analysis-expand-level clear">
                      Broadband lookup unavailable for this location.
                    </p>
                  )}
                </>
              )
            })()}

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
                  {canNativeShare && (
                    <button className="share-copy-button share-native-button" onClick={handleNativeShare}>
                      Share…
                    </button>
                  )}
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
        <Suspense fallback={null}>
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
              beforeShow: () => { setLayerPanelOpen(false); setAnalysisPanelOpen(false) },
            },
            {
              selector: '.layer-panel',
              title: '🗺️ Map Layers',
              content: 'Toggle map layers on and off — airport noise contours, Superfund sites, Costco locations, data centers, traffic, and more. On desktop, open it any time from the "Map Layers" chip at the top-left.',
              position: 'right',
              beforeShow: () => { setLayerPanelOpen(true); setAnalysisPanelOpen(false) },
            },
            {
              selector: '.analysis-panel',
              title: '📊 Recon Report',
              content: 'This panel shows a summary of what was found at this address. Each category card is clickable — tap one to see detailed findings in a flyout. The × in the header collapses it; reopen it any time with the "Report" chip at the top-right.',
              position: 'left',
              beforeShow: () => { setAnalysisPanelOpen(true); setLayerPanelOpen(false); setSheetHeight(null) },
            },
            {
              selector: '.analysis-score-bar',
              title: '🏆 Location Score',
              content: 'Your overall location grade based on all categories combined. Click it to see a full breakdown explaining how each factor contributed to the score.',
              position: 'left',
              beforeShow: () => { setAnalysisPanelOpen(true); setLayerPanelOpen(false) },
            },
            {
              selector: '.analysis-card',
              title: '🔍 Category Details',
              content: 'Click any category card to open a detailed flyout to the left with findings, recommendations, and links. The chevron indicates it\'s expandable.',
              position: 'left',
              beforeShow: () => { setAnalysisPanelOpen(true); setLayerPanelOpen(false) },
            },
            {
              selector: '.map-container',
              title: '🌍 Interactive Map',
              content: 'Explore the map freely — zoom, pan, and click on markers for more info. Layer data updates automatically as you navigate.',
              position: 'top',
              beforeShow: () => {
                const isMobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
                setLayerPanelOpen(false)
                if (isMobile) setAnalysisPanelOpen(false)
              },
            },
          ]}
        />
        </Suspense>
      )}

    </div>
  )
}

export default MapPage
