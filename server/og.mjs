// /share + /og.png sidecar — generates per-URL Open Graph metadata + image
// for crawler requests. Listens on 127.0.0.1:3002.
//
// Routing (set up in nginx.conf):
//   - GET /map?address=…   from a crawler UA → proxied to /share?address=…
//   - GET /og.png?address=… (from anywhere) → proxied to this server
//
// Real users hitting /map still get the static index.html (and the static
// brand-level OG tags from index.html cover the root URL).

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { addressSvg, defaultSvg, renderPng, LAYER_LABELS, BASE_LABELS } from './render-og-image.mjs'

const PORT = Number(process.env.OG_PORT || 3002)
const INDEX_HTML_PATH = process.env.OG_INDEX_HTML || '/usr/share/nginx/html/index.html'
const FALLBACK_ORIGIN = (process.env.PUBLIC_ORIGIN
  || 'https://landrecon.com').replace(/\/$/, '')

// Per-request debug logging. Opt in by setting env LR_DEBUG_OG=1 on the
// container (silent by default to avoid noisy stdout). Always-on errors
// continue to go through console.error.
const LR_DEBUG = process.env.LR_DEBUG_OG === '1' || process.env.LR_DEBUG === '1'
function dbg(...args) { if (LR_DEBUG) console.debug('[og]', ...args) }

// Derive the absolute origin from the incoming request so og:url and
// og:image always match the host the crawler hit (works the moment a
// custom domain is wired up — no redeploy needed). nginx is configured
// to forward Host + X-Forwarded-Proto headers.
function originFromReq(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https'
  const host = req.headers['x-forwarded-host'] || req.headers.host
  if (host) return `${proto}://${host}`.replace(/\/$/, '')
  return FALLBACK_ORIGIN
}

const CACHE_LIMIT = 200
const pngCache = new Map()
const htmlCache = new Map()
let indexHtmlCache = null
let indexHtmlMtime = 0

function lruGet(map, key) {
  if (!map.has(key)) return null
  const v = map.get(key)
  map.delete(key)
  map.set(key, v)
  return v
}
function lruSet(map, key, val) {
  if (map.has(key)) map.delete(key)
  map.set(key, val)
  while (map.size > CACHE_LIMIT) map.delete(map.keys().next().value)
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function parseParams(url) {
  const u = new URL(url, 'http://x')
  const address = (u.searchParams.get('address') || '').slice(0, 300)
  const layers = (u.searchParams.get('layers') || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && LAYER_LABELS[s])
  const base = BASE_LABELS[u.searchParams.get('base') || ''] ? u.searchParams.get('base') : 'street'
  return { address, layers, base }
}

function buildQuery({ address, layers, base }) {
  const qs = new URLSearchParams()
  if (address) qs.set('address', address)
  if (layers.length) qs.set('layers', layers.join(','))
  if (base && base !== 'street') qs.set('base', base)
  return qs.toString()
}

function rewriteOgTags(html, { address, layers, base, ogImageUrl, pageUrl }) {
  const title = address ? `${address} — Land Recon` : 'Land Recon — Neighborhood land intelligence'
  const baseLabel = BASE_LABELS[base] || 'Street'
  const layerLabels = layers.map((l) => LAYER_LABELS[l]).filter(Boolean)
  const description = address
    ? (layerLabels.length > 0
      ? `Land intelligence for ${address}. ${baseLabel} map with ${layerLabels.length} active layer${layerLabels.length === 1 ? '' : 's'}: ${layerLabels.slice(0, 5).join(', ')}${layerLabels.length > 5 ? ', …' : ''}.`
      : `Land intelligence for ${address}. ${baseLabel} map view.`)
    : 'Airport noise, Superfunds, transit, traffic, cameras, data centers, and crowd magnets — all on one interactive map.'

  // Replace a content="..." attribute on a meta tag matched by property/name.
  // Tolerant to attribute order — looks for the tag, then swaps content.
  const setMeta = (h, attr, name, value) => {
    const re = new RegExp(`(<meta\\s+${attr}="${name}"[^>]*content=")[^"]*(")`, 'i')
    if (re.test(h)) return h.replace(re, `$1${esc(value)}$2`)
    // Also handle reversed attribute order (content first, then property/name).
    const re2 = new RegExp(`(<meta\\s+content=")[^"]*("\\s+${attr}="${name}")`, 'i')
    if (re2.test(h)) return h.replace(re2, `$1${esc(value)}$2`)
    return h
  }

  let out = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
  out = setMeta(out, 'name', 'description', description)
  out = setMeta(out, 'property', 'og:title', title)
  out = setMeta(out, 'property', 'og:description', description)
  out = setMeta(out, 'property', 'og:url', pageUrl)
  out = setMeta(out, 'property', 'og:image', ogImageUrl)
  out = setMeta(out, 'property', 'og:image:secure_url', ogImageUrl)
  out = setMeta(out, 'property', 'og:image:alt', address ? `Land Recon preview card for ${address}` : 'Land Recon preview card')
  out = setMeta(out, 'name', 'twitter:title', title)
  out = setMeta(out, 'name', 'twitter:description', description)
  out = setMeta(out, 'name', 'twitter:image', ogImageUrl)
  out = setMeta(out, 'name', 'twitter:image:alt', address ? `Land Recon preview card for ${address}` : 'Land Recon preview card')

  // Per-URL canonical. The static index.html canonical points at the
  // brand homepage; for crawler-rendered /map shares we point each
  // address-specific page at its own canonical so search engines don't
  // collapse them into one entry.
  const canonRe = /(<link\s+rel="canonical"[^>]*href=")[^"]*(")/i
  if (canonRe.test(out)) {
    out = out.replace(canonRe, `$1${esc(pageUrl)}$2`)
  } else {
    out = out.replace(/<\/head>/i, `  <link rel="canonical" href="${esc(pageUrl)}" />\n  </head>`)
  }

  // Inject a crawler-visible HTML body inside <div id="root"></div>. Real
  // browsers (which never hit this code path — only crawler UAs are forked
  // here) would have React replace the children on hydration anyway, so
  // there's no risk of double-rendering. Bots see an actual <h1>, real
  // paragraph copy, and a topical link list — dramatically stronger
  // organic-search signal than a 4 KB empty SPA shell.
  const body = address ? renderAddressBody({ address, baseLabel, layerLabels, pageUrl }) : renderHomeBody()
  out = out.replace(
    /<div id="root">\s*<\/div>/,
    `<div id="root">${body}</div>`,
  )
  return out
}

const ALL_LAYER_LABELS = Object.values(LAYER_LABELS)

function renderHomeBody() {
  const items = ALL_LAYER_LABELS.map((l) => `<li>${esc(l)}</li>`).join('')
  return `
    <main class="seo-shell">
      <header>
        <h1>Land Recon — Neighborhood land intelligence</h1>
        <p>Look up airport noise, EPA Superfund sites, data centers, hospitals, transit, traffic, cameras, and crowd magnets by U.S. street address on one interactive map.</p>
      </header>
      <section>
        <h2>What you can search</h2>
        <ul>${items}</ul>
      </section>
      <section>
        <h2>How it works</h2>
        <p>Enter any U.S. address on the home page. Land Recon geocodes it, drops a marker, and overlays the public-records and operational data layers you choose — all client-side, no account required.</p>
      </section>
      <noscript>
        <p><strong>Land Recon requires JavaScript</strong> to render the interactive map. Please enable JavaScript and reload the page.</p>
      </noscript>
    </main>
  `
}

function renderAddressBody({ address, baseLabel, layerLabels, pageUrl }) {
  const layerList = layerLabels.length
    ? `<ul>${layerLabels.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
    : '<p>No additional layers are active on this view.</p>'
  return `
    <main class="seo-shell">
      <header>
        <h1>Land intelligence for ${esc(address)}</h1>
        <p>Land Recon report for <strong>${esc(address)}</strong> on a ${esc(baseLabel.toLowerCase())} basemap.</p>
      </header>
      <section>
        <h2>Active map layers</h2>
        ${layerList}
      </section>
      <section>
        <h2>Open this report</h2>
        <p><a href="${esc(pageUrl)}">View the interactive map for ${esc(address)}</a></p>
      </section>
      <noscript>
        <p><strong>The interactive map requires JavaScript.</strong> Please enable JavaScript and reload the page.</p>
      </noscript>
    </main>
  `
}

async function loadIndexHtml() {
  try {
    const stat = await readFile(INDEX_HTML_PATH).then((b) => ({ data: b, mtime: Date.now() }))
    if (!indexHtmlCache || stat.mtime !== indexHtmlMtime) {
      indexHtmlCache = stat.data.toString('utf8')
      indexHtmlMtime = stat.mtime
    }
  } catch (err) {
    console.error('[og] cannot read index.html:', err.message)
    indexHtmlCache = '<!doctype html><html><head><title>Land Recon</title></head><body></body></html>'
  }
  return indexHtmlCache
}

const server = createServer(async (req, res) => {
  const t0 = Date.now()
  try {
    const url = req.url || ''
    const ua = (req.headers['user-agent'] || '').slice(0, 80)

    if (url.startsWith('/og.png')) {
      const params = parseParams(url)
      const key = `${params.address}|${params.layers.join(',')}|${params.base}`
      let png = lruGet(pngCache, key)
      const cacheHit = !!png
      if (!png) {
        const svg = addressSvg(params)
        png = await renderPng(svg)
        lruSet(pngCache, key, png)
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': png.length,
        'Cache-Control': 'public, max-age=86400, immutable',
      })
      res.end(png)
      dbg(`png ${cacheHit ? 'HIT ' : 'MISS'} addr="${params.address.slice(0,40)}" layers=${params.layers.length} base=${params.base} bytes=${png.length} ${Date.now() - t0}ms ua="${ua}"`)
      return
    }

    if (url.startsWith('/share')) {
      const params = parseParams(url)
      const origin = originFromReq(req)
      const key = `${origin}|${params.address}|${params.layers.join(',')}|${params.base}`
      let html = lruGet(htmlCache, key)
      const cacheHit = !!html
      if (!html) {
        const indexHtml = await loadIndexHtml()
        const qs = buildQuery(params)
        const ogImageUrl = `${origin}/og.png${qs ? '?' + qs : ''}`
        const pageUrl = `${origin}/map${qs ? '?' + qs : ''}`
        html = rewriteOgTags(indexHtml, { ...params, ogImageUrl, pageUrl })
        lruSet(htmlCache, key, html)
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'public, max-age=3600',
      })
      res.end(html)
      dbg(`share ${cacheHit ? 'HIT ' : 'MISS'} addr="${params.address.slice(0,40)}" layers=${params.layers.length} base=${params.base} origin=${origin} bytes=${Buffer.byteLength(html)} ${Date.now() - t0}ms ua="${ua}"`)
      return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
    dbg(`404 url=${url} ${Date.now() - t0}ms ua="${ua}"`)
  } catch (err) {
    console.error('[og] handler error:', err)
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('OG render error')
  }
})

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`[og] listening on 127.0.0.1:${PORT}; fallback origin = ${FALLBACK_ORIGIN}; debug=${LR_DEBUG}`)
  // Pre-warm libvips/sharp + render the default brand card so the first
  // real crawler request doesn't pay the ~700ms cold-start cost. We also
  // seed the LRU with the default key so '/og.png' with no params is
  // served straight from memory.
  try {
    const t0 = Date.now()
    const warmPng = await renderPng(defaultSvg())
    lruSet(pngCache, '||street', warmPng)
    console.log(`[og] pre-warm complete in ${Date.now() - t0}ms (${warmPng.length} bytes seeded)`)
  } catch (err) {
    console.error('[og] pre-warm failed (non-fatal):', err.message)
  }
})
