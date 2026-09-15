# Downloadable PDF Recon Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Download PDF" action to the live Recon Report that generates a real, client-side PDF (grade, evidence, prominent caveats, and a map snapshot) with the PDF library lazy-loaded.

**Architecture:** Three pure/isolated modules — `staticMap.ts` (Google Static Maps URL + fetch→base64), `reconPdf.ts` (data → pdfmake document definition), `pdfExport.ts` (dynamically imports pdfmake and triggers download) — wired into `MapPage.tsx` by a new action button. Every value comes verbatim from the existing `computeLocationGrade(...)` result; scores are never recomputed.

**Tech Stack:** React 19 + TypeScript + Vite, Vitest, `pdfmake` (lazy-loaded), Google Static Maps API.

## Global Constraints

- **Grade math is frozen.** The PDF consumes `computeLocationGrade` output only; no change to scoring, tier weights, thresholds, or the on-screen report.
- **Lazy-load pdfmake.** pdfmake is reached ONLY via dynamic `import()` inside `pdfExport.ts`, so it lands in its own async chunk and never enters the Home entry, map-route, or analysis-detail static graphs. Elsewhere use `import type` only.
- **Graceful degradation.** A missing/failed map snapshot must not block the PDF; a failed pdfmake load/generation must show a dismissible error and never crash the app.
- **Bundle budget stays green.** `scripts/check-bundle-budget.mjs` gets a dedicated documented bucket (~1.2 MB gzip) for the on-demand pdfmake chunk(s); the generic 55 KiB per-async-chunk cap and all route/entry caps remain strict for every other chunk.
- **Windows dev env.** Run tests via `npx vitest run <files>`; typecheck via `npx tsc -b --pretty false`. Vitest globals are imported explicitly (`import { describe, it, expect, vi } from 'vitest'`).

---

### Task 1: Static map snapshot helper

**Files:**
- Create: `src/map/staticMap.ts`
- Test: `src/map/staticMap.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `type StaticMapOptions = { lat: number; lng: number; zoom?: number; width?: number; height?: number; scale?: number; key: string }`
  - `buildStaticMapUrl(opts: StaticMapOptions): string`
  - `fetchStaticMapDataUrl(opts: StaticMapOptions, deps?: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<string | null>`

- [ ] **Step 1: Write the failing tests**

Create `src/map/staticMap.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { buildStaticMapUrl, fetchStaticMapDataUrl } from './staticMap'

describe('buildStaticMapUrl', () => {
  it('encodes center, zoom, size, scale, marker, and key', () => {
    const url = buildStaticMapUrl({ lat: 40.1, lng: -74.2, key: 'KEY123' })
    expect(url).toContain('https://maps.googleapis.com/maps/api/staticmap')
    expect(url).toContain('center=40.1%2C-74.2')
    expect(url).toContain('markers=')
    expect(url).toContain('40.1%2C-74.2')
    expect(url).toContain('zoom=15')
    expect(url).toContain('size=640x320')
    expect(url).toContain('scale=2')
    expect(url).toContain('key=KEY123')
  })

  it('honors explicit zoom and size overrides', () => {
    const url = buildStaticMapUrl({ lat: 1, lng: 2, zoom: 12, width: 320, height: 200, scale: 1, key: 'K' })
    expect(url).toContain('zoom=12')
    expect(url).toContain('size=320x200')
    expect(url).toContain('scale=1')
  })
})

describe('fetchStaticMapDataUrl', () => {
  it('returns null when no key is provided (without fetching)', async () => {
    const fetchImpl = vi.fn()
    const result = await fetchStaticMapDataUrl({ lat: 1, lng: 2, key: '' }, { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('resolves to a base64 PNG data URL on success', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]).buffer
    const fetchImpl = vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes })) as unknown as typeof fetch
    const result = await fetchStaticMapDataUrl({ lat: 1, lng: 2, key: 'K' }, { fetchImpl })
    expect(result).toMatch(/^data:image\/png;base64,/)
  })

  it('returns null on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch
    const result = await fetchStaticMapDataUrl({ lat: 1, lng: 2, key: 'K' }, { fetchImpl })
    expect(result).toBeNull()
  })

  it('returns null when fetch throws', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network') }) as unknown as typeof fetch
    const result = await fetchStaticMapDataUrl({ lat: 1, lng: 2, key: 'K' }, { fetchImpl })
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src/map/staticMap.test.ts`
Expected: FAIL — `staticMap.ts` does not exist.

- [ ] **Step 3: Implement `src/map/staticMap.ts`**

```ts
export type StaticMapOptions = {
  lat: number
  lng: number
  zoom?: number
  width?: number
  height?: number
  scale?: number
  key: string
}

const STATIC_MAP_ENDPOINT = 'https://maps.googleapis.com/maps/api/staticmap'

export function buildStaticMapUrl(opts: StaticMapOptions): string {
  const zoom = opts.zoom ?? 15
  const width = opts.width ?? 640
  const height = opts.height ?? 320
  const scale = opts.scale ?? 2
  const center = `${opts.lat},${opts.lng}`
  const params = new URLSearchParams({
    center,
    zoom: String(zoom),
    size: `${width}x${height}`,
    scale: String(scale),
    markers: `color:red|${center}`,
    key: opts.key,
  })
  return `${STATIC_MAP_ENDPOINT}?${params.toString()}`
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export async function fetchStaticMapDataUrl(
  opts: StaticMapOptions,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<string | null> {
  if (!opts.key) return null
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? 8000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(buildStaticMapUrl(opts), { signal: controller.signal })
    if (!res.ok) return null
    const buffer = await res.arrayBuffer()
    return `data:image/png;base64,${toBase64(new Uint8Array(buffer))}`
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run src/map/staticMap.test.ts`
Expected: PASS (6 assertions across 6 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b --pretty false`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/map/staticMap.ts src/map/staticMap.test.ts
git commit -m "feat: add Google Static Maps snapshot helper"
```

---

### Task 2: Recon PDF document-definition builder

**Files:**
- Create: `src/map/reconPdf.ts`
- Test: `src/map/reconPdf.test.ts`
- Modify: `package.json` (add `pdfmake` + `@types/pdfmake`)

**Interfaces:**
- Consumes: `LocationGradeResult` from `src/map/analysisTypes.ts`; `qualitySummaryText`, `qualitySummaryTone` from `src/map/evidence.ts`.
- Produces:
  - `type ReconPdfInput = { address: string; date: Date; grade: LocationGradeResult; mapDataUrl?: string | null }`
  - `buildReconPdfDocDefinition(input: ReconPdfInput): TDocumentDefinitions`
  - `reconPdfFilename(address: string, date: Date): string`

- [ ] **Step 1: Add the pdfmake dependency**

Run:

```bash
npm install pdfmake@^0.3.11
npm install -D @types/pdfmake
```

Expected: `package.json` and `package-lock.json` updated. (Only `import type` from pdfmake is used in this task — no runtime import, so no bundle impact yet.)

- [ ] **Step 2: Write the failing tests**

Create `src/map/reconPdf.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildReconPdfDocDefinition, reconPdfFilename } from './reconPdf'
import type { LocationGradeResult } from './analysisTypes'
import type { FactorEvidence } from './evidence'

function ev(state: FactorEvidence['state'], extra: Partial<FactorEvidence> = {}): FactorEvidence {
  return {
    state,
    source: 'FEMA',
    rule: 'Point lookup',
    whyItMatters: 'Matters because reasons.',
    ...extra,
  }
}

function grade(overrides: Partial<LocationGradeResult> = {}): LocationGradeResult {
  return {
    letter: 'A',
    color: '#4caf50',
    severity: 'clear',
    pct: 1,
    breakdown: [
      { label: 'Flood Zone', icon: '🌊', score: 0, max: 3, detail: 'Zone X', tier: 'safety' },
      { label: 'Nearest Costco', icon: '🛒', score: 0, max: 1, detail: '4 mi away', tier: 'convenience' },
    ],
    evidence: {
      'Flood Zone': ev('verified'),
      'Nearest Costco': ev('verified', { whyItMatters: 'Bulk mayonnaise proximity, obviously.' }),
    } as LocationGradeResult['evidence'],
    quality: { state: 'verified', verifiedCount: 2, cautionCount: 0, unavailableCount: 0 },
    ...overrides,
  }
}

describe('buildReconPdfDocDefinition', () => {
  it('includes the address, date, and grade letter', () => {
    const doc = buildReconPdfDocDefinition({ address: '123 Main St', date: new Date('2026-09-15T12:00:00Z'), grade: grade() })
    const json = JSON.stringify(doc)
    expect(json).toContain('123 Main St')
    expect(json).toContain('Recon Report')
    expect(json).toContain('2026')
    expect(json).toContain('"A"')
  })

  it('renders each factor with its evidence source and why-it-matters', () => {
    const json = JSON.stringify(buildReconPdfDocDefinition({ address: 'x', date: new Date(), grade: grade() }))
    expect(json).toContain('Flood Zone')
    expect(json).toContain('Nearest Costco')
    expect(json).toContain('FEMA')
    expect(json).toContain('Bulk mayonnaise proximity, obviously.')
  })

  it('omits the caveats block when all checks are verified', () => {
    const json = JSON.stringify(buildReconPdfDocDefinition({ address: 'x', date: new Date(), grade: grade() }))
    expect(json).not.toContain('Incomplete data')
  })

  it('renders a prominent caveats block listing unavailable factors', () => {
    const g = grade({
      evidence: {
        'Flood Zone': ev('unavailable', { rule: 'Lookup failed' }),
        'Nearest Costco': ev('verified'),
      } as LocationGradeResult['evidence'],
      quality: { state: 'caution', verifiedCount: 1, cautionCount: 0, unavailableCount: 1 },
    })
    const json = JSON.stringify(buildReconPdfDocDefinition({ address: 'x', date: new Date(), grade: g }))
    expect(json).toContain('Incomplete data')
    expect(json).toContain('Flood Zone')
  })

  it('includes the map image node only when a data URL is provided', () => {
    const withMap = JSON.stringify(buildReconPdfDocDefinition({ address: 'x', date: new Date(), grade: grade(), mapDataUrl: 'data:image/png;base64,AAAA' }))
    expect(withMap).toContain('data:image/png;base64,AAAA')
    const withoutMap = JSON.stringify(buildReconPdfDocDefinition({ address: 'x', date: new Date(), grade: grade(), mapDataUrl: null }))
    expect(withoutMap).not.toContain('data:image/png;base64')
  })
})

describe('reconPdfFilename', () => {
  it('slugifies the address and appends the ISO date', () => {
    expect(reconPdfFilename('123 Main St, Denver CO', new Date('2026-09-15T12:00:00Z')))
      .toBe('LandRecon-123-main-st-denver-co-2026-09-15.pdf')
  })

  it('falls back to "report" for an empty address', () => {
    expect(reconPdfFilename('', new Date('2026-09-15T12:00:00Z'))).toBe('LandRecon-report-2026-09-15.pdf')
  })
})
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `npx vitest run src/map/reconPdf.test.ts`
Expected: FAIL — `reconPdf.ts` does not exist.

- [ ] **Step 4: Implement `src/map/reconPdf.ts`**

```ts
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces'
import type { LocationGradeResult, LocationGradeBreakdownItem } from './analysisTypes'
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

function factorStatus(item: LocationGradeBreakdownItem): string {
  const ratio = item.max > 0 ? item.score / item.max : 0
  if (item.score === 0) return 'No concerns'
  return ratio >= 0.9 ? 'Notable concern' : 'Minor concern'
}

function factorBlocks(grade: LocationGradeResult): Content[] {
  return grade.breakdown.map((item) => {
    const evidence = grade.evidence[item.label]
    const lines: Content[] = [
      { text: `${item.label}`, style: 'factorLabel' },
      { text: `${factorStatus(item)} — ${item.detail}`, style: 'factorDetail' },
    ]
    if (evidence) {
      const parts = [
        `State: ${STATE_LABELS[evidence.state]}`,
        `Source: ${evidence.source}`,
        evidence.rule,
      ]
      if (evidence.freshness) parts.push(`Freshness: ${evidence.freshness}`)
      lines.push({ text: parts.join('\n'), style: 'evidence' })
      lines.push({ text: `Why it matters: ${evidence.whyItMatters}`, style: 'evidenceWhy' })
    }
    return { stack: lines, margin: [0, 0, 0, 10] } as Content
  })
}

function caveatsBlock(grade: LocationGradeResult): Content | null {
  const unavailable = Object.entries(grade.evidence)
    .filter(([, e]) => e.state === 'unavailable')
    .map(([label]) => label)
  if (unavailable.length === 0) return null
  return {
    table: {
      widths: ['*'],
      body: [[{
        stack: [
          { text: 'Incomplete data', style: 'caveatTitle' },
          { text: `These checks couldn't complete; the grade reflects only available data: ${unavailable.join(', ')}.`, style: 'caveatBody' },
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
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 2, lineColor: BRAND }], margin: [0, 6, 0, 12] },
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
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx vitest run src/map/reconPdf.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b --pretty false`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/map/reconPdf.ts src/map/reconPdf.test.ts package.json package-lock.json
git commit -m "feat: build recon report pdfmake document definition"
```

---

### Task 3: Lazy PDF export module

**Files:**
- Create: `src/map/pdfExport.ts`
- Test: `src/map/pdfExport.test.ts`

**Interfaces:**
- Consumes: `TDocumentDefinitions` (type only) from pdfmake.
- Produces: `downloadReconPdf(doc: TDocumentDefinitions, filename: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/map/pdfExport.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const download = vi.fn()
const createPdf = vi.fn(() => ({ download }))

vi.mock('pdfmake/build/pdfmake', () => ({
  default: { createPdf, vfs: {} },
}))
vi.mock('pdfmake/build/vfs_fonts', () => ({
  default: { vfs: { 'Roboto-Regular.ttf': 'AAAA' } },
}))

import { downloadReconPdf } from './pdfExport'

describe('downloadReconPdf', () => {
  beforeEach(() => {
    download.mockClear()
    createPdf.mockClear()
  })

  it('creates the pdf and triggers a download with the filename', async () => {
    await downloadReconPdf({ content: [] }, 'LandRecon-x-2026-09-15.pdf')
    expect(createPdf).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledWith('LandRecon-x-2026-09-15.pdf')
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/map/pdfExport.test.ts`
Expected: FAIL — `pdfExport.ts` does not exist.

- [ ] **Step 3: Implement `src/map/pdfExport.ts`**

The dynamic `import()` is what confines pdfmake to its own async chunk. The vfs
assignment is written defensively so it works across pdfmake's differing module
shapes.

```ts
import type { TDocumentDefinitions } from 'pdfmake/interfaces'

type PdfMakeLike = {
  vfs?: unknown
  createPdf: (doc: TDocumentDefinitions) => { download: (filename: string) => void }
}

export async function downloadReconPdf(doc: TDocumentDefinitions, filename: string): Promise<void> {
  const pdfMakeModule = await import('pdfmake/build/pdfmake')
  const pdfFontsModule = await import('pdfmake/build/vfs_fonts')
  const pdfMake = ((pdfMakeModule as { default?: PdfMakeLike }).default ?? pdfMakeModule) as PdfMakeLike
  const fonts = pdfFontsModule as { default?: { vfs?: unknown }; vfs?: unknown; pdfMake?: { vfs?: unknown } }
  const vfs = fonts.vfs ?? fonts.default?.vfs ?? fonts.pdfMake?.vfs
  if (vfs) pdfMake.vfs = vfs
  pdfMake.createPdf(doc).download(filename)
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run src/map/pdfExport.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b --pretty false`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/map/pdfExport.ts src/map/pdfExport.test.ts
git commit -m "feat: add lazy-loaded pdf export module"
```

---

### Task 4: Wire the Download button, budget bucket, and verify end to end

**Files:**
- Modify: `scripts/check-bundle-budget.mjs`
- Modify: `src/pages/MapPage.tsx` (imports; new state near `shareModalOpen` ~line 939; new `handleDownloadPdf` useCallback; new action button beside the Print button ~line 6860; error toast near the button)
- Modify: `src/pages/MapPage.css` (button spinner/error styles; ensure the new button hides in `@media print`)
- Modify: `README.md` (document the Download PDF behavior)

**Interfaces:**
- Consumes: `computeLocationGrade` (already imported in MapPage), `fetchStaticMapDataUrl` (Task 1), `buildReconPdfDocDefinition` + `reconPdfFilename` (Task 2), `downloadReconPdf` (Task 3), `GOOGLE_MAPS_KEY` (MapPage:230), `targetLocationRef` (MapPage:806), `address` (MapPage:717), `trackEvent` (MapPage:17).
- Produces: user-facing Download PDF action. No new exported API.

- [ ] **Step 1: Add the documented PDF-chunk budget bucket**

In `scripts/check-bundle-budget.mjs`, add a `pdfChunk` budget and classify the
pdfmake async chunk(s) into it instead of the generic 55 KiB cap.

Add to the `budgets` object:

```js
const budgets = {
  homeJs: 90 * 1024,
  mapJs: 110 * 1024,
  mapCss: 20 * 1024,
  analysisDetailJs: 15 * 1024,
  asyncJs: 55 * 1024,
  // On-demand, user-initiated PDF generator (pdfmake core + embedded font VFS).
  // Reached ONLY via dynamic import(), so it never affects initial or route
  // load. It is a heavyweight download the user explicitly triggers, so it gets
  // its own generous bucket rather than the strict 55 KiB per-async-chunk cap.
  pdfChunkJs: 1200 * 1024,
}
```

Then, in the async-chunk loop that pushes `Async chunk ${file}` checks, route
pdfmake/vfs chunks to the PDF bucket. Replace:

```js
for (const file of asyncFiles) {
  checks.push({
    label: `Async chunk ${file}`,
    actual: await transferBytes(new Set([file])),
    limit: budgets.asyncJs,
  })
}
```

with:

```js
const isPdfChunk = (file) => /pdfmake|vfs_fonts/i.test(file)
for (const file of asyncFiles) {
  checks.push({
    label: `Async chunk ${file}`,
    actual: await transferBytes(new Set([file])),
    limit: isPdfChunk(file) ? budgets.pdfChunkJs : budgets.asyncJs,
  })
}
```

- [ ] **Step 2: Add imports to `src/pages/MapPage.tsx`**

Near the other `../map/*` imports, add:

```tsx
import { fetchStaticMapDataUrl } from '../map/staticMap'
import { buildReconPdfDocDefinition, reconPdfFilename } from '../map/reconPdf'
import { downloadReconPdf } from '../map/pdfExport'
```

- [ ] **Step 3: Add state next to the share state (~line 939)**

After `const [shareModalOpen, setShareModalOpen] = useState(false)` add:

```tsx
const [generatingPdf, setGeneratingPdf] = useState(false)
const [pdfError, setPdfError] = useState<string | null>(null)
```

- [ ] **Step 4: Add the `handleDownloadPdf` handler**

Place it near `handleShare` (~line 1339):

```tsx
const handleDownloadPdf = useCallback(async () => {
  if (generatingPdf) return
  setGeneratingPdf(true)
  setPdfError(null)
  try {
    const grade = computeLocationGrade(analysisResults)
    const loc = targetLocationRef.current
    const mapDataUrl = loc
      ? await fetchStaticMapDataUrl({ lat: loc.lat, lng: loc.lng, key: GOOGLE_MAPS_KEY })
      : null
    const now = new Date()
    const doc = buildReconPdfDocDefinition({ address, date: now, grade, mapDataUrl })
    await downloadReconPdf(doc, reconPdfFilename(address, now))
    trackEvent('report_pdf_download', { grade: grade.letter })
  } catch (err) {
    dbg('analysis', `PDF export failed: ${String(err)}`)
    setPdfError('Couldn’t generate PDF — try again.')
  } finally {
    setGeneratingPdf(false)
  }
}, [generatingPdf, analysisResults, address])
```

(`computeLocationGrade`, `dbg`, and `trackEvent` are already imported/in scope in MapPage.)

- [ ] **Step 5: Add the Download PDF button beside the Print button (~line 6860)**

Immediately after the existing Print `<button>…</button>` block, add:

```tsx
<button
  className="analysis-action-btn"
  onClick={handleDownloadPdf}
  disabled={analysisResults.loading || generatingPdf}
  title="Download PDF report"
  aria-label="Download PDF report"
>
  {generatingPdf ? (
    <span className="analysis-action-spinner" aria-hidden="true" />
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )}
</button>
```

- [ ] **Step 6: Render the dismissible error near the action row**

Directly after the closing `</div>` of the action-button row that contains the
buttons, add (guarded so it only shows on failure):

```tsx
{pdfError && (
  <div className="analysis-pdf-error" role="alert">
    <span>{pdfError}</span>
    <button type="button" onClick={() => setPdfError(null)} aria-label="Dismiss">×</button>
  </div>
)}
```

- [ ] **Step 7: Add CSS in `src/pages/MapPage.css`**

Append:

```css
.analysis-action-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: analysis-action-spin 0.7s linear infinite;
}

@keyframes analysis-action-spin {
  to { transform: rotate(360deg); }
}

.analysis-pdf-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 8px 0 0;
  padding: 6px 10px;
  font-size: 0.8rem;
  color: #c62828;
  background: #fdecea;
  border: 1px solid #f5c6c2;
  border-radius: 4px;
}

.analysis-pdf-error button {
  border: none;
  background: none;
  color: inherit;
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
}
```

Then, in the existing `@media print` block, add `.analysis-pdf-error` to the
list of elements set to `display: none !important;` (alongside
`.analysis-header-actions`, `.analysis-close`, etc.) so it never prints.

- [ ] **Step 8: Run the full test suite, lint, and typecheck**

Run:

```bash
npx vitest run
npx tsc -b --pretty false
npm run lint
```

Expected: all tests pass, tsc exit 0, lint exit 0.

- [ ] **Step 9: Build and verify the bundle budget (including the new bucket)**

Run: `npm run build`
Expected: build succeeds; `bundle:check` prints a PASS line for the pdfmake
async chunk(s) against the new `pdfChunkJs` bucket, and every other entry/route/
async check still PASSES. Confirm the "Additional map-route JavaScript" line is
unchanged from before this feature (pdfmake must NOT appear in it).

- [ ] **Step 10: Document the behavior in `README.md`**

Under the "Recon Report Evidence" section, add a short paragraph:

```markdown
## Downloadable PDF Report

The Recon Report panel has a **Download PDF** action that generates a
self-contained PDF of the current address — the overall grade, the data-quality
summary, every factor with its evidence (source, rule, why-it-matters,
freshness), a prominent "Incomplete data" callout for any checks that couldn't
complete, and a static map snapshot of the location. The PDF library is
lazy-loaded on first use, so it never affects initial page load. If the map
snapshot can't be fetched the report still downloads without it; scores in the
PDF always match the on-screen report.
```

- [ ] **Step 11: Commit**

```bash
git add scripts/check-bundle-budget.mjs src/pages/MapPage.tsx src/pages/MapPage.css README.md
git commit -m "feat: add Download PDF action to the recon report"
```

---

## Self-Review Notes

- **Spec coverage:** staticMap.ts (Task 1), reconPdf.ts (Task 2), pdfExport.ts (Task 3), MapPage wiring + budget bucket + docs (Task 4) — every spec section maps to a task. Graceful degradation covered by staticMap returning null (Task 1/Task 4 handler) and the try/catch error toast (Task 4). Caveats, evidence, grade block, footer disclaimer all in Task 2. Filename in Task 2.
- **Type consistency:** `LocationGradeResult`, `LocationGradeBreakdownItem`, `FactorEvidence`, `qualitySummaryText`, `qualitySummaryTone` match their definitions in `analysisTypes.ts`/`evidence.ts`. `TDocumentDefinitions`/`Content` come from `pdfmake/interfaces`. `fetchStaticMapDataUrl`, `buildReconPdfDocDefinition`, `reconPdfFilename`, `downloadReconPdf` signatures are identical across producer and consumer tasks.
- **No placeholders:** every code step shows complete code and exact commands.
