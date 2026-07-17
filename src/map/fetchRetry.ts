import { combineAbortSignals } from '../utils/abort'

// Shared fetch helper for the flaky government GIS endpoints (FEMA NFHL,
// USFS WHP) behind the Recon Report point lookups. fetch() does not reject on
// HTTP 500, so we treat any non-ok response as a transient failure and retry
// with a short linear backoff (and a per-attempt timeout) before giving up.
// The flood *overlay* fetch has its own inline retry tuned for large payloads;
// this is the lightweight version for the single-point report queries.
function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function fetchJsonWithRetry<T = unknown>(
  url: string,
  opts: {
    init?: RequestInit
    retries?: number // extra attempts after the first
    timeoutMs?: number
    backoffMs?: number // base delay; multiplied by (attempt + 1)
  } = {},
): Promise<T> {
  const { init, retries = 2, timeoutMs = 10000, backoffMs = 400 } = opts
  let lastErr: unknown = new Error('fetch failed')
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs)
      const signal = init?.signal
        ? combineAbortSignals([init.signal, timeoutSignal])
        : timeoutSignal
      const res = await fetch(url, { ...init, signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as T
    } catch (err) {
      lastErr = err
      if (init?.signal?.aborted) throw err
      if (attempt < retries) {
        await waitForRetry(backoffMs * (attempt + 1), init?.signal ?? undefined)
      }
    }
  }
  throw lastErr
}
