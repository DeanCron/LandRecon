type AirportNoiseModule = typeof import('./airportNoise')

let airportNoiseModulePromise: Promise<AirportNoiseModule> | null = null

export function loadAirportNoiseModule(): Promise<AirportNoiseModule> {
  if (!airportNoiseModulePromise) {
    airportNoiseModulePromise = import('./airportNoise')
  }
  return airportNoiseModulePromise
}
