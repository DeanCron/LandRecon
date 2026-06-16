import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  type SavedAnalysis,
  type SavedFactor,
  loadSavedAnalyses,
  writeSavedAnalyses,
} from '../map/savedAnalyses'
import { dbg } from '../utils/debug'
import './ComparePage.css'

// Canonical factor order + tier grouping for the comparison matrix. Mirrors
// the breakdown produced by computeLocationGrade() so rows read top-to-bottom
// the same way the Recon Report does.
const TIER_ORDER: Array<{ tier: SavedFactor['tier']; label: string }> = [
  { tier: 'safety', label: 'Safety' },
  { tier: 'lifestyle', label: 'Lifestyle' },
  { tier: 'convenience', label: 'Convenience' },
]

const FACTOR_ORDER = [
  'Airport Noise',
  'Superfund Sites',
  'Emergency Room',
  'Flood Zone',
  'Wildfire Hazard',
  'Data Centers',
  'Crowd Magnets',
  'Broadband',
  'Nearest Costco',
]

type FactorRow = {
  label: string
  icon: string
  tier: SavedFactor['tier']
  max: number
}

// Severity colour from a 0..1 score ratio — green (good) → amber → red.
function ratioColor(ratio: number): string {
  if (ratio >= 0.9) return '#4caf50'
  if (ratio >= 0.5) return '#ffb300'
  return '#ef5350'
}

function ComparePage() {
  const [saved, setSaved] = useState<SavedAnalysis[]>(() => loadSavedAnalyses())

  useEffect(() => {
    document.title = 'Compare Locations · LandRecon'
  }, [])

  const removeAt = (idx: number) => {
    const next = saved.filter((_, i) => i !== idx)
    dbg('compare', `Removed entry #${idx} from /compare; ${next.length} remaining`)
    setSaved(next)
    writeSavedAnalyses(next)
  }

  const clearAll = () => {
    dbg('compare', 'Cleared all saved locations from /compare')
    setSaved([])
    writeSavedAnalyses([])
  }

  // Build the union of factors present across all saved locations, ordered
  // canonically and grouped by tier.
  const rows = useMemo<FactorRow[]>(() => {
    const byLabel = new Map<string, FactorRow>()
    for (const sa of saved) {
      for (const f of sa.breakdown ?? []) {
        if (!byLabel.has(f.label)) {
          byLabel.set(f.label, { label: f.label, icon: f.icon, tier: f.tier, max: f.max })
        }
      }
    }
    return Array.from(byLabel.values()).sort(
      (a, b) => FACTOR_ORDER.indexOf(a.label) - FACTOR_ORDER.indexOf(b.label),
    )
  }, [saved])

  // For a given factor row, the best (highest) score ratio across locations,
  // used to highlight the strongest option — but only when there's variation.
  const bestRatioByLabel = useMemo<Record<string, number | null>>(() => {
    const out: Record<string, number | null> = {}
    for (const row of rows) {
      const ratios: number[] = []
      for (const sa of saved) {
        const f = sa.breakdown?.find((b) => b.label === row.label)
        if (f && f.max > 0) ratios.push(f.score / f.max)
      }
      const allEqual = ratios.length > 1 && ratios.every((r) => r === ratios[0])
      out[row.label] = ratios.length > 1 && !allEqual ? Math.max(...ratios) : null
    }
    return out
  }, [rows, saved])

  if (saved.length === 0) {
    return (
      <div className="compare-page">
        <div className="compare-page-inner">
          <header className="compare-page-head">
            <Link to="/map" className="compare-back">← Back to map</Link>
            <h1 className="compare-page-title">Compare Locations</h1>
          </header>
          <div className="compare-empty">
            <p>You haven't saved any locations yet.</p>
            <p className="compare-empty-hint">
              Open a Recon Report on the map and tap <strong>Save</strong> to pin a location here for
              side-by-side comparison.
            </p>
            <Link to="/map" className="compare-cta">Go to the map</Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="compare-page">
      <div className="compare-page-inner">
        <header className="compare-page-head">
          <Link to="/map" className="compare-back">← Back to map</Link>
          <h1 className="compare-page-title">Compare Locations</h1>
          <div className="compare-head-actions">
            <span className="compare-count">{saved.length} saved</span>
            <button className="compare-clear-all" onClick={clearAll}>Clear all</button>
          </div>
        </header>

        <div className="compare-matrix-scroll">
          <div
            className="compare-matrix"
            style={{ gridTemplateColumns: `minmax(140px, 1.2fr) repeat(${saved.length}, minmax(150px, 1fr))` }}
          >
            {/* Header row: location columns */}
            <div className="compare-cell compare-corner">Factor</div>
            {saved.map((sa, i) => (
              <div className="compare-cell compare-loc-head" key={`head-${i}`}>
                <div className="compare-loc-top">
                  <span className="compare-grade-badge" style={{ background: sa.gradeColor }}>{sa.grade}</span>
                  <span className="compare-loc-pct">{Math.round(sa.pct * 100)}%</span>
                  <button
                    className="compare-loc-remove"
                    onClick={() => removeAt(i)}
                    title="Remove"
                    aria-label={`Remove ${sa.address}`}
                  >×</button>
                </div>
                <div className="compare-loc-addr" title={sa.address}>{sa.address}</div>
                <div className="compare-loc-meta">
                  <span className="compare-loc-date">{sa.date}</span>
                  <Link className="compare-loc-reanalyze" to={`/map?address=${encodeURIComponent(sa.address)}`}>
                    Re-analyze
                  </Link>
                </div>
                {!sa.breakdown && (
                  <div className="compare-loc-legacy">Saved before detailed scoring — re-analyze for full breakdown.</div>
                )}
              </div>
            ))}

            {/* Tier-grouped factor rows — flat grid so columns stay aligned */}
            {TIER_ORDER.map(({ tier, label }) => {
              const tierRows = rows.filter((r) => r.tier === tier)
              if (tierRows.length === 0) return null
              return (
                <Fragment key={tier}>
                  <div className="compare-tier-head">{label}</div>
                  {tierRows.map((row) => (
                    <Row key={row.label} row={row} saved={saved} best={bestRatioByLabel[row.label]} />
                  ))}
                </Fragment>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function Row({ row, saved, best }: { row: FactorRow; saved: SavedAnalysis[]; best: number | null }) {
  return (
    <>
      <div className="compare-cell compare-factor-label">
        <span className="compare-factor-icon" aria-hidden="true">{row.icon}</span>
        <span>{row.label}</span>
      </div>
      {saved.map((sa, i) => {
        const f = sa.breakdown?.find((b) => b.label === row.label)
        if (!f) {
          return <div className="compare-cell compare-value compare-na" key={`${row.label}-${i}`}>—</div>
        }
        const ratio = f.max > 0 ? f.score / f.max : 0
        const isBest = best != null && ratio === best
        return (
          <div className={`compare-cell compare-value${isBest ? ' is-best' : ''}`} key={`${row.label}-${i}`}>
            <div className="compare-bar-track">
              <div
                className="compare-bar-fill"
                style={{ width: `${Math.round(ratio * 100)}%`, background: ratioColor(ratio) }}
              />
            </div>
            <div className="compare-value-row">
              <span className="compare-value-detail">{f.detail}</span>
              <span className="compare-value-score">{f.score}/{f.max}</span>
            </div>
          </div>
        )
      })}
    </>
  )
}

export default ComparePage
