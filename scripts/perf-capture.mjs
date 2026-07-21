// scripts/perf-capture.mjs
//
// Automated performance-capture harness for LandRecon.
//
// Drives a real Chromium session through the interactions that exercise the
// seven shipped performance optimizations, records a Chrome DevTools-loadable
// trace over CDP, and writes it gzipped so it can be dropped straight into the
// DevTools "Performance" panel (File → Load profile) or compared against a
// baseline build.
//
// Why this exists: hand-captured traces kept missing the optimized code paths
// (no Overpass/Superfund worker ever spun up, no heavy panning), so the wins
// were invisible. This script deterministically toggles the Data Center +
// Superfund overlays, pans repeatedly, and runs several analyses so that
// #2 (Places coalescing), #3 (Superfund worker), #4 (analysis-cache churn),
// #6 (Data Center in-place pan) and #7 (snapshot cooldown) all actually fire.
//
// Usage:
//   node scripts/perf-capture.mjs                       # live site, label "after"
//   node scripts/perf-capture.mjs --label after
//   node scripts/perf-capture.mjs --url http://localhost:4173 --label before
//   node scripts/perf-capture.mjs --cpu 4 --pans 10 --headed
//
// Getting a real before/after pair:
//   1) git checkout ad5f3a7~1   (the commit *before* the first optimization)
//      npm ci && npm run build && npm run preview   # serves http://localhost:4173
//      node scripts/perf-capture.mjs --url http://localhost:4173 --label before
//   2) git checkout main
//      npm run build && npm run preview
//      node scripts/perf-capture.mjs --url http://localhost:4173 --label after
//   Then load both Trace-*.json.gz files into DevTools and compare, or run them
//   through the same offline analysis you use on ad-hoc traces.
//
// Flags:
//   --url <url>          target origin (default https://www.landrecon.com)
//   --label <name>       filename label, e.g. before|after (default "after")
//   --cpu <n>            CDP CPU throttling multiplier, 1 = off (default 4)
//   --pans <n>           pan drags per overlay (default 8)
//   --addresses "a|b|c"  pipe-separated addresses to analyze
//   --out <dir>          output directory (default ~/Downloads)
//   --headed / --headless   run with a visible window (default: headed)
//   --include-load       start tracing before the first analysis (captures the
//                        cold-start compile/GC too; off by default so the trace
//                        focuses on steady-state interaction)

import { chromium } from 'playwright'
import { gzipSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ────────────────────────────── config ──────────────────────────────
const args = parseArgs(process.argv.slice(2))
const BASE_URL = args.url || process.env.PERF_URL || 'https://www.landrecon.com'
const LABEL = args.label || 'after'
const HEADED = args.headless ? false : true
const CPU_THROTTLE = Number(args.cpu ?? 4)
const PAN_STEPS = Number(args.pans ?? 8)
const ADDRESSES = args.addresses
  ? String(args.addresses).split('|').map((s) => s.trim()).filter(Boolean)
  : [
      '1600 Pennsylvania Ave NW, Washington, DC',
      '350 Fifth Ave, New York, NY',
      '233 S Wacker Dr, Chicago, IL',
    ]
const OUT_DIR = args.out || join(homedir(), 'Downloads')
const INCLUDE_LOAD = Boolean(args['include-load'])

// DevTools-equivalent category set. The disabled-by-default cpu_profiler
// category is what makes the flame chart (bottom-up self time) available.
const CATEGORIES = [
  '-*',
  'toplevel',
  'blink.console',
  'blink.user_timing',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack',
  'v8',
  'v8.execute',
  'disabled-by-default-v8.cpu_profiler',
  'loading',
  'latencyInfo',
  'benchmark',
]

const log = (...a) => console.log('[perf-capture]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ────────────────────────────── main ──────────────────────────────
async function main() {
  log(`target=${BASE_URL} label=${LABEL} cpu=${CPU_THROTTLE}x pans=${PAN_STEPS} headed=${HEADED}`)
  const browser = await chromium.launch({ headless: !HEADED })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  const client = await context.newCDPSession(page)

  // Suppress the first-run guided tour — its full-screen overlay intercepts
  // clicks. Set before any app code runs so the tour never activates.
  await context.addInitScript(() => {
    try {
      localStorage.setItem('lr_tour_done', '1')
    } catch {
      /* ignore */
    }
  })

  page.on('console', (m) => {
    const t = m.text()
    if (t.includes('worker') || t.includes('LR:')) log('page:', t)
  })

  const applyThrottle = async () => {
    if (CPU_THROTTLE > 1) {
      await client.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE })
      log(`CPU throttled ${CPU_THROTTLE}x`)
    }
  }

  log('Navigating…')
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })

  const traceEvents = []
  client.on('Tracing.dataCollected', (d) => {
    for (const e of d.value) traceEvents.push(e)
  })
  const tracingComplete = () =>
    new Promise((res) => client.once('Tracing.tracingComplete', res))

  async function startTrace() {
    await client.send('Tracing.start', {
      traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: CATEGORIES },
    })
    log('Tracing started')
  }

  if (INCLUDE_LOAD) {
    await applyThrottle()
    await startTrace()
  }

  // ── Warm-up: first analysis (loads the map, reaches status "ready") ──
  await enterAddress(page, ADDRESSES[0])
  await waitForReady(page)
  log('Map ready after first analysis')

  if (!INCLUDE_LOAD) {
    await applyThrottle()
    await startTrace()
  }

  // ── #6 Data Center in-place pan + #7 snapshot cooldown ──
  await openLayerPanel(page)
  await toggleLayer(page, 'Infrastructure', 'Data Centers', true)
  log('Data Centers on — panning')
  await panMap(page, PAN_STEPS)

  // ── #3 Superfund worker offload (spins up the Overpass worker) ──
  await toggleLayer(page, 'Contamination', 'Superfund Sites', true)
  log('Superfund on — panning')
  await panMap(page, PAN_STEPS)

  // ── #2 Places coalescing + #4 analysis-cache churn: more analyses ──
  for (const addr of ADDRESSES.slice(1)) {
    await enterAddress(page, addr)
    await waitForReady(page)
    await panMap(page, 3)
  }
  // Re-analyze the first address to exercise the cache merge / superseded path.
  await enterAddress(page, ADDRESSES[0])
  await waitForReady(page)

  // ── stop trace ──
  const done = tracingComplete()
  await client.send('Tracing.end')
  await done
  log(`Collected ${traceEvents.length} trace events`)

  const payload = {
    metadata: {
      source: 'LandRecon scripts/perf-capture.mjs',
      label: LABEL,
      url: BASE_URL,
      cpuThrottle: CPU_THROTTLE,
      panSteps: PAN_STEPS,
      includeLoad: INCLUDE_LOAD,
      addresses: ADDRESSES,
      capturedAt: new Date().toISOString(),
    },
    traceEvents,
  }
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
  const file = join(OUT_DIR, `Trace-${LABEL}-${ts}.json.gz`)
  writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(payload))))
  log(`Wrote ${file} (${(traceEvents.length).toLocaleString()} events)`) 

  await browser.close()
  log('Done. Load the .json.gz into DevTools → Performance → "Load profile".')
}

// ────────────────────────────── interactions ──────────────────────────────

// The HomePage and the MapPage header enter addresses differently:
//   • HomePage: type + submit the "Explore" form → navigate('/map').
//   • MapPage:  click the address chip to reveal the header input, type,
//     then pick a suggestion → submitAddressChange() re-analyzes in place.
async function enterAddress(page, text) {
  const exploreBtn = page.locator('button.home-button')
  if (await exploreBtn.isVisible().catch(() => false)) {
    const input = page.getByPlaceholder('Street address, city, state').first()
    await input.click()
    await input.fill('')
    await input.type(text, { delay: 50 })
    await sleep(700) // let the map chunk prefetch kick off
    await input.press('Enter') // submits the "Explore" form → navigate('/map')
    log(`Home → "${text}"`)
    return
  }
  // MapPage: reveal the editable input if it's collapsed to a chip.
  const chip = page.locator('button.header-address')
  if (await chip.isVisible().catch(() => false)) {
    await chip.click()
    await sleep(200)
  }
  const input = page.locator('input.header-address-input')
  await input.waitFor({ state: 'visible', timeout: 20000 })
  await input.click()
  await input.fill('')
  await input.type(text, { delay: 60 })
  const suggestion = page.locator('ul.header-address-suggestions li.header-address-suggestion').first()
  try {
    await suggestion.waitFor({ state: 'visible', timeout: 15000 })
    await suggestion.click()
  } catch {
    log(`No suggestion for "${text}", pressing Enter`)
    await input.press('Enter')
  }
  log(`Map → "${text}"`)
}

// status !== 'ready' disables the layer checkboxes; wait until one is enabled.
async function waitForReady(page) {
  await page.waitForURL(/\/map/i, { timeout: 30000 }).catch(() => {})
  await page.locator('.leaflet-container').first().waitFor({ state: 'visible', timeout: 30000 })
  await page
    .locator('label.layer-toggle input:not([disabled])')
    .first()
    .waitFor({ state: 'attached', timeout: 45000 })
    .catch(() => log('Ready-wait: no enabled toggle yet, continuing'))
  await sleep(1500) // let the analysis overlay settle
}

async function openLayerPanel(page) {
  await dismissTour(page)
  const btn = page.locator('button.layer-toggle-btn')
  if (await btn.isVisible().catch(() => false)) {
    await btn.click()
    await sleep(400)
    log('Opened layer panel')
  }
}

// Safety net in case the init-script suppression missed (e.g. a differently
// keyed tour): click "Skip tour" if the overlay is up.
async function dismissTour(page) {
  const skip = page.locator('button.tour-skip')
  if (await skip.isVisible().catch(() => false)) {
    await skip.click().catch(() => {})
    await sleep(300)
    log('Dismissed guided tour')
  }
}

async function toggleLayer(page, groupText, labelText, on) {
  // Expand the collapsible group if needed.
  const group = page.locator('details.layer-group', {
    has: page.locator('summary', { hasText: groupText }),
  })
  if ((await group.count()) > 0) {
    const isOpen = await group.first().evaluate((el) => el.hasAttribute('open')).catch(() => true)
    if (!isOpen) {
      await group.first().locator('summary').click()
      await sleep(250)
    }
  }
  const toggle = page.locator('label.layer-toggle', { hasText: labelText }).first()
  await toggle.waitFor({ state: 'visible', timeout: 15000 })
  const box = toggle.locator('input[type="checkbox"]')
  // Wait until it's enabled (status ready).
  for (let i = 0; i < 30; i++) {
    if (await box.isEnabled().catch(() => false)) break
    await sleep(500)
  }
  const checked = await box.isChecked().catch(() => false)
  if (checked !== on) {
    await toggle.click()
    await sleep(800)
    log(`${labelText} -> ${on ? 'on' : 'off'}`)
  }
}

async function panMap(page, steps) {
  const map = page.locator('.leaflet-container').first()
  await map.waitFor({ state: 'visible', timeout: 15000 })
  const box = await map.boundingBox()
  if (!box) {
    log('panMap: no map bounding box')
    return
  }
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  // Directions chosen so the viewport keeps entering *new* territory, which is
  // what triggers incremental overlay adds + fresh snapshot/worker fetches.
  const dirs = [
    [-260, 0], [-260, 0], [0, -220], [220, 0],
    [220, 0], [0, 220], [-200, -160], [200, 160],
  ]
  for (let i = 0; i < steps; i++) {
    const [dx, dy] = dirs[i % dirs.length]
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + dx / 2, cy + dy / 2, { steps: 6 })
    await page.mouse.move(cx + dx, cy + dy, { steps: 6 })
    await page.mouse.up()
    // moveend is debounced in the app; give overlays time to fetch/render.
    await sleep(900)
  }
}

// ────────────────────────────── util ──────────────────────────────
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        out[key] = true
      } else {
        out[key] = next
        i++
      }
    }
  }
  return out
}

main().catch((err) => {
  console.error('[perf-capture] FAILED:', err)
  process.exit(1)
})
