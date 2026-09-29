import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'

let child
let origin
before(async () => {
  const reservation = createServer()
  await new Promise((done) => reservation.listen(0, '127.0.0.1', done))
  const port = reservation.address().port
  await new Promise((done) => reservation.close(done))
  origin = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['server/og.mjs'], {
    env: { ...process.env, OG_PORT: String(port), OG_INDEX_HTML: resolve('index.html') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('OG sidecar did not start')), 15000)
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`OG sidecar exited: ${code}`)) })
    child.stdout.on('data', (data) => {
      if (data.toString().includes('[og] listening')) { clearTimeout(timeout); done() }
    })
  })
})
after(() => child?.kill())

test('GPS canonical links retain exact coordinates and use approximate-location context', async () => {
  const params = 'lat=47.610123456&lng=-122.330123456&accuracy=18&capturedAt=1790680000000&locationLabel=Nearby&layers=noise'
  const html = await (await fetch(`${origin}/share?${params}`)).text()
  assert.match(html, /Approximate GPS location/)
  assert.match(html, /lat=47\.610123456/)
  assert.match(html, /lng=-122\.330123456/)
  assert.match(html, /accuracy=18/)
  const second = await (await fetch(`${origin}/share?${params.replace('47.610123456', '48.610123456')}`)).text()
  assert.match(second, /lat=48\.610123456/)
  assert.notEqual(html, second)
})

test('invalid GPS parameters never become an address report', async () => {
  const html = await (await fetch(`${origin}/share?address=MisleadingStreet&lat=999&lng=-122`)).text()
  assert.doesNotMatch(html, /MisleadingStreet/)
  assert.doesNotMatch(html, /lat=999/)
})
