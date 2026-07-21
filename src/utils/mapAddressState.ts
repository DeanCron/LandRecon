export const MAP_ADDRESS_STATE_KEY = 'landReconAddress'

export type MapAddressState = {
  [MAP_ADDRESS_STATE_KEY]: string
}

export function rememberMapAddress(address: string): MapAddressState {
  return { [MAP_ADDRESS_STATE_KEY]: address.trim() }
}

export function resolveMapAddress(routeState: unknown): string {
  if (routeState && typeof routeState === 'object' && MAP_ADDRESS_STATE_KEY in routeState) {
    const value = routeState[MAP_ADDRESS_STATE_KEY]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export function scrubMapAddressBeforeAnalytics(): void {
  if (typeof window === 'undefined' || window.location.pathname !== '/map') return

  const url = new URL(window.location.href)
  if (!url.searchParams.has('address')) return

  const address = url.searchParams.get('address')?.trim() ?? ''
  url.searchParams.delete('address')

  const currentState = window.history.state && typeof window.history.state === 'object'
    ? window.history.state as Record<string, unknown>
    : {}
  const currentUserState = currentState.usr && typeof currentState.usr === 'object'
    ? currentState.usr as Record<string, unknown>
    : {}
  const addressState = address ? rememberMapAddress(address) : {}

  window.history.replaceState(
    {
      ...currentState,
      usr: { ...currentUserState, ...addressState },
    },
    '',
    `${url.pathname}${url.search}${url.hash}`,
  )
}
