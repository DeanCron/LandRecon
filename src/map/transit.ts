export interface TransitStop {
  lat: number
  lon: number
  name: string
  type: 'rail' | 'subway' | 'tram' | 'bus'
}

export const TRANSIT_COLORS: Record<TransitStop['type'], string> = {
  rail: '#0072B2',
  subway: '#D55E00',
  tram: '#009E73',
  bus: '#E69F00',
}

export const TRANSIT_LABELS: Record<TransitStop['type'], string> = {
  rail: 'Rail Stations',
  subway: 'Subway Stations',
  tram: 'Tram Stops',
  bus: 'Bus Stops',
}

export function transitPopup(stop: TransitStop): string {
  const label = TRANSIT_LABELS[stop.type]
  const color = TRANSIT_COLORS[stop.type]
  return `
    <div class="transit-popup">
      <div class="popup-header">
        <span class="transit-icon" style="background:${color}"></span>
        <strong>${stop.name || 'Unnamed Stop'}</strong>
      </div>
      <div class="popup-body">
        <div class="popup-row">
          <span class="popup-label">Type</span>
          <span>${label}</span>
        </div>
      </div>
    </div>
  `
}
