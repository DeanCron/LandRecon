import type { EvidenceState, FactorEvidence as FactorEvidenceData } from '../map/evidence'

type Props = {
  label: string
  evidence?: FactorEvidenceData
  /** Compact single-line variant for the Compare view rows. */
  compact?: boolean
}

const LEGACY_MESSAGE =
  'Evidence details unavailable for this saved analysis. Re-analyze to refresh.'

const STATE_LABELS: Record<EvidenceState, string> = {
  verified: 'Verified',
  caution: 'Limited data',
  unavailable: 'Data unavailable',
}

const STATE_ARIA: Record<EvidenceState, string> = {
  verified: 'Evidence verified',
  caution: 'Evidence limited — review caution',
  unavailable: 'Data unavailable',
}

/**
 * Presentational evidence renderer shared by the Recon Report and Compare views.
 * Purely additive to the (frozen) grade math — it never touches scores. State is
 * always conveyed with text + aria-label, never colour alone.
 */
export function FactorEvidence({ label, evidence, compact = false }: Props) {
  if (!evidence) {
    return (
      <p className="factor-evidence factor-evidence-legacy" role="note">
        {LEGACY_MESSAGE}
      </p>
    )
  }

  const stateLabel = STATE_LABELS[evidence.state]
  const stateAria = STATE_ARIA[evidence.state]

  if (compact) {
    return (
      <span
        className={`factor-evidence-chip factor-evidence-${evidence.state}`}
        aria-label={`${label}: ${stateAria}`}
      >
        {stateLabel}
      </span>
    )
  }

  return (
    <div
      className={`factor-evidence factor-evidence-${evidence.state}`}
      aria-label={`${label}: ${stateAria}`}
    >
      <div className="factor-evidence-state">
        <span className="factor-evidence-state-label">{stateLabel}</span>
        {evidence.freshness && (
          <span className="factor-evidence-freshness">{evidence.freshness}</span>
        )}
      </div>
      <p className="factor-evidence-source">
        <span className="factor-evidence-source-label">Source:</span> {evidence.source}
      </p>
      <p className="factor-evidence-rule">{evidence.rule}</p>
      <div className="factor-evidence-why">
        <span className="factor-evidence-why-label">Why it matters</span>
        <p>{evidence.whyItMatters}</p>
      </div>
    </div>
  )
}

export default FactorEvidence
