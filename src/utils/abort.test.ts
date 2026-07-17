import { describe, expect, it } from 'vitest'
import { combineAbortSignals } from './abort'

describe('combineAbortSignals', () => {
  it('aborts when either source signal aborts', () => {
    const first = new AbortController()
    const second = new AbortController()
    const combined = combineAbortSignals([first.signal, second.signal])

    second.abort('superseded')

    expect(combined.aborted).toBe(true)
    expect(combined.reason).toBe('superseded')
  })

  it('is immediately aborted when a source is already aborted', () => {
    const first = new AbortController()
    first.abort('already done')

    const combined = combineAbortSignals([first.signal, new AbortController().signal])

    expect(combined.aborted).toBe(true)
    expect(combined.reason).toBe('already done')
  })

  it('returns a single source signal unchanged', () => {
    const controller = new AbortController()
    expect(combineAbortSignals([controller.signal])).toBe(controller.signal)
  })
})
