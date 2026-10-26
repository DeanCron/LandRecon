import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from './store.mjs'
import { createApiServer, createRateLimiter, parsePrincipal, validateObject } from './api.mjs'

function principalHeaders(idp = 'google', id = 'abc123', authTyp = idp) {
  const principal = { auth_typ: authTyp, claims: [{ typ: 'name', val: 'Pat Example' }] }
  return {
    'x-ms-client-principal': Buffer.from(JSON.stringify(principal)).toString('base64'),
    'x-ms-client-principal-id': id,
    'x-ms-client-principal-idp': idp,
  }
}

function listen(opts) {
  const server = createApiServer(opts)
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, origin: `http://127.0.0.1:${server.address().port}`,
  })))
}

let on, off
before(async () => {
  on = await listen({ easyAuthEnabled: true, userLimit: 3, anonLimit: 2 })
  off = await listen({ easyAuthEnabled: false })
})
after(() => { on.server.close(); off.server.close() })

test('/api/me returns anonymous without principal headers', async () => {
  const res = await fetch(`${on.origin}/api/me`, { headers: { 'x-real-client-ip': '1.1.1.1' } })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { authenticated: false })
  assert.equal(res.headers.get('cache-control'), 'no-store')
})

test('/api/me returns a namespaced user for a valid principal', async () => {
  const res = await fetch(`${on.origin}/api/me`, { headers: principalHeaders() })
  assert.deepEqual(await res.json(), {
    authenticated: true, user: { id: 'google:abc123', provider: 'google', name: 'Pat Example' },
  })
})

test('principal headers are ignored when Easy Auth is not enabled', async () => {
  const res = await fetch(`${off.origin}/api/me`, { headers: principalHeaders() })
  assert.deepEqual(await res.json(), { authenticated: false })
})

test('malformed principals are treated as anonymous', () => {
  const ok = { easyAuthEnabled: true }
  const req = (headers) => ({ headers })
  const good = principalHeaders()
  assert.ok(parsePrincipal(req(good), ok))
  assert.equal(parsePrincipal(req({ ...good, 'x-ms-client-principal-idp': 'github' }), ok), null)
  assert.equal(parsePrincipal(req({ ...good, 'x-ms-client-principal-id': 'a b/../' }), ok), null)
  assert.equal(parsePrincipal(req({ ...good, 'x-ms-client-principal': '!!notbase64json' }), ok), null)
  assert.equal(parsePrincipal(req(principalHeaders('google', 'abc', 'aad')), ok), null)
  assert.equal(parsePrincipal(req({ ...good, 'x-ms-client-principal': Buffer.from('{}').toString('base64') }), ok), null)
  assert.equal(parsePrincipal(req({ 'x-ms-client-principal-id': 'abc' }), ok), null)
})

test('anonymous requests are rate limited per client IP', async () => {
  const headers = { 'x-real-client-ip': '9.9.9.9' }
  const statuses = []
  for (let i = 0; i < 3; i++) statuses.push((await fetch(`${on.origin}/api/me`, { headers })).status)
  assert.deepEqual(statuses, [200, 200, 429])
  const other = await fetch(`${on.origin}/api/me`, { headers: { 'x-real-client-ip': '8.8.8.8' } })
  assert.equal(other.status, 200)
  const limited = await fetch(`${on.origin}/api/me`, { headers })
  assert.ok(Number(limited.headers.get('retry-after')) >= 1)
})

test('authenticated requests are rate limited per user', async () => {
  const headers = principalHeaders('aad', 'user-limit')
  const statuses = []
  for (let i = 0; i < 4; i++) statuses.push((await fetch(`${on.origin}/api/me`, { headers })).status)
  assert.deepEqual(statuses, [200, 200, 200, 429])
  const other = await fetch(`${on.origin}/api/me`, { headers: principalHeaders('aad', 'someone-else') })
  assert.equal(other.status, 200)
})

test('method and path handling', async () => {
  const post = await fetch(`${on.origin}/api/me`, { method: 'POST', headers: { 'x-real-client-ip': '7.7.7.7' } })
  assert.equal(post.status, 405)
  const nf = await fetch(`${on.origin}/api/nope`, { headers: { 'x-real-client-ip': '7.7.7.8' } })
  assert.equal(nf.status, 404)
})

test('rate limiter window resets and caps tracked keys', () => {
  let t = 0
  const check = createRateLimiter({ windowMs: 1000, maxKeys: 2, now: () => t })
  assert.ok(check('a', 1).ok)
  assert.equal(check('a', 1).ok, false)
  t = 1000
  assert.ok(check('a', 1).ok)
  assert.ok(check('b', 1).ok)
  assert.equal(check('c', 1).ok, false)
})

test('validateObject enforces types, limits and unknown fields', () => {
  const schema = { label: { type: 'string', required: true, max: 5 }, lat: { type: 'number', min: -90, maxValue: 90 } }
  assert.deepEqual(validateObject(schema, { label: 'ok', lat: 10 }), [])
  assert.ok(validateObject(schema, {}).length)
  assert.ok(validateObject(schema, { label: 'toolong' }).length)
  assert.ok(validateObject(schema, { label: 'ok', lat: 91 }).length)
  assert.ok(validateObject(schema, { label: 'ok', extra: 1 }).length)
  assert.ok(validateObject(schema, []).length)
})

// ---- saved addresses ----

const addr = { label: 'Home', address: '1 Main St', lat: 30.1, lng: -97.2, snapshot: { grade: 'B' } }
const json = (headers, method, body) => ({
  method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
})

test('saved addresses: auth required', async () => {
  const s = await listen({ easyAuthEnabled: true, store: createMemoryStore() })
  try {
    const h = { 'x-real-client-ip': '5.5.5.5' }
    assert.equal((await fetch(`${s.origin}/api/me/addresses`, { headers: h })).status, 401)
    assert.equal((await fetch(`${s.origin}/api/me/addresses`, json(h, 'POST', addr))).status, 401)
  } finally { s.server.close() }
})

test('saved addresses: CRUD, validation, isolation and cap', async () => {
  const s = await listen({ easyAuthEnabled: true, store: createMemoryStore(), maxPerUser: 2, userLimit: 100 })
  try {
    const alice = principalHeaders('google', 'alice')
    const bob = principalHeaders('google', 'bob')
    const base = `${s.origin}/api/me/addresses`

    const created = await fetch(base, json(alice, 'POST', addr))
    assert.equal(created.status, 201)
    const rec = await created.json()
    assert.equal(rec.label, 'Home')

    const list = await (await fetch(base, { headers: alice })).json()
    assert.equal(list.addresses.length, 1)
    assert.equal((await (await fetch(base, { headers: bob })).json()).addresses.length, 0)
    assert.equal((await fetch(`${base}/${rec.id}`, { headers: bob })).status, 404)

    const put = await fetch(`${base}/${rec.id}`, json(alice, 'PUT', { ...addr, label: 'Cabin' }))
    assert.equal((await put.json()).label, 'Cabin')
    assert.equal((await fetch(`${base}/${rec.id}`, json(bob, 'PUT', addr))).status, 404)
    assert.equal((await fetch(`${base}/${rec.id}`, json(bob, 'DELETE'))).status, 404)

    assert.equal((await fetch(base, json(alice, 'POST', { ...addr, lat: 100 }))).status, 400)
    assert.equal((await fetch(base, json(alice, 'POST', { ...addr, userId: 'x' }))).status, 400)
    assert.equal((await fetch(base, json(alice, 'POST', { label: 'only' }))).status, 400)
    assert.equal((await fetch(base, { method: 'POST', headers: { ...alice, 'content-type': 'text/plain' }, body: 'x' })).status, 415)
    assert.equal((await fetch(base, json(alice, 'POST', { ...addr, snapshot: { blob: 'x'.repeat(40_000) } }))).status, 400)
    assert.equal((await fetch(`${base}/not-a-uuid`, { headers: alice })).status, 404)

    assert.equal((await fetch(base, json(alice, 'POST', addr))).status, 201)
    const over = await fetch(base, json(alice, 'POST', addr))
    assert.equal(over.status, 409)
    assert.equal((await over.json()).limit, 2)

    assert.equal((await fetch(`${base}/${rec.id}`, json(alice, 'DELETE'))).status, 204)
    assert.equal((await fetch(`${base}/${rec.id}`, { headers: alice })).status, 404)
    assert.equal((await fetch(base, json(alice, 'DELETE'))).status, 405)
  } finally { s.server.close() }
})
