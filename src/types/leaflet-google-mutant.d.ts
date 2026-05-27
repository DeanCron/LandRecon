import * as L from 'leaflet'

declare module 'leaflet' {
  namespace gridLayer {
    function googleMutant(options?: GoogleMutantOptions): GoogleMutant
  }

  interface GoogleMutantOptions extends L.GridLayerOptions {
    type?: string
    styles?: Array<Record<string, unknown>>
    maxZoom?: number
  }

  interface GoogleMutant extends L.GridLayer {}
}
