import L from 'leaflet'

// ── USFS Wildfire Hazard Potential (Classified) ─────────────────────────
// 270m raster, 5 classes (Very Low → Very High) + non-burnable + water.
// Hosted by the Imagery Information Products Program (IIPP) — the new
// home for what used to live on apps.fs.usda.gov. We request a single
// pre-symbolized PNG per viewport via the ImageServer's exportImage
// endpoint and overlay it via Leaflet's L.imageOverlay (re-fetched on
// moveend). The "WHP_CLS_2023_8bit" raster function bakes in the
// canonical USFS color ramp.
export const WHP_BASE =
  'https://imagery.geoplatform.gov/iipp/rest/services/Fire_Aviation/USFS_EDW_RMRS_WildfireHazardPotentialClassified/ImageServer/exportImage'

export const WHP_RENDERING_RULE = JSON.stringify({ rasterFunction: 'WHP_CLS_2023_8bit' })

// Min zoom where overlay reads usefully. Below this the 270m pixels
// degenerate into noise and the request size cap kicks in.
export const WHP_MIN_ZOOM = 6
// Above this zoom the source raster (270m / pixel) is heavily upsampled
// and looks blocky. Keep the overlay attached but request the same image
// size — the browser will scale it. No additional fetch needed.
export const WHP_MAX_USEFUL_ZOOM = 14

export const WHP_CLASS_COLORS: Array<{ label: string; color: string }> = [
  { label: 'Very low',      color: '#1a9850' },
  { label: 'Low',           color: '#a6d96a' },
  { label: 'Moderate',      color: '#fee08b' },
  { label: 'High',          color: '#fc8d59' },
  { label: 'Very high',     color: '#d73027' },
  { label: 'Non-burnable',  color: '#bdbdbd' },
  { label: 'Water',         color: '#6baed6' },
]

export function buildWhpImageUrl(bounds: L.LatLngBounds, widthPx: number, heightPx: number): string {
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
