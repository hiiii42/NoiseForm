import test from 'node:test';
import assert from 'node:assert/strict';
import { total, left, seedSource, seedChoice, shouldCheckFree, resultPolicy } from '../../public/js/queue/policy.js';

const error = (status, extra = {}) => ({ err: { status, ...extra } });

test('success resets both counters and takes precedence over other result flags', () => {
  assert.deepEqual(resultPolicy({ ok: true, skipped: true, stage: 'persist' }, { fails: 6, skips: 20 }),
    { action: 'continue', fails: 0, skips: 0 });
});

test('skipped starts wait 400ms twenty times, then fail without resetting failures', () => {
  for (let skips = 0; skips < 20; skips++) {
    assert.deepEqual(resultPolicy({ skipped: true }, { fails: 1, skips }),
      { action: 'backoff', delay: 400, fails: 1, skips: skips + 1 });
  }
  assert.deepEqual(resultPolicy({ skipped: true, stage: 'persist' }, { fails: 1, skips: 20 }),
    { action: 'fail', reason: 'skipped', fails: 1, skips: 0 });
});

for (const stage of ['persist', 'unknown']) {
  test(`${stage} pauses before any HTTP retry/XY skip and preserves counters`, () => {
    for (const kind of ['batch', 'oneoff', 'xy', 'tiled']) {
      for (const status of [undefined, 400, 401, 429, 500]) {
        const result = stage === 'persist' ? { ...error(status, { unknown: true }), stage } : error(status, { unknown: true });
        assert.deepEqual(resultPolicy(result, { kind, fails: 6, skips: 12 }),
          { action: 'pause', reason: stage, stage, fails: 6, skips: 12 });
      }
    }
  });
}

for (const status of [401, 402, 403]) {
  test(`${status} pauses all job kinds without consuming a retry`, () => {
    for (const kind of ['batch', 'oneoff', 'xy', 'tiled']) {
      assert.deepEqual(resultPolicy(error(status), { kind, fails: 1, skips: 3 }),
        { action: 'pause', reason: 'response', fails: 1, skips: 3 });
    }
  });
}

test('429 has six linear backoffs, then follows the job-specific failure path', () => {
  for (const kind of ['batch', 'oneoff', 'xy', 'tiled']) {
    for (let fails = 0; fails < 6; fails++) {
      assert.deepEqual(resultPolicy(error(429), { kind, fails, skips: 2 }),
        { action: 'backoff', delay: 3000 * (fails + 1), busy: true, fails: fails + 1, skips: 2 });
    }
    assert.deepEqual(resultPolicy(error(429), { kind, fails: 6 }), kind === 'xy'
      ? { action: 'skip-cell', failJob: true, fails: 7, skips: 0 }
      : { action: 'fail', reason: 'response', fails: 0, skips: 0 });
  }
});

test('ordinary failure retries once for 1500ms; second failure ends and resets fails', () => {
  for (const result of [null, undefined, {}, error(500), error(502)]) {
    for (const kind of ['batch', 'oneoff', 'tiled']) {
      assert.deepEqual(resultPolicy(result, { kind, skips: 3 }), { action: 'backoff', delay: 1500, fails: 1, skips: 3 });
      assert.deepEqual(resultPolicy(result, { kind, fails: 1, skips: 3 }), { action: 'fail', reason: 'response', fails: 0, skips: 3 });
    }
  }
  assert.equal(resultPolicy({}).delay, 1500);
});

test('400 fails immediately except XY, where one bad cell is skipped first', () => {
  for (const kind of ['batch', 'oneoff', 'tiled']) {
    assert.deepEqual(resultPolicy(error(400), { kind }), { action: 'fail', reason: 'response', fails: 0, skips: 0 });
  }
  for (const status of [400, 500, undefined]) {
    assert.deepEqual(resultPolicy(error(status), { kind: 'xy' }), { action: 'skip-cell', failJob: false, fails: 1, skips: 0 });
    assert.deepEqual(resultPolicy(error(status), { kind: 'xy', fails: 1 }), { action: 'skip-cell', failJob: true, fails: 2, skips: 0 });
  }
});

test('batch free-only reads current settings, not the enqueue-time job field', () => {
  for (const freeOnly of [true, false, undefined]) {
    const job = { kind: 'batch', freeOnly };
    for (const autoFreeOnly of [true, undefined, null, 0]) assert.equal(shouldCheckFree(job, { autoFreeOnly }, { live: true }), true);
    assert.equal(shouldCheckFree(job, { autoFreeOnly: false }, { live: true }), false);
  }
});

test('oneoff bypasses free-only; XY/tiled keep their job guard; DEMO/save retries bypass it', () => {
  for (const kind of ['batch', 'oneoff', 'xy', 'tiled']) {
    const job = { kind, freeOnly: true };
    assert.equal(shouldCheckFree(job, { autoFreeOnly: true }, { live: true }), kind !== 'oneoff');
    assert.equal(shouldCheckFree(job, {}, { live: false }), false);
    assert.equal(shouldCheckFree({ ...job, pendingSaveId: 'saved-image' }, {}, { live: true }), false);
    if (kind !== 'batch') assert.equal(shouldCheckFree({ ...job, freeOnly: false }, {}, { live: true }), false);
  }
  assert.equal(shouldCheckFree({ kind: 'xy', freeOnly: true }, { autoFreeOnly: false }, { live: true }), true);
});

test('seed sources select the latest nonempty batch or an explicit job', () => {
  const history = [
    { id: 'grid', kind: 'xy', seeds: [99] }, { id: 'empty', kind: 'batch', seeds: [] },
    { id: 'latest', kind: 'batch', seeds: [21, 22] }, { id: 'old', kind: 'batch', seeds: [11] },
  ];
  assert.equal(seedSource({ seedMode: 'prev' }, history), history[2]);
  assert.equal(seedSource({ seedMode: 'job', seedFrom: 'old' }, history), history[3]);
  assert.equal(seedSource({ seedMode: 'job', seedFrom: 'missing' }, history), null);
  assert.equal(seedSource({ seedMode: 'prev' }, []), null);
  for (const seedMode of ['fixed', 'random', 'grid']) assert.equal(seedSource({ seedMode }, history), null);
});

test('fixed seeds preserve uint32 conversion and override source seeds', () => {
  for (const [seed, expected] of [['0', 0], ['4294967297', 1], ['-1', 4294967295], ['12.9', 12]]) {
    assert.deepEqual(seedChoice({ seedMode: 'fixed', snap: { params: { seed } }, srcSeeds: [42], done: 0 }), { seed: expected });
  }
});

test('prev/job choose the matching index, then ask the runner for a random seed', () => {
  for (const seedMode of ['prev', 'job']) {
    const job = { seedMode, srcSeeds: [0, 23], done: 0 };
    assert.deepEqual(seedChoice(job), { seed: 0 });
    assert.deepEqual(seedChoice({ ...job, done: 1 }), { seed: 23 });
    assert.deepEqual(seedChoice({ ...job, done: 2 }), { random: true });
    for (const srcSeeds of [null, undefined, []]) assert.deepEqual(seedChoice({ ...job, srcSeeds }), { random: true });
  }
  assert.deepEqual(seedChoice({ seedMode: 'random', done: 0 }), { random: true });
});

test('grid choices use each XY/tiled cell seed', () => {
  for (const kind of ['xy', 'tiled']) {
    assert.deepEqual(seedChoice({ kind, seedMode: 'grid', cells: [{ seed: 21 }, { seed: 0 }], done: 1 }), { seed: 0 });
  }
});

test('counts preserve infinity and lean XY/tiled history fallbacks', () => {
  for (const kind of ['batch', 'oneoff', 'xy', 'tiled']) {
    assert.equal(total({ kind, count: 4 }), 4);
    assert.equal(left({ kind, count: 4, done: 1 }), 3);
    assert.equal(total({ kind, count: 0 }), Infinity);
    assert.equal(total({ kind }), Infinity);
  }
  for (const kind of ['xy', 'tiled']) {
    assert.equal(total({ kind, cells: [1, 2], count: 99 }), 2);
    assert.equal(total({ kind, cells: [], count: 99 }), 0);
  }
});

test('policy inputs remain untouched', () => {
  const job = Object.freeze({ kind: 'batch', seedMode: 'prev', done: 0, srcSeeds: Object.freeze([4]) });
  const result = Object.freeze({ err: Object.freeze({ status: 429 }) });
  const counters = Object.freeze({ fails: 1, skips: 2, kind: 'batch' });
  seedChoice(job);
  shouldCheckFree(job, Object.freeze({ autoFreeOnly: false }), Object.freeze({ live: true }));
  resultPolicy(result, counters);
  assert.deepEqual(counters, { fails: 1, skips: 2, kind: 'batch' });
});
