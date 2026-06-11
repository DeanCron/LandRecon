import { escapeHtml } from '../utils/html'

// ALPR (automatic license plate reader) cameras. Flock Safety gets its own
// color because it's the most-deployed brand and the namesake of the
// DeFlock crowdsourcing project that supplies most of the underlying OSM
// tags. Everything else (Motorola Vigilant, Genetec, Rekor, etc.) shares
// a single neutral color.
//
// Magenta + violet are deliberately picked outside the rest of the layer
// palette (Wong colorblind-safe set + traffic gradient) so a camera pin
// is never mistaken for transit, EMS, data centers, or crowd magnets.
export const CAMERA_COLORS = { flock: '#db2777', other: '#7c3aed' } as const

export interface CameraRecord {
  id: string
  lat: number
  lon: number
  manufacturer: string
  operator: string
  direction: string
  isFlock: boolean
}

export function cameraPopup(c: CameraRecord): string {
  const label = c.isFlock ? 'Flock Safety ALPR' : (c.manufacturer ? `${c.manufacturer} ALPR` : 'ALPR camera')
  const color = c.isFlock ? CAMERA_COLORS.flock : CAMERA_COLORS.other
  const rows: string[] = []
  if (c.operator) rows.push(`<div><strong>Operator:</strong> ${escapeHtml(c.operator)}</div>`)
  if (c.direction) rows.push(`<div><strong>Direction:</strong> ${escapeHtml(c.direction)}</div>`)
  const nodeId = c.id.replace(/^node\//, '')
  return `
    <div class="transit-popup">
      <div class="transit-popup-title" style="color:${color}">${label}</div>
      ${rows.join('')}
      <div class="camera-popup-source">
        Source: <a href="https://www.openstreetmap.org/node/${nodeId}" target="_blank" rel="noopener noreferrer">OSM node ${nodeId}</a>
        &middot; <a href="https://deflock.me/" target="_blank" rel="noopener noreferrer">DeFlock</a>
      </div>
    </div>
  `.trim()
}
