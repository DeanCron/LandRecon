import { dbg } from '../utils/debug'

// Overpass requests are routed through a same-origin nginx proxy (see
// nginx.conf and vite.config.ts) that injects a non-Mozilla User-Agent.
// overpass-api.de returns 406 to generic browser UAs, and the browser's
// CORS preflight UA cannot be overridden from JavaScript, so the proxy
// is required.
const OVERPASS_ENDPOINTS = ['/overpass', '/overpass2']

export interface OverpassElement {
  type?: string
  id?: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
  geometry?: { lat: number; lon: number }[]
  members?: { type: string; ref: number }[]
}

export interface OverpassResponse {
  elements?: OverpassElement[]
  [key: string]: unknown
}

export async function fetchOverpass<T = OverpassResponse>(
  query: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; label?: string } = {},
): Promise<T | null> {
  const { timeoutMs = 20000, signal: externalSignal, label } = opts
  const tag = label ? `overpass:${label}` : 'overpass'
  const body = `data=${encodeURIComponent(query)}`
  let lastErr: unknown = null
  for (const url of OVERPASS_ENDPOINTS) {
    if (externalSignal?.aborted) break
    for (let attempt = 0; attempt < 2; attempt++) {
      if (externalSignal?.aborted) break
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt))
      dbg(tag, `${url} attempt ${attempt + 1}`)
      const ctrl = new AbortController()
      const onExternalAbort = () => ctrl.abort()
      externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
          body,
          signal: ctrl.signal,
        })
        if (res.status === 504 || res.status === 429) {
          lastErr = new Error(`Overpass HTTP ${res.status} at ${url}`)
          continue
        }
        if (!res.ok) {
          lastErr = new Error(`Overpass HTTP ${res.status} at ${url}`)
          break // non-retryable error, try next endpoint
        }
        return (await res.json()) as T
      } catch (err) {
        lastErr = err
        break // network error, try next endpoint
      } finally {
        clearTimeout(timer)
        externalSignal?.removeEventListener('abort', onExternalAbort)
      }
    }
  }
  console.warn('Overpass: all endpoints failed', lastErr)
  return null
}
