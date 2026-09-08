export type EvidenceState = 'verified' | 'caution' | 'unavailable'

export type FactorEvidence = {
  state: EvidenceState
  source: string
  rule: string
  whyItMatters: string
  freshness?: string
}

export type ReportQuality = {
  state: EvidenceState
  verifiedCount: number
  cautionCount: number
  unavailableCount: number
}

export function summarizeReportQuality(items: FactorEvidence[]): ReportQuality {
  const verifiedCount = items.filter((item) => item.state === 'verified').length
  const cautionCount = items.filter((item) => item.state === 'caution').length
  const unavailableCount = items.filter((item) => item.state === 'unavailable').length
  const state: EvidenceState = cautionCount > 0 || (verifiedCount > 0 && unavailableCount > 0)
    ? 'caution'
    : verifiedCount > 0
    ? 'verified'
      : 'unavailable'
  return { state, verifiedCount, cautionCount, unavailableCount }
}

/**
 * Tone used for the report-quality summary chip. Derived from the same
 * count priority as {@link qualitySummaryText} so the colour class and the
 * visible wording never disagree (unavailable data takes visual priority).
 */
export function qualitySummaryTone(quality: ReportQuality): EvidenceState {
  if (quality.unavailableCount > 0) return 'unavailable'
  if (quality.cautionCount > 0) return 'caution'
  return 'verified'
}

/** Human-readable one-line summary of overall report data quality. */
export function qualitySummaryText(quality: ReportQuality): string {
  if (quality.unavailableCount > 0) return 'Some data unavailable'
  if (quality.cautionCount > 0) return 'Review cautions'
  return 'All checks verified'
}
