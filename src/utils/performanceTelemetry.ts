import { trackEvent } from './analytics'

export type PerformanceOutcome = 'success' | 'partial' | 'error' | 'cancelled'

const MAX_DURATION_MS = 10 * 60 * 1000
const DURATION_BUCKET_MS = 10

export function toTelemetryDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0
  const clamped = Math.min(durationMs, MAX_DURATION_MS)
  return Math.round(clamped / DURATION_BUCKET_MS) * DURATION_BUCKET_MS
}

export function startPerformanceSpan(
  metric: string,
  dimensions: Record<string, string | number | boolean> = {},
): (
  outcome?: PerformanceOutcome,
  extra?: Record<string, string | number | boolean>,
) => void {
  const startedAt = performance.now()
  let finished = false

  return (outcome = 'success', extra = {}) => {
    if (finished) return
    finished = true
    trackEvent('perf_timing', {
      metric,
      outcome,
      duration_ms: toTelemetryDuration(performance.now() - startedAt),
      ...dimensions,
      ...extra,
    })
  }
}
