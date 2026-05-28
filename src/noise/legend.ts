// Synchronous noise constants — split out of airportNoise.ts so the UI
// legend can render without dragging in PMTiles, protomaps-leaflet, and
// @mapbox/vector-tile on the initial MapPage chunk.

export const NOISE_LAYER_NAME = 'airport_noise'

export const NOISE_MAX_ZOOM = 12

export const NOISE_BAND_COLORS: Record<number, string> = {
  50: '#7CB342',
  55: '#FFEB3B',
  60: '#FF9800',
  65: '#F44336',
  70: '#880E4F',
}

export const NOISE_BAND_BREAKS = [50, 55, 60, 65, 70] as const

export interface LegendBand {
  dbMin: number
  label: string
  color: string
}

export const LEGEND_BANDS: readonly LegendBand[] = NOISE_BAND_BREAKS.map((db, i) => ({
  dbMin: db,
  label: i === NOISE_BAND_BREAKS.length - 1 ? `${db}+ dB` : `${db}\u2013${NOISE_BAND_BREAKS[i + 1]}`,
  color: NOISE_BAND_COLORS[db],
}))

export function colorForDbMin(db: unknown): string {
  if (typeof db !== 'number' || !Number.isFinite(db)) return '#888888'
  let snap: number = NOISE_BAND_BREAKS[0]
  for (const b of NOISE_BAND_BREAKS) {
    if (db >= b) snap = b
  }
  return NOISE_BAND_COLORS[snap] ?? '#888888'
}
