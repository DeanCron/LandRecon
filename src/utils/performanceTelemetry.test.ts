import { beforeEach, describe, expect, it, vi } from 'vitest'

const { trackEvent } = vi.hoisted(() => ({ trackEvent: vi.fn() }))
vi.mock('./analytics', () => ({ trackEvent }))

import { startPerformanceSpan, toTelemetryDuration } from './performanceTelemetry'

beforeEach(() => {
  trackEvent.mockReset()
})

describe('performance telemetry', () => {
  it('rounds and clamps durations', () => {
    expect(toTelemetryDuration(-1)).toBe(0)
    expect(toTelemetryDuration(14)).toBe(10)
    expect(toTelemetryDuration(16)).toBe(20)
    expect(toTelemetryDuration(999_999)).toBe(600_000)
  })

  it('emits each span only once', () => {
    const now = vi.spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(137)

    const finish = startPerformanceSpan('api_overpass', { operation: 'railroad' })
    finish('success', { attempts: 1 })
    finish('error', { attempts: 2 })

    expect(trackEvent).toHaveBeenCalledOnce()
    expect(trackEvent).toHaveBeenCalledWith('perf_timing', {
      metric: 'api_overpass',
      outcome: 'success',
      duration_ms: 40,
      operation: 'railroad',
      attempts: 1,
    })
    now.mockRestore()
  })
})
