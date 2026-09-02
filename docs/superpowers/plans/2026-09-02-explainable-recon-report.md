# Explainable Recon Report v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add transparent evidence, freshness, and degraded-data context to the existing Recon Report and Compare views without changing grade calculations.

**Architecture:** Keep scoring in `src/map/scoring.ts`, introduce the typed factor evidence model and provider metadata in `src/map/evidence.ts`, and have the scoring boundary return both the existing breakdown and explainability data. Render a shared presentational evidence component from the existing report/detail and comparison components, persisting optional fields so older localStorage records remain valid.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, existing localStorage persistence, existing provider fetch/cache state.

## Global Constraints

- Preserve the existing A-F grade, percentage, tier weights, thresholds, and factor rules exactly.
- Loading and API errors remain neutral in scoring but must be visible as evidence limitations.
- Do not add a backend, dependency, new provider, export format, configurable weights, or history store.
- Use ASCII by default and follow existing React/TypeScript/CSS conventions.
- Keep saved-analysis fields optional and safely render legacy records.
- Run focused Vitest tests after each implementation task and the full existing test suite before completion.

---

### Task 1: Define the explainability data model and provider metadata

**Files:**
- Create: `src/map/evidence.ts`
- Modify: `src/map/savedAnalyses.ts:10-37`
- Test: `src/map/evidence.test.ts`

**Interfaces:**
- Produces `EvidenceState = 'verified' | 'caution' | 'unavailable'`.
- Produces `FactorEvidence` with `state`, `source`, `rule`, `whyItMatters`, and optional `freshness`.
- Produces `ReportQuality` with `verifiedCount`, `cautionCount`, `unavailableCount`, and `state`.
- Produ optional `SavedFactor.evidence` and `SavedAnalysis.quality`.

- [ ] **Step 1: Write failing model tests**

Add tests for deterministic quality aggregation:

```ts
import { describe, expect, it } from 'vitest'
import { summarizeReportQuality, type FactorEvidence } from './evidence'

const evidence = (state: FactorEvidence['state']): FactorEvidence => ({
  state,
  source: 'Test source',
  rule: 'Test rule',
  whyItMatters: 'Test explanation',
})

describe('summarizeReportQuality', () => {
  it('counts states and marks mixed evidence as caution', () => {
    expect(summarizeReportQuality([evidence('verified'), evidence('caution'), evidence('unavailable')]))
      .toEqual({ state: 'caution', verifiedCount: 1, cautionCount: 1, unavailableCount: 1 })
  })

  it('marks an all-verified report verified', () => {
    expect(summarizeReportQuality([evidence('verified'), evidence('verified')]).state).toBe('verified')
  })

  it('marks an empty report unavailable', () => {
    expect(summarizeReportQuality([]).state).toBe('unavailable')
  })
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npx vitest run src/map/evidence.test.ts`

Expected: FAIL because `src/map/evidence.ts` does not yet exist.

- [ ] **Step 3: Implement the typed evidence model**

Create `src/map/evidence.ts` with:

```ts
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
  const state: EvidenceState = unavailableCount > 0 || cautionCount > 0
    ? 'caution'
    : verifiedCount > 0
      ? 'verified'
      : 'unavailable'
  return { state, verifiedCount, cautionCount, unavailableCount }
}
```

Add `evidence?: FactorEvidence` to `SavedFactor` and `quality?: ReportQuality` to `SavedAnalysis`.

- [ ] **Step 4: Run the focused tests**

Run: `npx vitest run src/map/evidence.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the model**

```bash
git add src/map/evidence.ts src/map/evidence.test.ts src/map/savedAnalyses.ts
git commit -m "feat: add recon evidence model"
```

### Task 2: Attach evidence to scoring without changing scores

**Files:**
- Modify: `src/map/scoring.ts:72-291`
- Modify: `src/map/analysisTypes.ts:26-118`
- Test: `src/map/scoring.test.ts`

**Interfaces:**
- Consumes existing `AnalysisResults` loading/error fields and factor values.
- Produces `computeLocationGrade(...).evidence: Record<string, FactorEvidence>` and `.quality: ReportQuality`.
- Existing `letter`, `color`, `severity`, `pct`, and `breakdown` outputs remain unchanged.

- [ ] **Step 1: Add regression tests for unchanged grade and evidence states**

Extend `src/map/scoring.test.ts` with tests that a fully resolved result keeps
its prior percentage and produces verified evidence, while a provider error
produces unavailable evidence without lowering the score beyond the existing
neutral behavior:

```ts
it('adds evidence while preserving the resolved grade', () => {
  const result = computeLocationGrade(allClearResults())
  expect(result.letter).toBe('A')
  expect(result.pct).toBe(1)
  expect(result.evidence['Flood Zone'].state).toBe('verified')
  expect(result.quality.unavailableCount).toBe(0)
})

it('marks loading and failed lookups unavailable without inventing a penalty', () => {
  const result = computeLocationGrade({ ...allClearResults(), floodLoading: true, wildfireError: true })
  expect(result.evidence['Flood Zone'].state).toBe('unavailable')
  expect(result.evidence['Wildfire Hazard'].state).toBe('unavailable')
  expect(result.breakdown.some((factor) => factor.label === 'Flood Zone')).toBe(false)
  expect(result.breakdown.find((factor) => factor.label === 'Wildfire Hazard')?.score).toBe(0)
})
```

- [ ] **Step 2: Run the scoring tests and verify the new assertions fail**

Run: `npx vitest run src/map/scoring.test.ts`

Expected: FAIL because the grade result has no evidence or quality fields.

- [ ] **Step 3: Add factor evidence alongside each existing scoring branch**

Import `FactorEvidence` and `summarizeReportQuality`. Build an evidence record
using stable factor labels. For every factor, set:

- `source` to the provider/dataset name.
- `rule` to the existing radius, threshold, or classification rule.
- `whyItMatters` to a short user-facing explanation.
- `state` to `verified` for usable resolved data, `caution` for usable but
  limited coverage/stale results, and `unavailable` for loading/error/no usable
  lookup.

Do not alter any existing score, max, tier, or weight expression. Return:

```ts
return {
  letter,
  color,
  severity,
  pct,
  breakdown,
  evidence,
  quality: summarizeReportQuality(Object.values(evidence)),
}
```

Update the function return type explicitly so TypeScript checks all consumers.

- [ ] **Step 4: Run scoring and related map tests**

Run: `npx vitest run src/map/scoring.test.ts src/map/evidence.test.ts`

Expected: PASS, including all pre-existing scoring assertions.

- [ ] **Step 5: Commit scoring evidence**

```bash
git add src/map/scoring.ts src/map/analysisTypes.ts src/map/scoring.test.ts
git commit -m "feat: attach evidence to recon scoring"
```

### Task 3: Persist evidence and quality in saved analyses

**Files:**
- Modify: `src/pages/MapPage.tsx:960-995, 6890-7040`
- Modify: `src/map/savedAnalyses.ts:39-50`
- Test: `src/map/savedAnalyses.test.ts`

**Interfaces:**
- Consumes `computeLocationGrade(...).evidence` and `.quality`.
- Produces saved entries whose `breakdown` factors include optional evidence
  and whose `quality` is optional.
- Legacy records without those fields continue to load and render.

- [ ] **Step 1: Write failing persistence compatibility tests**

Add tests for loading a legacy saved entry and a current entry:

```ts
it('loads legacy records without evidence fields', () => {
  localStorage.setItem(SAVED_ANALYSES_KEY, JSON.stringify([{ address: '1 Main St' }]))
  expect(loadSavedAnalyses()[0].address).toBe('1 Main St')
  expect(loadSavedAnalyses()[0].quality).toBeUndefined()
})

it('round-trips quality and factor evidence', () => {
  const entry = { address: '1 Main St', quality: { state: 'verified', verifiedCount: 1, cautionCount: 0, unavailableCount: 0 } }
  writeSavedAnalyses([entry as SavedAnalysis])
  expect(loadSavedAnalyses()[0].quality?.state).toBe('verified')
})
```

- [ ] **Step 2: Run the persistence test and verify the new compatibility assertions fail**

Run: `npx vitest run src/map/savedAnalyses.test.ts`

Expected: FAIL because the new test assertions are not yet present in the implementation.

- [ ] **Step 3: Add a focused saved-analysis test file and preserve compatibility**

Use the existing Vitest localStorage setup pattern. Keep `loadSavedAnalyses`
and `writeSavedAnalyses` behavior unchanged except for typed optional fields;
do not reject partial legacy objects or silently synthesize verified evidence.

- [ ] **Step 4: Persist current evidence from MapPage**

When constructing the `SavedAnalysis` object near the existing save handler,
copy `grade.evidence` into each matching breakdown factor and copy
`grade.quality` to the saved entry. Keep the existing address/date/score fields
unchanged.

- [ ] **Step 5: Run persistence and scoring tests**

Run: `npx vitest run src/map/savedAnalyses.test.ts src/map/scoring.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit persistence**

```bash
git add src/map/savedAnalyses.ts src/map/savedAnalyses.test.ts src/pages/MapPage.tsx
git commit -m "feat: preserve recon evidence in saved analyses"
```

### Task 4: Render evidence in the Recon Report and Compare views

**Files:**
- Create: `src/components/FactorEvidence.tsx`
- Modify: `src/components/AnalysisDetailPanel.tsx`
- Modify: `src/map/CompareScorecard.tsx`
- Modify: `src/pages/MapPage.tsx:6797-7040`
- Modify: `src/pages/MapPage.css`
- Modify: `src/map/CompareScorecard.css`
- Test: `src/components/FactorEvidence.test.tsx`

**Interfaces:**
- Consumes live `grade.evidence`/`grade.quality` and optional saved evidence.
- Renders report quality, state labels, source/rule, freshness where present, and
  why-it-matters text.
- Does not own fetch state, scoring, localStorage, or grade calculation.
- Produces `FactorEvidence` props that can be reused by both report and compare
  surfaces.

- [ ] **Step 1: Write focused rendering tests**

Create a small presentational test around a concrete component contract:

```tsx
const verified: FactorEvidence = {
  state: 'verified',
  source: 'FEMA National Flood Hazard Layer',
  rule: 'Point lookup at the searched address',
  whyItMatters: 'Flood exposure can affect insurance, access, and property risk.',
}

it('shows source and explanation for a verified factor', () => {
  render(<FactorEvidence label="Flood Zone" evidence={verified} />)
  expect(screen.getByText(/Source:/i)).toBeInTheDocument()
  expect(screen.getByText(/Why it matters/i)).toBeInTheDocument()
})

it('labels unavailable evidence explicitly', () => {
  render(<FactorEvidence label="Flood Zone" evidence={{
    ...verified,
    state: 'unavailable',
    rule: 'Point lookup did not resolve',
  }} />)
  expect(screen.getByText(/Data unavailable/i)).toBeInTheDocument()
})
```

Add a third assertion that omits `evidence` from a saved factor and renders the
literal legacy message:
`Evidence details unavailable for this saved analysis. Re-analyze to refresh.`

- [ ] **Step 2: Run the component test and verify the new assertions fail**

Run: `npx vitest run src/components/FactorEvidence.test.tsx`

Expected: FAIL because `FactorEvidence` does not yet exist.

- [ ] **Step 3: Add shared state-label presentation**

Create `src/components/FactorEvidence.tsx` with this typed contract:

```tsx
type Props = {
  label: string
  evidence?: FactorEvidence
}
```

Render the state, source, rule, optional freshness, and why-it-matters copy.
Use text and `aria-label` values rather than color alone. When `evidence` is
missing, render:
`Evidence details unavailable for this saved analysis. Re-analyze to refresh.`

Render a compact quality summary near the report grade:

```tsx
<div className={`report-quality report-quality-${quality.state}`}>
  Data quality: {quality.unavailableCount > 0 ? 'Some data unavailable' :
    quality.cautionCount > 0 ? 'Review cautions' : 'All checks verified'}
</div>
```

- [ ] **Step 4: Add Compare evidence indicators**

Extend each `CompareScorecard` factor row with the evidence state and show the
saved quality summary at card level when available. Keep the existing rank,
grade, tier bars, remove, expand, and re-analyze controls unchanged.

- [ ] **Step 5: Add CSS for accessible evidence states**

Add neutral, caution, and unavailable styles using existing CSS variables or
colors. Ensure the state text remains readable without color, wraps on narrow
cards, and does not change the existing score bar semantics.

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run src/components/FactorEvidence.test.tsx src/map/scoring.test.ts src/map/savedAnalyses.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the UI**

```bash
git add src/components/AnalysisDetailPanel.tsx src/map/CompareScorecard.tsx src/pages/MapPage.tsx src/pages/MapPage.css src/map/CompareScorecard.css src/components/AnalysisDetailPanel.test.tsx
git commit -m "feat: surface recon evidence in report views"
```

### Task 5: Verify complete behavior and update user documentation

**Files:**
- Modify: `README.md` (Recon Report feature/debugging description)
- Modify: `DEPLOY.md` only if operational configuration changes are required

- [ ] **Step 1: Document the evidence behavior**

Add a concise README note that the Recon Report preserves its grade while
showing provider/rule evidence, freshness where available, and explicit
unavailable states; mention that re-analysis refreshes saved evidence.

- [ ] **Step 2: Run the complete existing validation**

Run:

```bash
npm test
npm run lint
npm run build
```

Expected: all existing tests pass, ESLint exits successfully, and the Vite
build plus bundle budget check succeeds.

- [ ] **Step 3: Review the final diff against the spec**

Confirm that every factor has source/rule/explanation metadata, degraded data
is visible, grades are unchanged, saved legacy records work, and no backend or
new dependency was added.

- [ ] **Step 4: Commit documentation and verification-ready changes**

```bash
git add README.md DEPLOY.md
git commit -m "docs: describe recon report evidence"
```
