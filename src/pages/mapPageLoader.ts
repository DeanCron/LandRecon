import { loadAirportNoiseModule } from '../noise/loadAirportNoise'

type MapPageModule = typeof import('./MapPage')

let mapPageModulePromise: Promise<MapPageModule> | null = null

export function loadMapPage(): Promise<MapPageModule> {
  if (!mapPageModulePromise) {
    mapPageModulePromise = import('./MapPage')
  }
  return mapPageModulePromise
}

export function prefetchMapPage(): void {
  void loadMapPage().catch(() => undefined)
}

export function prefetchMapAnalysis(): void {
  prefetchMapPage()
  void loadAirportNoiseModule().catch(() => undefined)
}
