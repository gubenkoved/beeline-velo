/**
 * Async key/value persistence backend for the ride cache.
 *
 * The Store keeps rides in memory (the source of truth); this is only the durable
 * layer behind its load()/save()/clear(). It holds one serialized JSON blob under
 * a single key, but the interface is deliberately minimal so the same Store works
 * against IndexedDB (production) or an in-memory Map (demo + tests).
 *
 * Why IndexedDB and not LocalStorage: LocalStorage caps an origin at ~5 MB, and
 * the cache (rough GPS tracks included) can grow past that. IndexedDB shares the
 * much larger per-origin disk quota. There is NO automatic migration — users move
 * data across the boundary with the existing JSON export/import.
 */

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

/**
 * Binary sibling of `KeyValueStore` for storing raw bytes (compressed GPX) without
 * a base64 round-trip. `keys()` lets a cache enumerate what it holds — used to
 * rebuild/repair the size index. IndexedDB stores `Uint8Array` directly via
 * structured clone; the in-memory backend just keeps the arrays.
 */
export interface BlobStore {
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, value: Uint8Array): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/**
 * In-memory backend for demo mode and tests. Its operations mutate the backing
 * Map synchronously (the returned promise is already resolved), so a save()
 * followed by a load() observes the write without awaiting a tick. Pass a shared
 * Map to persist across multiple Store.load() calls.
 */
export function memoryBackend(map: Map<string, string> = new Map()): KeyValueStore {
  return {
    get: (k) => Promise.resolve(map.has(k) ? map.get(k)! : null),
    set: (k, v) => {
      map.set(k, v);
      return Promise.resolve();
    },
    del: (k) => {
      map.delete(k);
      return Promise.resolve();
    },
  };
}

/**
 * In-memory binary backend for demo mode and tests. Like `memoryBackend` but holds
 * `Uint8Array` values; pass a shared Map to persist across reloads in a test.
 */
export function memoryBlobBackend(map: Map<string, Uint8Array> = new Map()): BlobStore {
  return {
    get: (k) => Promise.resolve(map.has(k) ? map.get(k)! : null),
    set: (k, v) => {
      map.set(k, v);
      return Promise.resolve();
    },
    del: (k) => {
      map.delete(k);
      return Promise.resolve();
    },
    keys: () => Promise.resolve([...map.keys()]),
  };
}

const DB_NAME = "beeline-toolkit";
const STORE_NAME = "kv";
/** Object store holding the compressed full-GPX cache (binary, one blob per ride). */
const GPX_STORE_NAME = "gpx";
// v2 adds the `gpx` object store alongside the original `kv` store.
const DB_VERSION = 2;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      if (!db.objectStoreNames.contains(GPX_STORE_NAME)) db.createObjectStore(GPX_STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

// One shared connection for every backend in the page, so the `kv` and `gpx`
// stores ride on a single open DB (and a single onupgradeneeded that creates both).
let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

function runOn<T>(
  storeName: string,
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return db().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        const tx = database.transaction(storeName, mode);
        const request = op(tx.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
      }),
  );
}

/** Durable IndexedDB-backed store (production): one object store, one blob per key. */
export function idbBackend(): KeyValueStore {
  return {
    get: (k) =>
      runOn<unknown>(STORE_NAME, "readonly", (s) => s.get(k)).then((v) =>
        v == null ? null : String(v),
      ),
    set: (k, v) => runOn(STORE_NAME, "readwrite", (s) => s.put(v, k)).then(() => undefined),
    del: (k) => runOn(STORE_NAME, "readwrite", (s) => s.delete(k)).then(() => undefined),
  };
}

/**
 * Durable IndexedDB-backed binary store (production) for the compressed GPX cache.
 * Shares the same DB connection as `idbBackend` but lives in its own `gpx` object
 * store, so clearing the GPX cache never touches the main ride-state blob.
 */
export function idbBlobBackend(): BlobStore {
  const toBytes = (v: unknown): Uint8Array | null => {
    if (v == null) return null;
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return null;
  };
  return {
    get: (k) => runOn<unknown>(GPX_STORE_NAME, "readonly", (s) => s.get(k)).then(toBytes),
    set: (k, v) =>
      runOn(GPX_STORE_NAME, "readwrite", (s) => s.put(v, k)).then(() => undefined),
    del: (k) => runOn(GPX_STORE_NAME, "readwrite", (s) => s.delete(k)).then(() => undefined),
    keys: () =>
      runOn<IDBValidKey[]>(GPX_STORE_NAME, "readonly", (s) => s.getAllKeys()).then((ks) =>
        ks.map((k) => String(k)),
      ),
  };
}
