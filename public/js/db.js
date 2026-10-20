// @ts-check
// IndexedDB persistence for the generation archive.

const DB_NAME = 'noiseform';
const VERSION = 1;
let dbp;
let connection;

function forget(db) {
  if (connection !== db) return;
  connection = undefined;
  dbp = undefined;
}

function open() {
  if (dbp) return dbp;
  const pending = new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    let ended = false;
    const fail = (error) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      rej(error);
    };
    // Another tab can indefinitely block an upgrade; make that failure observable too.
    const timer = setTimeout(() => fail(new DOMException('Database open timed out', 'TimeoutError')), 10000);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('images')) {
        const s = db.createObjectStore('images', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => {
      const db = req.result;
      if (ended) return db.close();
      ended = true;
      clearTimeout(timer);
      connection = db;
      db.onversionchange = () => {
        db.close();
        forget(db);
      };
      db.onclose = () => forget(db);
      res(db);
    };
    req.onerror = () => fail(req.error || new DOMException('Database open failed', 'UnknownError'));
    req.onblocked = () => fail(new DOMException('Database upgrade blocked by another connection', 'InvalidStateError'));
  });
  dbp = pending;
  pending.catch(() => {
    if (dbp === pending) dbp = undefined;
  });
  return pending;
}

async function tx(store, mode, fn) {
  let db = await open();
  let t;
  try {
    t = db.transaction(store, mode);
  } catch (error) {
    // Explicit close() has no close event. Retry only before a transaction exists,
    // never replay a write that may already have started.
    if (error.name !== 'InvalidStateError') throw error;
    forget(db);
    db = await open();
    t = db.transaction(store, mode);
  }
  return new Promise((res, rej) => {
    let out;
    t.oncomplete = () => res(out && 'result' in Object(out) ? out.result : out);
    t.onerror = (event) => rej(t.error || event.target?.error || new DOMException('Database request failed', 'UnknownError'));
    t.onabort = () => rej(t.error || new DOMException('Database transaction aborted', 'AbortError'));
    try {
      out = fn(t.objectStore(store));
    } catch (error) {
      // A synchronous clone/schema error must not commit earlier writes in this transaction.
      try { t.abort(); } catch {}
      rej(error);
    }
  });
}

export const images = {
  put: (rec) => tx('images', 'readwrite', (s) => s.put(rec)),
  get: (id) => tx('images', 'readonly', (s) => s.get(id)),
  delete: (id) => tx('images', 'readwrite', (s) => s.delete(id)),
  clear: () => tx('images', 'readwrite', (s) => s.clear()),
  // Merge `patch` (object, or id => object) into many records in one transaction.
  patch: (ids, patch) =>
    tx('images', 'readwrite', (s) => {
      for (const id of ids) {
        const req = s.get(id);
        req.onsuccess = () => req.result && s.put(Object.assign(req.result, typeof patch === 'function' ? patch(id) : patch));
      }
    }),
  deleteMany: (ids) => tx('images', 'readwrite', (s) => ids.forEach((id) => s.delete(id))),
  // Lightweight list (no full-size blobs) newest first.
  list() {
    return tx('images', 'readonly', (s) => {
      const out = [];
      const req = s.index('createdAt').openCursor(null, 'prev');
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        const { blob, ...rest } = cur.value;
        rest.bytes = (blob?.size || 0) + (rest.thumb?.size || 0); // Blob sizes are metadata, no read
        out.push(rest);
        cur.continue();
      };
      return out;
    });
  },
};

export const kv = {
  // The compatibility facade keeps UI callers on data, while disk stores envelopes.
  // Dynamic import also keeps the low-level transaction layer independently testable.
  async get(k) {
    if (!['queue', 'refs', 'xyGrids', 'promptLog'].includes(k)) return kv.getRaw(k);
    const { readVersioned, kvSchemas } = await import('./persist.js');
    let original;
    const storage = {
      get: async (key) => (original = await kv.getRaw(key)),
      set: (key, value) => key === k
        ? kv.updateRaw(key, (current) => JSON.stringify(current) === JSON.stringify(original) ? value : current)
        : kv.setRaw(key, value),
    };
    return readVersioned(k, { ...kvSchemas[k], storage, json: false });
  },
  async set(k, v) {
    if (!['queue', 'refs', 'xyGrids', 'promptLog'].includes(k)) return kv.setRaw(k, v);
    const { writeVersioned, kvSchemas, persistError } = await import('./persist.js');
    if (!kvSchemas[k].validate(v)) {
      const error = new TypeError('Invalid persistence value');
      persistError(k, 'write', error);
      throw error;
    }
    return writeVersioned(k, v, { storage: { get: kv.getRaw, set: kv.setRaw }, json: false });
  },
  getRaw: (k) => tx('kv', 'readonly', (s) => s.get(k)),
  setRaw: (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k)),
  // The callback must be synchronous: read/compare/write share one IDB transaction.
  updateRaw(k, update) {
    let result;
    return tx('kv', 'readwrite', (s) => {
      const req = s.get(k);
      req.onsuccess = () => {
        try { result = update(req.result); s.put(result, k); }
        catch (error) { s.transaction.abort(); }
      };
    }).then(() => result);
  },
  delete: (k) => tx('kv', 'readwrite', (s) => s.delete(k)),
};
