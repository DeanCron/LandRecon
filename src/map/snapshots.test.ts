import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSnapshotLoader } from './snapshots'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('makeSnapshotLoader cancellation', () => {
  it('detaches an aborted caller without cancelling the shared snapshot fetch', async () => {
    type Payload = { count: number; generated_at: string; values: number[] }
    const payload: Payload = { count: 1, generated_at: '2026-07-17', values: [42] }
    let resolveFetch!: (value: Response) => void
    const fetchMock = vi.fn().mockImplementation(() =>
      new Promise<Response>((resolve) => { resolveFetch = resolve }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const load = makeSnapshotLoader<Payload>('test.json', 'test')

    const shared = load()
    const controller = new AbortController()
    const cancelled = load(controller.signal)
    controller.abort()

    await expect(cancelled).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    resolveFetch({
      ok: true,
      json: async () => payload,
    } as Response)
    await expect(shared).resolves.toEqual(payload)
    await expect(load()).resolves.toEqual(payload)

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(load(alreadyAborted.signal)).resolves.toBeNull()
  })
})
