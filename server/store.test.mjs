import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore, createTableStore, StoreError } from './store.mjs'

const sample = { label: 'Home', address: '1 Main St', lat: 30.1, lng: -97.2, snapshot: { grade: 'B' } }

// Minimal in-memory stand-in for @azure/data-tables TableClient.
function fakeTableClient() {
  const rows = new Map()
  const k = (pk, rk) => `${pk}|${rk}`
  const err = (statusCode) => Object.assign(new Error('x'), { statusCode })
  return {
    rows,
    async createEntity(e) {
      if (rows.has(k(e.partitionKey, e.rowKey))) throw err(409)
      rows.set(k(e.partitionKey, e.rowKey), { ...e })
    },
    async getEntity(pk, rk) {
      const e = rows.get(k(pk, rk))
      if (!e) throw err(404)
      return { ...e }
    },
    async updateEntity(e) {
      if (!rows.has(k(e.partitionKey, e.rowKey))) throw err(404)
      rows.set(k(e.partitionKey, e.rowKey), { ...e })
    },
    async deleteEntity(pk, rk) {
      if (!rows.delete(k(pk, rk))) throw err(404)
    },
    async *listEntities({ queryOptions }) {
      const pk = /PartitionKey eq '(.*)'/.exec(queryOptions.filter)[1].replace(/''/g, "'")
      for (const e of rows.values()) if (e.partitionKey === pk) yield { ...e }
    },
  }
}

for (const [name, make] of [
  ['memory', async () => createMemoryStore()],
  ['table', async () => createTableStore({ client: fakeTableClient() })],
]) {
  test(`${name} store: CRUD round trip`, async () => {
    const s = await make()
    const created = await s.create('google:u1', sample, { maxPerUser: 5 })
    assert.match(created.id, /^[0-9a-f-]{36}$/)
    assert.deepEqual(created.snapshot, { grade: 'B' })
    assert.equal(created.gps_accuracy_m, null)
    assert.equal((await s.get('google:u1', created.id)).label, 'Home')

    const updated = await s.update('google:u1', created.id, { ...sample, label: 'Cabin', gps_accuracy_m: 12 })
    assert.equal(updated.label, 'Cabin')
    assert.equal(updated.gps_accuracy_m, 12)
    assert.equal(updated.created_at, created.created_at)

    assert.equal((await s.list('google:u1')).length, 1)
    assert.equal(await s.remove('google:u1', created.id), true)
    assert.equal(await s.remove('google:u1', created.id), false)
    assert.equal(await s.get('google:u1', created.id), null)
    assert.equal(await s.update('google:u1', created.id, sample), null)
  })

  test(`${name} store: users are isolated and capped`, async () => {
    const s = await make()
    const a = await s.create('google:a', sample, { maxPerUser: 2 })
    await s.create('google:a', sample, { maxPerUser: 2 })
    await assert.rejects(() => s.create('google:a', sample, { maxPerUser: 2 }), (e) => e instanceof StoreError && e.code === 'limit')
    // Same id string under another user / provider is a different row.
    assert.equal(await s.get('aad:a', a.id), null)
    assert.equal(await s.remove('google:b', a.id), false)
    assert.equal((await s.list('google:b')).length, 0)
    await s.create('google:b', sample, { maxPerUser: 2 })
  })
}

test('table store requires an account URL without a client', async () => {
  await assert.rejects(() => createTableStore({}), /TABLE_STORAGE_URL/)
})

test('createStoreFromEnv fails closed without TABLE_STORAGE_URL unless ALLOW_MEMORY_STORE=1', async () => {
  const { createStoreFromEnv } = await import('./store.mjs')
  await assert.rejects(createStoreFromEnv({}), { code: 'unavailable' })
  const store = await createStoreFromEnv({ ALLOW_MEMORY_STORE: '1' })
  assert.equal(await store.count('u'), 0)
})
