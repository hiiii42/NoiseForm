// @ts-check
import { kv } from './db.js';
import { persistError } from './persist.js';
import { invoke } from './callbacks.js';

// A fallback queue write must check the lease in the SAME IDB transaction.
// Checking first and writing later permits a suspended owner to overwrite its successor.
let leaseDB;
async function withLease(fn) {
  if (!leaseDB) {
    await kv.getRaw('queue.runLock'); // let db.js create / upgrade the database
    leaseDB = new Promise((resolve, reject) => {
      const request = indexedDB.open('noiseform');
      request.onerror = () => { leaseDB = null; reject(request.error); };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); leaseDB = null; };
        db.onclose = () => { leaseDB = null; };
        resolve(db);
      };
    });
  }
  const db = await leaseDB;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite'), store = tx.objectStore('kv');
    let result, error;
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () => reject(error || tx.error || new Error('Lease transaction failed'));
    const claim = store.get('queue.runLock');
    claim.onsuccess = () => {
      const queue = store.get('queue');
      queue.onsuccess = () => {
        try { result = fn(claim.result?.data, queue.result, store); }
        catch (err) { error = err; tx.abort(); }
      };
    };
  });
}

/** @param {{locks?: LockManager|null, channelName?: string, leaseMs?: number, heartbeatMs?: number, now?: () => number}} [options] */
export function createTabCoordinator({ locks = globalThis.navigator?.locks, channelName = 'nf:tabs', leaseMs = 15000, heartbeatMs = 4000, now = Date.now } = {}) {
  const id = crypto.randomUUID();
  // Node also exposes BroadcastChannel; importing store in unit tests must not
  // create a browser coordination channel that keeps the process alive.
  const channel = typeof document !== 'undefined' && typeof BroadcastChannel === 'function' ? new BroadcastChannel(channelName) : null;
  const listeners = new Set();
  let held = false, acquiring = false;
  let token = null, heartbeat = null;
  const valid = (lease, expected) => !!expected && lease?.owner === id && lease?.token === expected && lease?.expiresAt > now();
  const lost = (expected) => {
    if (token !== expected) return;
    held = false;
    clearInterval(heartbeat);
    heartbeat = null;
  };
  async function checkRunLock(expected = token) {
    if (locks) return held && !!expected && token === expected;
    const alive = await withLease((lease, _disk, store) => {
      if (!valid(lease, expected)) return false;
      store.put({ v: 1, data: { ...lease, expiresAt: now() + leaseMs } }, 'queue.runLock');
      return true;
    });
    if (!alive) lost(expected);
    return alive;
  }
  async function updateQueue(update, expected = null) {
    if (locks) return kv.updateRaw('queue', (disk) => {
      if (expected && (!held || token !== expected)) throw new Error('Queue ownership lost');
      return update(disk);
    });
    return withLease((lease, disk, store) => {
      if (expected && !valid(lease, expected)) { lost(expected); throw new Error('Queue ownership lost'); }
      const result = update(disk);
      store.put(result, 'queue');
      return result;
    });
  }
  /** @type {null | (() => Promise<void>)} */
  let releaseHeld = null;
  const notify = (topic) => channel?.postMessage({ topic, source: id });
  if (channel) channel.onmessage = ({ data }) => {
    if (data?.source !== id && typeof data?.topic === 'string') for (const fn of [...listeners]) invoke(fn, 'tabs:' + data.topic, data.topic);
  };

  async function acquireRunLock() {
    if (held || acquiring) return null;
    acquiring = true;
    try {
      if (locks) {
        return await new Promise((resolve, reject) => {
          locks.request('nf:queue:run', { ifAvailable: true }, async (lock) => {
            if (!lock) return resolve(null);
            held = true;
            token = crypto.randomUUID();
            const granted = token;
            await new Promise((unlock) => {
              releaseHeld = async () => {
                if (token !== granted) return;
                held = false; token = null; releaseHeld = null; unlock(); notify('queue');
              };
              resolve(releaseHeld);
            });
          }).catch(reject);
        });
      }
      if (!channel) throw new Error('Queue coordination unavailable');
      const granted = crypto.randomUUID();
      const claimed = await withLease((lease, _disk, store) => {
        if (lease?.owner && lease.expiresAt > now()) return false;
        store.put({ v: 1, data: { owner: id, token: granted, expiresAt: now() + leaseMs } }, 'queue.runLock');
        return true;
      });
      if (!claimed) return null;
      held = true;
      token = granted;
      heartbeat = setInterval(() => {
        checkRunLock(granted).catch((error) => { lost(granted); persistError('queue', 'heartbeat', error); });
      }, heartbeatMs);
      releaseHeld = async () => {
        lost(granted);
        await withLease((lease, _disk, store) => {
          if (lease?.owner === id && lease?.token === granted) store.put({ v: 1, data: { owner: null } }, 'queue.runLock');
        });
        if (token === granted) { token = null; releaseHeld = null; }
        notify('queue');
      };
      return releaseHeld;
    } catch (error) { persistError('queue', 'lock', error); return null; }
    finally { acquiring = false; }
  }
  const releaseOnExit = () => { releaseHeld?.().catch((error) => persistError('queue', 'unlock', error)); };
  globalThis.addEventListener?.('pagehide', releaseOnExit);
  return {
    id, notify, acquireRunLock, checkRunLock, updateQueue, runToken: () => held ? token : null, isRunner: () => held,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    async close() { await releaseHeld?.(); channel?.close(); globalThis.removeEventListener?.('pagehide', releaseOnExit); },
  };
}

export const tabs = createTabCoordinator();
