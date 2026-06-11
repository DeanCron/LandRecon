import L from 'leaflet'

// ── EPA AirNow Latest AQI Contours (combined Ozone + PM2.5) ─────────────
// Hourly-refreshed polygon contour layer hosted on EPA's public ArcGIS
// Online org. `gridcode` is the AQI category (1–6); "Combined" means the
// worst-of Ozone and PM2.5 at the contour location. Polygons are coarse
// and useful even at low zoom for visualizing regional smoke / dust /
// ozone events, so the gate is permissive.
export const AQI_API =
  'https://services.arcgis.com/cJ9YHowT8TU7DUyn/ArcGIS/rest/services/AirNowLatestContoursCombined/FeatureServer/0/query'

export const AQI_FIELDS = ['gridcode', 'Timestamp'].join(',')

export const AQI_MIN_ZOOM = 4

// EPA standard AQI category colors (https://www.airnow.gov/aqi/aqi-basics/)
export const AQI_CATEGORY_COLORS: Record<number, string> = {
  1: '#00e400',
  2: '#ffff00',
  3: '#ff7e00',
  4: '#ff0000',
  5: '#8f3f97',
  6: '#7e0023',
}

export const AQI_CATEGORY_LABELS: Record<number, string> = {
  1: 'Good (0–50)',
  2: 'Moderate (51–100)',
  3: 'Unhealthy for sensitive (101–150)',
  4: 'Unhealthy (151–200)',
  5: 'Very unhealthy (201–300)',
  6: 'Hazardous (301+)',
}

export function aqiCategory(props: GeoJSON.GeoJsonProperties): number {
  const raw = (props as Record<string, unknown> | null | undefined)?.gridcode
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return 1
  return Math.min(Math.max(Math.round(n), 1), 6)
}

export function aqiColor(props: GeoJSON.GeoJsonProperties): string {
  return AQI_CATEGORY_COLORS[aqiCategory(props)] || AQI_CATEGORY_COLORS[1]
}

export async function fetchAqiFeatures(bounds: L.LatLngBounds): Promise<GeoJSON.FeatureCollection> {
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
