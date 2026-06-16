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

// Tier grouping + canonical factor order for the expandable breakdown. Mirrors
// the breakdown produced by computeLocationGrade() so factors read top-to-bottom
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
  'Seismic Hazard',
  'Data Centers',
  'Crowd Magnets',
  'Broadband',
  'Nearest Costco',
]

// Colour from a 0..1 *goodness* ratio (1 = clear / no penalty): green → amber
// → red. Breakdown scores are penalties (higher = worse), so callers pass
// goodness = 1 − score/max.
function goodnessColor(g: number): string {
  if (g >= 0.9) return '#4caf50'
  if (g >= 0.5) return '#ffb300'
  return '#ef5350'
}

// Per-tier goodness for one location: 1 − (sum of penalties / sum of maxes)
// across that tier's factors. Returns null when the tier has no scored factors.
function tierGoodness(breakdown: SavedFactor[] | undefined, tier: SavedFactor['tier']): number | null {
  if (!breakdown) return null
  const items = breakdown.filter((f) => f.tier === tier)
  const max = items.reduce((a, b) => a + b.max, 0)
  if (max <= 0) return null
  const score = items.reduce((a, b) => a + b.score, 0)
  return 1 - score / max
}

function orderedBreakdown(breakdown: SavedFactor[]): SavedFactor[] {
  return [...breakdown].sort(
    (a, b) => FACTOR_ORDER.indexOf(a.label) - FACTOR_ORDER.indexOf(b.label),
  )
}

function keyOf(sa: SavedAnalysis): string {
  return `${sa.address}|${sa.date}`
}

function ComparePage() {
  const [saved, setSaved] = useState<SavedAnalysis[]>(() => loadSavedAnalyses())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

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

  const toggle = (k: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  // Rank locations best → worst by overall score, keeping each entry's original
  // index so remove still targets the right localStorage slot.
  const ranked = useMemo(
    () => saved.map((sa, idx) => ({ sa, idx })).sort((a, b) => b.sa.pct - a.sa.pct),
    [saved],
  )
  const topPct = ranked.length > 0 ? ranked[0].sa.pct : 0

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

        <p className="compare-rank-hint">Ranked best to worst by overall Recon score.</p>

        <ol className="compare-rank-list">
          {ranked.map(({ sa, idx }, rank) => {
            const k = keyOf(sa)
            const isOpen = expanded.has(k)
            const isWinner = ranked.length > 1 && rank === 0
            const deltaPts = Math.round((sa.pct - topPct) * 100)
            return (
              <li
                className={`compare-rank-card${isWinner ? ' is-winner' : ''}`}
                key={k}
              >
                <div className="compare-rank-main">
                  <div className="compare-rank-badge" aria-label={`Rank ${rank + 1}`}>
                    {isWinner ? '🏆' : `#${rank + 1}`}
                  </div>
                  <span className="compare-grade-badge" style={{ background: sa.gradeColor }}>{sa.grade}</span>
                  <div className="compare-rank-body">
                    <div className="compare-rank-addr" title={sa.address}>{sa.address}</div>
                    <div className="compare-rank-sub">
                      <span className="compare-loc-date">{sa.date}</span>
                      {isWinner && <span className="compare-best-tag">Best match</span>}
                      {!isWinner && deltaPts < 0 && (
                        <span className="compare-delta">{deltaPts} pts vs. #1</span>
                      )}
                    </div>
                  </div>
                  <div className="compare-rank-score">
                    <span className="compare-rank-pct">{Math.round(sa.pct * 100)}%</span>
                    <div className="compare-bar-track compare-rank-bar">
                      <div
                        className="compare-bar-fill"
                        style={{ width: `${Math.round(sa.pct * 100)}%`, background: goodnessColor(sa.pct) }}
                      />
                    </div>
                  </div>
                  <div className="compare-rank-actions">
                    <Link className="compare-loc-reanalyze" to={`/map?address=${encodeURIComponent(sa.address)}`}>
                      Re-analyze
                    </Link>
                    <button
                      className="compare-loc-remove"
                      onClick={() => removeAt(idx)}
                      title="Remove"
                      aria-label={`Remove ${sa.address}`}
                    >×</button>
                  </div>
                </div>

                {/* Tier sub-scores — a quick visual even before expanding */}
                {sa.breakdown ? (
                  <>
                    <div className="compare-tier-strip">
                      {TIER_ORDER.map(({ tier, label }) => {
                        const g = tierGoodness(sa.breakdown, tier)
                        if (g === null) return null
                        return (
                          <div className="compare-tier-mini" key={tier}>
                            <span className="compare-tier-mini-label">{label}</span>
                            <div className="compare-bar-track">
                              <div
                                className="compare-bar-fill"
                                style={{ width: `${Math.round(g * 100)}%`, background: goodnessColor(g) }}
                              />
                            </div>
                          </div>
                        )
                      })}
                    </div>

                    <button
                      className="compare-expand-toggle"
                      onClick={() => toggle(k)}
                      aria-expanded={isOpen}
                    >
                      {isOpen ? '▾ Hide factor breakdown' : '▸ Show factor breakdown'}
                    </button>

                    {isOpen && (
                      <div className="compare-factors">
                        {TIER_ORDER.map(({ tier, label }) => {
                          const items = orderedBreakdown(sa.breakdown!.filter((f) => f.tier === tier))
                          if (items.length === 0) return null
                          return (
                            <Fragment key={tier}>
                              <div className="compare-factor-tier">{label}</div>
                              {items.map((f) => {
                                const g = f.max > 0 ? 1 - f.score / f.max : 1
                                return (
                                  <div className="compare-factor-row" key={f.label}>
                                    <span className="compare-factor-icon" aria-hidden="true">{f.icon}</span>
                                    <span className="compare-factor-name">{f.label}</span>
                                    <div className="compare-bar-track compare-factor-bar">
                                      <div
                                        className="compare-bar-fill"
                                        style={{ width: `${Math.round(g * 100)}%`, background: goodnessColor(g) }}
                                      />
                                    </div>
                                    <span className="compare-factor-detail">{f.detail}</span>
                                  </div>
                                )
                              })}
                            </Fragment>
                          )
                        })}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="compare-loc-legacy">
                    Saved before detailed scoring — re-analyze for the full factor breakdown.
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}

export default ComparePage
