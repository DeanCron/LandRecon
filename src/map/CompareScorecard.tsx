import { Fragment, memo, useMemo, useState, type CSSProperties } from 'react'
import {
  type SavedAnalysis,
  type SavedFactor,
} from './savedAnalyses'
import './CompareScorecard.css'

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
  'Tornado Risk',
  'Railroad',
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

type Props = {
  saved: SavedAnalysis[]
  onRemove: (idx: number) => void
  onReanalyze: (address: string) => void
}

// Presentational ranked scorecard — locations sorted best → worst by overall
// Recon score, the winner emphasized, each card expandable to its full factor
// breakdown. Storage/state is owned by the parent (the map's Compare panel and
// the saved-analyses store); this component is pure UI.
function CompareScorecard({ saved, onRemove, onReanalyze }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const toggle = (k: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  // Rank best → worst by overall score, keeping each entry's original index so
  // remove still targets the right store slot. Memoized so the parent's
  // frequent re-renders (map moves, analysis updates) don't re-sort the list.
  const { ranked, topPct } = useMemo(() => {
    const r = saved
      .map((sa, idx) => ({ sa, idx }))
      .sort((a, b) => b.sa.pct - a.sa.pct)
    return { ranked: r, topPct: r.length > 0 ? r[0].sa.pct : 0 }
  }, [saved])

  if (saved.length === 0) {
    return <p className="compare-rank-empty">No saved locations yet.</p>
  }

  return (
    <>
      <p className="compare-rank-hint">Ranked best to worst by overall Recon score.</p>
      <ol className="compare-rank-list">
        {ranked.map(({ sa, idx }, rank) => {
          const k = keyOf(sa)
          const isOpen = expanded.has(k)
          const isWinner = ranked.length > 1 && rank === 0
          const deltaPts = Math.round((sa.pct - topPct) * 100)
          return (
            <li className={`compare-rank-card${isWinner ? ' is-winner' : ''}`} key={k}>
              <div className="compare-rank-top">
                <div className="compare-rank-badge" aria-label={`Rank ${rank + 1}`}>
                  {isWinner ? '🏆' : `#${rank + 1}`}
                </div>
                <span className="compare-grade-badge" style={{ '--grade-color': sa.gradeColor } as CSSProperties}>{sa.grade}</span>
                <button
                  className="compare-loc-remove"
                  onClick={() => onRemove(idx)}
                  title="Remove"
                  aria-label={`Remove ${sa.address}`}
                >×</button>
              </div>
              <div className="compare-rank-addr" title={sa.address}>{sa.address}</div>
              <div className="compare-rank-sub">
                <span className="compare-loc-date">{sa.date}</span>
                {isWinner && <span className="compare-best-tag">Best match</span>}
                {!isWinner && deltaPts < 0 && (
                  <span className="compare-delta">{deltaPts} pts vs. #1</span>
                )}
              </div>

              <div className="compare-rank-scorerow">
                <span className="compare-rank-pct">{Math.round(sa.pct * 100)}%</span>
                <div className="compare-bar-track compare-rank-bar">
                  <div
                    className="compare-bar-fill"
                    style={{ width: `${Math.round(sa.pct * 100)}%`, background: goodnessColor(sa.pct) }}
                  />
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

                  <div className="compare-rank-footer">
                    <button
                      className="compare-expand-toggle"
                      onClick={() => toggle(k)}
                      aria-expanded={isOpen}
                    >
                      {isOpen ? '▾ Hide factor breakdown' : '▸ Show factor breakdown'}
                    </button>
                    <button
                      className="compare-loc-reanalyze"
                      onClick={() => onReanalyze(sa.address)}
                    >
                      Re-analyze
                    </button>
                  </div>

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
                <div className="compare-rank-footer">
                  <button
                    className="compare-loc-reanalyze"
                    onClick={() => onReanalyze(sa.address)}
                  >
                    Re-analyze
                  </button>
                </div>
              )}
              {!sa.breakdown && (
                <div className="compare-loc-legacy">
                  Saved before detailed scoring — re-analyze for the full factor breakdown.
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </>
  )
}

export default memo(CompareScorecard)
