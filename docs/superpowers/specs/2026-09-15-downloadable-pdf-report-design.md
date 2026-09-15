# Downloadable PDF Recon Report — Design

Date: 2026-09-15
Status: Approved (brainstorming)
Builds on: 2026-09-02-explainable-recon-report-design.md (evidence model)

## Summary

Add a **Download PDF** action to the live Recon Report panel that generates a
real, client-side PDF of the current address's report. The PDF contains the
overall A–F grade, a data-quality summary, every factor with its score/detail
and explainability evidence (source, rule, why-it-matters, freshness), a
prominently rendered caveats callout for unavailable/failed checks, and a static
map snapshot of the location. The PDF library is lazy-loaded so the initial and
route bundles are unaffected. Every value in the PDF is read verbatim from the
existing `computeLocationGrade(...)` result — the PDF never recomputes scores.

## Goals

- One-click download of a self-contained, on-brand PDF of the current Recon
  Report, suitable for sharing with a partner, agent, or lender.
- Include the explainability evidence added in the prior feature.
- Call out incomplete/unavailable data prominently.
- Include a map snapshot of the address.
- No regression to bundle budgets; no change to grade math.

## Non-Goals

- PDF export for saved analyses or the Compare view (live report only for now).
- Capturing the exact on-screen live Leaflet map (we use Google Static Maps).
- Server-side rendering of the PDF (fully client-side).
- Any change to scoring, tier weights, thresholds, or the on-screen report.

## Global Constraints

- **Grade math is frozen.** The PDF consumes `computeLocationGrade` output only.
- **Lazy-load the PDF library.** `pdfmake` must land in its own async chunk,
  reached only via dynamic `import()` when the user clicks Download. The Home
  entry, map-route, and analysis-detail bundle budgets must remain green.
- **Graceful degradation.** A missing map, a failed map fetch, or a failed
  library load must never crash the app or block the rest of the report.

## Approach

- **PDF library:** `pdfmake` — declarative document definition producing vector,
  selectable text and native tables/blocks. Lazy-loaded.
- **Map snapshot:** Google Static Maps API, using the existing
  `VITE_GOOGLE_MAPS_KEY`. One PNG request centered on the address with a marker;
  no canvas capture, no CORS handling. Degrades to no-map on any failure.

## Architecture & Module Boundaries

Three new, independently testable modules plus thin wiring in `MapPage.tsx`.

### `src/map/staticMap.ts` (pure URL + fetch helper)
- `buildStaticMapUrl(opts: { lat; lng; zoom?; width?; height?; scale?; key })`
  returns a Google Static Maps URL with `center`, `zoom`, `size`, `scale`,
  `markers`, and `key`.
- `fetchStaticMapDataUrl(opts, { fetchImpl?, timeoutMs? })` fetches the PNG and
  resolves to a base64 `data:` URL (pdfmake requires embedded base64), or
  `null` on missing key, non-200, network error, or timeout.
- No React, no pdfmake. Unit-testable with a mocked `fetch`.

### `src/map/reconPdf.ts` (pure data → pdfmake doc definition)
- `buildReconPdfDocDefinition(input: { address; date; grade; mapDataUrl? })`
  returns a pdfmake `TDocumentDefinitions`.
- `grade` is the `computeLocationGrade(...)` result (letter, color, pct,
  breakdown, evidence, quality).
- No I/O, no library load. Fully unit-testable against the returned object.

### `src/map/pdfExport.ts` (only module that touches pdfmake)
- `downloadReconPdf(docDefinition, filename)` dynamically imports pdfmake
  (`await import(...)`), creates the PDF, and triggers the browser download.
- Isolates the heavy dependency into its own lazy async chunk.

### Wiring in `src/pages/MapPage.tsx`
- New `analysis-action-btn` "Download PDF" beside Print/Share.
- Handler orchestrates: best-effort `fetchStaticMapDataUrl` → build doc
  definition → `downloadReconPdf`. Transient `generatingPdf` state disables the
  button and shows a spinner; on library failure show a small dismissible error.
- `trackEvent('report_pdf_download', { grade })` mirrors existing analytics.

## PDF Content & Layout

Single-column, print-friendly (A4/Letter, ~40pt margins):

1. **Header** — "LandRecon — Recon Report", the address, the generated date, and
   a brand-color accent.
2. **Map snapshot** — the Static Maps PNG, full content width (~200pt tall).
   Omitted entirely (no empty box, no error text) when the fetch failed.
3. **Overall grade block** — large grade letter in its color, percentage +
   label ("Excellent"/"Good"/"Fair"/"Poor"/"Critical"), and the Data quality
   line using the shared `qualitySummaryText`/`qualitySummaryTone` logic.
4. **Caveats callout (prominent)** — rendered only when
   `quality.unavailableCount > 0`: a bordered, tinted box titled
   "Incomplete data" that lists each unavailable factor by name plus the line
   "These checks couldn't complete; the grade reflects only available data."
5. **Factor breakdown** — factors in the report's canonical order. Each block:
   label (+icon glyph), status (No concerns / Minor concern / Notable concern),
   the detail string, and an indented evidence sub-block: State, Source, Rule,
   Freshness (if present), and "Why it matters". Sarcastic Costco copy flows
   through unchanged from the evidence data.
6. **Footer** — the existing informational disclaimer and a page number.

## Failure Handling

- Map: no key / non-200 / network / timeout → `null` → PDF generates without a
  map section.
- Library: dynamic import or generation throws → caught; show a small inline,
  dismissible error near the button ("Couldn't generate PDF — try again"); app
  never crashes.
- Button disabled while `analysisResults.loading` and while a generation is in
  flight (prevents double-clicks); re-enabled afterward.

## Filename

`LandRecon-<slugified-address>-<YYYY-MM-DD>.pdf`

## Testing

- `src/map/staticMap.test.ts` — URL params correct; mocked `fetch` success
  yields a data URL; failure/timeout yields `null`.
- `src/map/reconPdf.test.ts` — doc definition includes address, date, and grade
  letter; every breakdown factor appears with its evidence source and
  why-it-matters; the caveats block appears only when unavailable checks exist
  and is absent when all verified; the map image node is present/absent based on
  the passed `mapDataUrl`.
- `src/map/pdfExport.test.ts` — pdfmake mocked; asserts the dynamic import is
  used and the download is triggered with the expected filename.
- No new MapPage render tests (wiring is thin).

## Dependencies

- Add `pdfmake` (runtime) and `@types/pdfmake` (dev).
- The bundle-budget check must still pass: pdfmake must appear only in its own
  async chunk, never in the Home entry, map-route, or analysis-detail budgets.

## Acceptance Criteria

1. Clicking Download PDF on a completed report downloads a valid PDF containing
   the grade, all factors with evidence, a prominent caveats section (when
   applicable), and a map snapshot (when available).
2. Grade and per-factor scores in the PDF match the on-screen report exactly.
3. A map failure still downloads the report (without a map); a library failure
   shows a dismissible error and never crashes the app.
4. The bundle-budget check passes and initial/route bundle sizes are unchanged
   (pdfmake is confined to a lazy async chunk).
5. `npm test`, `npm run lint`, and `npm run build` all pass.
