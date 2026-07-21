// Leaflet-free Superfund data helpers shared by the main thread and the geo
// worker. Deliberately import-light (no leaflet, no analytics, no fetchRetry)
// so the worker bundle stays small and can run the ArcGIS fetch + GeoJSON
// parse + polygon->centroid reduction off the main thread. The Leaflet marker
// icon and the LatLngBounds-based entry point live in ./superfund, which
// re-exports the pieces below.

export const SUPERFUND_API =
  'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/FAC_Superfund_Site_Boundaries_EPA_Public/FeatureServer/0/query'

const SUPERFUND_FIELDS = [
  'SITE_NAME', 'EPA_ID', 'NPL_STATUS_CODE', 'CITY_NAME',
  'STATE_CODE', 'SITE_FEATURE_TYPE', 'URL_ALIAS_TXT',
].join(',')

type GeoJSONCoord = number[]
type GeoJSONRing = GeoJSONCoord[]

// Local copy of the fetchRetry error-envelope guard so this module can stay
// free of that dependency (and everything it pulls in) inside the worker.
function assertNoSuperfundError(data: unknown): void {
  if (!data || typeof data !== 'object' || !('error' in data) || !data.error) return
  const error = (data as { error: unknown }).error
  const code = typeof error === 'object' && error && 'code' in error
    ? String((error as { code: unknown }).code)
    : ''
  throw new Error(code ? `API error ${code}` : 'API returned an error payload')
}

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

export function superfundFeaturesToPoints(
  fc: GeoJSON.FeatureCollection,
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const features: GeoJSON.Feature<GeoJSON.Point>[] = []
  for (const f of fc.features || []) {
    const pt = superfundFeatureToPoint(f)
    if (pt) features.push(pt)
  }
  return { type: 'FeatureCollection', features }
}

function superfundQueryUrl(bbox: string): string {
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
  return `${SUPERFUND_API}?${params}`
}

// bbox is "west,south,east,north" in EPSG:4326.
export async function fetchSuperfundFeaturesByBbox(
  bbox: string,
  signal?: AbortSignal,
): Promise<GeoJSON.FeatureCollection> {
  const res = await fetch(superfundQueryUrl(bbox), signal ? { signal } : undefined)
  if (!res.ok) throw new Error(`Superfund query failed: HTTP ${res.status}`)
  const data = await res.json()
  assertNoSuperfundError(data)
  if (!Array.isArray((data as { features?: unknown })?.features)) {
    throw new Error('Superfund query returned an invalid response')
  }
  return data as GeoJSON.FeatureCollection
}

// Fetch + parse + reduce to centroid points in one call. This is the worker
// entry point: the heavy JSON.parse of the boundary GeoJSON and the
// polygon->centroid loop both run off the main thread, and only the small
// point collection is posted back.
export async function fetchSuperfundPoints(
  bbox: string,
  signal?: AbortSignal,
): Promise<GeoJSON.FeatureCollection<GeoJSON.Point>> {
  const fc = await fetchSuperfundFeaturesByBbox(bbox, signal)
  return superfundFeaturesToPoints(fc)
}
