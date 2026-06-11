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

// FEMA NFHL polygons carry full survey-grade vertex precision: a single
// coastal viewport can be 100+ MB of raw GeoJSON, which makes the service time
// out and return HTTP 500 on the larger queries (and chews bandwidth on the
// rest). We pass maxAllowableOffset to have the server generalise geometry to a
// tolerance suited to the current zoom — this shrinks payloads ~10-100x (e.g. a
// query that 500s at full precision returns in ~2s at ~1 MB) with no visible
// change at overlay zoom levels, and as a bonus drops the feature footprint
// under the transfer cap so coastal zones stop being truncated.
//
// FEMA NFHL still caps each response at maxRecordCount (2000) and returns
// features in OID order, so a very dense viewport can drop the highest-OID
// polygons — in coastal metros the V/VE coastal zones (added after the sprawling
// inland X zones). The service errors (HTTP 500) on orderByFields and
// resultOffset for heavy queries, so we can't prioritise or page. Instead, when
// a cell comes back truncated we split its envelope into quadrants and re-query
// each until every cell returns whole — using only the plain bbox query that the
// service reliably serves. This keeps every flood polygon, coastal included.
const FLOOD_PAGE_SIZE = 2000
const FLOOD_MAX_SUBDIVIDE = 2 // depth cap → at most 4^2 = 16 leaf queries
const FLOOD_FETCH_RETRIES = 2 // extra attempts after the first, for transient 500s/resets
const FLOOD_FETCH_TIMEOUT_MS = 20000

// Server-side geometry generalisation tolerance (in degrees, matching outSR
// 4326), scaled to the queried span so it stays roughly one screen pixel at the
// zoom the viewport implies — flood-zone edges don't need sub-pixel precision
// for an overlay, and a coarser tolerance roughly halves the payload (faster
// transfer and faster Leaflet rendering). Clamped so we never demand survey
// precision (huge, 500-prone payloads) nor over-simplify a wide view into
// visibly blocky polygons.
function floodSimplifyTolerance(west: number, east: number): number {
  const span = Math.abs(east - west)
  return Math.min(0.0015, Math.max(0.00003, span / 1500))
}

function floodDedupeKey(feature: GeoJSON.Feature): string {
  const props = (feature.properties as Record<string, unknown> | null) ?? {}
  // The first vertex of a polygon is identical no matter which overlapping cell
  // query returned it, so it uniquely identifies a feature for de-duplication.
  let c: unknown = (feature.geometry as { coordinates?: unknown } | null)?.coordinates
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0]
  const vertex = Array.isArray(c) ? c.join(',') : ''
  return `${props.FLD_ZONE ?? ''}|${props.ZONE_SUBTY ?? ''}|${vertex}`
}

export async function fetchFloodFeatures(
  bounds: L.LatLngBounds,
  onChunk?: (newFeatures: GeoJSON.Feature[]) => void,
): Promise<GeoJSON.FeatureCollection> {
  const features: GeoJSON.Feature[] = []
  const seen = new Set<string>()
  // A single tolerance for the whole call (derived from the original bounds, not
  // each sub-cell) so a feature returned by both a parent and a child query has
  // identical generalised geometry — otherwise its first-vertex dedupe key would
  // differ between zoom levels and we'd render duplicates.
  const tolerance = floodSimplifyTolerance(bounds.getWest(), bounds.getEast())

  // Collect a cell's newly-seen (de-duplicated) features and hand them to the
  // optional onChunk callback so the caller can paint incrementally — the
  // parent query's inland zones render immediately, then each subdivided
  // quadrant's coastal zones fill in as they arrive, instead of the whole
  // overlay waiting on the slowest sub-request.
  function addFeatures(fc: GeoJSON.FeatureCollection | null | undefined): void {
    const fresh: GeoJSON.Feature[] = []
    for (const f of fc?.features ?? []) {
      const key = floodDedupeKey(f)
      if (seen.has(key)) continue
      seen.add(key)
      features.push(f)
      fresh.push(f)
    }
    if (fresh.length && onChunk) onChunk(fresh)
  }

  async function fetchCell(west: number, south: number, east: number, north: number, depth: number): Promise<void> {
    const params = new URLSearchParams({
      where: '1=1',
      outFields: FLOOD_FIELDS,
      geometry: `${west},${south},${east},${north}`,
      geometryType: 'esriGeometryEnvelope',
      spatialRel: 'esriSpatialRelIntersects',
      inSR: '4326',
      outSR: '4326',
      f: 'geojson',
      maxAllowableOffset: String(tolerance),
      resultRecordCount: String(FLOOD_PAGE_SIZE),
    })
    const url = `${FLOOD_API}?${params}`
    let data: (GeoJSON.FeatureCollection & { exceededTransferLimit?: boolean }) | null = null
    // Retry transient FEMA failures (intermittent HTTP 500s, connection resets)
    // with a short backoff before giving up on the cell.
    for (let attempt = 0; attempt <= FLOOD_FETCH_RETRIES; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(FLOOD_FETCH_TIMEOUT_MS) })
        if (!res.ok) throw new Error(`FEMA NFHL ${res.status}`)
        data = await res.json()
        break
      } catch {
        data = null
        if (attempt < FLOOD_FETCH_RETRIES) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
        }
      }
    }
    if (!data || !Array.isArray(data.features)) return

    // Always keep this cell's own features, so we still render something (the
    // same truncated set the API would otherwise return) even if the refining
    // sub-queries below fail or get rate-limited. Subdivision then only *adds*
    // the high-OID polygons (coastal V/VE zones) that the cap dropped.
    addFeatures(data)

    if (data.exceededTransferLimit && depth < FLOOD_MAX_SUBDIVIDE) {
      const midX = (west + east) / 2
      const midY = (south + north) / 2
      // Query the four quadrants in parallel. This used to be sequential to
      // avoid FEMA's burst rate-limiting, but the coarse-geometry payloads are
      // now small and each request has retry-with-backoff, while the parent's
      // features were already added above as a never-zero fallback — so a
      // throttled child self-heals or, worst case, just misses some refinement
      // rather than blanking the overlay. Parallel is ~4x faster on dense views.
      await Promise.all([
        fetchCell(west, south, midX, midY, depth + 1),
        fetchCell(midX, south, east, midY, depth + 1),
        fetchCell(west, midY, midX, north, depth + 1),
        fetchCell(midX, midY, east, north, depth + 1),
      ])
    }
  }

  await fetchCell(bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth(), 0)
  return { type: 'FeatureCollection', features }
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
    returnGeometry: 'false',
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
