// IndexedDB-backed cache for Google Places searchText responses.
//
// Why: searchText is $32/1k and our three call sites (Costco, ER, EMS) all
// fire on map pan/recenter or layer-toggle. A single user exploring an area
// can easily trigger 5-15 calls per visit, and most of those queries are
// repeats for the same neighborhood. Caching keyed on (textQuery, snapped
// geo bias, fieldMask) collapses the duplicates.
//
// Cache key strategy:
//   - Lat/lng snapped to ~1.1 km grid (0.01°). Two visits to addresses
//     within a kilometer share the same key.
//   - Radius snapped to nearest 1 km bucket.
//   - Rectangle corners snapped to the same grid.
//   - textQuery + fieldMask included verbatim so different searches
//     (e.g. "police station" vs "fire station") have distinct entries.
//
// TTL defaults to 7 days — Places data for hospitals, police, fire stations,
// and Costco warehouses is effectively static at that horizon.
//
// Fail-open: if IndexedDB is unavailable (private browsing, quota errors,
// SSR), every call falls through to the network unwrapped.

const DB_NAME = 'landrecon-places-cache'
const DB_VERSION = 1
const STORE = 'searchText'
const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText'
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const DEFAULT_GRID_DEG = 0.01                  // ~1.1 km
const DEFAULT_RADIUS_BUCKET_M = 1000           // 1 km
const MAX_ENTRIES = 500                        // LRU cap

const LR_DEBUG = typeof localStorage !== 'undefined' && localStorage.getItem('LR_DEBUG') === '1'
function dbg(...args: unknown[]) { if (LR_DEBUG) console.debug('[LR:places-cache]', ...args) }

type LatLng = { latitude: number; longitude: number }
type Circle = { center: LatLng; radius: number }
type Rectangle = { low: LatLng; high: LatLng }

export interface PlacesSearchTextBody {
  textQuery: string
  maxResultCount?: number
  locationBias?: { circle?: Circle; rectangle?: Rectangle }
  locationRestriction?: { circle?: Circle; rectangle?: Rectangle }
  [k: string]: unknown
}

export interface CachedPlacesOpts {
  body: PlacesSearchTextBody
  fieldMask: string
  apiKey: string
  signal?: AbortSignal
  ttlMs?: number
  gridDeg?: number
  radiusBucketM?: number
  /** Force-skip the cache (still writes the response back on success). */
  bypassRead?: boolean
}

interface CacheEntry {
  key: string
  response: { places?: unknown[] } & Record<string, unknown>
  insertedAt: number
  expiresAt: number
  lastReadAt: number
}

// ---------------------------------------------------------------------------
// IndexedDB plumbing
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  if (typeof indexedDB === 'undefined') return (dbPromise = Promise.resolve(null))
  dbPromise = new Promise((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (err) {
      dbg('indexedDB.open threw', err)
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'key' })
        os.createIndex('lastReadAt', 'lastReadAt')
        os.createIndex('expiresAt', 'expiresAt')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => { dbg('indexedDB open error', req.error); resolve(null) }
    req.onblocked = () => { dbg('indexedDB open blocked'); resolve(null) }
  })
  return dbPromise
}

function idbGet(db: IDBDatabase, key: string): Promise<CacheEntry | null> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => resolve((req.result as CacheEntry | undefined) ?? null)
      req.onerror = () => resolve(null)
    } catch { resolve(null) }
  })
}

function idbPut(db: IDBDatabase, entry: CacheEntry): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(entry)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch { resolve() }
  })
}

function idbCount(db: IDBDatabase): Promise<number> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).count()
      req.onsuccess = () => resolve(req.result || 0)
      req.onerror = () => resolve(0)
    } catch { resolve(0) }
  })
}

// Evict expired entries first; if still over cap, evict the
// least-recently-read N entries until under the cap.
let evictInFlight = false
async function evictIfNeeded(db: IDBDatabase): Promise<void> {
  if (evictInFlight) return
  evictInFlight = true
  try {
    const now = Date.now()
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite')
        const idx = tx.objectStore(STORE).index('expiresAt')
        const range = IDBKeyRange.upperBound(now)
        const req = idx.openCursor(range)
        req.onsuccess = () => {
          const cur = req.result
          if (cur) { cur.delete(); cur.continue() } else { resolve() }
        }
        req.onerror = () => resolve()
        tx.onabort = () => resolve()
      } catch { resolve() }
    })
    const remaining = await idbCount(db)
    if (remaining > MAX_ENTRIES) {
      const toDrop = remaining - MAX_ENTRIES
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(STORE, 'readwrite')
          const idx = tx.objectStore(STORE).index('lastReadAt')
          const req = idx.openCursor()
          let dropped = 0
          req.onsuccess = () => {
            const cur = req.result
            if (cur && dropped < toDrop) {
              cur.delete()
              dropped++
              cur.continue()
            } else {
              resolve()
            }
          }
          req.onerror = () => resolve()
        } catch { resolve() }
      })
    }
  } finally {
    evictInFlight = false
  }
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

function snap(value: number, step: number): number {
  // Round to step, then format to fixed precision so floating-point noise
  // (e.g. 39.0299999...) doesn't break key stability.
  const snapped = Math.round(value / step) * step
  const decimals = Math.max(0, -Math.floor(Math.log10(step)))
  return Number(snapped.toFixed(Math.min(decimals, 6)))
}

function snapLatLng(p: LatLng, gridDeg: number): LatLng {
  return { latitude: snap(p.latitude, gridDeg), longitude: snap(p.longitude, gridDeg) }
}

function snapCircle(c: Circle, gridDeg: number, radiusBucketM: number): Circle {
  return {
    center: snapLatLng(c.center, gridDeg),
    radius: Math.max(radiusBucketM, Math.round(c.radius / radiusBucketM) * radiusBucketM),
  }
}

function snapRect(r: Rectangle, gridDeg: number): Rectangle {
  return { low: snapLatLng(r.low, gridDeg), high: snapLatLng(r.high, gridDeg) }
}

function snapBody(body: PlacesSearchTextBody, gridDeg: number, radiusBucketM: number): PlacesSearchTextBody {
  const out: PlacesSearchTextBody = {
    textQuery: body.textQuery,
    maxResultCount: body.maxResultCount,
  }
  if (body.locationBias?.circle) {
    out.locationBias = { circle: snapCircle(body.locationBias.circle, gridDeg, radiusBucketM) }
  } else if (body.locationBias?.rectangle) {
    out.locationBias = { rectangle: snapRect(body.locationBias.rectangle, gridDeg) }
  } else if (body.locationRestriction?.circle) {
    out.locationRestriction = { circle: snapCircle(body.locationRestriction.circle, gridDeg, radiusBucketM) }
  } else if (body.locationRestriction?.rectangle) {
    out.locationRestriction = { rectangle: snapRect(body.locationRestriction.rectangle, gridDeg) }
  }
  return out
}

function makeKey(body: PlacesSearchTextBody, fieldMask: string): string {
  // Stable stringify — sort keys at the top level (the only nesting we use
  // is the bias/restriction shapes, which are already canonical above).
  const keys = Object.keys(body).sort()
  const ordered: Record<string, unknown> = {}
  for (const k of keys) ordered[k] = body[k]
  return `searchText|${JSON.stringify(ordered)}|${fieldMask}`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PlacesCacheStats {
  hit: number
  miss: number
  networkErr: number
}

const stats: PlacesCacheStats = { hit: 0, miss: 0, networkErr: 0 }
export function getPlacesCacheStats(): Readonly<PlacesCacheStats> { return stats }

/**
 * Make a Google Places searchText request, transparently caching the
 * response in IndexedDB. Returns the parsed response body, or `null` if
 * the network call failed (mirrors existing call-site error semantics).
 */
export async function cachedPlacesSearchText(opts: CachedPlacesOpts): Promise<{ places?: unknown[] } | null> {
  const {
    body,
    fieldMask,
    apiKey,
    signal,
    ttlMs = DEFAULT_TTL_MS,
    gridDeg = DEFAULT_GRID_DEG,
    radiusBucketM = DEFAULT_RADIUS_BUCKET_M,
    bypassRead = false,
  } = opts

  const snapped = snapBody(body, gridDeg, radiusBucketM)
  const key = makeKey(snapped, fieldMask)
  const db = await openDb()
  const now = Date.now()

  if (db && !bypassRead) {
    const hit = await idbGet(db, key)
    if (hit && hit.expiresAt > now) {
      stats.hit++
      dbg(`HIT  q="${body.textQuery}" age=${Math.round((now - hit.insertedAt) / 1000)}s`)
      // Update lastReadAt (fire-and-forget so we don't block the caller).
      void idbPut(db, { ...hit, lastReadAt: now })
      return hit.response
    }
  }

  stats.miss++
  dbg(`MISS q="${body.textQuery}"${bypassRead ? ' (bypass)' : ''}`)

  let response: { places?: unknown[] } & Record<string, unknown>
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) { stats.networkErr++; dbg(`network ${res.status} q="${body.textQuery}"`); return null }
    response = await res.json()
  } catch (err) {
    stats.networkErr++
    dbg(`fetch threw q="${body.textQuery}"`, err)
    return null
  }

  if (db) {
    const entry: CacheEntry = {
      key,
      response,
      insertedAt: now,
      expiresAt: now + ttlMs,
      lastReadAt: now,
    }
    void idbPut(db, entry).then(() => evictIfNeeded(db))
  }

  return response
}

/** Drop every cached entry. Exposed so a "Reset cache" UI hook can use it. */
export async function clearPlacesCache(): Promise<void> {
  const db = await openDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch { resolve() }
  })
  stats.hit = 0; stats.miss = 0; stats.networkErr = 0
  dbg('cleared')
}
