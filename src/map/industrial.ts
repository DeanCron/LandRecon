import L from 'leaflet'

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
export const INDUSTRIAL_API_BASE =
  'https://gispub.epa.gov/arcgis/rest/services/OEI/TRI_Reporting_Facilities/MapServer/0'
export const INDUSTRIAL_FIELDS = [
  'EPA_REGISTRY_ID', 'TRI_FACILITY_ID', 'FACILITY_NAME', 'STREET_ADDRESS',
  'CITY', 'STATE', 'INDUSTRY', 'TOTAL_RELEASES_lb', 'REPORTING_YEAR',
].join(',')
// Scope the layer to a radius around the searched address rather than the
// viewport — refinery / chemical / paper-mill impact is meaningfully tied
// to the property the user is researching. 10 mi keeps the focus tight on
// the immediate neighborhood (most acute air-quality + nuisance reach).
export const INDUSTRIAL_RADIUS_MI = 10

export type IndustrialIndustryKey = 'PETROLEUM' | 'CHEMICALS' | 'PAPER'

export interface IndustrialIndustryMeta {
  key: IndustrialIndustryKey
  // EPA INDUSTRY field literal (e.g. "324 Petroleum")
  industryValue: string
  label: string
  color: string
  icon: string
}

export const INDUSTRIAL_INDUSTRIES: readonly IndustrialIndustryMeta[] = [
  { key: 'PETROLEUM', industryValue: '324 Petroleum', label: 'Oil refineries',  color: '#37474f', icon: '🛢️' },
  { key: 'CHEMICALS', industryValue: '325 Chemicals', label: 'Chemical plants', color: '#ef5350', icon: '⚗️' },
  { key: 'PAPER',     industryValue: '322 Paper',     label: 'Paper mills',     color: '#6d4c41', icon: '📄' },
] as const

export const INDUSTRIAL_INDUSTRY_BY_VALUE = new Map(
  INDUSTRIAL_INDUSTRIES.map((m) => [m.industryValue, m]),
)

export interface IndustrialFacility {
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

export async function fetchIndustrialFacilities(
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
