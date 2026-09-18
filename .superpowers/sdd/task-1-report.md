# Task 1 Report: Static map snapshot helper

## Scope
- Added `src/map/staticMap.ts`
- Added `src/map/staticMap.test.ts`

## Implementation
- `buildStaticMapUrl(opts)` builds a Google Static Maps URL with:
  - default `zoom=15`
  - default `size=640x320`
  - default `scale=2`
  - `center` and `markers` at the requested lat/lng
  - API key included in the query string
- `fetchStaticMapDataUrl(opts, deps?)`:
  - returns `null` immediately when `key` is empty
  - fetches the static map URL with an optional timeout
  - converts the response bytes to a base64 PNG data URL on success
  - returns `null` for non-OK responses, thrown errors, or aborts

## TDD evidence

### RED
- Ran: `npx vitest run src/map/staticMap.test.ts`
- Result: failed before implementation because `src/map/staticMap.ts` did not exist
- Vitest output:
  - `Unhandled Errors`
  - `Failed to start forks worker for test files ... staticMap.test.ts`

### GREEN
- Ran: `npx vitest run src/map/staticMap.test.ts`
- Result: `1 passed`, `6 passed`

### Typecheck
- Ran: `npx tsc -b --pretty false`
- Result: exit code `0`

## Commit
- Pending commit: `feat: add Google Static Maps snapshot helper`

## Notes
- No concerns.
