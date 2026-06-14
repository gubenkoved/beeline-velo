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

const DB_NAME = "beeline-toolkit";
const STORE_NAME = "kv";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

/** Durable IndexedDB-backed store (production): one object store, one blob per key. */
export function idbBackend(): KeyValueStore {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> => (dbPromise ??= openDb());

  function run<T>(
    mode: IDBTransactionMode,
    op: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    return db().then(
      (database) =>
        new Promise<T>((resolve, reject) => {
          const tx = database.transaction(STORE_NAME, mode);
          const request = op(tx.objectStore(STORE_NAME));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
        }),
    );
  }

  return {
    get: (k) =>
      run<unknown>("readonly", (s) => s.get(k)).then((v) => (v == null ? null : String(v))),
    set: (k, v) => run("readwrite", (s) => s.put(v, k)).then(() => undefined),
    del: (k) => run("readwrite", (s) => s.delete(k)).then(() => undefined),
  };
}
