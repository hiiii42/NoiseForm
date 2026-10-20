import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readVersioned, writeVersioned, validateDefaults, validateQueue, mergeQueue } from '../../public/js/persist.js';

const storage = () => {
  const rows = new Map();
  return { rows, get: (key) => rows.get(key), set: (key, value) => rows.set(key, structuredClone(value)) };
};
const empty = () => ({ seq: 0, jobs: [], history: [] });
const job = (id = 'a') => ({ id, no: 1, kind: 'batch', createdAt: 1, status: 'queued', done: 0, seeds: [], recs: [], count: 2, snap: { params: { prompt: id } } });
const queue = (...jobs) => ({ seq: jobs.length, jobs, history: [] });

test('v0 JSON settings/params and structured queue migrate without changing payloads', async () => {
  for (const [key, data, json] of [['nf.settings', { lang: 'en', llm: { base: 'local' } }, true], ['nf.params', { prompt: '雨夜', seed: '42', scale: 5 }, true], ['queue', queue(job()), false]]) {
    const store = storage();
    store.set(key, json ? JSON.stringify(data) : data);
    const value = await readVersioned(key, { version: 1, validate: key === 'queue' ? validateQueue : (d) => typeof d === 'object', fallback: {}, storage: store, json });
    assert.deepEqual(value, data);
    assert.deepEqual(json ? JSON.parse(store.get(key)) : store.get(key), { v: 1, data });
  }
});

test('invalid JSON, invalid shape and future schema are backed up verbatim and reported', async () => {
  const originalDocument = globalThis.document;
  const doc = globalThis.document = new EventTarget();
  const events = [];
  doc.addEventListener('nf:persist-error', (e) => events.push(e.detail));
  try {
    for (const raw of ['{broken', JSON.stringify({ v: 1, data: { scale: 'wrong' } }), JSON.stringify({ v: 20, data: { scale: 5 } })]) {
      const store = storage();
      store.set('nf.params', raw);
      assert.deepEqual(await readVersioned('nf.params', { version: 1, validate: (d) => validateDefaults(d, { scale: 7 }), fallback: {}, storage: store, json: true }), {});
      const backups = [...store.rows].filter(([k]) => k.startsWith('nf.params.bak-'));
      assert.equal(backups.length, 1);
      assert.equal(backups[0][1], raw);
      assert.equal(events.at(-1).backupKey, backups[0][0]);
      assert.equal(events.at(-1).operation, 'validate');
      assert.ok(!JSON.stringify(events.at(-1)).includes(raw), 'error events exclude stored values');
    }
  } finally { globalThis.document = originalDocument; }
});

test('backup quota failure preserves the original; failed writes reject and emit events', async () => {
  const originalDocument = globalThis.document;
  const doc = globalThis.document = new EventTarget();
  const events = [];
  doc.addEventListener('nf:persist-error', (e) => events.push(e.detail));
  const store = storage();
  store.set('x', '{invalid');
  store.set = () => { throw new DOMException('full', 'QuotaExceededError'); };
  try {
    await readVersioned('x', { version: 1, validate: (d) => !!d, fallback: {}, storage: store, json: true });
    assert.equal(store.get('x'), '{invalid');
    assert.ok(events.some((e) => e.operation === 'backup'));
    await assert.rejects(writeVersioned('x', {}, { storage: store }), { name: 'QuotaExceededError' });
    assert.equal(events.at(-1).operation, 'write');
  } finally { globalThis.document = originalDocument; }
});

test('explicit migration chain, current envelope and absent key', async () => {
  const store = storage();
  store.set('x', { v: 1, data: { n: 3 } });
  const options = { version: 2, storage: store, json: false, validate: (d) => typeof d.n === 'number', fallback: { n: 0 }, migrate: (d, from) => ({ n: d.n + from }) };
  assert.deepEqual(await readVersioned('x', options), { n: 4 });
  assert.deepEqual(store.get('x'), { v: 2, data: { n: 4 } });
  assert.deepEqual(await readVersioned('x', options), { n: 4 });
  assert.deepEqual(await readVersioned('missing', options), { n: 0 });
  assert.equal(store.get('missing'), undefined);
});

test('stale follower cannot roll back runner progress or resurrect completed jobs; additions survive', () => {
  const base = queue(job());
  const done = { ...job(), status: 'done', done: 2, recs: ['r1', 'r2'] };
  const disk = { seq: 1, jobs: [], history: [done] };
  const local = queue(job(), job('new'));
  const merged = mergeQueue(disk, local, base, false, true);
  assert.deepEqual(merged.jobs.map((j) => j.id), ['new']);
  assert.deepEqual(merged.history, [done]);
  const running = { ...job(), status: 'running', done: 1 };
  assert.equal(mergeQueue(queue(running), queue({ ...job(), count: 100 }), queue(running), false, true).jobs[0].count, 2);
});

test('runner merges follower additions while retaining progress and own deletions', () => {
  const base = queue(job());
  const local = queue({ ...job(), done: 1 });
  const disk = queue(job(), job('new'));
  const merged = mergeQueue(disk, local, base, true);
  assert.equal(merged.jobs[0].done, 1);
  assert.equal(merged.jobs[1].id, 'new');
  assert.deepEqual(mergeQueue(disk, empty(), base, true).jobs.map((j) => j.id), ['new']);
});

test('importing store outside a browser releases Node without an open coordination channel', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../../public/js/store.js', import.meta.url).href)})`], { timeout: 3000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});
