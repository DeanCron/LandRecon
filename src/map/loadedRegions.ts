import type { LatLngBounds } from 'leaflet'

// Tracks which map areas a viewport-driven layer has already fetched.
//
// A single LatLngBounds grown with `extend` is wrong here: loading two distant
// areas produces one rectangle that also covers everything between them, so
// panning into that gap is treated as "already loaded" and never fetched.
// Instead we keep the individual loaded boxes and only skip a load when one
// box fully contains the viewport. Partial overlap simply refetches; layers
// dedupe markers by id, so that's cheap and correct.
export type LoadedRegions = readonly LatLngBounds[]

// Bounds the list on long panning sessions. Evicting the oldest region only
// costs a refetch if the user returns there.
export const MAX_LOADED_REGIONS = 32

export function isRegionLoaded(regions: LoadedRegions | null, bounds: LatLngBounds): boolean {
  return !!regions && regions.some((r) => r.contains(bounds))
}

export function addLoadedRegion(regions: LoadedRegions | null, bounds: LatLngBounds): LoadedRegions {
  const next = [...(regions ?? []).filter((r) => !bounds.contains(r)), bounds]
  return next.length > MAX_LOADED_REGIONS ? next.slice(next.length - MAX_LOADED_REGIONS) : next
}
