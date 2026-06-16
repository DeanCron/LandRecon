import { lazy, Suspense, useEffect, useRef, useState, useCallback, useMemo } from 'react'
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
import { debounce } from '../utils/perf'
import { trackEvent } from '../utils/analytics'
import { cachedPlacesSearchText } from '../utils/placesCache'
import { LEGEND_BANDS } from '../noise/legend'
import type { DistrictLayerId } from '../utils/districtsLayer'
import { DISTRICT_LAYER_LABELS, marginToColor, loadDistrictLayer } from '../utils/districtsLayer'
import { LR_DEBUG, dbg } from '../utils/debug'
import {
  FLOOD_MIN_ZOOM,
  FLOOD_ZONE_COLORS,
  FLOOD_ZONE_LABELS,
  floodBucket,
  floodZoneLabel,
  floodSeverity,
  fetchFloodFeatures,
  fetchFloodAtPoint,
} from '../map/flood'
import {
  SUPERFUND_API,
  SUPERFUND_ICON,
  superfundFeaturesToPoints,
  fetchSuperfundFeatures,
} from '../map/superfund'
import {
  type BroadbandResponse,
  broadbandSeverity,
  formatBroadbandSpeed,
  fetchBroadband,
  BROADBAND_TECH_LABELS,
} from '../map/broadband'
import { fetchCostcosViaPlaces, parseCostcoAddress } from '../map/costco'
import {
  readAnalysisCache,
  writeAnalysisCache,
  patchAnalysisCacheFlood,
  patchAnalysisCacheWildfire,
} from '../map/analysisCache'
import {
  type DevTodo,
  DEV_TODOS,
  readDevTodoItems,
  writeDevTodoItems,
  readDevTodoChecks,
  writeDevTodoChecks,
  fetchDevTodosFromServer,
  saveDevTodosToServer,
} from '../map/devTodos'
import { fetchOverpass } from '../map/overpass'
import {
  POWER_MIN_ZOOM,
  POWER_VOLT_COLORS,
  POWER_VOLT_ORDER,
  POWER_VOLT_LABELS,
  powerColor,
  fetchPowerLineFeatures,
} from '../map/power'
import {
  INDUSTRIAL_RADIUS_MI,
  INDUSTRIAL_INDUSTRIES,
  fetchIndustrialFacilities,
} from '../map/industrial'
import {
  WHP_MIN_ZOOM,
  WHP_MAX_USEFUL_ZOOM,
  WHP_CLASS_COLORS,
  buildWhpImageUrl,
  wildfireSeverity,
  fetchWildfireAtPoint,
  type WildfirePointResult,
} from '../map/wildfire'
import {
  AQI_MIN_ZOOM,
  AQI_CATEGORY_COLORS,
  AQI_CATEGORY_LABELS,
  aqiCategory,
  aqiColor,
  fetchAqiFeatures,
} from '../map/aqi'
import {
  SURGE_CATEGORIES,
  type SurgeCategory,
  SURGE_TILE_URL,
  SURGE_ATTRIBUTION,
} from '../map/surge'
import {
  SLR_LEVELS,
  type SlrLevel,
  SLR_TILE_URL,
  SLR_ATTRIBUTION,
} from '../map/slr'
import {
  type DataCenter,
  DC_STATUS_COLORS,
  DC_STATUSES,
  DC_STATUS_LABELS,
  DATA_CENTER_ANALYSIS_RADIUS_MI,
} from '../map/datacenters'
import {
  EMS_TYPES,
  type EmsType,
  EMS_COLORS,
  EMS_LABELS,
  EMS_ICONS,
  EMS_QUERIES,
} from '../map/ems'
import {
  type TransitStop,
  TRANSIT_COLORS,
  TRANSIT_LABELS,
  transitPopup,
} from '../map/transit'
import {
  CAMERA_COLORS,
  type CameraRecord,
  cameraPopup,
} from '../map/cameras'
import {
  CROWD_TYPES,
  type CrowdType,
  CROWD_COLORS,
  CROWD_LABELS,
  CROWD_ICONS,
  CROWD_LABEL_SINGULAR,
  CROWD_ANALYSIS_RADIUS_MI,
  type CrowdMagnet,
  fetchCrowdMagnets,
} from '../map/crowd'
import {
  CONUS_BOUNDS,
  loadCamerasSnapshot,
  loadCrowdSnapshot,
  loadTransitStopsSnapshot,
  loadTransitLinesSnapshot,
} from '../map/snapshots'
import {
  getExpFlag,
  costcoSeverity,
  noiseSeverity,
  superfundSeverity,
  dataCenterSeverity,
  crowdMagnetsSeverity,
  erSeverity,
  computeLocationGrade,
} from '../map/scoring'
import { patchTooltipClickBehavior } from '../map/tooltipFix'

// Enforce one consistent map-marker interaction on every device: hover shows
// the simple tooltip (desktop only) and a click/tap opens the detailed popup.
// Without this, Leaflet's built-in click->open-tooltip handler makes a tap on
// touch devices open both the tooltip and the popup, leaving the tooltip stuck
// on screen. See src/map/tooltipFix.ts for the full rationale.
patchTooltipClickBehavior(L)

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

// Costco Places search + address parsing live in src/map/costco.ts.

// FCC Broadband types + helpers live in src/map/broadband.ts.

// Analysis sessionStorage cache (schema + read/write/patch) lives in
// src/map/analysisCache.ts. Dev-todo storage lives in src/map/devTodos.ts.
const LEGEND_STOPS = LEGEND_BANDS

// ── FEMA National Flood Hazard Layer (NFHL) ────────────────────────────
// Flood constants, buckets, severity and fetchers live in src/map/flood.ts.


// Overpass proxy fetch helper + types live in src/map/overpass.ts.

// fetchTransitFromOverpass / loadTransitLines / loadBusLines now offload
// the network fetch + JSON.parse + element classification to a Web Worker
// (see src/workers/overpassWorker.ts). The main thread only receives the
// parsed, typed payload and creates the Leaflet polylines / markers.

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

function escPopupHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// Detailed click-popup for point facility markers. Mirrors the EPA
// industrial-facility popup so every pin behaves the same way: a simple
// hover tooltip plus this richer popup on click.
function facilityPopupHtml(opts: {
  title: string
  badges?: Array<{ text: string; color?: string }>
  rows?: Array<string | null | undefined | false>
  linkHref?: string | null
  linkText?: string
}): string {
  const badgeHtml = (opts.badges || [])
    .map((b, i) =>
      `<span style="display:inline-block;padding:1px 6px;${i ? 'margin-left:4px;' : ''}border-radius:3px;background:${b.color || '#eceff1'};color:${b.color ? '#fff' : '#37474f'};font-size:11px;font-weight:600">${escPopupHtml(b.text)}</span>`,
    )
    .join('')
  const rowsHtml = (opts.rows || [])
    .filter((r): r is string => Boolean(r))
    .map((r) => `<div style="font-size:12px;color:#555;margin-top:4px">${escPopupHtml(r)}</div>`)
    .join('')
  const linkHtml = opts.linkHref
    ? `<div style="margin-top:6px"><a href="${opts.linkHref}" target="_blank" rel="noopener noreferrer" style="font-size:12px">${escPopupHtml(opts.linkText || 'More info')} ↗</a></div>`
    : ''
  return `<div style="min-width:200px;max-width:280px">
     <div style="font-weight:700;font-size:13px;margin-bottom:4px">${escPopupHtml(opts.title)}</div>
     ${badgeHtml ? `<div>${badgeHtml}</div>` : ''}
     ${rowsHtml}
     ${linkHtml}
   </div>`
}

// Superfund details are now rendered in the analysis flyout
// (analysisDetail === 'superfunds'), not in the map hover tooltip.
// The map tooltip is just the site name.



const SHARE_LAYER_IDS = ['noise', 'superfund', 'flood', 'wildfire', 'aqi', 'transit', 'traffic', 'costco', 'datacenters', 'power', 'ems', 'crowd', 'cameras', 'industrial', 'surge', 'slr'] as const

type ShareLayerId = typeof SHARE_LAYER_IDS[number]

const COSTCO_ANALYSIS_RADIUS_MI = 100
const ER_ANALYSIS_RADIUS_MI = 15
const SUPERFUND_ANALYSIS_RADIUS_MI = 3

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
  // True while the map is animating a pan/zoom (e.g. a post-search flyTo).
  // Lets bounds-scoped layer loads wait for the final viewport.
  const mapMovingRef = useRef(false)
  const aqiLayerRef = useRef<L.GeoJSON | null>(null)
  const aqiLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const powerLineLayerRef = useRef<L.GeoJSON | null>(null)
  const powerLineLoadedBoundsRef = useRef<L.LatLngBounds | null>(null)
  const industrialLayerRef = useRef<L.LayerGroup | null>(null)
  // Tracks the L.LatLng we last fetched facilities for. When the searched
  // address changes (or the user re-enables the layer for a new target)
  // this ref is reset so loadIndustrialData refetches.
  const industrialFetchedKeyRef = useRef<string | null>(null)
  // NOAA coastal hazards — single L.TileLayer per parent layer; we swap
  // its URL template when the user picks a different category / SLR foot.
  const surgeLayerRef = useRef<L.TileLayer | null>(null)
  const slrLayerRef = useRef<L.TileLayer | null>(null)
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
  // In-flight guards for the GeoJSON polygon/line loaders below. Without
  // these, a zoom+pan in quick succession can launch overlapping fetches; an
  // older request resolving last would clobber the newer viewport's features
  // (and cache the wrong bbox). Mirrors transitStopsLoadingRef / camerasLoadingRef.
  const superfundLoadingRef = useRef(false)
  const floodLoadingRef = useRef(false)
  const aqiLoadingRef = useRef(false)
  const powerLineLoadingRef = useRef(false)
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
  const [surgeVisible, setSurgeVisible] = useState(false)
  const [surgeCategory, setSurgeCategory] = useState<SurgeCategory>(3)
  const [slrVisible, setSlrVisible] = useState(false)
  const [slrLevel, setSlrLevel] = useState<SlrLevel>(3)
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
  // Generic "a map layer failed to load its data" toast. Layer loaders that
  // would otherwise fail silently (console.warn only) push a friendly message
  // here so the user knows the data source was unavailable rather than
  // assuming the area is simply empty. Transit and cameras have their own
  // dedicated status toasts and don't use this one.
  const [layerNotice, setLayerNotice] = useState<string | null>(null)
  const notifyLayerErrorRef = useRef((label: string) => {
    setLayerNotice(`Couldn't load ${label}. The data source may be busy — try again in a moment.`)
  })
  // Voting districts — experimental layer set; each chamber loads lazily on
  // first toggle and is cached on the L.Map afterward.
  const districtLayerRefs = useRef<Record<DistrictLayerId, L.GeoJSON | null>>({
    cd118: null,
  })
  const [districtVisible, setDistrictVisible] = useState<Record<DistrictLayerId, boolean>>({
    cd118: false,
  })
  const [districtLoading, setDistrictLoading] = useState<Record<DistrictLayerId, boolean>>({
    cd118: false,
  })
  const [districtAvailable, setDistrictAvailable] = useState<Record<DistrictLayerId, boolean | null>>({
    cd118: null,
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
    floodZone: { bucket: string; zone: string; label: string } | null
    floodError: boolean
    floodLoading: boolean
    wildfireHazard: WildfirePointResult | null
    wildfireError: boolean
    wildfireLoading: boolean
  }>({ loading: true, noiseLevel: null, noiseAirport: null, noiseAirportCode: null, superfunds: [], costco: null, costcoNearby: [], costcoNearestBeyond: null, costcoError: false, costcoLoading: true, dataCenters: [], nearestER: null, erError: false, crowdMagnets: [], broadband: null, broadbandLoading: true, floodZone: null, floodError: false, floodLoading: true, wildfireHazard: null, wildfireError: false, wildfireLoading: true })
  const [analysisProgress, setAnalysisProgress] = useState<Record<string, 'pending' | 'done'>>({})
  const [analysisDetail, setAnalysisDetail] = useState<'noise' | 'superfunds' | 'costco' | 'datacenters' | 'er' | 'score' | 'crowd' | 'broadband' | 'flood' | 'wildfire' | null>(null)

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
  const [showClearLayers, setShowClearLayers] = useState(false)

  const saveCurrentAnalysis = useCallback(() => {
    if (analysisResults.loading || analysisResults.costcoLoading) {
      dbg('compare', 'Save skipped — analysis still loading')
      return
    }
    const grade = computeLocationGrade(analysisResults)
    const entry: SavedAnalysis = {
      address: address || 'Unknown',
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
    dbg('compare', `Saved "${entry.address}" (grade ${entry.grade}); ${next.length} saved`)
    setSavedAnalyses(next)
    localStorage.setItem('lr_saved_analyses', JSON.stringify(next))
  }, [address, analysisResults, savedAnalyses])

  const removeSavedAnalysis = useCallback((idx: number) => {
    const next = savedAnalyses.filter((_, i) => i !== idx)
    dbg('compare', `Removed saved entry #${idx}; ${next.length} remaining`)
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
      dbg('devtodos', `Saving to server: ${items.length} item(s)…`)
      const ok = await saveDevTodosToServer({ items, checks })
      dbg('devtodos', ok ? 'Server save OK' : 'Server save failed — falling back to localStorage-only')
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
    dbg('devtodos', 'Modal opened — fetching from server…')
    fetchDevTodosFromServer().then((data) => {
      if (cancelled) return
      if (data) {
        dbg('devtodos', `Server returned ${data.items.length} item(s); using server as source of truth`)
        setDevTodoItems(data.items.length > 0 ? data.items : DEV_TODOS)
        setDevTodoChecks(data.checks)
        writeDevTodoItems(data.items.length > 0 ? data.items : DEV_TODOS)
        writeDevTodoChecks(data.checks)
        setDevTodoSync('idle')
      } else {
        dbg('devtodos', 'Server unreachable or no token — staying in localStorage-only mode')
        setDevTodoSync('offline')
      }
    })
    return () => { cancelled = true }
  }, [devTodosOpen])

  const toggleDevTodo = (id: string) => {
    dbg('devtodos', `Toggle "${id}"`)
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
    dbg('devtodos', `Add "${label}" (${id})`)
    setDevTodoItems((prev) => {
      const next = [...prev, { id, label }]
      writeDevTodoItems(next)
      persistDevTodos(next, devTodoChecks)
      return next
    })
    setNewDevTodoText('')
  }
  const deleteDevTodo = (id: string) => {
    dbg('devtodos', `Delete "${id}"`)
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
    if (surgeVisible) active.push('surge')
    if (slrVisible) active.push('slr')
    if (active.length > 0) params.set('layers', active.join(','))
    if (activeBaseMap !== 'street') params.set('base', activeBaseMap)
    return `${window.location.origin}/map?${params.toString()}`
  }, [address, noiseVisible, superfundVisible, floodVisible, wildfireVisible, aqiVisible, transitVisible, trafficVisible, costcoVisible, dataCenterVisible, powerLineVisible, emsVisible, crowdVisible, camerasVisible, industrialVisible, surgeVisible, slrVisible, activeBaseMap])

  const handleShare = useCallback(() => {
    const url = buildShareUrl()
    setShareModalOpen(true)
    setShareLoading(false)
    setShareError(null)
    setShareCopied(false)
    setShareLongUrl(url)
    setShareUrl(url)
    trackEvent('share_click', {
      layer_count: [noiseVisible, superfundVisible, floodVisible, wildfireVisible, aqiVisible, transitVisible, trafficVisible, costcoVisible, dataCenterVisible, powerLineVisible, emsVisible, crowdVisible, camerasVisible, industrialVisible, surgeVisible, slrVisible].filter(Boolean).length,
    })
  }, [buildShareUrl, noiseVisible, superfundVisible, floodVisible, wildfireVisible, aqiVisible, transitVisible, trafficVisible, costcoVisible, dataCenterVisible, powerLineVisible, emsVisible, crowdVisible, camerasVisible, industrialVisible, surgeVisible, slrVisible])

  // GA4: emit one `layer_toggle` event per layer that changed state since
  // the last render. Keeps the analytics call sites out of every toggle
  // handler and is robust to new toggle paths (share-link replay).
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
    surge: surgeVisible,
    slr: slrVisible,
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
      surge: surgeVisible,
      slr: slrVisible,
    }
    const prev = prevLayerStateRef.current
    for (const k of Object.keys(next)) {
      if (prev[k] !== next[k]) {
        trackEvent('layer_toggle', { layer: k, action: next[k] ? 'on' : 'off' })
      }
    }
    prevLayerStateRef.current = next
  }, [noiseVisible, superfundVisible, floodVisible, wildfireVisible, aqiVisible, transitVisible, trafficVisible, costcoVisible, dataCenterVisible, powerLineVisible, emsVisible, crowdVisible, camerasVisible, industrialVisible, surgeVisible, slrVisible])

  const handleCopyShare = useCallback(async () => {
    const value = shareUrl || shareLongUrl
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setShareCopied(true)
      trackEvent('share_copy', { result: 'success' })
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
            trackEvent('locate_use', { result: 'no_us_address' })
            setErrorMsg('Land Recon currently supports US addresses only.')
            return
          }
          trackEvent('locate_use', { result: 'success' })
          submitAddressChange(resolved)
        } catch (err) {
          dbg('geocode', 'useMyLocation: reverseGeocode threw', err)
          trackEvent('locate_use', { result: 'error' })
          setLocating(false)
        }
      },
      (err) => {
        dbg('geocode', 'useMyLocation: geolocation rejected', err)
        trackEvent('locate_use', { result: 'denied' })
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
        const airportRows: string[] = []
        if (tags.icao) airportRows.push(`ICAO: ${tags.icao}`)
        if (tags.operator) airportRows.push(`Operator: ${tags.operator}`)
        L.marker([lat, lon], { icon })
          .bindTooltip(label, { direction: 'top', offset: [0, -16] })
          .bindPopup(facilityPopupHtml({
            title: name || iata,
            badges: iata ? [{ text: iata, color: '#1565c0' }] : [],
            rows: airportRows,
          }), { maxWidth: 320 })
          .addTo(layer)
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
        L.marker([p.lat, p.lng], { icon })
          .bindTooltip(tooltip, { direction: 'top', offset: [0, -16] })
          .bindPopup(facilityPopupHtml({
            title: locality ? `Costco — ${locality}` : 'Costco',
            badges: [{ text: 'Warehouse', color: '#0060a9' }],
            rows: [street || null],
          }), { maxWidth: 320 })
          .addTo(layer)
        known.add(p.id)
      }

      costcoLoadedBoundsRef.current = loaded ? loaded.extend(padded.getSouthWest()).extend(padded.getNorthEast()) : padded
    } catch (err) {
      console.warn('Costco label fetch failed:', err)
      notifyLayerErrorRef.current('Costco locations')
    }
  }, [])

  const loadSuperfundData = useCallback(async (map: L.Map, layer: L.GeoJSON) => {
    const bounds = map.getBounds()
    const loaded = superfundLoadedBoundsRef.current
    if (loaded && loaded.contains(bounds)) { dbg('superfund', 'Skipping — bounds already loaded'); return }
    if (superfundLoadingRef.current) { dbg('superfund', 'Skipping — load already in flight'); return }
    dbg('superfund', 'Loading Superfund sites…')

    setSuperfundLoading(true)
    superfundLoadingRef.current = true
    try {
      const padded = bounds.pad(0.5)
      const geojson = await fetchSuperfundFeatures(padded)
      dbg('superfund', `Got ${geojson.features?.length || 0} features`)
      layer.clearLayers()
      layer.addData(superfundFeaturesToPoints(geojson))
      superfundLoadedBoundsRef.current = padded
    } catch (err) {
      console.error('Failed to load Superfund data:', err)
      notifyLayerErrorRef.current('Superfund sites')
    } finally {
      setSuperfundLoading(false)
      superfundLoadingRef.current = false
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
    if (floodLoadingRef.current) { dbg('flood', 'Skipping — load already in flight'); return }
    dbg('flood', 'Loading FEMA flood zones…')

    setFloodLoading(true)
    floodLoadingRef.current = true
    try {
      // Smaller padding than other overlays: the FEMA polygons are heavy, so a
      // tighter query area loads markedly faster (a wide pad roughly tripled the
      // payload). Panning re-fetches a little sooner, which the progressive
      // paint below keeps feeling responsive.
      const padded = bounds.pad(0.15)
      // Paint progressively: clear once the first chunk (the parent query's
      // inland zones) lands, then append each subdivided quadrant's coastal
      // zones as they arrive instead of waiting on the slowest sub-request.
      let painted = false
      const geojson = await fetchFloodFeatures(padded, (chunk) => {
        if (!painted) { layer.clearLayers(); painted = true }
        layer.addData({ type: 'FeatureCollection', features: chunk } as GeoJSON.FeatureCollection)
      })
      dbg('flood', `Got ${geojson.features?.length || 0} features`)
      // No features at all (or no callback fired) — make sure the layer reflects
      // the empty result rather than stale geometry from a previous view.
      if (!painted) layer.clearLayers()
      floodLoadedBoundsRef.current = padded
    } catch (err) {
      console.error('Failed to load FEMA flood zones:', err)
      notifyLayerErrorRef.current('flood zones')
    } finally {
      setFloodLoading(false)
      floodLoadingRef.current = false
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
    if (aqiLoadingRef.current) { dbg('aqi', 'Skipping — load already in flight'); return }
    dbg('aqi', 'Loading AirNow AQI contours…')

    setAqiLoading(true)
    aqiLoadingRef.current = true
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
      notifyLayerErrorRef.current('air quality data')
    } finally {
      setAqiLoading(false)
      aqiLoadingRef.current = false
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
    if (powerLineLoadingRef.current) { dbg('power', 'Skipping — load already in flight'); return }
    dbg('power', 'Loading transmission lines…')

    setPowerLineLoading(true)
    powerLineLoadingRef.current = true
    try {
      const padded = bounds.pad(0.3)
      const geojson = await fetchPowerLineFeatures(padded)
      dbg('power', `Got ${geojson.features?.length || 0} features`)
      layer.clearLayers()
      layer.addData(geojson)
      powerLineLoadedBoundsRef.current = padded
    } catch (err) {
      console.error('Failed to load HIFLD transmission lines:', err)
      notifyLayerErrorRef.current('power transmission lines')
    } finally {
      setPowerLineLoading(false)
      powerLineLoadingRef.current = false
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
      notifyLayerErrorRef.current('industrial facilities')
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
      notifyLayerErrorRef.current('wildfire hazard')
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
          .bindTooltip(stop.name || 'Transit stop', { direction: 'top', offset: [0, -10] })
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
      // Flood is cached only once the FEMA query produced a determined result
      // (the floodZone key is present). Otherwise it stays pending and re-fetches.
      const floodIsCached = cached.floodZone !== undefined
      allDone['flood'] = floodIsCached ? 'done' : 'pending'
      const wildfireIsCached = cached.wildfireHazard !== undefined
      allDone['wildfire'] = wildfireIsCached ? 'done' : 'pending'
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        floodZone: floodIsCached ? (cached.floodZone as any) : null,
        floodError: false,
        floodLoading: !floodIsCached,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wildfireHazard: wildfireIsCached ? (cached.wildfireHazard as any) : null,
        wildfireError: false,
        wildfireLoading: !wildfireIsCached,
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
      // Flood is cached once determined; only re-fetch on a cache hit when the
      // cached entry predates the flood feature (no floodZone key stored).
      if (!floodIsCached) {
        fetchFloodAtPoint(lat, lng).then((fz) => {
          if (!isLatestRun()) return
          dbg('analysis', 'Flood result (cache-hit path):', fz ? `${fz.bucket} (${fz.zone})` : 'no mapped hazard')
          setAnalysisResults((prev) => ({ ...prev, floodZone: fz, floodError: false, floodLoading: false }))
          setAnalysisProgress((prev) => ({ ...prev, flood: 'done' }))
          patchAnalysisCacheFlood(lat, lng, fz)
        }).catch((err) => {
          dbg('analysis', 'Flood failed (cache-hit path):', err)
          if (!isLatestRun()) return
          setAnalysisResults((prev) => ({ ...prev, floodZone: null, floodError: true, floodLoading: false }))
          setAnalysisProgress((prev) => ({ ...prev, flood: 'done' }))
        })
      }
      if (!wildfireIsCached) {
        fetchWildfireAtPoint(lat, lng).then((wf) => {
          if (!isLatestRun()) return
          dbg('analysis', 'Wildfire result (cache-hit path):', wf ? `${wf.label} (${wf.value})` : 'no mapped hazard')
          setAnalysisResults((prev) => ({ ...prev, wildfireHazard: wf, wildfireError: false, wildfireLoading: false }))
          setAnalysisProgress((prev) => ({ ...prev, wildfire: 'done' }))
          patchAnalysisCacheWildfire(lat, lng, wf)
        }).catch((err) => {
          dbg('analysis', 'Wildfire failed (cache-hit path):', err)
          if (!isLatestRun()) return
          setAnalysisResults((prev) => ({ ...prev, wildfireHazard: null, wildfireError: true, wildfireLoading: false }))
          setAnalysisProgress((prev) => ({ ...prev, wildfire: 'done' }))
        })
      }
      return
    }

    setAnalysisResults({ loading: true, noiseLevel: null, noiseAirport: null, noiseAirportCode: null, superfunds: [], costco: null, costcoNearby: [], costcoNearestBeyond: null, costcoError: false, costcoLoading: true, dataCenters: [], nearestER: null, erError: false, crowdMagnets: [], broadband: null, broadbandLoading: true, floodZone: null, floodError: false, floodLoading: true, wildfireHazard: null, wildfireError: false, wildfireLoading: true })

    const checks = ['noise', 'superfund', 'costco', 'datacenters', 'er', 'crowd', 'broadband', 'flood', 'wildfire'] as const
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
    // here so the report can render as soon as these checks resolve. Each one
    // commits its own slice of state and marks itself done the moment it
    // individually resolves (see the commit chains below the IIFEs), so each
    // report tile flips to its real value as its check lands — never showing a
    // resolved-but-not-yet-committed state.
    // Check noise via PMTiles vector query, then find nearest airport
    const noiseP = (async () => {
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
      })()

    // Check Superfund sites within SUPERFUND_ANALYSIS_RADIUS_MI miles
    const superfundP = (async () => {
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
      })()

    // Data centers within radius (static JSON)
    const dataCenterP = (async () => {
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
      })()

    // Emergency Room proximity via Google Places
    const erP = (async () => {
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
      })()

    // Crowd magnets within 5mi (OSM Overpass)
    const crowdP = (async () => {
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
        }
      })()

    // Commit each check's result and mark it done together, the moment it
    // resolves, so each report tile's progress flag and its data stay in sync.
    noiseP.then((r) => {
      if (!isLatestRun()) return
      setAnalysisResults((prev) => ({ ...prev, noiseLevel: r?.level ?? null, noiseAirport: r?.airport ?? null, noiseAirportCode: r?.code ?? null }))
      markDone('noise')
    }).catch(() => {
      if (!isLatestRun()) return
      setAnalysisResults((prev) => ({ ...prev, noiseLevel: null, noiseAirport: null, noiseAirportCode: null }))
      markDone('noise')
    })
    superfundP.then((r) => {
      if (!isLatestRun()) return
      setAnalysisResults((prev) => ({ ...prev, superfunds: r }))
      markDone('superfund')
    }).catch(() => {
      if (!isLatestRun()) return
      setAnalysisResults((prev) => ({ ...prev, superfunds: [] }))
      markDone('superfund')
    })
    dataCenterP.then((r) => {
      if (!isLatestRun()) return
      setAnalysisResults((prev) => ({ ...prev, dataCenters: r }))
      markDone('datacenters')
    }).catch(() => {
      if (!isLatestRun()) return
      setAnalysisResults((prev) => ({ ...prev, dataCenters: [] }))
      markDone('datacenters')
    })
    erP.then((r) => {
      if (!isLatestRun()) return
      setAnalysisResults((prev) => ({ ...prev, nearestER: r, erError: false }))
      markDone('er')
    }).catch(() => {
      if (!isLatestRun()) return
      setAnalysisResults((prev) => ({ ...prev, nearestER: null, erError: true }))
      markDone('er')
    })
    crowdP.then((r) => {
      if (!isLatestRun()) return
      setAnalysisResults((prev) => ({ ...prev, crowdMagnets: r }))
      markDone('crowd')
    })

    const [noiseResult, superfundResult, dataCenterResult, erResult, crowdResult] = await Promise.allSettled([noiseP, superfundP, dataCenterP, erP, crowdP])

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
    // All in-batch values were already committed by the per-check chains above;
    // just flip the top-level loading flag so the grade/score section renders.
    setAnalysisResults((prev) => ({ ...prev, loading: false }))

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

    // FEMA flood zone for the exact point — same fire-and-forget pattern.
    // Captured for the cache write below; stays undefined ("not determined")
    // until the query produces a result so errors aren't cached as "no hazard".
    let floodForCache: unknown
    fetchFloodAtPoint(lat, lng).then((fz) => {
      if (!isLatestRun()) {
        dbg('analysis', 'Stale run — discarding Flood result')
        return
      }
      dbg('analysis', 'Flood result:', fz ? `${fz.bucket} (${fz.zone})` : 'no mapped hazard')
      setAnalysisResults((prev) => ({ ...prev, floodZone: fz, floodError: false, floodLoading: false }))
      floodForCache = fz
      patchAnalysisCacheFlood(lat, lng, fz)
      markDone('flood')
    }).catch((err) => {
      dbg('analysis', 'Flood failed:', err)
      if (!isLatestRun()) return
      setAnalysisResults((prev) => ({ ...prev, floodZone: null, floodError: true, floodLoading: false }))
      markDone('flood')
    })

    // USFS Wildfire Hazard Potential class for the exact point — same
    // fire-and-forget + cache-patch pattern as flood.
    let wildfireForCache: unknown
    fetchWildfireAtPoint(lat, lng).then((wf) => {
      if (!isLatestRun()) {
        dbg('analysis', 'Stale run — discarding Wildfire result')
        return
      }
      dbg('analysis', 'Wildfire result:', wf ? `${wf.label} (${wf.value})` : 'no mapped hazard')
      setAnalysisResults((prev) => ({ ...prev, wildfireHazard: wf, wildfireError: false, wildfireLoading: false }))
      wildfireForCache = wf
      patchAnalysisCacheWildfire(lat, lng, wf)
      markDone('wildfire')
    }).catch((err) => {
      dbg('analysis', 'Wildfire failed:', err)
      if (!isLatestRun()) return
      setAnalysisResults((prev) => ({ ...prev, wildfireHazard: null, wildfireError: true, wildfireLoading: false }))
      markDone('wildfire')
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
        // Omitted (left undefined) if flood hasn't resolved yet — the flood
        // .then patches it in once it lands.
        ...(floodForCache !== undefined ? { floodZone: floodForCache } : {}),
        ...(wildfireForCache !== undefined ? { wildfireHazard: wildfireForCache } : {}),
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
            const sfCity = [props.CITY_NAME, props.STATE_CODE].filter(Boolean).join(', ')
            const sfUrl = (props.URL_ALIAS_TXT as string | undefined)
              || (props.EPA_ID ? `https://cumulis.epa.gov/supercpad/CurSites/csitinfo.cfm?id=${props.EPA_ID}` : null)
            layer.bindTooltip(name, { direction: 'top', offset: [0, -16] })
            layer.bindPopup(facilityPopupHtml({
              title: name,
              badges: [{ text: 'EPA Superfund', color: '#b71c1c' }],
              rows: [sfCity || null, props.SITE_FEATURE_TYPE ? String(props.SITE_FEATURE_TYPE) : null],
              linkHref: sfUrl,
              linkText: 'EPA site report',
            }), { maxWidth: 320 })
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

        map.on('movestart zoomstart', () => { mapMovingRef.current = true })
        map.on('moveend zoomend', () => { mapMovingRef.current = false })

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
    // Intentionally re-run only on address/navigate change. Pulling in
    // runLocationAnalysis, loadIndustrialData, or industrialVisible would
    // re-init the entire map on unrelated re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

    // Capture the stable known-id Sets so the cleanup closure references
    // locals rather than ref.current. These refs are created once and only
    // mutated (add/clear), never reassigned, so this is equivalent.
    const airportKnownIds = airportKnownIdsRef.current
    const transitLinesKnownIds = transitLinesKnownIdsRef.current
    const busLinesKnownIds = busLinesKnownIdsRef.current
    const transitStopsKnownIds = transitStopsKnownIdsRef.current
    const costcoKnownIds = costcoKnownIdsRef.current
    const emsKnownIds = emsKnownIdsRef.current
    const crowdKnownIds = crowdKnownIdsRef.current
    const camerasKnownIds = camerasKnownIdsRef.current

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
      airportKnownIds.clear()
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
      surgeLayerRef.current = null
      slrLayerRef.current = null
      wildfireLayerRef.current = null
      wildfireRenderedBoundsRef.current = null
      transitLayerRef.current = null
      transitLineLayersRef.current = null
      transitLinesLoadedBoundsRef.current = null
      transitLinesKnownIds.clear()
      busLinesLoadedBoundsRef.current = null
      busLinesKnownIds.clear()
      transitSubLayersRef.current = null
      transitLoadedBoundsRef.current = null
      transitBusStopsLoadedBoundsRef.current = null
      transitStopsKnownIds.clear()
      costcoLayerRef.current = null
      costcoLoadedBoundsRef.current = null
      costcoKnownIds.clear()
      trafficLayerRef.current = null
      dataCenterLayerRef.current = null
      dataCenterSubLayersRef.current = null
      dataCenterDataRef.current = null
      emsLayerRef.current = null
      emsSubLayersRef.current = null
      emsLoadedBoundsRef.current = null
      emsKnownIds.clear()
      crowdLayerRef.current = null
      crowdSubLayersRef.current = null
      crowdLoadedBoundsRef.current = null
      crowdKnownIds.clear()
      camerasLayerRef.current = null
      camerasLoadedBoundsRef.current = null
      camerasKnownIds.clear()
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
      trackEvent('basemap_switch', { base: id })
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

  // Auto-dismiss the generic layer-error toast a few seconds after it appears.
  useEffect(() => {
    if (!layerNotice) return
    const t = setTimeout(() => setLayerNotice(null), 6000)
    return () => clearTimeout(t)
  }, [layerNotice])

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

  const handleAirportMove = useMemo(
    () => debounce(() => {
      const map = mapRef.current
      const layer = airportLayerRef.current
      if (map && layer) {
        loadAirportLabels(map, layer)
      }
    }, 250),
    [loadAirportLabels],
  )

  const handleCostcoMove = useMemo(
    () => debounce(() => {
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
        notifyLayerErrorRef.current('data centers')
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
      const dcTitle = dc.name || 'Data Center'
      const dcTip = [dc.operator ? `${dcTitle} (${dc.operator})` : dcTitle]
      if (dc.city || dc.state) dcTip.push([dc.city, dc.state].filter(Boolean).join(', '))
      const dcRows: string[] = []
      if (dc.operator) dcRows.push(`Operator: ${dc.operator}`)
      if (dc.address) dcRows.push(dc.address)
      const dcLoc = [dc.city, dc.state].filter(Boolean).join(', ')
      if (dcLoc) dcRows.push(dcLoc)
      if (dc.mw) dcRows.push(`Capacity: ${dc.mw} MW`)
      if (dc.sizerank && dc.sizerank !== 'Unknown') dcRows.push(dc.sizerank)
      L.marker([dc.lat, dc.lng], { icon })
        .bindTooltip(dcTip.join('<br/>'), { direction: 'top', offset: [0, -14] })
        .bindPopup(facilityPopupHtml({
          title: dcTitle,
          badges: [{ text: `Status: ${dc.status}`, color }],
          rows: dcRows,
        }), { maxWidth: 320 })
        .addTo(sub)
    }
  }, [])

  const handleDataCenterMove = useMemo(
    () => debounce(() => {
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
            .bindPopup(facilityPopupHtml({
              title: name || 'Emergency service',
              badges: [{ text: EMS_LABELS[type].replace(/s$/, ''), color }],
              rows: [address || null],
            }), { maxWidth: 320 })
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
      notifyLayerErrorRef.current('emergency services')
    } finally {
      setEmsLoading(false)
    }
  }, [])

  const handleEmsMove = useMemo(
    () => debounce(() => {
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
        const camLabel = cam.isFlock
          ? 'Flock Safety ALPR'
          : (cam.manufacturer ? `${cam.manufacturer} ALPR` : 'ALPR camera')
        L.marker([cam.lat, cam.lon], { icon: makeCameraIcon(color, cam.direction) })
          .bindTooltip(camLabel, { direction: 'top', offset: [0, -10] })
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
        setCamerasStatus({ kind: 'empty', text: 'No mapped surveillance cameras in this area' })
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

  const handleCamerasMove = useMemo(
    () => debounce(() => {
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
          .bindPopup(facilityPopupHtml({
            title: m.name || CROWD_LABEL_SINGULAR[m.type],
            badges: [{ text: CROWD_LABEL_SINGULAR[m.type], color }],
          }), { maxWidth: 320 })
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
      notifyLayerErrorRef.current('points of interest')
    } finally {
      setCrowdLoading(false)
    }
  }, [])

  const handleCrowdMove = useMemo(
    () => debounce(() => {
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

  const handleSuperfundMove = useMemo(
    () => debounce(() => {
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
      setFloodVisible(false)
    } else {
      enableFloodLayer()
    }
  }

  const handleFloodMove = useMemo(
    () => debounce(() => {
      const map = mapRef.current
      const layer = floodLayerRef.current
      if (map && layer) {
        loadFloodData(map, layer)
      }
    }, 250),
    [loadFloodData],
  )

  // Idempotently turn the FEMA flood overlay on for the current map view.
  // Shared by the manual layer toggle and the Recon Report auto-reveal below.
  const enableFloodLayer = useCallback(() => {
    const map = mapRef.current
    const layer = floodLayerRef.current
    if (!map || !layer || floodVisible) return
    layer.addTo(map)
    floodLoadedBoundsRef.current = null
    map.on('moveend', handleFloodMove)
    map.on('zoomend', handleFloodMove)
    setFloodVisible(true)
    if (mapMovingRef.current) {
      // A post-search flyTo is still animating — loading now would fetch an
      // intermediate, zoomed-out viewport and cache those wide bounds, leaving
      // the final view only partially populated. Wait for the map to settle.
      map.once('moveend', () => {
        floodLoadedBoundsRef.current = null
        loadFloodData(map, layer)
      })
    } else {
      loadFloodData(map, layer)
    }
  }, [floodVisible, loadFloodData, handleFloodMove])

  // When the Recon Report finds a moderate-or-higher flood risk (anything not
  // "green"), reveal the FEMA flood zones on the map automatically — scoped to
  // the visible viewport like the manual toggle. Fires once per flood result;
  // the user can still toggle the layer off and it won't re-enable for that
  // same result.
  const floodAutoShownForRef = useRef<unknown>(null)
  useEffect(() => {
    if (analysisProgress.flood !== 'done' || analysisResults.floodError) return
    const fz = analysisResults.floodZone
    if (!fz) return
    const sev = floodSeverity(fz.bucket as keyof typeof FLOOD_ZONE_COLORS)
    if (sev !== 'warning' && sev !== 'danger') return
    if (floodAutoShownForRef.current === fz) return
    floodAutoShownForRef.current = fz
    enableFloodLayer()
  }, [analysisProgress.flood, analysisResults.floodError, analysisResults.floodZone, enableFloodLayer])

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

  const handleAqiMove = useMemo(
    () => debounce(() => {
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

  const handlePowerLineMove = useMemo(
    () => debounce(() => {
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

  // NOAA Storm Surge — one cached XYZ tile layer per Saffir-Simpson
  // category. Sublayer changes are handled by tearing down the layer and
  // recreating it with the new URL template (Leaflet doesn't support
  // re-pointing a tileLayer in place).
  const toggleSurge = () => {
    const map = mapRef.current
    if (!map) return
    dbg('toggle', `surge → ${surgeVisible ? 'OFF' : 'ON'}`)
    if (surgeVisible) {
      if (surgeLayerRef.current) {
        map.removeLayer(surgeLayerRef.current)
        surgeLayerRef.current = null
      }
    } else {
      const layer = L.tileLayer(SURGE_TILE_URL(surgeCategory), {
        opacity: 0.6,
        maxNativeZoom: 14,
        maxZoom: 18,
        attribution: SURGE_ATTRIBUTION,
        pane: 'overlayPane',
      })
      layer.addTo(map)
      surgeLayerRef.current = layer
    }
    setSurgeVisible(!surgeVisible)
  }

  // Swap surge category while the layer is on. Tears down the old tile
  // layer and instantiates a new one pointed at the new MapServer.
  const changeSurgeCategory = (cat: SurgeCategory) => {
    if (cat === surgeCategory) return
    setSurgeCategory(cat)
    const map = mapRef.current
    if (!map || !surgeVisible) return
    if (surgeLayerRef.current) {
      map.removeLayer(surgeLayerRef.current)
      surgeLayerRef.current = null
    }
    const layer = L.tileLayer(SURGE_TILE_URL(cat), {
      opacity: 0.6,
      maxNativeZoom: 14,
      maxZoom: 18,
      attribution: SURGE_ATTRIBUTION,
      pane: 'overlayPane',
    })
    layer.addTo(map)
    surgeLayerRef.current = layer
  }

  // NOAA Sea-Level Rise — same pattern as surge but with foot increments
  // 0–10. Each foot is its own MapServer on coast.noaa.gov.
  const toggleSlr = () => {
    const map = mapRef.current
    if (!map) return
    dbg('toggle', `slr → ${slrVisible ? 'OFF' : 'ON'}`)
    if (slrVisible) {
      if (slrLayerRef.current) {
        map.removeLayer(slrLayerRef.current)
        slrLayerRef.current = null
      }
    } else {
      const layer = L.tileLayer(SLR_TILE_URL(slrLevel), {
        opacity: 0.6,
        maxNativeZoom: 16,
        maxZoom: 18,
        attribution: SLR_ATTRIBUTION,
        pane: 'overlayPane',
      })
      layer.addTo(map)
      slrLayerRef.current = layer
    }
    setSlrVisible(!slrVisible)
  }

  const changeSlrLevel = (ft: SlrLevel) => {
    if (ft === slrLevel) return
    setSlrLevel(ft)
    const map = mapRef.current
    if (!map || !slrVisible) return
    if (slrLayerRef.current) {
      map.removeLayer(slrLayerRef.current)
      slrLayerRef.current = null
    }
    const layer = L.tileLayer(SLR_TILE_URL(ft), {
      opacity: 0.6,
      maxNativeZoom: 16,
      maxZoom: 18,
      attribution: SLR_ATTRIBUTION,
      pane: 'overlayPane',
    })
    layer.addTo(map)
    slrLayerRef.current = layer
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
      enableWildfireLayer()
    }
    setWildfireVisible(!wildfireVisible)
  }

  const handleWildfireMove = useMemo(
    () => debounce(() => {
      const map = mapRef.current
      if (map) loadWildfireData(map)
    }, 300),
    [loadWildfireData],
  )

  // Idempotently turn the USFS wildfire overlay on for the current map view.
  // Shared by the manual layer toggle and the Recon Report auto-reveal below.
  const enableWildfireLayer = useCallback(() => {
    const map = mapRef.current
    if (!map || wildfireVisible) return
    map.on('moveend', handleWildfireMove)
    map.on('zoomend', handleWildfireMove)
    setWildfireVisible(true)
    if (mapMovingRef.current) {
      // A post-search flyTo is still animating; wait for the map to settle so
      // we render the final viewport rather than an intermediate one.
      map.once('moveend', () => loadWildfireData(map))
    } else {
      loadWildfireData(map)
    }
  }, [wildfireVisible, loadWildfireData, handleWildfireMove])

  // When the Recon Report finds a High-or-higher wildfire hazard, reveal the
  // USFS overlay on the map automatically — scoped to the visible viewport like
  // the manual toggle. Fires once per result; a manual toggle-off stays off for
  // that same result.
  const wildfireAutoShownForRef = useRef<unknown>(null)
  useEffect(() => {
    if (analysisProgress.wildfire !== 'done' || analysisResults.wildfireError) return
    const wf = analysisResults.wildfireHazard
    if (!wf) return
    if (wildfireSeverity(wf.value) !== 'danger') return
    if (wildfireAutoShownForRef.current === wf) return
    wildfireAutoShownForRef.current = wf
    enableWildfireLayer()
  }, [analysisProgress.wildfire, analysisResults.wildfireError, analysisResults.wildfireHazard, enableWildfireLayer])

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

  const handleTransitMove = useMemo(
    () => debounce(() => {
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
    const unknown = [...requested].filter((id) => !SHARE_LAYER_IDS.includes(id as ShareLayerId))
    if (unknown.length) dbg('share', `Ignoring unknown layer id(s) from share link: ${unknown.join(', ')}`)
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
    if (requested.has('surge')) toggleSurge()
    if (requested.has('slr')) toggleSlr()
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
            .bindPopup(facilityPopupHtml({
              title: s.name,
              badges: [{ text: s.status || 'EPA Superfund', color: '#b71c1c' }],
              rows: [s.city || null, `${s.distanceMi} mi away`],
              linkHref: s.url || null,
              linkText: 'EPA site report',
            }), { maxWidth: 320 })
            .addTo(layer)
        }
      }
    }

    // Costco highlight pins are dropped by a dedicated effect below (Costco
    // results arrive in a deferred state update that doesn't toggle
    // `loading`, so they cannot be handled in this effect).

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
        .bindPopup(facilityPopupHtml({
          title: er.name,
          badges: [{ text: 'Emergency Room', color: '#0072B2' }],
          rows: [er.address || null, `${er.distanceMi} mi away`],
        }), { maxWidth: 320 })
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
          const dcTitle = dc.name || 'Data Center'
          const dcTip = [dc.operator ? `${dcTitle} (${dc.operator})` : dcTitle]
          if (dc.city || dc.state) dcTip.push([dc.city, dc.state].filter(Boolean).join(', '))
          const dcRows: string[] = []
          if (dc.operator) dcRows.push(`Operator: ${dc.operator}`)
          const dcLoc = [dc.city, dc.state].filter(Boolean).join(', ')
          if (dcLoc) dcRows.push(dcLoc)
          dcRows.push(`${dc.distanceMi} mi away`)
          if (dc.mw) dcRows.push(`Capacity: ${dc.mw} MW`)
          if (dc.sizerank && dc.sizerank !== 'Unknown') dcRows.push(dc.sizerank)
          L.marker([dc.lat, dc.lng], { icon })
            .bindTooltip(dcTip.join('<br/>'), { direction: 'top', offset: [0, -14] })
            .bindPopup(facilityPopupHtml({
              title: dcTitle,
              badges: [{ text: `Status: ${dc.status}`, color }],
              rows: dcRows,
            }), { maxWidth: 320 })
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
            .bindPopup(facilityPopupHtml({
              title: m.name || CROWD_LABEL_SINGULAR[m.type],
              badges: [{ text: CROWD_LABEL_SINGULAR[m.type], color }],
              rows: [`${m.distanceMi} mi away`],
            }), { maxWidth: 320 })
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

  // Costco highlight pin — kept separate from the main analysis effect above
  // because Costco results arrive in a *deferred* state update (after
  // analysisResults.loading has already flipped to false). Keying this effect
  // on the Costco fields means the pin is drawn both on a cache-hit revisit
  // (Costco set synchronously) and on a fresh, uncached analysis (Costco set
  // later). It deliberately does NOT re-fit the map — the main effect already
  // framed the viewport, and re-panning a second later would be jarring.
  useEffect(() => {
    if (!mapRef.current) return
    const layer = costcoAnalysisLayerRef.current
    if (!layer) return
    layer.clearLayers()
    if (analysisResults.loading) return
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
        .bindPopup(facilityPopupHtml({
          title: c.city ? `Costco — ${c.city}` : 'Costco',
          badges: [{ text: 'Warehouse', color: '#0060a9' }],
          rows: [c.address || null, `${c.distanceMi} mi away`],
        }), { maxWidth: 320 })
        .addTo(layer)
    }
  }, [analysisResults.loading, analysisResults.costcoNearby, analysisResults.costcoNearestBeyond])

  // Stamp the computed grade onto the Recent search entry so the home page
  // can show it as a badge next to the address. Also emit a one-time
  // `location_grade` GA4 event per address — the Recon Report grade is the
  // product's signature output, so its A-F distribution is a key signal.
  const lastGradedAddrRef = useRef<string | null>(null)
  useEffect(() => {
    if (analysisResults.loading || analysisResults.costcoLoading) return
    if (!address) return
    const g = computeLocationGrade(analysisResults)
    updateRecentSearchGrade(address, g.letter, g.color)
    if (lastGradedAddrRef.current !== address) {
      lastGradedAddrRef.current = address
      trackEvent('location_grade', { grade: g.letter, pct: Math.round(g.pct * 100) })
    }
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
          const checks = ['noise', 'superfund', 'costco', 'datacenters', 'er', 'crowd', 'broadband', 'flood'] as const
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

      {/* Generic layer-load failure toast — any environmental/POI layer whose
          data fetch fails surfaces a short, dismissible message here so the
          empty map isn't mistaken for "nothing in this area." */}
      {layerNotice && (
        <div className="map-toast layer-error-toast transit-status-error" role="alert">
          <span className="transit-status-icon" aria-hidden="true">⚠️</span>
          <span className="map-toast-text">{layerNotice}</span>
          <button
            type="button"
            className="map-toast-dismiss"
            onClick={() => setLayerNotice(null)}
            aria-label="Dismiss"
          >
            ×
          </button>
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
            const checks = ['noise', 'superfund', 'costco', 'datacenters', 'er', 'crowd', 'broadband', 'flood'] as const
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

      {/* Compare: map-level entry point + dedicated overlay */}
      {savedAnalyses.length > 0 && !showCompare && (
        <button
          className="compare-fab"
          onClick={() => { dbg('compare', `Overlay opened (${savedAnalyses.length} saved)`); setShowCompare(true) }}
          title={`Compare (${savedAnalyses.length} saved)`}
          aria-label={`Compare ${savedAnalyses.length} saved location${savedAnalyses.length === 1 ? '' : 's'}`}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>
          <span className="fab-label">Compare</span>
          <span className="compare-fab-badge">{savedAnalyses.length}</span>
        </button>
      )}
      {showCompare && savedAnalyses.length > 0 && (
        <div className="compare-overlay" role="dialog" aria-modal="true" aria-label="Compare saved locations">
          <div className="compare-overlay-backdrop" onClick={() => { dbg('compare', 'Overlay closed (backdrop)'); setShowCompare(false) }} />
          <div className="compare-overlay-panel">
            <div className="compare-overlay-header">
              <h2 className="compare-overlay-title">Compare Locations</h2>
              <button className="compare-overlay-close" onClick={() => { dbg('compare', 'Overlay closed'); setShowCompare(false) }} aria-label="Close comparison">×</button>
            </div>
            <div className="compare-overlay-body">
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
          </div>
        </div>
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
                <p className="flood-legend-hint">USFS Wildfire Hazard Potential (2023). Non-burnable covers developed/agricultural land; hazard reflects the surrounding wildland.</p>
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

        {/* ── Coastal hazards ── */}
        <details className="layer-group">
          <summary className="layer-group-heading">🌊 Coastal hazards</summary>
          <div className="layer-group-body">
            <label className="layer-toggle">
              <input
                type="checkbox"
                checked={surgeVisible}
                onChange={toggleSurge}
                disabled={status !== 'ready'}
              />
              <span className="layer-label">Hurricane Storm Surge</span>
            </label>
            {surgeVisible && (
              <div className="flood-legend">
                <p className="flood-legend-hint">Max water depth from a Saffir-Simpson category storm (NOAA SLOSH model). Coastal US, PR, USVI only.</p>
                <div className="surge-cat-row">
                  {SURGE_CATEGORIES.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      className={`surge-cat-btn${surgeCategory === cat ? ' active' : ''}`}
                      onClick={() => changeSurgeCategory(cat)}
                      aria-pressed={surgeCategory === cat}
                      title={`Category ${cat} hurricane storm surge`}
                    >
                      Cat {cat}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <label className="layer-toggle">
              <input
                type="checkbox"
                checked={slrVisible}
                onChange={toggleSlr}
                disabled={status !== 'ready'}
              />
              <span className="layer-label">Sea-Level Rise</span>
            </label>
            {slrVisible && (
              <div className="flood-legend">
                <p className="flood-legend-hint">Land permanently inundated at the selected feet of sea-level rise. Coastal US only.</p>
                <div className="slr-level-row">
                  <input
                    type="range"
                    min={SLR_LEVELS[0]}
                    max={SLR_LEVELS[SLR_LEVELS.length - 1]}
                    step={1}
                    value={slrLevel}
                    onChange={(e) => changeSlrLevel(Number(e.target.value) as SlrLevel)}
                    className="slr-slider"
                    aria-label="Sea-level rise in feet"
                  />
                  <span className="slr-level-label">{slrLevel} ft</span>
                </div>
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
                Surveillance Cameras
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

            <label className="layer-toggle">
              <input
                type="checkbox"
                checked={districtVisible.cd118}
                onChange={() => toggleDistrict('cd118')}
                disabled={status !== 'ready' || districtLoading.cd118}
              />
              <span className="layer-label">
                {DISTRICT_LAYER_LABELS.cd118}
                {districtLoading.cd118 && <span className="layer-loading"> ⏳</span>}
                {districtAvailable.cd118 === false && (
                  <span className="layer-loading" title="Boundary loaded but no result data on file"> · outline only</span>
                )}
              </span>
            </label>
            {districtVisible.cd118 && (
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
            <button
              className="analysis-action-btn"
              onClick={saveCurrentAnalysis}
              disabled={analysisResults.loading || analysisResults.costcoLoading}
              title="Save for comparison"
              aria-label="Save for comparison"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
            </button>
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
              <div className="analysis-score-bar" onClick={() => { if (!showScoreBreakdown) trackEvent('score_breakdown_open', { grade: grade.letter }); setShowScoreBreakdown(!showScoreBreakdown); setAnalysisDetail(showScoreBreakdown ? null : 'score') }} style={{ cursor: 'pointer' }} title="Click for score breakdown">
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
        <div className="analysis-content">
          {(() => {
            type CardDesc = { key: string; severity: string; node: React.ReactNode }
            const cards: CardDesc[] = []

            {
              const pNoise = analysisProgress.noise !== 'done'
              const severity = pNoise ? 'pending' : (analysisResults.noiseLevel ? noiseSeverity(analysisResults.noiseLevel) : 'clear')
              cards.push({ key: 'noise', severity, node: (
                <div className={`analysis-card ${severity}`} key="noise">
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
              ) })
            }

            {
              const pSF = analysisProgress.superfund !== 'done'
              const severity = pSF ? 'pending' : superfundSeverity(analysisResults.superfunds)
              cards.push({ key: 'superfunds', severity, node: (
                <div className={`analysis-card ${severity}`} key="superfunds">
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
              ) })
            }

            {
              const pER = analysisProgress.er !== 'done'
              const severity = pER ? 'pending' : (analysisResults.nearestER ? (erSeverity(analysisResults.nearestER.distanceMi) === 'clear' || erSeverity(analysisResults.nearestER.distanceMi) === 'good' ? 'clear' : erSeverity(analysisResults.nearestER.distanceMi)) : 'danger')
              cards.push({ key: 'er', severity, node: (
                <div className={`analysis-card ${severity}`} key="er">
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
              ) })
            }

            {
              const pDC = analysisProgress.datacenters !== 'done'
              const severity = pDC ? 'pending' : dataCenterSeverity(analysisResults.dataCenters.length)
              cards.push({ key: 'datacenters', severity, node: (
                <div className={`analysis-card ${severity}`} key="datacenters">
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
              ) })
            }

            {
              const pCrowd = analysisProgress.crowd !== 'done'
              const severity = pCrowd ? 'pending' : crowdMagnetsSeverity(analysisResults.crowdMagnets.length)
              cards.push({ key: 'crowd', severity, node: (
                <div className={`analysis-card ${severity}`} key="crowd">
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
              ) })
            }

            {
              const pFlood = analysisProgress.flood !== 'done'
              const fz = analysisResults.floodZone
              const severity = pFlood
                ? 'pending'
                : analysisResults.floodError
                  ? 'clear'
                  : fz
                    ? floodSeverity(fz.bucket as keyof typeof FLOOD_ZONE_COLORS)
                    : 'clear'
              const subtitle = pFlood
                ? 'Checking…'
                : analysisResults.floodError
                  ? 'Flood data unavailable'
                  : fz
                    ? FLOOD_ZONE_LABELS[fz.bucket]
                    : 'Minimal flood hazard'
              cards.push({ key: 'flood', severity, node: (
                <div className={`analysis-card ${severity}`} key="flood">
                  <div
                    className={`analysis-item${pFlood ? '' : ' clickable'}`}
                    onClick={() => {
                      if (pFlood) return
                      if (analysisDetail === 'flood') setAnalysisDetail(null)
                      else setAnalysisDetail('flood')
                    }}
                    aria-busy={pFlood || undefined}
                  >
                    <div className={`analysis-chevron${analysisDetail === 'flood' ? ' expanded' : ''}${pFlood ? ' hidden' : ''}`}>‹</div>
                    <div className="analysis-icon">🌊</div>
                    <div className="analysis-detail">
                      <strong>Flood Zone</strong>
                      <p>{subtitle}</p>
                    </div>
                    {pFlood && <div className="analysis-card-spinner" aria-hidden="true" />}
                  </div>
                </div>
              ) })
            }

            {
              const pWildfire = analysisProgress.wildfire !== 'done'
              const wf = analysisResults.wildfireHazard
              const severity = pWildfire
                ? 'pending'
                : analysisResults.wildfireError
                  ? 'clear'
                  : wf
                    ? wildfireSeverity(wf.value)
                    : 'clear'
              const subtitle = pWildfire
                ? 'Checking…'
                : analysisResults.wildfireError
                  ? 'Wildfire data unavailable'
                  : wf
                    ? `${wf.label} wildfire hazard`
                    : 'Minimal wildfire hazard'
              cards.push({ key: 'wildfire', severity, node: (
                <div className={`analysis-card ${severity}`} key="wildfire">
                  <div
                    className={`analysis-item${pWildfire ? '' : ' clickable'}`}
                    onClick={() => {
                      if (pWildfire) return
                      if (analysisDetail === 'wildfire') setAnalysisDetail(null)
                      else setAnalysisDetail('wildfire')
                    }}
                    aria-busy={pWildfire || undefined}
                  >
                    <div className={`analysis-chevron${analysisDetail === 'wildfire' ? ' expanded' : ''}${pWildfire ? ' hidden' : ''}`}>‹</div>
                    <div className="analysis-icon">🔥</div>
                    <div className="analysis-detail">
                      <strong>Wildfire Hazard</strong>
                      <p>{subtitle}</p>
                    </div>
                    {pWildfire && <div className="analysis-card-spinner" aria-hidden="true" />}
                  </div>
                </div>
              ) })
            }

            {
              // Broadband at this address — FCC BDC
              const bbLoading = analysisResults.broadbandLoading
              const bb = analysisResults.broadband
              const summary = bb?.summary || null
              const severity = bbLoading
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
              cards.push({ key: 'broadband', severity, node: (
                <div className={`analysis-card ${severity}`} key="broadband">
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
              ) })
            }

            {
              // Costco — convenience tier, lowest weight, lives at the bottom of the report
              const severity = analysisResults.costcoLoading ? 'pending' : analysisResults.costco ? costcoSeverity(analysisResults.costco.distanceMi) : analysisResults.costcoError ? 'clear' : 'danger'
              cards.push({ key: 'costco', severity, node: (
                <div className={`analysis-card ${severity}`} key="costco">
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
              ) })
            }

            const isProblem = (s: string) => s === 'warning' || s === 'danger'
            const problems = cards.filter((c) => isProblem(c.severity))
            const pending = cards.filter((c) => c.severity === 'pending')
            const cleared = cards.filter((c) => c.severity !== 'pending' && !isProblem(c.severity))

            return (
              <>
                {problems.length > 0 && <div className="analysis-group-head">Needs attention</div>}
                {problems.map((c) => c.node)}
                {pending.map((c) => c.node)}
                {cleared.length > 0 && (
                  <>
                    <button
                      type="button"
                      className="analysis-clear-toggle"
                      onClick={() => setShowClearLayers((v) => !v)}
                      aria-expanded={showClearLayers}
                    >
                      <span>✓ {cleared.length} {cleared.length === 1 ? 'layer' : 'layers'} clear</span>
                      <span className={`analysis-chevron${showClearLayers ? ' expanded' : ''}`}>‹</span>
                    </button>
                    {showClearLayers && cleared.map((c) => c.node)}
                  </>
                )}
              </>
            )
          })()}
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
               analysisDetail === 'flood' ? '🌊 Flood Zone' :
               analysisDetail === 'wildfire' ? '🔥 Wildfire Hazard' :
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
                      },
                      'Flood Zone': {
                        clear: 'This address is outside FEMA\'s moderate- and high-risk flood zones. Flood insurance is generally not federally required, though no area is completely risk-free.',
                        warning: 'This address is in a moderate-risk zone (0.2% annual-chance / "500-year" floodplain). Flood insurance is usually optional but recommended — moderate-risk areas still see a meaningful share of claims.',
                        danger: 'This address is in a Special Flood Hazard Area (1% annual-chance / "100-year" floodplain) or coastal V zone. Federally backed mortgages require flood insurance, premiums run higher, and flood risk is real.'
                      },
                      'Wildfire Hazard': {
                        clear: 'This address is in a Low / Very Low USFS wildfire hazard class (or a non-burnable developed/water area). Wildfire risk here is minimal, though no area is entirely risk-free.',
                        warning: 'This address is in a Moderate wildfire hazard class. Risk is real but lower — defensible space and ember-resistant home hardening are still worthwhile precautions.',
                        danger: 'This address is in a High or Very High wildfire hazard class. Expect stricter insurance underwriting and higher premiums, defensible-space obligations, and meaningful wildfire risk in fire season.'
                      }
                    }
                    return (
                      <div className="score-breakdown-row" key={b.label}>
                        <div className="score-breakdown-label">
                          <span>{b.icon}</span>
                          <span>{b.label}</span>
                          <span className="score-breakdown-tier" title={`${tierLabel} tier · ${b.max === 1 ? 'sole factor in its tier' : `weight ${b.max} within the ${tierLabel} tier`}`}>{tierLabel}</span>
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

            {analysisDetail === 'flood' && (() => {
              const fz = analysisResults.floodZone
              const sev = analysisResults.floodError ? 'clear' : fz ? floodSeverity(fz.bucket as keyof typeof FLOOD_ZONE_COLORS) : 'clear'
              if (analysisResults.floodError) {
                return (
                  <>
                    <p className="analysis-expand-level clear">FEMA flood data couldn’t be loaded for this location.</p>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        Flood zone designation affects flood-insurance requirements, premiums, and risk.
                        Try re-analyzing, or look up the address directly on the{' '}
                        <a href="https://msc.fema.gov/portal/home" target="_blank" rel="noopener noreferrer">FEMA Flood Map Service Center</a>.
                      </p>
                    </div>
                  </>
                )
              }
              return (
                <>
                  <p className={`analysis-expand-level ${sev}`}>
                    {fz ? `${FLOOD_ZONE_LABELS[fz.bucket]} — ${fz.label}` : 'Not within a mapped FEMA flood hazard zone'}
                  </p>
                  <div className="analysis-expand-rec">
                    <strong>Why this matters</strong>
                    <p>
                      {sev === 'danger'
                        ? 'This address sits in a Special Flood Hazard Area (1% annual-chance / “100-year” floodplain). Federally backed mortgages here require flood insurance, premiums are typically higher, and the structure faces meaningful flood risk.'
                        : sev === 'warning'
                        ? 'This address is in a moderate-risk zone (0.2% annual-chance / “500-year” floodplain). Flood insurance is usually optional but recommended — moderate-risk areas still account for a substantial share of flood claims.'
                        : fz
                        ? 'This address is in a minimal-hazard or undetermined zone. Flood insurance is generally not federally required, though no area is completely risk-free.'
                        : 'This address is outside FEMA’s mapped flood hazard zones, so flood insurance is generally not federally required. Mapping is periodic, so it can lag local changes.'}
                    </p>
                  </div>
                  <div className="analysis-expand-rec">
                    <strong>Risk bands</strong>
                    <p>
                      <span className="analysis-band danger">A/AE/V</span> high · {' '}
                      <span className="analysis-band warning">0.2% shaded X</span> moderate · {' '}
                      <span className="analysis-band good">unshaded X / D</span> minimal
                    </p>
                  </div>
                  <div className="analysis-expand-rec">
                    <strong>Source</strong>
                    <p>
                      FEMA National Flood Hazard Layer via the{' '}
                      <a href="https://msc.fema.gov/portal/home" target="_blank" rel="noopener noreferrer">Flood Map Service Center</a>. Flag shown only for moderate risk or higher.
                    </p>
                  </div>
                </>
              )
            })()}

            {analysisDetail === 'wildfire' && (() => {
              const wf = analysisResults.wildfireHazard
              const sev = analysisResults.wildfireError ? 'clear' : wf ? wildfireSeverity(wf.value) : 'clear'
              if (analysisResults.wildfireError) {
                return (
                  <>
                    <p className="analysis-expand-level clear">USFS wildfire hazard data couldn’t be loaded for this location.</p>
                    <div className="analysis-expand-rec">
                      <strong>Why this matters</strong>
                      <p>
                        Wildfire hazard affects insurance availability and premiums, defensible-space
                        requirements, and personal safety. Try re-analyzing, or explore the{' '}
                        <a href="https://wildfirerisk.org/" target="_blank" rel="noopener noreferrer">Wildfire Risk to Communities</a> tool.
                      </p>
                    </div>
                  </>
                )
              }
              return (
                <>
                  <p className={`analysis-expand-level ${sev}`}>
                    {wf ? `${wf.label} wildfire hazard` : 'No mapped USFS wildfire hazard'}
                  </p>
                  <div className="analysis-expand-rec">
                    <strong>Why this matters</strong>
                    <p>
                      {sev === 'danger'
                        ? 'This address falls in a High or Very High wildfire hazard class. Expect stricter insurance underwriting and higher premiums, defensible-space and home-hardening obligations, and meaningful wildfire risk during fire season.'
                        : wf && wf.value === 3
                        ? 'This address is in a Moderate wildfire hazard class — not flagged in the report, but risk is real. Defensible space and ember-resistant home hardening are still worthwhile precautions.'
                        : wf
                        ? 'This address is in a Low / Very Low class, or a non-burnable (developed) or water area. Wildfire risk here is minimal, though no area is entirely risk-free.'
                        : 'This address has no mapped USFS wildfire hazard class (e.g. outside the contiguous U.S. coverage). That is not a guarantee of zero risk.'}
                    </p>
                  </div>
                  <div className="analysis-expand-rec">
                    <strong>Hazard classes</strong>
                    <p>
                      <span className="analysis-band danger">High / Very high</span> flagged · {' '}
                      <span className="analysis-band good">Moderate</span> noted, not flagged · {' '}
                      <span className="analysis-band good">Low / Very low</span> minimal
                    </p>
                  </div>
                  <div className="analysis-expand-rec">
                    <strong>Source</strong>
                    <p>
                      USFS Wildfire Hazard Potential (classified, 2023) via the{' '}
                      <a href="https://www.firelab.org/project/wildfire-hazard-potential" target="_blank" rel="noopener noreferrer">USFS Fire Modeling Institute</a>. Auto-revealed on the map only for High risk or higher.
                    </p>
                  </div>
                </>
              )
            })()}
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
