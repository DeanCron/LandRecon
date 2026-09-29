import { GPS_QUERY_KEYS, gpsTargetFromParams, gpsTargetLabel, parseGpsTarget, type GpsTarget } from './locationTarget'

export const MAP_ADDRESS_STATE_KEY = 'landReconAddress'
const GPS_STATE_KEY = 'landReconGps'
const ERROR_STATE_KEY = 'landReconLocationError'

export type MapAddressState = {
  [MAP_ADDRESS_STATE_KEY]?: string
  [GPS_STATE_KEY]?: GpsTarget
  [ERROR_STATE_KEY]?: string
}

export function rememberMapAddress(address: string): MapAddressState {
  return { [MAP_ADDRESS_STATE_KEY]: address.trim() }
}

export function rememberMapGps(target: GpsTarget): MapAddressState {
  const gps = parseGpsTarget(target)
  if (!gps) return { [ERROR_STATE_KEY]: 'This saved or shared GPS location is invalid. Try scoring your location again or enter an address.' }
  return { [GPS_STATE_KEY]: gps }
}

export function resolveMapGps(routeState: unknown): GpsTarget | null {
  return routeState && typeof routeState === 'object' && GPS_STATE_KEY in routeState
    ? parseGpsTarget(routeState[GPS_STATE_KEY]) : null
}

export function resolveMapLocationError(routeState: unknown): string {
  if (!routeState || typeof routeState !== 'object') return ''
  if (ERROR_STATE_KEY in routeState && typeof routeState[ERROR_STATE_KEY] === 'string') return routeState[ERROR_STATE_KEY]
  if (GPS_STATE_KEY in routeState && !resolveMapGps(routeState)) return 'This saved or shared GPS location is invalid. Enter an address or try your location again.'
  return ''
}

export function resolveMapAddress(routeState: unknown): string {
  if (resolveMapLocationError(routeState)) return ''
  const gps = resolveMapGps(routeState)
  if (gps) return gpsTargetLabel(gps)
  if (routeState && typeof routeState === 'object' && MAP_ADDRESS_STATE_KEY in routeState) {
    const value = routeState[MAP_ADDRESS_STATE_KEY]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export function scrubMapAddressBeforeAnalytics(): void {
  if (typeof window === 'undefined' || window.location.pathname !== '/map') return

  const url = new URL(window.location.href)
  const hasGps = GPS_QUERY_KEYS.some((key) => url.searchParams.has(key))
  if (!url.searchParams.has('address') && !hasGps) return

  const address = url.searchParams.get('address')?.trim() ?? ''
  const gps = hasGps ? gpsTargetFromParams(url.searchParams) : null
  url.searchParams.delete('address')
  for (const key of GPS_QUERY_KEYS) url.searchParams.delete(key)

  const currentState = window.history.state && typeof window.history.state === 'object'
    ? window.history.state as Record<string, unknown>
    : {}
  const currentUserState = currentState.usr && typeof currentState.usr === 'object'
    ? currentState.usr as Record<string, unknown>
    : {}
  const retainedState = { ...currentUserState }
  delete retainedState[MAP_ADDRESS_STATE_KEY]
  delete retainedState[GPS_STATE_KEY]
  delete retainedState[ERROR_STATE_KEY]
  const targetState = hasGps
    ? gps ? rememberMapGps(gps) : { [ERROR_STATE_KEY]: 'This shared GPS location is invalid. Enter an address or try your location again.' }
    : address ? rememberMapAddress(address) : {}

  window.history.replaceState(
    {
      ...currentState,
      usr: { ...retainedState, ...targetState },
    },
    '',
    `${url.pathname}${url.search}${url.hash}`,
  )
}
