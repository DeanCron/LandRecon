import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces'
import type { LocationGradeResult } from './analysisTypes'
import { qualitySummaryText, qualitySummaryTone } from './evidence'

export type ReconPdfInput = {
  address: string
  date: Date
  grade: LocationGradeResult
  mapDataUrl?: string | null
}

const BRAND = '#2e7d32'
const CAUTION_BG = '#fff8e1'
const CAUTION_BORDER = '#ffb300'

const GRADE_LABELS: Record<string, string> = {
  A: 'Excellent',
  B: 'Good',
  C: 'Fair',
  D: 'Poor',
  F: 'Critical',
}

const STATE_LABELS = {
  verified: 'Verified',
  caution: 'Caution: limited data',
  unavailable: 'Data unavailable',
} as const

function gradeLabel(letter: string): string {
  return GRADE_LABELS[letter] ?? 'Critical'
}

function factorBlocks(grade: LocationGradeResult): Content[] {
  return grade.breakdown.map((item) => {
    const evidence = grade.evidence[item.label]
    const stack: Content[] = [
      { text: item.label, style: 'factorLabel' },
      { text: item.detail, style: 'factorDetail' },
    ]

    if (evidence) {
      const evidenceLines = [
        `State: ${STATE_LABELS[evidence.state]}`,
        `Source: ${evidence.source}`,
        evidence.rule,
      ]
      if (evidence.freshness) evidenceLines.push(`Freshness: ${evidence.freshness}`)
      stack.push({ text: evidenceLines.join('\n'), style: 'evidence' })
      stack.push({ text: `Why it matters: ${evidence.whyItMatters}`, style: 'evidenceWhy' })
    }

    return { stack, margin: [0, 0, 0, 10] }
  })
}

function caveatsBlock(grade: LocationGradeResult): Content | null {
  const unavailable = Object.entries(grade.evidence)
    .filter(([, evidence]) => evidence.state === 'unavailable')
    .map(([label]) => label)

  if (unavailable.length === 0) return null

  return {
    table: {
      widths: ['*'],
      body: [[{
        stack: [
          { text: 'Incomplete data', style: 'caveatTitle' },
          {
            text: `These checks couldn't complete; the grade reflects only available data: ${unavailable.join(', ')}.`,
            style: 'caveatBody',
          },
        ],
        fillColor: CAUTION_BG,
        margin: [8, 8, 8, 8],
      }]],
    },
    layout: {
      hLineColor: () => CAUTION_BORDER,
      vLineColor: () => CAUTION_BORDER,
      hLineWidth: () => 1,
      vLineWidth: () => 1,
    },
    margin: [0, 0, 0, 14],
  }
}

export function buildReconPdfDocDefinition(input: ReconPdfInput): TDocumentDefinitions {
  const { address, date, grade, mapDataUrl } = input
  const content: Content[] = [
    { text: 'LandRecon — Recon Report', style: 'title' },
    { text: address || 'Unknown address', style: 'address' },
    { text: date.toLocaleDateString(), style: 'date' },
    {
      canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 2, lineColor: BRAND }],
      margin: [0, 6, 0, 12],
    },
  ]

  if (mapDataUrl) {
    content.push({ image: mapDataUrl, width: 515, margin: [0, 0, 0, 14] })
  }

  content.push({
    columns: [
      { text: grade.letter, style: 'gradeLetter', color: grade.color, width: 60 },
      {
        stack: [
          { text: `${Math.round(grade.pct * 100)}% — ${gradeLabel(grade.letter)}`, style: 'gradeSummary' },
          { text: `Data quality: ${qualitySummaryText(grade.quality)}`, style: `quality_${qualitySummaryTone(grade.quality)}` },
        ],
      },
    ],
    margin: [0, 0, 0, 14],
  })

  const caveats = caveatsBlock(grade)
  if (caveats) content.push(caveats)

  content.push({ text: 'Factor breakdown', style: 'sectionHeading' })
  content.push(...factorBlocks(grade))
  content.push({
    text: 'LandRecon is provided for informational purposes only. Data may not be complete or current. Always verify important findings through official sources before making decisions.',
    style: 'disclaimer',
    margin: [0, 14, 0, 0],
  })

  return {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 48],
    content,
    styles: {
      title: { fontSize: 18, bold: true, color: BRAND },
      address: { fontSize: 12, bold: true, margin: [0, 4, 0, 0] },
      date: { fontSize: 9, color: '#666' },
      gradeLetter: { fontSize: 40, bold: true },
      gradeSummary: { fontSize: 13, bold: true, margin: [0, 6, 0, 2] },
      quality_verified: { fontSize: 10, color: '#2e7d32' },
      quality_caution: { fontSize: 10, color: '#b26a00' },
      quality_unavailable: { fontSize: 10, color: '#c62828' },
      caveatTitle: { fontSize: 12, bold: true, color: '#b26a00' },
      caveatBody: { fontSize: 10, margin: [0, 4, 0, 0] },
      sectionHeading: { fontSize: 14, bold: true, margin: [0, 6, 0, 8] },
      factorLabel: { fontSize: 12, bold: true },
      factorDetail: { fontSize: 10, margin: [0, 1, 0, 2] },
      evidence: { fontSize: 9, color: '#444' },
      evidenceWhy: { fontSize: 9, italics: true, color: '#444', margin: [0, 2, 0, 0] },
      disclaimer: { fontSize: 8, color: '#888', italics: true },
    },
    footer: (currentPage: number, pageCount: number) => ({
      text: `Page ${currentPage} of ${pageCount}`,
      alignment: 'center',
      fontSize: 8,
      color: '#999',
      margin: [0, 8, 0, 0],
    }),
  }
}

export function reconPdfFilename(address: string, date: Date): string {
  const slug = address
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const iso = date.toISOString().slice(0, 10)
  return `LandRecon-${slug || 'report'}-${iso}.pdf`
}
