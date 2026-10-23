import { describe, expect, it } from 'vitest'
import scriptRaw from '../../scripts/build_noise_pmtiles.py?raw'
import { NOISE_BAND_BREAKS } from './legend'

// The PMTiles builder contours the source rasters at DB_BREAKS, and the app
// styles and queries the result by `db_min`. If the two drift apart (as they
// once did, when the script also emitted a 45-50 dB band), "outside mapped
// contours" starts reading as a noisy site and the legend mislabels the band.
describe('build_noise_pmtiles.py', () => {
  it('contours at the same dB breaks the app legend uses', () => {
    const raw = scriptRaw.match(/^DB_BREAKS: list\[int\] = \[([\d,\s]+)\]/m)?.[1]
    if (!raw) throw new Error('DB_BREAKS not found in scripts/build_noise_pmtiles.py')
    expect(raw.split(',').map((s) => Number(s.trim()))).toEqual([...NOISE_BAND_BREAKS])
  })
})
