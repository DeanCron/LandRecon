// AbortSignal.any() is not available across the full browser baseline emitted
// by Vite (notably older Safari/iOS 16 and Firefox 114). Compose signals with
// an AbortController instead so caller cancellation and per-request timeouts
// work without relying on that newer native API.
export function combineAbortSignals(
  signals: Array<AbortSignal | null | undefined>,
): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  if (active.length === 1) return active[0]

  const controller = new AbortController()
  const listeners = new Map<AbortSignal, () => void>()
  const cleanup = () => {
    for (const [signal, listener] of listeners) {
      signal.removeEventListener('abort', listener)
    }
    listeners.clear()
  }
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      cleanup()
      return controller.signal
    }
    const listener = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason)
      cleanup()
    }
    listeners.set(signal, listener)
    signal.addEventListener('abort', listener, { once: true })
  }
  return controller.signal
}
