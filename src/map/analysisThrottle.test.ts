import { beforeEach, describe, expect, it } from 'vitest'
import {
  ANALYSIS_THROTTLE_MAX,
  ANALYSIS_THROTTLE_WINDOW_MS,
  consumeAnalysisSlot,
} from './analysisThrottle'

describe('consumeAnalysisSlot', () => {
  beforeEach(() => sessionStorage.clear())

  it('allows up to the max then blocks', () => {
    for (let i = 0; i < ANALYSIS_THROTTLE_MAX; i++) {
      expect(consumeAnalysisSlot(1000 + i).allowed).toBe(true)
    }
    const d = consumeAnalysisSlot(2000)
    expect(d.allowed).toBe(false)
    expect(d.retryAfterMs).toBe(1000 + ANALYSIS_THROTTLE_WINDOW_MS - 2000)
  })

  it('frees slots after the window elapses', () => {
    for (let i = 0; i < ANALYSIS_THROTTLE_MAX; i++) consumeAnalysisSlot(1000)
    expect(consumeAnalysisSlot(1000 + ANALYSIS_THROTTLE_WINDOW_MS).allowed).toBe(true)
  })

  it('recovers from corrupt storage', () => {
    sessionStorage.setItem('lr_analysis_throttle_v1', '{bad')
    expect(consumeAnalysisSlot(5).allowed).toBe(true)
  })
})
