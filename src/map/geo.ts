// Leaflet-free geometry helpers so scoring/fetch code runs in Node as well as
// the browser. Semantics match the Leaflet calls they replace.
export type LatLngLike = { lat: number; lng: number }

export interface BoundsLike {
  getSouth(): number
  getWest(): number
  getNorth(): number
  getEast(): number
  getCenter(): LatLngLike
}

export const CONUS_BOUNDS: [[number, number], [number, number]] = [
  [24.5, -125.0],
  [49.4, -66.9],
]

const EARTH_RADIUS_M = 6371000

export function makeBounds(south: number, west: number, north: number, east: number): BoundsLike {
  return {
    getSouth: () => south,
    getWest: () => west,
    getNorth: () => north,
    getEast: () => east,
    getCenter: () => ({ lat: (south + north) / 2, lng: (west + east) / 2 }),
  }
}

export function boundsContains(bounds: BoundsLike, p: LatLngLike): boolean {
  return p.lat >= bounds.getSouth() && p.lat <= bounds.getNorth()
    && p.lng >= bounds.getWest() && p.lng <= bounds.getEast()
}

export function pointInConus(p: LatLngLike): boolean {
  const [[south, west], [north, east]] = CONUS_BOUNDS
  return p.lat >= south && p.lat <= north && p.lng >= west && p.lng <= east
}

export function haversineMeters(a: LatLngLike, b: LatLngLike): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))
}
