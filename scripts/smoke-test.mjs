#!/usr/bin/env node
/**
 * LandRecon HTTP smoke test.
 *
 * Hammers the deployed site (default: prod) with 100 real US addresses
 * spanning urban, suburban, and rural environments and verifies the
 * end-to-end share / OG pipeline:
 *
 *   Pre-flight
 *     1. GET /                        → 200 text/html
 *     2. GET /map                     → 200 text/html
 *     3. GET /og-image.png            → 200 image/png, size sane
 *     4. HEAD on each snapshot blob   → 200, Last-Modified within 48h
 *
 *   Per address (×100)
 *     a. GET /map?address=...        (real browser UA)  → 200 HTML
 *     b. GET /map?address=...        (crawler UA)       → 200 HTML, og:title contains address, og:image is absolute https://
 *     c. GET /og.png?address=...     → 200 image/png, 5KB ≤ size ≤ 300KB
 *
 * Optional (only if VITE_TOMTOM_API_KEY or TOMTOM_API_KEY is in env)
 *     d. TomTom forward-geocode      → returns ≥1 US result
 *
 * Usage:
 *   node scripts/smoke-test.mjs
 *   node scripts/smoke-test.mjs --target=http://localhost:8080
 *   LR_SMOKE_TARGET=http://localhost:8080 node scripts/smoke-test.mjs
 *   LR_SMOKE_CONCURRENCY=4 node scripts/smoke-test.mjs
 *   node scripts/smoke-test.mjs --only=rural --limit=10
 *   node scripts/smoke-test.mjs --skip-snapshots --skip-tomtom
 *
 * Flags:
 *   --target=<url>      Site under test (default $LR_SMOKE_TARGET or prod)
 *   --concurrency=<n>   Parallel address workers (default 8)
 *   --only=<category>   urban | suburban | rural | <region name>
 *   --limit=<n>         Cap addresses tested (after filter)
 *   --skip-snapshots    Don't probe Azure blob inventory
 *   --skip-tomtom       Don't hit TomTom even if a key is set
 *   --json=<path>       Where to dump the full result report (default scripts/smoke-test-results.json)
 *   --no-color          Disable ANSI colors (also honored: NO_COLOR env)
 *   --quiet             Suppress per-address chatter; print summary only
 *   --help
 *
 * Exit codes:
 *   0  every check passed
 *   1  one or more checks failed
 *   2  bad CLI usage / config error
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_TARGET = 'https://landrecon.livelybush-ee6a3eea.eastus.azurecontainerapps.io'

const SNAPSHOT_BLOBS = [
  'https://landreconstorage.blob.core.windows.net/snapshots/cameras-us.json',
  'https://landreconstorage.blob.core.windows.net/snapshots/crowd-us.json',
  'https://landreconstorage.blob.core.windows.net/snapshots/transit-stops-us.json',
  'https://landreconstorage.blob.core.windows.net/snapshots/transit-lines-us.json',
]

const LAYERS_POOL = ['noise', 'cameras', 'crowd', 'transit', 'superfund', 'er']
const BASES = ['street', 'satellite']
const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const REQUEST_TIMEOUT_MS = 30_000
const SNAPSHOT_STALE_HOURS = 48

// ---------------------------------------------------------------------------
// CLI parse
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  printHelp()
  process.exit(0)
}

const target = stripTrailingSlash(args.target || process.env.LR_SMOKE_TARGET || DEFAULT_TARGET)
const concurrency = Math.max(1, Number(args.concurrency || process.env.LR_SMOKE_CONCURRENCY || 8))
const skipSnapshots = !!args['skip-snapshots']
const skipTomtom = !!args['skip-tomtom']
const tomtomKey = skipTomtom ? '' : (process.env.VITE_TOMTOM_API_KEY || process.env.TOMTOM_API_KEY || '')
const onlyFilter = args.only ? String(args.only).toLowerCase() : ''
const limit = args.limit ? Number(args.limit) : Infinity
const jsonOut = args.json || path.join(__dirname, 'smoke-test-results.json')
const quiet = !!args.quiet
const useColor = !args['no-color'] && !process.env.NO_COLOR && process.stdout.isTTY

if (!/^https?:\/\//.test(target)) {
  console.error(`error: --target must be an http(s) URL (got "${target}")`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// Tiny ANSI helpers
// ---------------------------------------------------------------------------

const COLORS = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m',
}
const c = (color, s) => useColor ? `${COLORS[color]}${s}${COLORS.reset}` : String(s)
const pass = (s) => c('green', s)
const fail = (s) => c('red', s)
const warn = (s) => c('yellow', s)
const dim = (s) => c('gray', s)

// ---------------------------------------------------------------------------
// Load address list
// ---------------------------------------------------------------------------

const addressesPath = path.join(__dirname, 'smoke-addresses.json')
let allAddresses
try {
  allAddresses = JSON.parse(await fs.readFile(addressesPath, 'utf8'))
} catch (err) {
  console.error(`error: could not read ${addressesPath}: ${err.message}`)
  process.exit(2)
}

let addresses = allAddresses
if (onlyFilter) {
  addresses = addresses.filter(a =>
    a.category.toLowerCase() === onlyFilter || a.region.toLowerCase() === onlyFilter,
  )
  if (addresses.length === 0) {
    console.error(`error: --only=${args.only} matched 0 addresses`)
    process.exit(2)
  }
}
if (Number.isFinite(limit)) addresses = addresses.slice(0, limit)

// Give each address a deterministic layers+base combo so tested URLs span
// the parameter space (0..3 layers, both basemaps).
const cases = addresses.map((a, i) => ({
  ...a,
  layers: LAYERS_POOL.slice(0, i % 4).join(','),
  base: BASES[i % BASES.length],
  index: i,
}))

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log()
console.log(c('bold', 'LandRecon smoke test'))
console.log(`  target          ${c('cyan', target)}`)
console.log(`  addresses       ${cases.length}${onlyFilter ? ` (only=${onlyFilter})` : ''} of ${allAddresses.length}`)
console.log(`  concurrency     ${concurrency}`)
console.log(`  tomtom geocode  ${tomtomKey ? c('green', 'on') : dim('off (no key)')}`)
console.log(`  snapshot blobs  ${skipSnapshots ? dim('skipped') : c('green', 'on')}`)
console.log()

const startedAt = Date.now()

const report = {
  target,
  startedAt: new Date(startedAt).toISOString(),
  options: { concurrency, only: onlyFilter || null, limit: Number.isFinite(limit) ? limit : null, skipSnapshots, tomtom: !!tomtomKey },
  preflight: { results: [] },
  addresses: [],
}

let preflightFailures = 0
let addressFailures = 0

console.log(c('bold', 'Pre-flight'))
const preflightChecks = [
  { name: 'GET /',                run: () => probePage(`${target}/`,         'text/html') },
  { name: 'GET /map',             run: () => probePage(`${target}/map`,      'text/html') },
  { name: 'GET /og-image.png',    run: () => probeImage(`${target}/og-image.png`, { min: 10_000, max: 200_000 }) },
]
if (!skipSnapshots) {
  for (const url of SNAPSHOT_BLOBS) {
    preflightChecks.push({ name: `HEAD ${shortBlob(url)}`, run: () => probeSnapshot(url) })
  }
}
for (const ck of preflightChecks) {
  const r = await ck.run()
  report.preflight.results.push({ name: ck.name, ...r })
  if (r.ok) {
    console.log(`  ${pass('✓')} ${ck.name} ${dim(r.detail || '')}`)
  } else {
    preflightFailures++
    console.log(`  ${fail('✗')} ${ck.name} ${fail(r.error || '')}`)
  }
}
console.log()

console.log(c('bold', `Per-address (${cases.length} addresses × ${tomtomKey ? 4 : 3} checks)`))
const runner = new Pool(concurrency)
const progress = { done: 0 }
await Promise.all(cases.map(cs => runner.run(async () => {
  const result = await runAddress(cs)
  report.addresses.push(result)
  progress.done++
  if (result.allOk) {
    if (!quiet) {
      console.log(`  ${pass('✓')} [${progress.done.toString().padStart(3)}/${cases.length}] ${cs.category.padEnd(8)} ${cs.address} ${dim(`${result.totalMs}ms`)}`)
    }
  } else {
    addressFailures++
    const failNames = result.checks.filter(x => !x.ok).map(x => x.name).join(', ')
    console.log(`  ${fail('✗')} [${progress.done.toString().padStart(3)}/${cases.length}] ${cs.category.padEnd(8)} ${cs.address}`)
    for (const ck of result.checks.filter(x => !x.ok)) {
      console.log(`      ${fail('•')} ${ck.name}: ${ck.error || `status ${ck.status}`}`)
    }
    void failNames
  }
})))
console.log()

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const durationMs = Date.now() - startedAt
const flatChecks = report.addresses.flatMap(a => a.checks)
const byCheck = groupBy(flatChecks, x => x.name)
const byCategory = groupBy(report.addresses, x => x.category)

console.log(c('bold', 'Summary'))
console.log(`  duration              ${humanMs(durationMs)}`)
console.log(`  pre-flight checks     ${tally(report.preflight.results)}`)
console.log(`  address-level checks  ${tally(flatChecks)}`)
console.log()
console.log(c('bold', '  By check'))
for (const [name, items] of Object.entries(byCheck)) {
  const okCount = items.filter(x => x.ok).length
  const total = items.length
  const okStrs = okCount === total ? pass(`${okCount}/${total}`) : fail(`${okCount}/${total}`)
  const okItems = items.filter(x => x.ok && Number.isFinite(x.elapsedMs)).map(x => x.elapsedMs).sort((a,b) => a-b)
  const p50 = okItems.length ? okItems[Math.floor(okItems.length * 0.5)] : null
  const p95 = okItems.length ? okItems[Math.floor(okItems.length * 0.95)] : null
  console.log(`    ${name.padEnd(36)} ${okStrs}${p50 != null ? dim(`  p50=${p50}ms  p95=${p95}ms`) : ''}`)
}
console.log()
console.log(c('bold', '  By category'))
for (const [cat, items] of Object.entries(byCategory)) {
  const okCount = items.filter(x => x.allOk).length
  const total = items.length
  const okStrs = okCount === total ? pass(`${okCount}/${total}`) : fail(`${okCount}/${total}`)
  console.log(`    ${cat.padEnd(12)} ${okStrs}`)
}
console.log()

const failed = preflightFailures + addressFailures
if (failed === 0) {
  console.log(pass(`✓ All checks passed (${flatChecks.length + report.preflight.results.length} total) in ${humanMs(durationMs)}`))
} else {
  console.log(fail(`✗ ${preflightFailures} pre-flight + ${addressFailures} address failure(s)`))
}

try {
  report.finishedAt = new Date().toISOString()
  report.durationMs = durationMs
  report.preflightFailures = preflightFailures
  report.addressFailures = addressFailures
  await fs.writeFile(jsonOut, JSON.stringify(report, null, 2))
  console.log(dim(`  full report → ${jsonOut}`))
} catch (err) {
  console.warn(warn(`  could not write ${jsonOut}: ${err.message}`))
}

process.exit(failed === 0 ? 0 : 1)

// ===========================================================================
// Address-level runner
// ===========================================================================

async function runAddress(cs) {
  const qs = new URLSearchParams({ address: cs.address })
  if (cs.layers) qs.set('layers', cs.layers)
  if (cs.base) qs.set('base', cs.base)
  const mapUrl = `${target}/map?${qs.toString()}`
  const ogUrl = `${target}/og.png?${qs.toString()}`

  const checks = []
  const startedAt = Date.now()

  // a) /map under a real browser UA → 200 HTML (SPA shell)
  checks.push(await timed('map (browser)', () => fetchAndCheck(mapUrl, {
    headers: { 'User-Agent': BROWSER_UA },
    expect: { contentType: /text\/html/i, minBytes: 500 },
  })))

  // b) /map under a crawler UA → rewritten OG HTML carrying the address
  checks.push(await timed('share (crawler)', async () => {
    const res = await fetchAndCheck(mapUrl, {
      headers: { 'User-Agent': CRAWLER_UA },
      expect: { contentType: /text\/html/i, minBytes: 500 },
      returnBody: true,
    })
    if (!res.ok) return res
    const body = res.body
    const ogTitle = match(body, /<meta\s+property="og:title"\s+content="([^"]+)"/i)
    const ogImage = match(body, /<meta\s+property="og:image"\s+content="([^"]+)"/i)
    const ogImageSecure = match(body, /<meta\s+property="og:image:secure_url"\s+content="([^"]+)"/i)
    const ogUrlTag = match(body, /<meta\s+property="og:url"\s+content="([^"]+)"/i)
    const problems = []
    // og:title should mention the street portion of the address (first comma chunk)
    const street = cs.address.split(',')[0].trim().toLowerCase()
    if (!ogTitle) problems.push('no og:title')
    else if (!ogTitle.toLowerCase().includes(street)) problems.push(`og:title missing street ("${ogTitle}")`)
    if (!ogImage) problems.push('no og:image')
    else if (!/^https:\/\//i.test(ogImage)) problems.push(`og:image not https ("${ogImage}")`)
    if (!ogImageSecure) problems.push('no og:image:secure_url')
    else if (!/^https:\/\//i.test(ogImageSecure)) problems.push(`og:image:secure_url not https ("${ogImageSecure}")`)
    if (!ogUrlTag) problems.push('no og:url')
    if (problems.length) return { ok: false, error: problems.join('; '), status: res.status, bytes: res.bytes }
    return { ok: true, status: res.status, bytes: res.bytes }
  }))

  // c) /og.png direct → image/png with sane size
  checks.push(await timed('og.png', () => fetchAndCheck(ogUrl, {
    expect: { contentType: /^image\/png/i, minBytes: 5_000, maxBytes: 300_000 },
  })))

  // d) Optional TomTom forward-geocode (US only)
  if (tomtomKey) {
    checks.push(await timed('tomtom geocode', async () => {
      const url = `https://api.tomtom.com/search/2/geocode/${encodeURIComponent(cs.address)}.json?key=${tomtomKey}&limit=1&countrySet=US`
      const res = await fetchSafe(url)
      if (!res.ok) return { ok: false, status: res.status, error: res.error || `status ${res.status}` }
      try {
        const data = JSON.parse(res.body)
        const hit = data?.results?.[0]
        if (!hit) return { ok: false, status: res.status, error: 'no US result' }
        if (hit?.address?.countryCode !== 'US') return { ok: false, status: res.status, error: `non-US: ${hit?.address?.countryCode}` }
        return { ok: true, status: res.status, bytes: res.body.length }
      } catch (err) {
        return { ok: false, status: res.status, error: `bad JSON: ${err.message}` }
      }
    }))
  }

  const totalMs = Date.now() - startedAt
  return {
    address: cs.address,
    category: cs.category,
    region: cs.region,
    note: cs.note,
    layers: cs.layers,
    base: cs.base,
    mapUrl,
    ogUrl,
    checks,
    allOk: checks.every(x => x.ok),
    totalMs,
  }
}

async function timed(name, fn) {
  const t0 = Date.now()
  try {
    const r = await fn()
    return { name, elapsedMs: Date.now() - t0, ...r }
  } catch (err) {
    return { name, elapsedMs: Date.now() - t0, ok: false, error: err.message }
  }
}

// ===========================================================================
// Pre-flight probes
// ===========================================================================

async function probePage(url, expectedCT) {
  const res = await fetchSafe(url)
  if (!res.ok) return { ok: false, error: res.error || `status ${res.status}` }
  if (!new RegExp(expectedCT, 'i').test(res.headers['content-type'] || '')) {
    return { ok: false, error: `unexpected content-type "${res.headers['content-type']}"` }
  }
  return { ok: true, detail: `${res.body.length}B ${res.elapsedMs}ms` }
}

async function probeImage(url, { min, max }) {
  const res = await fetchSafe(url)
  if (!res.ok) return { ok: false, error: res.error || `status ${res.status}` }
  if (!/^image\/png/i.test(res.headers['content-type'] || '')) {
    return { ok: false, error: `not image/png ("${res.headers['content-type']}")` }
  }
  const len = Number(res.headers['content-length'] || res.body.length)
  if (len < min || len > max) return { ok: false, error: `bytes=${len} outside [${min}..${max}]` }
  return { ok: true, detail: `${len}B ${res.elapsedMs}ms` }
}

async function probeSnapshot(url) {
  const res = await fetchSafe(url, { method: 'HEAD' })
  if (!res.ok) return { ok: false, error: res.error || `status ${res.status}` }
  const lm = res.headers['last-modified']
  if (!lm) return { ok: false, error: 'no Last-Modified header' }
  const ageHours = (Date.now() - new Date(lm).getTime()) / 3_600_000
  if (!Number.isFinite(ageHours)) return { ok: false, error: `bad Last-Modified: ${lm}` }
  if (ageHours > SNAPSHOT_STALE_HOURS) {
    return { ok: false, error: `stale ${ageHours.toFixed(1)}h (>${SNAPSHOT_STALE_HOURS}h)` }
  }
  const size = Number(res.headers['content-length'] || 0)
  return { ok: true, detail: `${(size/1024/1024).toFixed(1)}MB, age ${ageHours.toFixed(1)}h` }
}

// ===========================================================================
// HTTP plumbing
// ===========================================================================

async function fetchAndCheck(url, { headers = {}, expect = {}, returnBody = false } = {}) {
  const res = await fetchSafe(url, { headers })
  if (!res.ok) return { ok: false, error: res.error || `status ${res.status}`, status: res.status }
  if (expect.contentType && !expect.contentType.test(res.headers['content-type'] || '')) {
    return { ok: false, error: `content-type "${res.headers['content-type']}" did not match ${expect.contentType}`, status: res.status }
  }
  const len = Number(res.headers['content-length'] || res.body.length)
  if (expect.minBytes && len < expect.minBytes) {
    return { ok: false, error: `bytes=${len} < min ${expect.minBytes}`, status: res.status }
  }
  if (expect.maxBytes && len > expect.maxBytes) {
    return { ok: false, error: `bytes=${len} > max ${expect.maxBytes}`, status: res.status }
  }
  return { ok: true, status: res.status, bytes: len, ...(returnBody ? { body: res.body } : {}) }
}

async function fetchSafe(url, { method = 'GET', headers = {} } = {}) {
  const t0 = Date.now()
  const ctl = new AbortController()
  const to = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Accept': '*/*', 'User-Agent': BROWSER_UA, ...headers },
      redirect: 'follow',
      signal: ctl.signal,
    })
    const hdrs = Object.fromEntries(res.headers.entries())
    const body = method === 'HEAD' ? '' : await res.text()
    return {
      ok: res.ok,
      status: res.status,
      headers: hdrs,
      body,
      elapsedMs: Date.now() - t0,
      error: res.ok ? null : `HTTP ${res.status}`,
    }
  } catch (err) {
    return { ok: false, status: 0, headers: {}, body: '', elapsedMs: Date.now() - t0, error: err.name === 'AbortError' ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : err.message }
  } finally {
    clearTimeout(to)
  }
}

// ===========================================================================
// Utilities
// ===========================================================================

class Pool {
  constructor(n) { this.n = n; this.active = 0; this.q = [] }
  run(fn) {
    return new Promise((resolve, reject) => {
      const task = () => {
        this.active++
        Promise.resolve().then(fn).then(
          (v) => { this.active--; this.next(); resolve(v) },
          (e) => { this.active--; this.next(); reject(e) },
        )
      }
      if (this.active < this.n) task()
      else this.q.push(task)
    })
  }
  next() { if (this.q.length && this.active < this.n) this.q.shift()() }
}

function match(s, re) { const m = s.match(re); return m ? m[1] : null }
function groupBy(arr, fn) { const m = {}; for (const x of arr) { const k = fn(x); (m[k] = m[k] || []).push(x) } return m }
function tally(items) {
  const ok = items.filter(x => x.ok).length
  return ok === items.length ? pass(`${ok}/${items.length}`) : fail(`${ok}/${items.length}`)
}
function humanMs(ms) {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60), r = (s - m * 60).toFixed(0)
  return `${m}m${r}s`
}
function stripTrailingSlash(s) { return s.replace(/\/$/, '') }
function shortBlob(url) { return url.replace(/^https?:\/\/[^/]+\/snapshots\//, '') }

function parseArgs(argv) {
  const out = {}
  for (const a of argv) {
    if (a === '--help' || a === '-h') { out.help = true; continue }
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    if (m) out[m[1]] = m[2] === undefined ? true : m[2]
  }
  return out
}

function printHelp() {
  const txt = `
LandRecon smoke test
  node scripts/smoke-test.mjs [flags]

Flags:
  --target=<url>          Site under test (default $LR_SMOKE_TARGET or prod)
  --concurrency=<n>       Parallel address workers (default 8)
  --only=<filter>         urban | suburban | rural | <region name>
  --limit=<n>             Cap addresses tested (after filter)
  --skip-snapshots        Don't probe Azure blob inventory
  --skip-tomtom           Don't hit TomTom even if a key is set
  --json=<path>           Where to dump the full result report
  --no-color              Disable ANSI colors
  --quiet                 Summary only; suppress per-address chatter
  --help

Env:
  LR_SMOKE_TARGET         Default for --target
  LR_SMOKE_CONCURRENCY    Default for --concurrency
  VITE_TOMTOM_API_KEY     Enables TomTom geocode check (also: TOMTOM_API_KEY)
  NO_COLOR                Disables ANSI colors

Examples:
  node scripts/smoke-test.mjs
  node scripts/smoke-test.mjs --only=rural --limit=5
  node scripts/smoke-test.mjs --target=http://localhost:8080 --skip-snapshots
`
  console.log(txt.trim())
}
