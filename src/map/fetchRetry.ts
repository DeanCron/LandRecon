// Shared fetch helper for the flaky government GIS endpoints (FEMA NFHL,
// USFS WHP) behind the Recon Report point lookups. fetch() does not reject on
// HTTP 500, so we treat any non-ok response as a transient failure and retry
// with a short linear backoff (and a per-attempt timeout) before giving up.
// The flood *overlay* fetch has its own inline retry tuned for large payloads;
// this is the lightweight version for the single-point report queries.
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
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as T
    } catch (err) {
      lastErr = err
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)))
      }
    }
  }
  throw lastErr
}
