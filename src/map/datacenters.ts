export interface DataCenter {
  name: string
  address: string
  city: string
  state: string
  lat: number
  lng: number
  status: string
  operator: string
  mw: string
  sizerank: string
}

export const DC_STATUS_COLORS: Record<string, string> = {
  'Operating': '#009E73',
  'Proposed': '#56B4E9',
  'Approved/Permitted/Under construction': '#E69F00',
  'Expanding': '#CC79A7',
  'Suspended': '#6b7280',
}

export const DC_STATUSES = Object.keys(DC_STATUS_COLORS) as string[]

export const DC_STATUS_LABELS: Record<string, string> = {
  'Operating': 'Operating',
  'Proposed': 'Proposed',
  'Approved/Permitted/Under construction': 'Under Construction',
  'Expanding': 'Expanding',
  'Suspended': 'Suspended',
}

export const DATA_CENTER_ANALYSIS_RADIUS_MI = 3
