// Per-session throttle for uncached (paid-API) analyses. Cache hits are free
// and never counted. State lives in sessionStorage so it spans in-page
// navigation but resets with the tab; it is a courtesy brake against runaway
// loops and casual scraping, not a security boundary (provider quotas and
// nginx limits are the real backstop).
const KEY = 'lr_analysis_throttle_v1'
export const ANALYSIS_THROTTLE_MAX = 12
export const ANALYSIS_THROTTLE_WINDOW_MS = 10 * 60 * 1000

function load(now: number): number[] {
  try {
    const raw = sessionStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (t): t is number => typeof t === 'number' && now - t < ANALYSIS_THROTTLE_WINDOW_MS && t <= now,
    )
  } catch {
    return []
  }
}

export interface ThrottleDecision {
  allowed: boolean
  retryAfterMs: number
}

// Records one analysis if under the limit; otherwise reports how long until a
// slot frees up. Storage failures fail open so the app still works.
export function consumeAnalysisSlot(now: number = Date.now()): ThrottleDecision {
  const recent = load(now)
  if (recent.length >= ANALYSIS_THROTTLE_MAX) {
    return { allowed: false, retryAfterMs: Math.max(0, recent[0] + ANALYSIS_THROTTLE_WINDOW_MS - now) }
  }
  recent.push(now)
  try {
    sessionStorage.setItem(KEY, JSON.stringify(recent))
  } catch {
    // ignore
  }
  return { allowed: true, retryAfterMs: 0 }
}
