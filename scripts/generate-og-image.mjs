// One-shot script: render public/og-image.png (1200x630) from the shared
// renderer in server/render-og-image.mjs. This is the brand-level default
// card served for the root URL and any non-/map link. Per-address cards
// are generated at runtime by the og sidecar (server/og.mjs).
//
// Re-run after branding changes:  node scripts/generate-og-image.mjs

import { writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultSvg, renderPng } from '../server/render-og-image.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '..', 'public', 'og-image.png')

const svg = defaultSvg()
await writeFile(join(__dirname, 'generate-og-image.preview.svg'), svg, 'utf8')

const png = await renderPng(svg)
await writeFile(OUT, png)

console.log(`Wrote ${OUT}`)
console.log(`  ${(png.length / 1024).toFixed(1)} KB`)
console.log(`  Source SVG saved to scripts/generate-og-image.preview.svg for inspection.`)

