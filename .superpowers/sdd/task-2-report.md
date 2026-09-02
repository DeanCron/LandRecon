# Task 2 Report — Explainable Recon Report v1

## Summary
- Added typed scoring output models in `src/map/analysisTypes.ts` for the location-grade input, breakdown rows, evidence record, and report quality.
- Extended `computeLocationGrade()` in `src/map/scoring.ts` to return per-factor evidence plus aggregate quality without changing any existing score, max, tier, weight, threshold, letter, color, severity, pct, or breakdown calculations.
- Kept breakdown behavior intact while marking unresolved/loading/error-backed evidence as unavailable and resolved evidence as verified.

## TDD
- Added regression tests in `src/map/scoring.test.ts` for resolved evidence preservation and unavailable evidence on loading/error states.
- Verified RED first with `npx vitest run src/map/scoring.test.ts`, which failed because `computeLocationGrade()` did not yet expose `evidence` or `quality`.
- Implemented the minimal scoring changes, then re-ran the focused scoring tests to reach GREEN.

## Verification
- `npx vitest run src/map/scoring.test.ts`
- `npx vitest run src/map/scoring.test.ts src/map/evidence.test.ts`
- `npx tsc -p tsconfig.app.json --noEmit`

## Self-review
- Reviewed the task diff for `src/map/scoring.ts`, `src/map/analysisTypes.ts`, and `src/map/scoring.test.ts` to confirm scoring math stayed unchanged and evidence additions remained additive.
- Confirmed the new type surface compiles cleanly across existing consumers.

## Concerns
- None.

## Task 2 review follow-up — caution evidence mapping
- Root cause: `computeLocationGrade()` treated any resolved provider payload as `verified`, even when the existing scoring logic already classified the result as a moderate/warning condition. That left usable-but-limited evidence indistinguishable from clean results.
- Fix: added a shared `evidenceState()` helper in `src/map/scoring.ts` and mapped existing moderate/warning classifications to `caution` without changing any score, max, tier, weight, threshold, letter, color, severity, pct, or breakdown math.
- Concrete caution cases now include moderate hazard bands (for example wildfire value `3`) and limited broadband (`speedTier: 'served'`), while loading/error/no-usable-data behavior remains `unavailable`.

### Review-follow-up TDD
- Added regression tests in `src/map/scoring.test.ts` for:
  - moderate wildfire hazard => `evidence['Wildfire Hazard'].state === 'caution'` with the existing score unchanged at `2`
  - limited broadband => `evidence.Broadband.state === 'caution'` with the existing score unchanged at `1`
- Verified RED first:

```text
FAIL  src/map/scoring.test.ts > computeLocationGrade (tier-normalized) > marks moderate hazards as caution without changing their score math
AssertionError: expected 'verified' to be 'caution'

FAIL  src/map/scoring.test.ts > computeLocationGrade (tier-normalized) > marks limited broadband results as caution without changing their score math
AssertionError: expected 'verified' to be 'caution'
```

### Review-follow-up verification output
```text
$ npx vitest run src/map/scoring.test.ts src/map/evidence.test.ts
RUN  v4.1.8 C:/Users/deancron/copilot-worktrees/LandRecon/deancron-cuddly-happiness

Test Files  2 passed (2)
     Tests  22 passed (22)
  Start at  15:29:10
  Duration  5.90s (transform 1.15s, setup 0ms, import 1.57s, tests 54ms, environment 8.37s)
```

```text
$ npx tsc -p tsconfig.app.json --noEmit
[no output; exit code 0]
```

### Review-follow-up self-review
- Checked the focused diff for `src/map/scoring.ts` and `src/map/scoring.test.ts`.
- Confirmed the caution mapping only re-labels evidence states and reuses existing scoring inputs; no weight, threshold, or grade math changed.
