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
