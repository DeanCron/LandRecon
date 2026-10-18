import { describe, expect, it } from 'vitest'
import boundariesRaw from '../../public/data/districts/cd119.geojson?raw'
import resultsRaw from '../../public/data/districts/cd119-results.json?raw'

// The shipped district data: 119th Congress boundaries (Census) joined by
// GEOID to the 2024 House results (MIT Election Lab). Rebuilding with
// `npm run build:districts` should keep these passing; moving to a new
// election cycle means updating the 2024 anchors on purpose.

type Props = { GEOID: string; STATEFP: string; CD119FP: string }
type Result = {
  d: number
  r: number
  o: number
  total: number
  d_pct: number
  r_pct: number
  margin_pct: number
  winner: 'D' | 'R' | 'O'
}

const boundaries = JSON.parse(boundariesRaw) as GeoJSON.FeatureCollection<GeoJSON.Geometry, Props>
const { meta, results } = JSON.parse(resultsRaw) as {
  meta: { cycle: number; district_count: number }
  results: Record<string, Result>
}

const geoids = boundaries.features.map((f) => f.properties.GEOID)

// Territories have a delegate-district boundary but no MIT result row.
const TERRITORY_FIPS = ['60', '66', '69', '72', '78']

describe('congressional district boundaries', () => {
  it('has one feature per seat: 435 districts, DC and the five territories', () => {
    expect(geoids).toHaveLength(441)
    expect(new Set(geoids).size).toBe(441)
  })

  it('carries the 119th Congress district field', () => {
    for (const { properties: p } of boundaries.features) {
      expect(p.CD119FP, p.GEOID).toMatch(/^\d{2}$/)
      expect(p.GEOID).toBe(p.STATEFP + p.CD119FP)
    }
  })
})

describe('2024 House results', () => {
  it('joins every result to a boundary, leaving only the territories unmatched', () => {
    expect(meta.cycle).toBe(2024)
    expect(Object.keys(results)).toHaveLength(meta.district_count)
    for (const id of Object.keys(results)) expect(geoids, id).toContain(id)
    const unmatched = geoids.filter((id) => !(id in results))
    expect(unmatched.map((id) => id.slice(0, 2)).sort()).toEqual(TERRITORY_FIPS)
  })

  it("keys DC by Census's delegate district 98, not MIT's 0", () => {
    expect(results['1198']?.winner).toBe('D')
    expect(results['1100']).toBeUndefined()
  })

  it('has vote counts that reconcile with the shares and winner', () => {
    for (const [id, r] of Object.entries(results)) {
      expect(r.d + r.r + r.o, id).toBe(r.total)
      expect(r.margin_pct, id).toBeCloseTo(r.d_pct - r.r_pct, 1)
      const votes = { D: r.d, R: r.r, O: r.o }
      expect(votes[r.winner], id).toBe(Math.max(...Object.values(votes)))
    }
  })

  it('reproduces the 2024 outcome: R 220, D 215 plus the DC delegate', () => {
    const tally = { D: 0, R: 0, O: 0 }
    for (const r of Object.values(results)) tally[r.winner]++
    expect(tally).toEqual({ D: 216, R: 220, O: 0 })
  })

  it("counts Minnesota's Democratic-Farmer-Labor candidates as Democrats", () => {
    expect(results['2703'].winner).toBe('D')
    expect(results['2703'].d_pct).toBeGreaterThan(55)
  })

  it('folds New York fusion lines into the major parties', () => {
    // Conservative / Working Families lines count for the candidate's party,
    // leaving only scattering votes in "other".
    const ny1 = results['3601']
    expect(ny1.winner).toBe('R')
    expect(ny1.d_pct + ny1.r_pct).toBeGreaterThan(99)
  })

  it("counts Vermont's \"Republican, Libertarian\" line as Republican", () => {
    expect(results['5000'].r_pct).toBeGreaterThan(25)
  })

  it('excludes blank ballots from vote shares', () => {
    // Unopposed MA-04 is ~97% for the Democrat, not ~70% with blanks counted.
    expect(results['2504'].d_pct).toBeGreaterThan(95)
  })
})
