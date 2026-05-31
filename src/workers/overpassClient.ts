// Singleton Overpass worker + promise-based RPC. Lazily created on first
// call so the worker bundle (and the network request for it) doesn't load
// until a transit/lines layer is actually used.

import OverpassWorker from './overpassWorker?worker'
import type { StopResult, LineResult, BusLineResult } from './overpassWorker'

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function getWorker(): Worker {
  if (!worker) {
    worker = new OverpassWorker()
    worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const { id, ok, result, error } = ev.data
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      if (ok) p.resolve(result)
      else p.reject(new Error(error || 'Worker error'))
    }
    worker.onerror = (ev: ErrorEvent) => {
      console.error('Overpass worker fatal:', ev.message)
      for (const [, p] of pending) p.reject(new Error('Worker crashed: ' + ev.message))
      pending.clear()
      worker?.terminate()
      worker = null
    }
  }
  return worker
}

function call<T>(kind: 'stops' | 'lines' | 'bus', payload: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
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
