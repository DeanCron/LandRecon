// One-shot script: render public/og-image.png (1200x630) from an inline SVG.
// Re-run after branding changes:  node scripts/generate-og-image.mjs
//
// 1200x630 is the modern Open Graph / Twitter "summary_large_image" size that
// renders cleanly in iMessage, Slack, Discord, Twitter, Facebook, LinkedIn.

import sharp from 'sharp'
import { writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '..', 'public', 'og-image.png')

// Palette borrowed from favicon.svg + index.css theme.
const OLIVE = '#3F4434'
const OLIVE_DARK = '#2A2E22'
const CREAM = '#F2EAD0'
const ACCENT = '#0072B2'  // theme-color

const reticle = (cx, cy, scale) => `
  <g transform="translate(${cx},${cy}) scale(${scale}) translate(-32,-32)">
    <g fill="none" stroke-linecap="round">
      <g stroke="${OLIVE}" stroke-width="9">
        <circle cx="32" cy="32" r="19" />
        <line x1="4"  y1="32" x2="22" y2="32" />
        <line x1="42" y1="32" x2="60" y2="32" />
        <line x1="32" y1="4"  x2="32" y2="22" />
        <line x1="32" y1="42" x2="32" y2="60" />
      </g>
      <g stroke="${CREAM}" stroke-width="5">
        <circle cx="32" cy="32" r="19" />
        <line x1="4"  y1="32" x2="22" y2="32" />
        <line x1="42" y1="32" x2="60" y2="32" />
        <line x1="32" y1="4"  x2="32" y2="22" />
        <line x1="32" y1="42" x2="32" y2="60" />
      </g>
    </g>
    <circle cx="32" cy="32" r="4" fill="${OLIVE}" />
    <circle cx="32" cy="32" r="2" fill="${CREAM}" />
  </g>
`

// Faint grid + scattered "pin" dots to evoke a map without copying any
// tile provider's imagery (keeps the asset license-clean).
const gridLines = () => {
  const lines = []
  for (let x = 0; x <= 1200; x += 60) {
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="630" stroke="${CREAM}" stroke-opacity="0.05" stroke-width="1"/>`)
  }
  for (let y = 0; y <= 630; y += 60) {
    lines.push(`<line x1="0" y1="${y}" x2="1200" y2="${y}" stroke="${CREAM}" stroke-opacity="0.05" stroke-width="1"/>`)
  }
  return lines.join('\n')
}

const pinDots = () => {
  // Deterministic pseudo-random scatter so the image is reproducible.
  const dots = []
  const seeds = [
    [220, 90], [340, 510], [890, 130], [1050, 480], [780, 540],
    [620, 100], [510, 470], [960, 280], [180, 380], [1100, 200],
    [420, 200], [720, 380], [840, 70], [120, 240], [1020, 580],
  ]
  for (const [x, y] of seeds) {
    dots.push(`<circle cx="${x}" cy="${y}" r="6" fill="${ACCENT}" fill-opacity="0.5"/>`)
    dots.push(`<circle cx="${x}" cy="${y}" r="2.5" fill="${CREAM}"/>`)
  }
  return dots.join('\n')
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0"   stop-color="${OLIVE}" />
      <stop offset="1"   stop-color="${OLIVE_DARK}" />
    </linearGradient>
    <radialGradient id="vignette" cx="0.5" cy="0.5" r="0.75">
      <stop offset="0.6" stop-color="black" stop-opacity="0" />
      <stop offset="1"   stop-color="black" stop-opacity="0.45" />
    </radialGradient>
  </defs>

  <rect width="1200" height="630" fill="url(#bg)" />
  ${gridLines()}
  ${pinDots()}
  <rect width="1200" height="630" fill="url(#vignette)" />

  ${reticle(180, 315, 3.6)}

  <g font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif">
    <text x="380" y="280" font-size="104" font-weight="800" fill="${CREAM}" letter-spacing="-3">Land Recon</text>
    <text x="380" y="340" font-size="34" font-weight="500" fill="${CREAM}" fill-opacity="0.88">Neighborhood land intelligence</text>
    <text x="380" y="408" font-size="22" font-weight="400" fill="${CREAM}" fill-opacity="0.72">Airport noise · Superfunds · Transit · Traffic · Cameras · Data centers</text>
  </g>

  <text x="600" y="585" text-anchor="middle" font-family="system-ui, sans-serif" font-size="18" font-weight="500" fill="${CREAM}" fill-opacity="0.45" letter-spacing="4">RECON · MAP · DECIDE</text>
</svg>`

await writeFile(join(__dirname, 'generate-og-image.preview.svg'), svg, 'utf8')

const png = await sharp(Buffer.from(svg))
  .png({ quality: 92, compressionLevel: 9 })
  .toFile(OUT)

console.log(`Wrote ${OUT}`)
console.log(`  ${png.width}x${png.height}, ${(png.size / 1024).toFixed(1)} KB`)
console.log(`  Source SVG saved to scripts/generate-og-image.preview.svg for inspection.`)
