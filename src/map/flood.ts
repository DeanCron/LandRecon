import L from 'leaflet'

// ── FEMA National Flood Hazard Layer (NFHL) ─────────────────────────────
export const FLOOD_API =
  'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query'

export const FLOOD_FIELDS = ['FLD_ZONE', 'ZONE_SUBTY', 'SFHA_TF', 'STATIC_BFE'].join(',')

export const FLOOD_MIN_ZOOM = 11

// Color buckets keyed by FLD_ZONE code. Subtypes (e.g. "0.2 PCT ANNUAL
// CHANCE FLOOD HAZARD") are handled inline in floodStyle().
//   High-risk SFHA (1% annual chance): A, AE, AH, AO, AR, A99 → red
//   Coastal high hazard (V): V, VE → purple
//   Moderate (0.2% / "500-year") shaded X → amber
//   Minimal hazard (unshaded X) → gray
//   Undetermined (D) → mid-gray
//   Open water → blue
export const FLOOD_ZONE_COLORS: Record<string, string> = {
  high: '#d62728',
  coastal: '#5d2e8c',
  moderate: '#f5c542',
  minimal: '#9ca3af',
  undetermined: '#6b7280',
  water: '#3b82f6',
}

export const FLOOD_ZONE_LABELS: Record<keyof typeof FLOOD_ZONE_COLORS | string, string> = {
  high: 'High risk (1% annual / SFHA)',
  coastal: 'Coastal high hazard (V/VE)',
  moderate: 'Moderate (0.2% / 500-yr)',
  minimal: 'Minimal hazard',
  undetermined: 'Undetermined (zone D)',
  water: 'Open water',
}

export function floodBucket(props: GeoJSON.GeoJsonProperties): keyof typeof FLOOD_ZONE_COLORS {
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

export function floodZoneLabel(props: GeoJSON.GeoJsonProperties): string {
  const zone = String((props as Record<string, unknown> | null | undefined)?.FLD_ZONE || '').trim() || 'Unknown'
  const sub = String((props as Record<string, unknown> | null | undefined)?.ZONE_SUBTY || '').trim()
  return sub ? `Zone ${zone} — ${sub}` : `Zone ${zone}`
}

export type FloodPointResult = { bucket: keyof typeof FLOOD_ZONE_COLORS; zone: string; label: string }

// Recon Report severity: only flag moderate risk or higher. High-risk SFHA
// (A/AE/…) and coastal V zones are dangers; the 0.2%/500-yr shaded-X bucket is
// a warning; everything else (minimal, undetermined, open water) stays clear.
export function floodSeverity(bucket: keyof typeof FLOOD_ZONE_COLORS): 'danger' | 'warning' | 'clear' {
  if (bucket === 'high' || bucket === 'coastal') return 'danger'
  if (bucket === 'moderate') return 'warning'
  return 'clear'
}

// Used to pick the worst bucket when a point intersects multiple polygons.
export const FLOOD_BUCKET_RANK: Record<string, number> = {
  coastal: 5, high: 4, moderate: 3, undetermined: 1, minimal: 0, water: 0,
}

export async function fetchFloodFeatures(bounds: L.LatLngBounds): Promise<GeoJSON.FeatureCollection> {
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

// Point-in-polygon query against the FEMA NFHL layer for a single location —
// used by the Recon Report. Returns the worst-severity flood bucket that the
// point falls inside, or null when the point isn't in any mapped flood zone.
export async function fetchFloodAtPoint(lat: number, lng: number): Promise<FloodPointResult | null> {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: FLOOD_FIELDS,
    geometry: `${lng},${lat}`,
    geometryType: 'esriGeometryPoint',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outSR: '4326',
    f: 'geojson',
    resultRecordCount: '50',
  })
  const res = await fetch(`${FLOOD_API}?${params}`, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error(`FEMA NFHL ${res.status}`)
  const data: GeoJSON.FeatureCollection = await res.json()
  const feats = data.features ?? []
  let best: FloodPointResult | null = null
  let bestRank = -1
  for (const f of feats) {
    const bucket = floodBucket(f.properties)
    const rank = FLOOD_BUCKET_RANK[bucket] ?? 0
    if (rank > bestRank) {
      bestRank = rank
      const zone = String((f.properties as Record<string, unknown> | null | undefined)?.FLD_ZONE || '').trim() || 'Unknown'
      best = { bucket, zone, label: floodZoneLabel(f.properties) }
    }
  }
  return best
}
