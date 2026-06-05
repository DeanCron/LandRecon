// Tiny zero-dependency JSON store for Dev Todos.
//
// Runs alongside nginx in the runtime container. Persists a single JSON
// document at DATA_PATH (default /var/lib/landrecon/dev-todos.json) and
// exposes GET/PUT through nginx at /api/dev-todos. The default location
// is on the container's local disk, so a container restart resets it
// unless that path is backed by a persistent volume (e.g. Azure Files).
//
// The file shape is { items: DevTodo[], checks: Record<string, boolean> }.
// We only validate the outermost types so old payloads keep working.
//
// AUTH: the store is gated by the DEV_TODOS_TOKEN env var.
//   - If DEV_TODOS_TOKEN is unset/empty the store is DISABLED: GET and PUT
//     both return 503. This fails closed so an un-configured deploy never
//     leaks the internal notes and can't be wiped by an anonymous PUT.
//   - If set, every request must carry `Authorization: Bearer <token>`
//     (compared in constant time). Missing/wrong token -> 401.
// The token is a developer secret entered in the browser (localStorage),
// so it is never shipped in the public JS bundle.

import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { timingSafeEqual } from 'node:crypto'

const PORT = Number(process.env.DEV_TODOS_PORT || 3001)
const DATA_PATH = process.env.DEV_TODOS_DATA_PATH || '/var/lib/landrecon/dev-todos.json'
const MAX_BODY = 256 * 1024
const TOKEN = process.env.DEV_TODOS_TOKEN || ''

const EMPTY = { items: [], checks: {} }

// Constant-time bearer-token check. Returns true only when TOKEN is
// configured AND the request presents a matching `Authorization: Bearer`.
function isAuthorized(req) {
  if (!TOKEN) return false
  const header = req.headers['authorization'] || ''
  const m = /^Bearer\s+(.+)$/i.exec(header)
  if (!m) return false
  const provided = Buffer.from(m[1])
  const expected = Buffer.from(TOKEN)
  // timingSafeEqual throws on length mismatch, so guard length first.
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

function ok(res, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}
function bad(res, status, msg) {
  const body = JSON.stringify({ error: msg })
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readDoc() {
  try {
    const raw = await readFile(DATA_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      items: Array.isArray(parsed?.items) ? parsed.items : [],
      checks: parsed?.checks && typeof parsed.checks === 'object' ? parsed.checks : {},
    }
  } catch {
    return EMPTY
  }
}

async function writeDoc(doc) {
  await mkdir(dirname(DATA_PATH), { recursive: true })
  await writeFile(DATA_PATH, JSON.stringify(doc), 'utf8')
}

const server = createServer(async (req, res) => {
  if (req.url !== '/dev-todos' && req.url !== '/dev-todos/') {
    return bad(res, 404, 'Not found')
  }

  // Fail closed: with no token configured the store is disabled entirely.
  // 503 (not an empty 200) so the SPA cleanly drops to its localStorage-only
  // offline path instead of treating an empty server response as canonical.
  if (!TOKEN) {
    return bad(res, 503, 'Dev todos store disabled (DEV_TODOS_TOKEN not set)')
  }

  if (!isAuthorized(req)) {
    res.writeHead(401, {
      'Content-Type': 'application/json; charset=utf-8',
      'WWW-Authenticate': 'Bearer',
    })
    return res.end(JSON.stringify({ error: 'Unauthorized' }))
  }

  if (req.method === 'GET') {
    return ok(res, await readDoc())
  }

  if (req.method === 'PUT') {
    let received = 0
    const chunks = []
    for await (const chunk of req) {
      received += chunk.length
      if (received > MAX_BODY) {
        req.destroy()
        return bad(res, 413, 'Payload too large')
      }
      chunks.push(chunk)
    }
    let parsed
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { return bad(res, 400, 'Invalid JSON') }

    const items = Array.isArray(parsed?.items)
      ? parsed.items.filter((t) => t && typeof t.id === 'string' && typeof t.label === 'string')
      : []
    const checks = parsed?.checks && typeof parsed.checks === 'object' ? parsed.checks : {}
    const doc = { items, checks }
    try { await writeDoc(doc) }
    catch (err) {
      console.error('[dev-todos] write failed:', err)
      return bad(res, 500, 'Write failed')
    }
    return ok(res, doc)
  }

  res.writeHead(405, { Allow: 'GET, PUT' })
  res.end()
})

server.listen(PORT, '127.0.0.1', () => {
  const authState = TOKEN ? 'token-protected' : 'DISABLED (no DEV_TODOS_TOKEN)'
  console.log(`[dev-todos] listening on 127.0.0.1:${PORT}, data at ${DATA_PATH}, auth ${authState}`)
})
