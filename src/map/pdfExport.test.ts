import { describe, it, expect, vi, beforeEach } from 'vitest'

const download = vi.fn()
const createPdf = vi.fn(() => ({ download }))

vi.mock('pdfmake/build/pdfmake', () => ({
  default: { createPdf, vfs: {} },
}))
vi.mock('pdfmake/build/vfs_fonts', () => ({
  default: { vfs: { 'Roboto-Regular.ttf': 'AAAA' } },
}))

import { downloadReconPdf } from './pdfExport'

describe('downloadReconPdf', () => {
  beforeEach(() => {
    download.mockClear()
    createPdf.mockClear()
  })

  it('creates the pdf and triggers a download with the filename', async () => {
    await downloadReconPdf({ content: [] }, 'LandRecon-x-2026-09-15.pdf')
    expect(createPdf).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledWith('LandRecon-x-2026-09-15.pdf')
  })
})
