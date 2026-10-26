// Persistence for saved addresses.
//
// Two interchangeable stores with the same async interface:
//   - createTableStore: Azure Table Storage, authenticated with managed
//     identity (DefaultAzureCredential), no secrets in env.
//   - createMemoryStore: in-process Map for dev/tests (data is lost on restart).
//
// Layout: table `savedaddresses`, PartitionKey = user id (namespaced
// "<idp>:<id>"), RowKey = address id. One partition per user keeps listing and
// per-user caps a single-partition query.

import { randomUUID } from 'node:crypto'

export const TABLE_NAME = 'savedaddresses'

export class StoreError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

// Table Storage key fields reject / \ # ? and control chars; user ids are
// already restricted by the principal validator, this is defence in depth.
function partitionKey(userId) {
  return encodeURIComponent(userId).replace(/%/g, '~')
}

function toRecord(e) {
  let snapshot = null
  if (e.snapshot) {
    try {
      snapshot = JSON.parse(e.snapshot)
    } catch {
      snapshot = null
    }
  }
  return {
    id: e.rowKey,
    label: e.label,
    address: e.address,
    lat: e.lat,
    lng: e.lng,
    gps_accuracy_m: e.gps_accuracy_m ?? null,
    snapshot,
    created_at: e.created_at,
    updated_at: e.updated_at,
  }
}

function toEntity(userId, id, data, createdAt, updatedAt) {
  const entity = {
    partitionKey: partitionKey(userId),
    rowKey: id,
    label: data.label,
    address: data.address,
    lat: data.lat,
    lng: data.lng,
    snapshot: data.snapshot ? JSON.stringify(data.snapshot) : '',
    created_at: createdAt,
    updated_at: updatedAt,
  }
  if (typeof data.gps_accuracy_m === 'number') entity.gps_accuracy_m = data.gps_accuracy_m
  return entity
}

const sortNewest = (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)

export function createMemoryStore({ now = () => new Date() } = {}) {
  const rows = new Map() // partitionKey -> Map(rowKey -> entity)
  const part = (userId) => {
    const k = partitionKey(userId)
    if (!rows.has(k)) rows.set(k, new Map())
    return rows.get(k)
  }
  return {
    async list(userId) {
      return [...part(userId).values()].map(toRecord).sort(sortNewest)
    },
    async count(userId) {
      return part(userId).size
    },
    async get(userId, id) {
      const e = part(userId).get(id)
      return e ? toRecord(e) : null
    },
    async create(userId, data, { maxPerUser }) {
      const p = part(userId)
      if (p.size >= maxPerUser) throw new StoreError('limit', 'saved address limit reached')
      const id = randomUUID()
      const ts = now().toISOString()
      p.set(id, toEntity(userId, id, data, ts, ts))
      return toRecord(p.get(id))
    },
    async update(userId, id, data) {
      const p = part(userId)
      const prev = p.get(id)
      if (!prev) return null
      p.set(id, toEntity(userId, id, data, prev.created_at, now().toISOString()))
      return toRecord(p.get(id))
    },
    async remove(userId, id) {
      return part(userId).delete(id)
    },
  }
}

// Loaded lazily so the memory store (and tests) never need the Azure SDK.
export async function createTableStore({ accountUrl, tableName = TABLE_NAME, client, now = () => new Date() } = {}) {
  let table = client
  if (!table) {
    if (!accountUrl) throw new Error('TABLE_STORAGE_URL is required for the table store')
    const [{ TableClient }, { DefaultAzureCredential }] = await Promise.all([
      import('@azure/data-tables'),
      import('@azure/identity'),
    ])
    table = new TableClient(accountUrl, tableName, new DefaultAzureCredential())
    try {
      await table.createTable()
    } catch (err) {
      // 409 = already exists; anything else (e.g. 403) surfaces on first use.
      if (err?.statusCode !== 409) console.warn('[api] table create skipped:', err?.statusCode || err?.code)
    }
  }

  const notFound = (err) => err?.statusCode === 404

  async function listEntities(userId) {
    const pk = partitionKey(userId)
    const out = []
    for await (const e of table.listEntities({ queryOptions: { filter: `PartitionKey eq '${pk.replace(/'/g, "''")}'` } })) out.push(e)
    return out
  }

  return {
    async list(userId) {
      return (await listEntities(userId)).map(toRecord).sort(sortNewest)
    },
    async count(userId) {
      return (await listEntities(userId)).length
    },
    async get(userId, id) {
      try {
        return toRecord(await table.getEntity(partitionKey(userId), id))
      } catch (err) {
        if (notFound(err)) return null
        throw err
      }
    },
    async create(userId, data, { maxPerUser }) {
      // Soft cap: a concurrent burst could overshoot slightly, which is
      // acceptable given the per-user rate limit.
      if ((await listEntities(userId)).length >= maxPerUser) throw new StoreError('limit', 'saved address limit reached')
      const id = randomUUID()
      const ts = now().toISOString()
      await table.createEntity(toEntity(userId, id, data, ts, ts))
      return toRecord(toEntity(userId, id, data, ts, ts))
    },
    async update(userId, id, data) {
      let prev
      try {
        prev = await table.getEntity(partitionKey(userId), id)
      } catch (err) {
        if (notFound(err)) return null
        throw err
      }
      const entity = toEntity(userId, id, data, prev.created_at, now().toISOString())
      await table.updateEntity(entity, 'Replace')
      return toRecord(entity)
    },
    async remove(userId, id) {
      try {
        await table.deleteEntity(partitionKey(userId), id)
        return true
      } catch (err) {
        if (notFound(err)) return false
        throw err
      }
    },
  }
}

export async function createStoreFromEnv(env = process.env) {
  if (env.TABLE_STORAGE_URL) return createTableStore({ accountUrl: env.TABLE_STORAGE_URL })
  console.warn('[api] TABLE_STORAGE_URL not set: saved addresses use a non-persistent in-memory store')
  return createMemoryStore()
}
