import L from 'leaflet'

// District layers we ship boundary + (optional) results for.
export type DistrictLayerId = 'cd118'

export const DISTRICT_LAYER_LABELS: Record<DistrictLayerId, string> = {
  cd118: 'Congressional districts',
}

const DATA_BASE = '/data/districts'

type DistrictResult = {
  d: number
  r: number
  o: number
  total: number
  d_pct: number
  r_pct: number
  margin_pct: number
  winner: 'D' | 'R' | 'O'
}

type DistrictResultsFile = {
  meta: {
    source: string
    cycle?: number
    fetched_at: string
    district_count: number
  }
  results: Record<string, DistrictResult>
}

export type DistrictDatasetMeta = DistrictResultsFile['meta'] | null

// ColorBrewer RdBu_9, but anchored so 0 = white (D=R) and extremes are at
// ±40pt margin. Linear interpolation between stops.
const RAMP: { m: number; color: [number, number, number] }[] = [
  { m: -40, color: [103, 0, 31] },
  { m: -25, color: [178, 24, 43] },
  { m: -15, color: [214, 96, 77] },
  { m: -5,  color: [244, 165, 130] },
  { m: 0,   color: [247, 247, 247] },
  { m: 5,   color: [146, 197, 222] },
  { m: 15,  color: [67, 147, 195] },
  { m: 25,  color: [33, 102, 172] },
  { m: 40,  color: [5, 48, 97] },
]

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function marginToColor(margin: number): string {
  const m = Math.max(-40, Math.min(40, margin))
  for (let i = 1; i < RAMP.length; i++) {
    const prev = RAMP[i - 1]
    const curr = RAMP[i]
    if (m <= curr.m) {
      const t = (m - prev.m) / (curr.m - prev.m || 1)
      const r = Math.round(lerp(prev.color[0], curr.color[0], t))
      const g = Math.round(lerp(prev.color[1], curr.color[1], t))
      const b = Math.round(lerp(prev.color[2], curr.color[2], t))
      return `rgb(${r}, ${g}, ${b})`
    }
  }
  const last = RAMP[RAMP.length - 1].color
  return `rgb(${last[0]}, ${last[1]}, ${last[2]})`
}

const NO_DATA_COLOR = '#dcdcdc'

type LoadedLayer = {
  layer: L.GeoJSON
  meta: DistrictDatasetMeta
  resultsCount: number
  featureCount: number
}

const cache = new Map<DistrictLayerId, Promise<LoadedLayer>>()

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

export function loadDistrictLayer(id: DistrictLayerId): Promise<LoadedLayer> {
  let entry = cache.get(id)
  if (entry) return entry
  entry = (async () => {
    const [geojson, results] = await Promise.all([
      fetchJson<GeoJSON.FeatureCollection>(`${DATA_BASE}/${id}.geojson`),
      fetchJson<DistrictResultsFile>(`${DATA_BASE}/${id}-results.json`),
    ])
    if (!geojson) throw new Error(`Failed to load ${id} boundary file`)

    const resultsMap = results?.results ?? {}
    const meta = results?.meta ?? null

    const layer = L.geoJSON(geojson, {
      // Render on the Canvas-backed overlayPane that we already opted into
      // via preferCanvas. Stays under markers/pins.
      pane: 'overlayPane',
      style: (feature) => {
        const props = (feature?.properties ?? {}) as { GEOID?: string }
        const r = props.GEOID ? resultsMap[props.GEOID] : undefined
        const fill = r ? marginToColor(r.margin_pct) : NO_DATA_COLOR
        return {
          color: '#333',
          weight: 0.5,
          opacity: 0.55,
          fillColor: fill,
          fillOpacity: r ? 0.55 : 0.25,
        }
      },
      onEachFeature: (feature, lyr) => {
        const props = (feature.properties ?? {}) as {
          GEOID?: string
          NAMELSAD?: string
          STATEFP?: string
        }
        const name = props.NAMELSAD ?? 'District'
        const r = props.GEOID ? resultsMap[props.GEOID] : undefined
        const tooltipHtml = r
          ? `<strong>${name}</strong><br/>${formatMargin(r)}`
          : `<strong>${name}</strong><br/><em>no result on file</em>`
        lyr.bindTooltip(tooltipHtml, {
          sticky: true,
          direction: 'top',
          className: 'district-tooltip',
        })
        if (r) {
          lyr.bindPopup(buildPopupHtml(name, r))
        } else {
          lyr.bindPopup(`<strong>${name}</strong><br/><em>No result on file.</em>`)
        }
      },
    })
    return {
      layer,
      meta,
      resultsCount: Object.keys(resultsMap).length,
      featureCount: geojson.features?.length ?? 0,
    }
  })()
  cache.set(id, entry)
  return entry
}

function formatMargin(r: DistrictResult): string {
  if (r.winner === 'O') return `Other +${Math.abs(r.margin_pct).toFixed(1)}`
  const lead = r.winner === 'D' ? r.d_pct - r.r_pct : r.r_pct - r.d_pct
  return `${r.winner} +${lead.toFixed(1)}`
}

function buildPopupHtml(name: string, r: DistrictResult): string {
  const total = r.total || (r.d + r.r + r.o)
  const fmt = (n: number) => (n ? n.toLocaleString() : '—')
  return `
    <div class="district-popup">
      <div class="district-popup-title">${name}</div>
      <div class="district-popup-margin">${formatMargin(r)}</div>
      <table class="district-popup-table">
        <tr><td>D</td><td>${fmt(r.d)}</td><td>${r.d_pct.toFixed(1)}%</td></tr>
        <tr><td>R</td><td>${fmt(r.r)}</td><td>${r.r_pct.toFixed(1)}%</td></tr>
        <tr><td>Other</td><td>${fmt(r.o)}</td><td>${(100 - r.d_pct - r.r_pct).toFixed(1)}%</td></tr>
        <tr><td>Total</td><td colspan="2">${fmt(total)}</td></tr>
      </table>
    </div>
  `
}
