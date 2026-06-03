// Shared OG image renderer. Used by:
//   - scripts/generate-og-image.mjs   — build-time, writes public/og-image.png
//   - server/og.mjs                   — runtime sidecar, per-address /og.png
//
// Both endpoints render an inline SVG and pipe it through sharp to PNG.
// SVG is intentionally font-only (no emojis or icon glyphs) so we don't
// depend on emoji fonts in the Alpine container.

import sharp from 'sharp'

const OLIVE = '#3F4434'
const OLIVE_DARK = '#2A2E22'
const CREAM = '#F2EAD0'
const ACCENT = '#0072B2'

const LAYER_LABELS = {
  noise: 'Airport noise',
  superfund: 'Superfunds',
  flood: 'Flood zones',
  transit: 'Transit',
  traffic: 'Traffic',
  costco: 'Costco',
  datacenters: 'Data centers',
  ems: 'EMS',
  crowd: 'Crowds',
  cameras: 'Cameras',
}

const BASE_LABELS = {
  street: 'Street',
  satellite: 'Satellite',
  hybrid: 'Hybrid',
  terrain: 'Terrain',
}

// Escape user-supplied text for embedding inside SVG text content.
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Crude character-count word wrap. Good enough for an OG card where we
// don't need glyph-accurate measurement.
function wrap(text, maxCharsPerLine, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const lines = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (next.length > maxCharsPerLine && cur) {
      lines.push(cur)
      if (lines.length === maxLines) break
      cur = w
    } else {
      cur = next
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur)
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1]
    if (last.length > maxCharsPerLine) lines[maxLines - 1] = last.slice(0, maxCharsPerLine - 1) + '\u2026'
  }
  return lines
}

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

const gridLines = () => {
  const out = []
  for (let x = 0; x <= 1200; x += 60) out.push(`<line x1="${x}" y1="0" x2="${x}" y2="630" stroke="${CREAM}" stroke-opacity="0.05"/>`)
  for (let y = 0; y <= 630; y += 60) out.push(`<line x1="0" y1="${y}" x2="1200" y2="${y}" stroke="${CREAM}" stroke-opacity="0.05"/>`)
  return out.join('')
}

const pinDots = () => {
  const seeds = [
    [220, 90], [340, 510], [890, 130], [1050, 480], [780, 540],
    [620, 100], [510, 470], [960, 280], [180, 380], [1100, 200],
    [420, 200], [720, 380], [840, 70], [120, 240], [1020, 580],
  ]
  return seeds.map(([x, y]) =>
    `<circle cx="${x}" cy="${y}" r="6" fill="${ACCENT}" fill-opacity="0.45"/><circle cx="${x}" cy="${y}" r="2.5" fill="${CREAM}"/>`
  ).join('')
}

const FRAME_HEAD = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${OLIVE}"/><stop offset="1" stop-color="${OLIVE_DARK}"/>
    </linearGradient>
    <radialGradient id="vignette" cx="0.5" cy="0.5" r="0.75">
      <stop offset="0.6" stop-color="black" stop-opacity="0"/><stop offset="1" stop-color="black" stop-opacity="0.45"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  ${gridLines()}
  ${pinDots()}
  <rect width="1200" height="630" fill="url(#vignette)"/>`

/**
 * Default brand-level card. Used at build time for the static
 * public/og-image.png fallback (root URL, no address context).
 */
export function defaultSvg() {
  return `${FRAME_HEAD}
  ${reticle(180, 315, 3.6)}
  <g font-family="Inter, 'DejaVu Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif">
    <text x="380" y="280" font-size="104" font-weight="800" fill="${CREAM}" letter-spacing="-3">Land Recon</text>
    <text x="380" y="340" font-size="34" font-weight="500" fill="${CREAM}" fill-opacity="0.88">Neighborhood land intelligence</text>
    <text x="380" y="408" font-size="22" font-weight="400" fill="${CREAM}" fill-opacity="0.72">Airport noise · Superfunds · Transit · Traffic · Cameras · Data centers</text>
  </g>
  <text x="600" y="585" text-anchor="middle" font-family="Inter, 'DejaVu Sans', system-ui, sans-serif" font-size="18" font-weight="500" fill="${CREAM}" fill-opacity="0.45" letter-spacing="4">RECON · MAP · DECIDE</text>
</svg>`
}

/**
 * Per-address card. Address as hero, base-map + layer-count footer,
 * layer-name chips. Renders cleanly even with missing/empty layers.
 *
 * @param {object} params
 * @param {string} [params.address]
 * @param {string[]} [params.layers]
 * @param {string} [params.base]
 */
export function addressSvg({ address = '', layers = [], base = 'street' } = {}) {
  const safe = String(address || '').trim().slice(0, 200)
  // Tighter wrap so multi-line addresses still fit horizontally; the
  // post-wrap pass below also shrinks the font if the longest line is
  // wider than the available content width (~1020px from x=170 to ~1190).
  const addressLines = safe ? wrap(safe, 24, 3) : ['Map view']
  const baseLabel = BASE_LABELS[base] || 'Street'
  const layerLabels = layers.map((l) => LAYER_LABELS[l]).filter(Boolean)

  // Font size starts at a per-line-count target and is shrunk to fit the
  // longest line in the available width (rough proportional approximation,
  // good enough for an OG card with bold sans-serif).
  const CONTENT_W = 1020
  // DejaVu Sans Bold (the Alpine runtime fallback) has wider glyphs than
  // typical system sans. Empirically ~0.62-0.65 em per glyph at bold
  // weight — using 0.55 like the Windows preview fonts under-shrinks
  // and the address bleeds past the right edge. 0.66 keeps a 1-line
  // 24-char address within the 1020px content width.
  const CHAR_W_RATIO = 0.66
  const targetSize = addressLines.length === 1 ? 76 : addressLines.length === 2 ? 64 : 52
  const longest = addressLines.reduce((m, l) => Math.max(m, l.length), 1)
  const widthCap = Math.floor(CONTENT_W / (longest * CHAR_W_RATIO))
  const addrFontSize = Math.max(34, Math.min(targetSize, widthCap))
  const addrLineHeight = Math.round(addrFontSize * 1.18)
  const addrBlockH = addressLines.length * addrLineHeight
  const addrStartY = 320 - addrBlockH / 2 + addrFontSize

  // Layer chips — packed left-to-right, wrap to next row when overflow.
  const chips = []
  const chipPad = 18
  const chipGap = 10
  const chipHeight = 38
  const chipFontSize = 18
  const chipMaxRight = 1060
  let cx = 140
  let cy = 470
  for (const label of layerLabels) {
    // Approximate width: char × 9.5px (proportional sans) + 2× pad.
    const w = Math.round(label.length * 9.5 + chipPad * 2)
    if (cx + w > chipMaxRight) { cx = 140; cy += chipHeight + 10 }
    if (cy > 530) break
    chips.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${chipHeight}" rx="${chipHeight / 2}" fill="${CREAM}" fill-opacity="0.12" stroke="${CREAM}" stroke-opacity="0.25"/><text x="${cx + w / 2}" y="${cy + chipHeight / 2 + chipFontSize / 3}" text-anchor="middle" font-size="${chipFontSize}" font-weight="500" fill="${CREAM}" font-family="Inter, 'DejaVu Sans', system-ui, sans-serif">${esc(label)}</text>`)
    cx += w + chipGap
  }
  const footerText = layerLabels.length > 0
    ? `${baseLabel} map · ${layerLabels.length} layer${layerLabels.length === 1 ? '' : 's'} active`
    : `${baseLabel} map`

  return `${FRAME_HEAD}

  ${reticle(105, 90, 1.5)}
  <text x="170" y="100" font-family="Inter, 'DejaVu Sans', system-ui, sans-serif" font-size="28" font-weight="700" fill="${CREAM}" letter-spacing="-1">Land Recon</text>
  <text x="170" y="125" font-family="Inter, 'DejaVu Sans', system-ui, sans-serif" font-size="13" font-weight="500" fill="${CREAM}" fill-opacity="0.65" letter-spacing="2.5">NEIGHBORHOOD INTEL</text>

  <g transform="translate(80, 260)">
    <path d="M30 0 C13 0 0 13 0 30 C0 52 30 80 30 80 C30 80 60 52 60 30 C60 13 47 0 30 0 Z" fill="${ACCENT}" fill-opacity="0.85"/>
    <circle cx="30" cy="30" r="11" fill="${CREAM}"/>
  </g>

  <g font-family="Inter, 'DejaVu Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" fill="${CREAM}">
    ${addressLines.map((line, i) =>
      `<text x="170" y="${addrStartY + i * addrLineHeight}" font-size="${addrFontSize}" font-weight="700" letter-spacing="-1">${esc(line)}</text>`
    ).join('')}
  </g>

  ${chips.join('')}

  <text x="140" y="595" font-family="Inter, 'DejaVu Sans', system-ui, sans-serif" font-size="18" font-weight="500" fill="${CREAM}" fill-opacity="0.55">${esc(footerText)}</text>
  <text x="1060" y="595" text-anchor="end" font-family="Inter, 'DejaVu Sans', system-ui, sans-serif" font-size="16" font-weight="500" fill="${CREAM}" fill-opacity="0.45" letter-spacing="3">RECON · MAP · DECIDE</text>
</svg>`
}

export async function renderPng(svg) {
  return sharp(Buffer.from(svg))
    .png({ quality: 92, compressionLevel: 9 })
    .toBuffer()
}

export { LAYER_LABELS, BASE_LABELS }
