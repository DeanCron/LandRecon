// Singleton Overpass worker + promise-based RPC. Lazily created on first
// call so the worker bundle (and the network request for it) doesn't load
// until a transit/lines layer is actually used.

import OverpassWorker from './overpassWorker?worker'
import type { StopResult, LineResult, BusLineResult, CameraResult } from './overpassWorker'

// Same opt-in flag MapPage uses (`localStorage.setItem('LR_DEBUG','1')`),
// so worker round-trip timings show up alongside everything else when
// debug is on. Silent in production.
const LR_DEBUG = typeof localStorage !== 'undefined' && localStorage.getItem('LR_DEBUG') === '1'
function dbg(...args: unknown[]) { if (LR_DEBUG) console.debug('[LR:worker]', ...args) }

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; kind: string; t0: number }>()

function getWorker(): Worker {
  if (!worker) {
    dbg('Spinning up Overpass worker')
    worker = new OverpassWorker()
    worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const { id, ok, result, error } = ev.data
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      const dt = Math.round(performance.now() - p.t0)
      const count = Array.isArray(result) ? result.length : undefined
      if (ok) {
        dbg(`${p.kind} #${id} resolved in ${dt}ms${count !== undefined ? ` (${count} rows)` : ''}`)
        p.resolve(result)
      } else {
        dbg(`${p.kind} #${id} rejected in ${dt}ms: ${error}`)
        p.reject(new Error(error || 'Worker error'))
      }
    }
    worker.onerror = (ev: ErrorEvent) => {
      console.error('Overpass worker fatal:', ev.message)
      dbg(`Worker crashed with ${pending.size} pending request(s)`)
      for (const [, p] of pending) p.reject(new Error('Worker crashed: ' + ev.message))
      pending.clear()
      worker?.terminate()
      worker = null
    }
  }
  return worker
}

function call<T>(kind: 'stops' | 'lines' | 'bus' | 'cameras', payload: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++
    const t0 = performance.now()
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, kind, t0 })
    dbg(`${kind} #${id} dispatched`)
    getWorker().postMessage({ id, kind, payload })
  })
}

export function fetchStopsInWorker(bbox: string, opts: { rail: boolean; bus: boolean }): Promise<StopResult[]> {
  return call<StopResult[]>('stops', { bbox, rail: opts.rail, bus: opts.bus })
}

export function fetchTransitLinesInWorker(bbox: string): Promise<LineResult[]> {
  return call<LineResult[]>('lines', { bbox })
}

export function fetchBusLinesInWorker(bbox: string): Promise<BusLineResult[]> {
  return call<BusLineResult[]>('bus', { bbox })
}

export function fetchCamerasInWorker(bbox: string): Promise<CameraResult[]> {
  return call<CameraResult[]>('cameras', { bbox })
}
