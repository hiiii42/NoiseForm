import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueueRepository } from '../../public/js/queue/repository.js';
import { createQueueRunner } from '../../public/js/queue/runner.js';

// Use the real repository/merge/schema with in-memory storage and an injected lock.
// No browser globals, timers for backoff, application UI or network are needed.
function harness() {
  const storage = new Map(), events = [], delays = [], released = [];
  let runner, held = false, serial = 0, generated = 0;
  const kv = {
    getRaw: async (key) => structuredClone(storage.get(key)),
    setRaw: async (key, value) => storage.set(key, structuredClone(value)),
    updateRaw: async (key, fn) => kv.setRaw(key, fn(await kv.getRaw(key))),
  };
  const tabs = {
    id: 'test-tab', subscribe() {}, notify() {},
    acquireRunLock: async () => {
      if (held) return null;
      held = true;
      return async () => { held = false; };
    },
    runToken: () => 'test-token', checkRunLock: async () => held,
    updateQueue: async (fn, token) => {
      if (token && !held) throw new Error('Queue ownership lost');
      return kv.updateRaw('queue', fn);
    },
  };
  const T = (_zh, en) => en;
  const repository = createQueueRepository({ kv, tabs, runtime: () => runner.runtime(), onChange() {}, T });
  const state = { settings: { autoFreeOnly: false }, session: { live: true }, vibes: [] };
  const deps = {
    generate: async (o) => ({ ok: true, recs: [{ id: `rec-${++generated}`, seed: o.seed }] }),
    releaseSave: (id) => released.push(id),
  };
  runner = createQueueRunner({ repository, tabs, state, getDeps: () => deps, autoRunning: () => false,
    paint() {}, toast() {}, notifyAlert() {}, fire: (name, data) => events.push([name, structuredClone(data)]),
    T, t: (key) => key, uid: () => `job-${++serial}`, randomSeed: () => 123,
    sleep: async (ms) => { delays.push(ms); }, effectiveModel: () => ({ id: 'test-model' }), freeBlockers: () => ['paid image'] });
  const enqueue = (count = 1) => runner.enqueue({ params: { prompt: 'test', seed: '' } }, { count });
  return { runner, repository, state, deps, events, delays, released, enqueue, storage, tabs };
}

test('runner + repository pause for storage and resume only retrySave, even when free-only becomes enabled', async () => {
  const h = harness();
  let generated = 0, retried = 0;
  h.deps.generate = async () => { generated++; return { stage: 'persist', pendingId: 'artifact', err: { message: 'quota' } }; };
  h.deps.retrySave = async (id) => {
    assert.equal(id, 'artifact');
    return ++retried === 1 ? { stage: 'persist', pendingId: id, err: { message: 'still full' } }
      : { ok: true, recs: [{ id: 'saved', seed: 777 }] };
  };
  const job = h.enqueue();
  await h.runner.runQueue();
  assert.equal(job.stage, 'persist');
  assert.equal(job.status, 'paused');
  h.state.settings.autoFreeOnly = true;
  await h.runner.runQueue();
  assert.equal(job.status, 'paused');
  await h.runner.runQueue();
  assert.equal(job.status, 'done');
  assert.equal(generated, 1);
  assert.equal(retried, 2);
  assert.deepEqual(h.released, ['artifact']);
  assert.deepEqual(job.seeds, [777]);
  assert.equal(h.storage.get('queue').runner, null);
  assert.equal(h.storage.get('queue').data.jobs.length, 0);
  assert.equal(h.runner.queueRunning(), false);
});

test('unknown result pauses and subsequent Run never replays the request', async () => {
  const h = harness();
  let generated = 0;
  h.deps.generate = async () => { generated++; return { err: { unknown: true, status: 502, message: 'uncertain' } }; };
  const job = h.enqueue();
  await h.runner.runQueue();
  await h.runner.runQueue();
  assert.equal(generated, 1);
  assert.equal(job.stage, 'unknown');
  assert.equal(job.done, 0);
  assert.equal(job.status, 'paused');
  h.runner.endJob(job.id);
  await h.repository.flushWrites();
  assert.equal(h.storage.get('queue').data.jobs.length, 0);
});

test('free-only settings changed after enqueue are read before each request', async () => {
  const h = harness();
  const job = h.enqueue();
  assert.equal(job.freeOnly, false);
  h.state.settings.autoFreeOnly = true;
  await h.runner.runQueue();
  assert.equal(job.done, 0);
  assert.equal(h.events.filter(([name]) => name === 'step').length, 0);
  h.state.settings.autoFreeOnly = false;
  await h.runner.runQueue();
  assert.equal(job.status, 'done');
  assert.deepEqual(h.events.map(([name]) => name), ['step', 'end']);
});

test('runner applies six 429 backoffs without real time delays, then fails', async () => {
  const h = harness();
  let requests = 0;
  h.deps.generate = async () => { requests++; return { err: { status: 429, message: 'busy' } }; };
  const job = h.enqueue();
  await h.runner.runQueue();
  assert.equal(requests, 7);
  assert.equal(job.status, 'failed');
  assert.deepEqual(h.delays, [3000, 6000, 9000, 12000, 15000, 18000]);
});

test('XY emits cell failure payloads and fails after two consecutive failed cells', async () => {
  const h = harness();
  h.deps.generate = async () => ({ err: { status: 400, message: 'bad cell' } });
  // enqueueXY starts automatically; await its end event and the final lock release.
  const job = h.runner.enqueueXY({ gridId: 'grid', freeOnly: false, snap: { params: {} },
    cells: [0, 1, 2].map((x) => ({ key: `c${x}`, x, y: 0, seed: x, params: {} })) });
  while (h.runner.queueRunning()) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(job.done, 2);
  assert.equal(job.status, 'failed');
  assert.deepEqual(h.events.filter(([name]) => name === 'xyfail').map(([, data]) => data), [
    { gridId: 'grid', key: 'c0', msg: 'bad cell' }, { gridId: 'grid', key: 'c1', msg: 'bad cell' },
  ]);
  assert.deepEqual(h.delays, []);
});

test('tiled composition retry reuses completed cells and retains event contracts', async () => {
  const h = harness();
  let compositions = 0;
  h.runner.setTiledFinalizer(async () => {
    if (++compositions === 1) throw new Error('compose failed');
    return 'composite';
  });
  const job = h.runner.enqueueTiled({ tiledId: 'tiles', freeOnly: false, snap: { params: {} },
    cells: [{ key: 't0', seed: 42, params: {}, base: { image: 'tile' } }] });
  while (h.runner.queueRunning()) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(job.stage, 'compose');
  assert.equal(job.status, 'paused');
  await h.runner.runQueue();
  assert.equal(job.status, 'done');
  assert.equal(job.result, 'composite');
  assert.equal(compositions, 2);
  assert.equal(h.events.filter(([name]) => name === 'step').length, 1);
  assert.deepEqual(h.events.find(([name]) => name === 'tiledCell')[1], { tiledId: 'tiles', key: 't0', id: 'rec-1', done: 1, total: 1 });
  assert.deepEqual(h.events.find(([name]) => name === 'tiledDone')[1], { tiledId: 'tiles', recs: ['rec-1'] });
  assert.equal(h.storage.get('queue').data.history[0].cells, undefined);
});

test('losing the lock after generate prevents consuming its result', async () => {
  const h = harness();
  h.deps.generate = async () => {
    h.tabs.checkRunLock = async () => false;
    return { ok: true, recs: [{ id: 'not-consumed', seed: 9 }] };
  };
  const job = h.enqueue();
  await h.runner.runQueue();
  assert.equal(job.done, 0);
  assert.deepEqual(job.recs, []);
  assert.equal(job.status, 'paused');
  assert.equal(h.runner.queueRunning(), false);
});
