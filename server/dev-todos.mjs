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

import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const PORT = Number(process.env.DEV_TODOS_PORT || 3001)
const DATA_PATH = process.env.DEV_TODOS_DATA_PATH || '/var/lib/landrecon/dev-todos.json'
const MAX_BODY = 256 * 1024

const EMPTY = { items: [], checks: {} }

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
  console.log(`[dev-todos] listening on 127.0.0.1:${PORT}, data at ${DATA_PATH}`)
})
