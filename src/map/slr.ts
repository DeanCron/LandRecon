// ── NOAA Sea-Level Rise ─────────────────────────────────────────────────
// Sea-Level Rise: NOAA Office for Coastal Management SLR Viewer. One
// MapServer per foot of rise (0–10 ft). Confidence-symbology raster
// shows where land would be permanently inundated at that level. Covers
// all US coasts including AK and HI. Max zoom 16.
export const SLR_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const
export type SlrLevel = typeof SLR_LEVELS[number]
export const SLR_TILE_URL = (ft: SlrLevel) =>
  `https://coast.noaa.gov/arcgis/rest/services/dc_slr/conf_${ft}ft/MapServer/tile/{z}/{y}/{x}`
export const SLR_ATTRIBUTION =
  '<a href="https://coast.noaa.gov/slr/" target="_blank" rel="noopener">NOAA Sea Level Rise Viewer</a>'
