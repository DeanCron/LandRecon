// Authenticated API sidecar (listens on 127.0.0.1:3003, proxied by nginx at
// /api/me and /api/me/addresses).
//
// Identity comes from Azure Container Apps built-in auth ("Easy Auth") with
// AllowAnonymous: signed-in requests carry X-MS-CLIENT-PRINCIPAL* headers,
// anonymous ones simply lack them. Those headers are only trustworthy when
// Easy Auth fronts the app, so they are honoured ONLY when EASY_AUTH_ENABLED=1
// (set where auth is configured). Otherwise every request is anonymous and a
// spoofed header is ignored.
//
// This file provides the shared plumbing for the saved-addresses work
// (principal validation, per-user rate limits, JSON body + schema validation).
// It never logs addresses, ids or emails.

import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { StoreError, createStoreFromEnv } from './store.mjs'

const PORT = Number(process.env.API_PORT || 3003)
const MAX_BODY = 64 * 1024
const PROVIDERS = new Set(['google', 'aad'])
const ID_RE = /^[A-Za-z0-9._:@\-]{1,128}$/

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)

// ---- principal -------------------------------------------------------------

function header(req, name) {
  const v = req.headers[name]
  return typeof v === 'string' ? v : ''
}

// Returns { id, provider, name } or null (anonymous / invalid). Never throws.
export function parsePrincipal(req, { easyAuthEnabled }) {
  if (!easyAuthEnabled) return null
  const idp = header(req, 'x-ms-client-principal-idp').toLowerCase()
  const rawId = header(req, 'x-ms-client-principal-id')
  const encoded = header(req, 'x-ms-client-principal')
  if (!PROVIDERS.has(idp) || !ID_RE.test(rawId) || !encoded || encoded.length > 16 * 1024) return null

  let principal
  try {
    principal = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  } catch {
    return null
  }
  if (!principal || typeof principal !== 'object' || typeof principal.auth_typ !== 'string') return null
  if (principal.auth_typ.toLowerCase() !== idp) return null

  const claims = Array.isArray(principal.claims) ? principal.claims : []
  const nameClaim = claims.find((c) => c && typeof c.val === 'string'
    && (c.typ === 'name' || c.typ === 'preferred_username' || /\/emailaddress$/.test(String(c.typ))))
  const display = (nameClaim?.val || header(req, 'x-ms-client-principal-name')).slice(0, 200)

  // Ids are unique per provider only, so namespace the user key.
  return { id: `${idp}:${rawId}`, provider: idp, name: display }
}

// ---- rate limiting ---------------------------------------------------------

// Fixed-window counter keyed per user (or per client IP for anonymous).
export function createRateLimiter({ windowMs = 60_000, maxKeys = 10_000, now = () => Date.now() } = {}) {
  const hits = new Map()
  return function check(key, limit) {
    const t = now()
    let e = hits.get(key)
    if (!e || t - e.start >= windowMs) {
      if (!e && hits.size >= maxKeys) {
        for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k)
        if (hits.size >= maxKeys) return { ok: false, retryAfter: Math.ceil(windowMs / 1000) }
      }
      e = { start: t, count: 0 }
      hits.set(key, e)
    }
    e.count += 1
    if (e.count > limit) return { ok: false, retryAfter: Math.max(1, Math.ceil((e.start + windowMs - t) / 1000)) }
    return { ok: true }
  }
}

// ---- body + schema validation ----------------------------------------------

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export async function readJsonBody(req, max = MAX_BODY) {
  if (!/^application\/json\b/i.test(header(req, 'content-type'))) throw new HttpError(415, 'expected application/json')
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > max) throw new HttpError(413, 'payload too large')
    chunks.push(c)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid JSON')
  }
}

// Minimal schema check. Field spec: { type: 'string'|'number'|'boolean'|'object',
// required?, max? (string length), min?/maxValue? (number range) }. Unknown fields are rejected.
export function validateObject(schema, value) {
  const errors = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['body must be an object']
  for (const key of Object.keys(value)) if (!(key in schema)) errors.push(`unknown field: ${key}`)
  for (const [key, spec] of Object.entries(schema)) {
    const v = value[key]
    if (v === undefined || v === null) {
      if (spec.required) errors.push(`missing field: ${key}`)
      continue
    }
    if (spec.type === 'object') {
      if (typeof v !== 'object' || Array.isArray(v)) errors.push(`${key} must be an object`)
      else if (JSON.stringify(v).length > (spec.maxBytes ?? 32 * 1024)) errors.push(`${key} too large`)
    } else if (typeof v !== spec.type) {
      errors.push(`${key} must be a ${spec.type}`)
    } else if (spec.type === 'string' && v.length > (spec.max ?? 500)) {
      errors.push(`${key} too long`)
    } else if (spec.type === 'number' && (!Number.isFinite(v) || v < (spec.min ?? -Infinity) || v > (spec.maxValue ?? Infinity))) {
      errors.push(`${key} out of range`)
    }
  }
  return errors
}

// ---- saved addresses -------------------------------------------------------

const ADDRESS_SCHEMA = {
  label: { type: 'string', required: true, max: 100 },
  address: { type: 'string', required: true, max: 300 },
  lat: { type: 'number', required: true, min: -90, maxValue: 90 },
  lng: { type: 'number', required: true, min: -180, maxValue: 180 },
  gps_accuracy_m: { type: 'number', min: 0, maxValue: 100_000 },
  snapshot: { type: 'object', maxBytes: 30_000 },
}
const ADDRESS_PATH = /^\/api\/me\/addresses(?:\/([0-9a-f-]{36}))?\/?$/i

async function handleAddresses(req, res, { principal, store, maxPerUser, id }) {
  if (!principal) return send(res, 401, { error: 'sign in required' })
  const userId = principal.id

  if (!id) {
    if (req.method === 'GET') return send(res, 200, { addresses: await store.list(userId) })
    if (req.method === 'POST') {
      const body = await readJsonBody(req)
      const errors = validateObject(ADDRESS_SCHEMA, body)
      if (errors.length) return send(res, 400, { error: 'invalid body', details: errors })
      try {
        return send(res, 201, await store.create(userId, body, { maxPerUser }))
      } catch (err) {
        if (err instanceof StoreError && err.code === 'limit') return send(res, 409, { error: err.message, limit: maxPerUser })
        throw err
      }
    }
    return send(res, 405, { error: 'method not allowed' }, { Allow: 'GET, POST' })
  }

  if (req.method === 'GET') {
    const rec = await store.get(userId, id)
    return rec ? send(res, 200, rec) : send(res, 404, { error: 'not found' })
  }
  if (req.method === 'PUT') {
    const body = await readJsonBody(req)
    const errors = validateObject(ADDRESS_SCHEMA, body)
    if (errors.length) return send(res, 400, { error: 'invalid body', details: errors })
    const rec = await store.update(userId, id, body)
    return rec ? send(res, 200, rec) : send(res, 404, { error: 'not found' })
  }
  if (req.method === 'DELETE') {
    return (await store.remove(userId, id)) ? send(res, 204, null) : send(res, 404, { error: 'not found' })
  }
  return send(res, 405, { error: 'method not allowed' }, { Allow: 'GET, PUT, DELETE' })
}

// ---- server ----------------------------------------------------------------

function send(res, status, payload, extra = {}) {
  if (status === 204) {
    res.writeHead(204, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra })
    return res.end()
  }
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  })
  res.end(body)
}

export function createApiServer(opts = {}) {
  const easyAuthEnabled = opts.easyAuthEnabled ?? process.env.EASY_AUTH_ENABLED === '1'
  const userLimit = opts.userLimit ?? num(process.env.API_USER_RATE_PER_MIN, 60)
  const anonLimit = opts.anonLimit ?? num(process.env.API_ANON_RATE_PER_MIN, 20)
  const limiter = opts.limiter ?? createRateLimiter()
  const maxPerUser = opts.maxPerUser ?? num(process.env.SAVED_ADDRESS_MAX, 50)
  // Created on first use so /api/me never depends on storage being reachable.
  let storePromise = opts.store ? Promise.resolve(opts.store) : null
  const getStore = () => {
    storePromise ??= createStoreFromEnv().catch((err) => {
      storePromise = null
      throw err
    })
    return storePromise
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      const principal = parsePrincipal(req, { easyAuthEnabled })
      // nginx sets this from its non-spoofable $real_client_ip.
      const ip = header(req, 'x-real-client-ip') || req.socket.remoteAddress || 'unknown'
      const rl = principal ? limiter(`u:${principal.id}`, userLimit) : limiter(`ip:${ip}`, anonLimit)
      if (!rl.ok) return send(res, 429, { error: 'rate limited' }, { 'Retry-After': String(rl.retryAfter) })

      if (url.pathname === '/api/me') {
        if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' }, { Allow: 'GET' })
        return send(res, 200, principal
          ? { authenticated: true, user: { id: principal.id, provider: principal.provider, name: principal.name } }
          : { authenticated: false })
      }
      const m = ADDRESS_PATH.exec(url.pathname)
      if (m) {
        let store = null
        if (principal) {
          try {
            store = await getStore()
          } catch (err) {
            if (!(err instanceof StoreError && err.code === 'unavailable')) throw err
            console.error('[api] storage unavailable:', err.message)
            return send(res, 503, { error: 'storage unavailable' })
          }
        }
        return await handleAddresses(req, res, { principal, store, maxPerUser, id: m[1] })
      }
      return send(res, 404, { error: 'not found' })
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message })
      console.error('[api] unhandled error:', err?.code || err?.statusCode || err?.message)
      return send(res, 500, { error: 'internal error' })
    }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.env.EASY_AUTH_ENABLED !== '1') {
    console.warn('[api] EASY_AUTH_ENABLED is not 1: all requests are treated as anonymous')
  }
  createApiServer().listen(PORT, '127.0.0.1', () => console.log(`[api] listening on 127.0.0.1:${PORT}`))
}
