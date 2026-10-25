import type L from 'leaflet'

// The Google base layer is created asynchronously (it first needs a tile
// session), so overlays restored from a share link (e.g. `?layers=noise`) can
// reach the map before it does. Leaflet paints tile layers with equal z-index
// in DOM order, so a base layer added late would cover those overlays.
// Always pin the base layer beneath every other tile layer.
export function addBaseLayer(map: L.Map, layer: L.TileLayer): void {
  layer.addTo(map)
  layer.bringToBack()
}
