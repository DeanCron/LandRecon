import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { resolve } from 'node:path'

function get(path, headers) {
  return new Promise((done, reject) => {
    const req = request(`${origin}${path}`, { headers }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => done(body))
    })
    req.on('error', reject)
    req.end()
  })
}

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

test('spoofed forwarded host is never echoed into share metadata', async () => {
  const path = '/share?address=123%20Main%20St%20Seattle%20WA'
  const spoofed = await get(path, { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' })
  assert.doesNotMatch(spoofed, /evil\.example/)
  assert.match(spoofed, /https:\/\/landrecon\.com\//)
  const trusted = await get(path, { 'x-forwarded-host': 'www.landrecon.com' })
  assert.match(trusted, /www\.landrecon\.com/)
})
