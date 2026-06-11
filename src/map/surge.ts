// ── NOAA Storm Surge ────────────────────────────────────────────────────
// Storm Surge: NHC's National Storm Surge Hazard Maps v3 (pre-computed
// SLOSH MOMs). One MapServer per Saffir-Simpson category, hosted on
// tiles.arcgis.com under the NWS.NCEP.NHC.SSU AGOL org. Covers Atlantic,
// Gulf, Hawaii, and Puerto Rico/USVI coasts. Max zoom 14.
export const SURGE_CATEGORIES = [1, 2, 3, 4, 5] as const
export type SurgeCategory = typeof SURGE_CATEGORIES[number]
export const SURGE_TILE_URL = (cat: SurgeCategory) =>
  `https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/Storm_Surge_HazardMaps_Category${cat}_v3/MapServer/tile/{z}/{y}/{x}`
export const SURGE_ATTRIBUTION =
  '<a href="https://www.nhc.noaa.gov/nationalsurge/" target="_blank" rel="noopener">NOAA NHC Storm Surge</a>'
