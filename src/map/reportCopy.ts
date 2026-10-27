import type { LocationGradeResult } from './analysisTypes'

// Shared by the PDF export and the printable /report page so both say the same thing.
export const REPORT_DISCLAIMER =
  'Informational only. This report is not a verified property boundary and is not a substitute for a professional inspection, survey, or an official FEMA flood determination. Data is drawn from public sources and may be incomplete or out of date; verify important findings through official sources before making decisions.'

export const MAP_UNAVAILABLE_NOTE = 'Map image unavailable for this report.'

export type DataVintage = { label: string; source: string; freshness: string }

/** One row per factor that reports a source and data vintage, in breakdown order. */
export function dataVintages(grade: LocationGradeResult): DataVintage[] {
  const rows: DataVintage[] = []
  for (const item of grade.breakdown) {
    const evidence = grade.evidence[item.label]
    if (evidence?.freshness) {
      rows.push({ label: item.label, source: evidence.source, freshness: evidence.freshness })
    }
  }
  return rows
}
