import type L from 'leaflet'

export const BASE_MAP_IDS = ['street', 'satellite'] as const
export type BaseMapId = (typeof BASE_MAP_IDS)[number]

// Share links carry the base map as `?base=<id>`. Match against the known ids
// instead of indexing an object, so inherited keys like "constructor" are
// rejected too.
export function parseBaseMapId(value: string | null | undefined): BaseMapId | null {
  return BASE_MAP_IDS.find((id) => id === value) ?? null
}

// The Google base layer is created asynchronously (it first needs a tile
// session), so overlays restored from a share link (e.g. `?layers=noise`) can
// reach the map before it does. Leaflet paints tile layers with equal z-index
// in DOM order, so a base layer added late would cover those overlays.
// Always pin the base layer beneath every other tile layer.
export function addBaseLayer(map: L.Map, layer: L.TileLayer): void {
  layer.addTo(map)
  layer.bringToBack()
}
