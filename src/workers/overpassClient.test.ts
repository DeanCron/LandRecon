import { beforeEach, describe, expect, it, vi } from 'vitest'

const instances: FakeWorker[] = []

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()

  constructor() {
    instances.push(this)
  }
}

vi.mock('./overpassWorker?worker', () => ({ default: FakeWorker }))

beforeEach(() => {
  vi.resetModules()
  instances.length = 0
})

describe('Overpass worker client cancellation', () => {
  it('rejects immediately and sends a cancel message for an in-flight request', async () => {
    const { fetchCamerasInWorker } = await import('./overpassClient')
    const controller = new AbortController()
    const request = fetchCamerasInWorker('1,2,3,4', controller.signal)
    const worker = instances[0]
    const dispatched = worker.postMessage.mock.calls[0][0]

    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.postMessage).toHaveBeenLastCalledWith({ id: dispatched.id, kind: 'cancel' })
  })

  it('does not dispatch an already-aborted request', async () => {
    const { fetchTransitLinesInWorker } = await import('./overpassClient')
    const controller = new AbortController()
    controller.abort()

    await expect(fetchTransitLinesInWorker('1,2,3,4', controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(instances).toHaveLength(0)
  })
})
