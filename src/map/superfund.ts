import L from 'leaflet'

export const SUPERFUND_API =
  'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/FAC_Superfund_Site_Boundaries_EPA_Public/FeatureServer/0/query'

const SUPERFUND_FIELDS = [
  'SITE_NAME', 'EPA_ID', 'NPL_STATUS_CODE', 'CITY_NAME',
  'STATE_CODE', 'SITE_FEATURE_TYPE', 'URL_ALIAS_TXT',
].join(',')

export const SUPERFUND_ICON = L.divIcon({
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

export async function fetchSuperfundFeatures(bounds: L.LatLngBounds): Promise<GeoJSON.FeatureCollection> {
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
