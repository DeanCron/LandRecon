export const EMS_TYPES = ['fire_station', 'hospital', 'police'] as const
export type EmsType = typeof EMS_TYPES[number]
export const EMS_COLORS: Record<EmsType, string> = {
  fire_station: '#D55E00',
  hospital: '#0072B2',
  police: '#332288',
}
export const EMS_LABELS: Record<EmsType, string> = {
  fire_station: 'Fire Stations',
  hospital: 'Hospitals',
  police: 'Police Stations',
}
export const EMS_ICONS: Record<EmsType, string> = {
  fire_station: '🚒',
  hospital: '🏥',
  police: '🚔',
}
export const EMS_QUERIES: Record<EmsType, string[]> = {
  fire_station: ['fire stations'],
  hospital: ['hospitals', 'emergency rooms'],
  police: ['police stations'],
}
