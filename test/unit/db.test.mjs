import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../public/js/db.js', import.meta.url), 'utf8');

async function load(factory, timers = { setTimeout, clearTimeout }) {
  const key = 'nf-db-test-' + crypto.randomUUID();
  globalThis[key] = { factory, timers };
  try {
    // Inject only platform boundaries; run the original module's exports unchanged.
    const prefix = `const { factory: indexedDB, timers: { setTimeout, clearTimeout } } = globalThis[${JSON.stringify(key)}];\n`;
    return await import('data:text/javascript;base64,' + Buffer.from(prefix + source).toString('base64'));
  } finally { delete globalThis[key]; }
}

function connection(value = 42) {
  return {
    closed: false,
    close() { this.closed = true; },
    transaction() {
      const request = { result: value };
      const transaction = { objectStore: () => ({ get: () => request }) };
      setTimeout(() => transaction.oncomplete(), 0);
      return transaction;
    },
  };
}

test('blocked open rejects all waiters, releases a late connection, and permits a fresh open', { timeout: 1500 }, async () => {
  const requests = [];
  const factory = { open() { const req = {}; requests.push(req); return req; } };
  const { kv } = await load(factory);
  const first = kv.get('a');
  const second = kv.get('b');
  const settled = Promise.allSettled([first, second]);
  assert.equal(requests.length, 1, 'simultaneous callers share an in-flight open');
  requests[0].onblocked();
  for (const result of await settled) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.name, 'InvalidStateError');
  }
  const next = kv.get('c');
  assert.equal(requests.length, 2, 'failure is not cached');
  const stale = connection(-1);
  requests[0].result = stale;
  requests[0].onsuccess();
  assert.equal(stale.closed, true, 'a late open cannot replace the retry connection');
  const current = connection();
  requests[1].result = current;
  requests[1].onsuccess();
  assert.equal(await next, 42);
  assert.equal(await kv.get('d'), 42);
  assert.equal(requests.length, 2);
});

test('an unresponsive database open times out and can be retried', { timeout: 1500 }, async () => {
  const requests = [];
  const factory = { open() { const req = {}; requests.push(req); return req; } };
  let openTimeout;
  const timers = { setTimeout(fn, ms) { openTimeout = ms; return setTimeout(fn, 5); }, clearTimeout };
  const { kv } = await load(factory, timers);
  await assert.rejects(kv.get('a'), { name: 'TimeoutError' });
  assert.equal(openTimeout, 10000, 'production open timeout is finite');
  const next = kv.get('a');
  assert.equal(requests.length, 2);
  requests[1].result = connection();
  requests[1].onsuccess();
  assert.equal(await next, 42);
  requests[0].result = connection();
  requests[0].onsuccess();
  assert.equal(requests[0].result.closed, true);
});
