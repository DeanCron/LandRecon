import L from 'leaflet'
import { fetchSuperfundFeaturesByBbox } from './superfundData'

export { SUPERFUND_API, superfundFeaturesToPoints } from './superfundData'

export const SUPERFUND_ICON = L.divIcon({
  className: 'superfund-marker',
  html: `<div class="superfund-marker-inner" aria-hidden="true">☢️</div>`,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  popupAnchor: [0, -16],
})

export async function fetchSuperfundFeatures(bounds: L.LatLngBounds): Promise<GeoJSON.FeatureCollection> {
  const bbox = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`
  return fetchSuperfundFeaturesByBbox(bbox)
}
