import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchOverpass } from './overpass'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('fetchOverpass concurrency', () => {
  it('falls back when an endpoint returns an HTTP-200 runtime error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          elements: [],
          remark: 'runtime error: Query ran out of memory',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ elements: [{ id: 1 }] }),
      })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchOverpass('query')).resolves.toEqual({ elements: [{ id: 1 }] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('removes an aborted request while it is waiting for a slot', async () => {
    let resolveFirst!: (value: Response) => void
    let resolveSecond!: (value: Response) => void
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveSecond = resolve }))
    vi.stubGlobal('fetch', fetchMock)

    const first = fetchOverpass('query-1', { timeoutMs: 10000 })
    const second = fetchOverpass('query-2', { timeoutMs: 10000 })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    const controller = new AbortController()
    const queued = fetchOverpass('query-3', { timeoutMs: 10000, signal: controller.signal })
    controller.abort()

    await expect(queued).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const response = {
      ok: true,
      json: async () => ({ elements: [] }),
    } as Response
    resolveFirst(response)
    resolveSecond(response)
    await Promise.all([first, second])
  })
})
