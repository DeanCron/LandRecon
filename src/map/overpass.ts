import { dbg } from '../utils/debug'
import { startPerformanceSpan, toTelemetryDuration } from '../utils/performanceTelemetry'

// Overpass requests are routed through a same-origin nginx proxy (see
// nginx.conf and vite.config.ts) that injects a non-Mozilla User-Agent.
// overpass-api.de returns 406 to generic browser UAs, and the browser's
// CORS preflight UA cannot be overridden from JavaScript, so the proxy
// is required.
const OVERPASS_ENDPOINTS = ['/overpass', '/overpass2']

// Public Overpass instances rate-limit by the number of *concurrent* requests
// from one client (overpass-api.de typically allows ~2 slots). The Recon Report
// fires several Overpass queries at once (airports, crowd magnets, railroad),
// and three-at-once reliably trips a 429 ("Too Many Requests") on one of them —
// most often the last one queued, which then shows a false "nothing found". We
// cap concurrency at 2 so we stay within the slot budget without serialising so
// hard that one slow query blocks the rest (head-of-line blocking). Crucially,
// each request's timeout is started *after* it acquires a slot (see
// fetchOverpass), not when it was enqueued, so waiting never eats its budget.
const OVERPASS_MAX_CONCURRENCY = 2
let overpassActive = 0
const overpassWaiters: Array<() => void> = []
function acquireOverpassSlot(signal?: AbortSignal): Promise<(() => void) | null> {
  return new Promise((resolve) => {
    let queued = false
    const onAbort = () => {
      if (!queued) return
      const index = overpassWaiters.indexOf(grant)
      if (index >= 0) overpassWaiters.splice(index, 1)
      queued = false
      resolve(null)
    }
    const grant = () => {
      queued = false
      signal?.removeEventListener('abort', onAbort)
      overpassActive++
      let released = false
      resolve(() => {
        if (released) return
        released = true
        overpassActive--
        const next = overpassWaiters.shift()
        if (next) next()
      })
    }
    if (signal?.aborted) {
      resolve(null)
    } else if (overpassActive < OVERPASS_MAX_CONCURRENCY) {
      grant()
    } else {
      queued = true
      signal?.addEventListener('abort', onAbort, { once: true })
      overpassWaiters.push(grant)
    }
  })
}

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
  remark?: string
  [key: string]: unknown
}

export async function fetchOverpass<T = OverpassResponse>(
  query: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; label?: string } = {},
): Promise<T | null> {
  const { timeoutMs = 12000, signal: externalSignal, label } = opts
  const tag = label ? `overpass:${label}` : 'overpass'
  const operation = label && /^[a-z0-9_-]{1,32}$/i.test(label) ? label : 'generic'
  const finishTiming = startPerformanceSpan('api_overpass', { operation })
  const queuedAt = performance.now()
  const body = `data=${encodeURIComponent(query)}`
  const release = await acquireOverpassSlot(externalSignal)
  const queueMs = toTelemetryDuration(performance.now() - queuedAt)
  if (!release) {
    finishTiming('cancelled', { queue_ms: queueMs, attempts: 0 })
    return null
  }
  try {
    let lastErr: unknown = null
    let attempts = 0
    // One attempt per mirror, failing straight over to the other on a timeout or
    // rate-limit rather than hammering the same overloaded server twice.
    for (const [index, url] of OVERPASS_ENDPOINTS.entries()) {
      if (externalSignal?.aborted) break
      attempts++
      dbg(tag, `${url}`)
      const ctrl = new AbortController()
      const onExternalAbort = () => ctrl.abort()
      externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
      // Timeout starts here — after any time spent waiting for a slot.
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
        if (!res.ok) {
          // 429/504 (rate-limit / gateway timeout) and any other non-OK status:
          // fall through to the next mirror.
          lastErr = new Error(`Overpass HTTP ${res.status} at ${url}`)
          continue
        }
        const data = (await res.json()) as T
        const remark = (data as { remark?: unknown }).remark
        if (typeof remark === 'string' && remark.trim()) {
          lastErr = new Error(`Overpass returned an error response at ${url}`)
          continue
        }
        finishTiming('success', {
          queue_ms: queueMs,
          attempts,
          mirror: index === 0 ? 'primary' : 'fallback',
        })
        return data
      } catch (err) {
        // Network error or per-attempt timeout — try the next mirror.
        lastErr = err
        continue
      } finally {
        clearTimeout(timer)
        externalSignal?.removeEventListener('abort', onExternalAbort)
      }
    }
    console.warn('Overpass: all endpoints failed', lastErr)
    finishTiming(externalSignal?.aborted ? 'cancelled' : 'error', {
      queue_ms: queueMs,
      attempts,
    })
    return null
  } finally {
    release()
  }
}
