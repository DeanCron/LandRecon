import L from 'leaflet'

// ── HIFLD Electric Power Transmission Lines ─────────────────────────────
// Public ArcGIS FeatureServer hosted by Esri on behalf of the Homeland
// Infrastructure Foundation-Level Data (HIFLD) Open program. ~88k feature
// polylines nationally — gated to zoom >= POWER_MIN_ZOOM to keep the fetch
// payload bounded.
export const POWER_API =
  'https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Electric_Power_Transmission_Lines/FeatureServer/0/query'

export const POWER_FIELDS = ['OWNER', 'VOLTAGE', 'VOLT_CLASS', 'TYPE', 'STATUS', 'SUB_1', 'SUB_2'].join(',')

export const POWER_MIN_ZOOM = 10

// Color bands keyed by VOLT_CLASS value. The dataset uses these exact
// strings for the bucketing field; values like "NOT AVAILABLE" and "DC"
// fall through to a neutral gray and a distinct blue respectively.
export const POWER_VOLT_COLORS: Record<string, string> = {
  'UNDER 100': '#fde725',
  '100-161': '#f7a51b',
  '220-287': '#ef4035',
  '345': '#c724b1',
  '500': '#7e1ce9',
  '735 AND ABOVE': '#3b0f7a',
  'DC': '#1f6feb',
  'NOT AVAILABLE': '#9ca3af',
}

export const POWER_VOLT_ORDER: readonly string[] = [
  'UNDER 100', '100-161', '220-287', '345', '500', '735 AND ABOVE', 'DC', 'NOT AVAILABLE',
] as const

export const POWER_VOLT_LABELS: Record<string, string> = {
  'UNDER 100': '< 100 kV',
  '100-161': '100–161 kV',
  '220-287': '220–287 kV',
  '345': '345 kV',
  '500': '500 kV',
  '735 AND ABOVE': '735 kV+',
  'DC': 'HVDC',
  'NOT AVAILABLE': 'Unknown',
}

export function powerColor(props: GeoJSON.GeoJsonProperties): string {
  const cls = String((props as Record<string, unknown> | null | undefined)?.VOLT_CLASS || '').toUpperCase().trim()
  return POWER_VOLT_COLORS[cls] || POWER_VOLT_COLORS['NOT AVAILABLE']
}

export async function fetchPowerLineFeatures(bounds: L.LatLngBounds): Promise<GeoJSON.FeatureCollection> {
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
