# Explainable Recon Report v1

## Goal

Make the existing Recon Report trustworthy as a decision aid by showing the
evidence and limitations behind each factor, without changing the current
location-grade math or adding a backend.

## Product behavior

The report keeps its current A-F grade, percentage, tier weights, thresholds,
and factor rules. It adds:

- A report-level data-quality summary.
- A factor-level evidence state: `Verified`, `Caution`, or `Unavailable`.
- A source/freshness label where the fetch or cache lifecycle provides a
  timestamp.
- The search radius or rule used by the factor.
- A short, plain-language explanation of why the factor matters.

Loading and API errors remain neutral in the score, as they are today, but are
visible in the report so a high grade cannot imply complete certainty.

The same evidence context appears in Compare. Re-analyzing a saved location
refreshes it; existing saved records continue to render with a graceful legacy
fallback.

## Architecture

Add a typed evidence/provenance model alongside `SavedFactor`. The scoring
boundary returns factor evidence and a report-quality aggregate in addition to
the existing grade and breakdown. Provider and rule metadata are centralized
as constants for the existing sources: EPA, FEMA, USFS, USGS, TomTom/Places,
Overpass, and broadband.

The existing `AnalysisDetailPanel` renders the detailed factor view, while
`CompareScorecard` renders the compact evidence state and persisted context.
Saved-analysis serialization gains optional, backward-compatible evidence
fields. No new service, dependency, or persistent backend is required.

## Data flow and degraded states

1. Existing analysis fetches resolve into the current `AnalysisResults`.
2. The scoring/presentation layer maps each factor to its score, rule,
   provider metadata, freshness, and evidence state.
3. The report derives an aggregate quality summary from those factor states.
4. Live report and saved-analysis views render the same typed presentation
   model.

`Verified` means the factor resolved with usable data. `Caution` means the
result is usable but has a documented limitation such as a moderate-risk
classification, stale cache, or reduced coverage. `Unavailable` means the
lookup failed, returned no usable data, or is still unresolved. Unavailable
data never receives a hidden negative penalty.

## Scope and non-goals

In scope:

- All existing Recon factors.
- The live Recon Report and Compare view.
- Explicit unavailable and last-refreshed wording.
- Backward-compatible localStorage serialization.
- Focused unit/component tests for aggregation and rendered states.

Out of scope:

- PDF or file export.
- User-configurable weights or thresholds.
- New data providers.
- A backend history or audit store.

## Acceptance criteria

- Every displayed factor has an understandable rule and source.
- Degraded data is visible and is never silently presented as verified.
- Existing grades and thresholds remain unchanged.
- Saved comparisons retain evidence context when available.
- Legacy saved records remain usable.
- Tests cover quality aggregation, loading/error neutrality, legacy records, and
  factor-state rendering.
