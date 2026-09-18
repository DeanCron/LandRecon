import type { TDocumentDefinitions } from 'pdfmake/interfaces'

type PdfMakeLike = {
  vfs?: unknown
  createPdf: (doc: TDocumentDefinitions) => { download: (filename: string) => void }
}

export async function downloadReconPdf(doc: TDocumentDefinitions, filename: string): Promise<void> {
  const pdfMakeModule = await import('pdfmake/build/pdfmake')
  const pdfFontsModule = await import('pdfmake/build/vfs_fonts')
  const pdfMake = ((pdfMakeModule as { default?: PdfMakeLike }).default ?? pdfMakeModule) as PdfMakeLike
  const fonts = pdfFontsModule as { default?: { vfs?: unknown }; vfs?: unknown; pdfMake?: { vfs?: unknown } }
  const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(fonts, key)
  const vfs = (hasOwn('vfs') ? fonts.vfs : undefined) ?? (hasOwn('default') ? fonts.default?.vfs : undefined) ?? (hasOwn('pdfMake') ? fonts.pdfMake?.vfs : undefined)
  if (vfs) pdfMake.vfs = vfs
  pdfMake.createPdf(doc).download(filename)
}
