# Task 1 Report — Explainable Recon Report v1

## Summary
- Added `src/map/evidence.ts` with `EvidenceState`, `FactorEvidence`, `ReportQuality`, and `summarizeReportQuality()`.
- Extended `SavedFactor` and `SavedAnalysis` in `src/map/savedAnalyses.ts` with optional `evidence` and `quality`.
- Added focused tests for deterministic quality aggregation in `src/map/evidence.test.ts`.

## Verification
- `npx vitest run src/map/evidence.test.ts`
- `npx tsc -p tsconfig.app.json --noEmit`

## Concerns
- None.
