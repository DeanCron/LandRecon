import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const base = process.env.LOCATION_TEST_URL || 'http://127.0.0.1:5179'
const browser = await chromium.launch({ headless: true })
const fix = { latitude: 47.610123456, longitude: -122.330123456, accuracy: 18 }
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, geolocation: fix, permissions: ['geolocation'] })
  await context.addInitScript(() => { localStorage.setItem('lr_tour_done', '1') })
  const requests = []
  const errors = []
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.includes('/reverseGeocode/')) {
      requests.push(url.href)
      return route.fulfill({ json: { addresses: [{ position: '48,-123', address: { countryCode: 'US', freeformAddress: 'Nearby fixture street' } }] } })
    }
    if (url.pathname.includes('/geocode/')) {
      requests.push(url.href)
      return route.fulfill({ json: { results: [{ position: { lat: 40, lon: -75 } }] } })
    }
    if (url.origin === base && !/^\/(api|overpass|overpass2|data)\//.test(url.pathname)) return route.continue()
    requests.push(url.href)
    if (url.pathname.endsWith('.pmtiles') || url.pathname.includes('/tile/')) return route.abort()
    return route.fulfill({ json: { elements: [], features: [], results: [] } })
  })
  const page = await context.newPage()
  const artifacts = process.env.LOCATION_TEST_ARTIFACTS
  if (artifacts) await mkdir(artifacts, { recursive: true })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(base)
  const homeLocate = page.getByRole('button', { name: 'Score my location', exact: true })
  const box = await homeLocate.boundingBox()
  assert.ok(box && box.width >= 44 && box.height >= 44, 'Home location action must be at least 44x44')
  await homeLocate.click()
  await page.waitForURL('**/map')
  await page.locator('.analysis-location-context').waitFor({ state: 'visible', timeout: 60000 })
  assert.match(await page.locator('.analysis-location-context').innerText(), /accuracy radius 18 m/)
  for (const key of ['address', 'lat', 'lng', 'accuracy', 'capturedAt', 'locationLabel']) {
    assert.equal(new URL(page.url()).searchParams.has(key), false)
  }
  assert.equal(requests.filter((url) => url.includes('/geocode/')).length, 0, 'GPS must never forward-geocode the label')
  await page.waitForFunction(() => !document.querySelector('[aria-label="Save for comparison"]')?.disabled, null, { timeout: 90000 })
  assert.ok(requests.some((url) => {
    const text = decodeURIComponent(url)
    return !text.includes('/reverseGeocode/') && text.includes(String(fix.latitude)) && text.includes(String(fix.longitude))
  }), 'Analysis providers must receive the original GPS coordinates')

  for (const [width, height] of [[320, 568], [375, 667], [390, 844], [844, 390], [1280, 800]]) {
    await page.setViewportSize({ width, height })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No page overflow at ${width}px`)
    for (const selector of ['.map-score-location', '.analysis-action-btn', '.analysis-close']) {
      for (const action of await page.locator(selector).all()) {
        if (!await action.isVisible()) continue
        const rect = await action.boundingBox()
        assert.ok(rect && rect.width >= 44 && rect.height >= 44, `${selector} must be at least 44x44 at ${width}px`)
      }
    }
    const last = page.locator('.analysis-content').locator('button').last()
    await last.scrollIntoViewIfNeeded()
    assert.ok(await last.isVisible(), `Report's last action reachable at ${width}px`)
    if (artifacts && (width === 390 || width === 1280)) {
      await page.locator('.analysis-panel').evaluate((panel) => { panel.scrollTop = 0 })
      await page.screenshot({ path: join(artifacts, `gps-report-${width}.png`) })
    }
  }

  await page.setViewportSize({ width: 390, height: 844 })
  const save = page.getByRole('button', { name: 'Save for comparison' })
  await save.waitFor({ state: 'visible' })
  await page.waitForFunction(() => !document.querySelector('[aria-label="Save for comparison"]')?.disabled, null, { timeout: 90000 })
  await save.click()
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('lr_saved_analyses'))[0])
  assert.equal(saved.gps.lat, fix.latitude)
  assert.equal(saved.gps.lng, fix.longitude)

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download PDF report' }).click()
  const download = await downloadPromise
  assert.match(download.suggestedFilename(), /^LandRecon-.*\.pdf$/)
  const chunks = []
  for await (const chunk of await download.createReadStream()) chunks.push(chunk)
  assert.equal(Buffer.concat(chunks).subarray(0, 5).toString(), '%PDF-')

  await page.getByRole('button', { name: 'Share this view as a short link' }).click()
  await page.getByText('This link reveals the analyzed GPS location', { exact: false }).waitFor()
  const shareLink = await page.locator('.share-modal-input').inputValue()
  assert.equal(new URL(shareLink).searchParams.get('lat'), String(fix.latitude))
  await page.goto(shareLink)
  await page.locator('.analysis-location-context').waitFor({ state: 'visible' })
  for (const key of ['address', 'lat', 'lng', 'accuracy', 'capturedAt', 'locationLabel']) {
    assert.equal(new URL(page.url()).searchParams.has(key), false)
  }

  await page.getByRole('button', { name: 'Close analysis' }).click()
  await page.getByRole('button', { name: 'Home', exact: true }).click()
  for (const width of [320, 375, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 })
    for (const selector of ['.home-saved-go', '.home-saved-item .home-recent-remove']) {
      const rect = await page.locator(selector).first().boundingBox()
      assert.ok(rect && rect.width >= 44 && rect.height >= 44, `${selector} must be at least 44x44 at ${width}px`)
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      JSON.stringify(await page.evaluate(() => ({
        width: innerWidth, scroll: document.documentElement.scrollWidth,
        overflow: [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > innerWidth)
          .map((el) => ({ class: el.className, right: el.getBoundingClientRect().right })).slice(0, 12),
      }))))
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.home-saved-go').first().click()
  await page.locator('.analysis-location-context').waitFor({ state: 'visible' })
  assert.equal(await page.evaluate(() => history.state.usr.landReconGps.lat), fix.latitude)

  await page.getByRole('button', { name: 'Close analysis' }).click()
  await context.setGeolocation({ latitude: 47.62, longitude: -122.34, accuracy: 500 })
  await page.getByRole('button', { name: 'Score my location', exact: true }).click()
  await page.locator('.analysis-location-context').filter({ hasText: 'accuracy radius 500 m' }).waitFor()
  assert.equal(await page.evaluate(() => history.state.usr.landReconGps.lat), 47.62)
  await page.getByRole('button', { name: 'Close analysis' }).click()
  await page.getByRole('button', { name: 'Home', exact: true }).click()
  await context.clearPermissions()
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition: (_success, failure) => failure({ code: 1 }),
    } })
  })
  await page.getByRole('button', { name: 'Score my location', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'blocked' }).waitFor()
  assert.deepEqual(errors, [], 'No uncaught browser errors')
  console.log('GPS report browser checks passed: exact coordinates, phone layouts, saved replay, PDF download, sharing, rescoring, and denial.')
} finally {
  await browser.close()
}
