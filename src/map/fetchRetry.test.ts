import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchJsonWithRetry } from './fetchRetry'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('fetchJsonWithRetry', () => {
  it('returns parsed JSON on the first success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ value: '4' }) })
    vi.stubGlobal('fetch', fetchMock)
    const data = await fetchJsonWithRetry<{ value: string }>('https://x', { backoffMs: 0 })
    expect(data).toEqual({ value: '4' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries transient HTTP failures then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: 1 }) })
    vi.stubGlobal('fetch', fetchMock)
    const data = await fetchJsonWithRetry('https://x', { retries: 2, backoffMs: 0 })
    expect(data).toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws after exhausting all attempts', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 })
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchJsonWithRetry('https://x', { retries: 1, backoffMs: 0 })).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(2) // first attempt + 1 retry
  })

  it('stops immediately when the caller aborts', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn().mockImplementation((_url, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const request = fetchJsonWithRetry('https://x', {
      init: { signal: controller.signal },
      retries: 2,
      backoffMs: 1000,
    })
    controller.abort()

    await expect(request).rejects.toBeDefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('cancels the retry backoff when the caller aborts', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 })
    vi.stubGlobal('fetch', fetchMock)

    const request = fetchJsonWithRetry('https://x', {
      init: { signal: controller.signal },
      retries: 2,
      backoffMs: 10000,
    })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    controller.abort()

    await expect(request).rejects.toBeDefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
