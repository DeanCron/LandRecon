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
  || 'https://landrecon.livelybush-ee6a3eea.eastus.azurecontainerapps.io').replace(/\/$/, '')

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
  return out
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
  try {
    const url = req.url || ''

    if (url.startsWith('/og.png')) {
      const params = parseParams(url)
      const key = `${params.address}|${params.layers.join(',')}|${params.base}`
      let png = lruGet(pngCache, key)
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
      return res.end(png)
    }

    if (url.startsWith('/share')) {
      const params = parseParams(url)
      const origin = originFromReq(req)
      const key = `${origin}|${params.address}|${params.layers.join(',')}|${params.base}`
      let html = lruGet(htmlCache, key)
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
      return res.end(html)
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    return res.end('Not found')
  } catch (err) {
    console.error('[og] handler error:', err)
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('OG render error')
  }
})

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`[og] listening on 127.0.0.1:${PORT}; fallback origin = ${FALLBACK_ORIGIN}`)
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
