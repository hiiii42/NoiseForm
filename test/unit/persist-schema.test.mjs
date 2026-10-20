import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDefaults, validateQueue, readVersioned } from '../../public/js/persist.js';

const character = () => ({ id: 'person', prompt: '1girl', uc: '', x: 0.5, y: 0.5, enabled: true });
const job = (params) => ({ id: 'job', no: 1, kind: 'batch', status: 'queued', done: 0, count: 1, seeds: [], recs: [], snap: { params } });
const queue = (params) => ({ seq: 1, jobs: [job(params)], history: [] });

test('characters are repaired in place, not rejected: one odd entry never resets the editor or a queue', () => {
  const defaults = { characters: [] };
  assert.equal(validateDefaults({ characters: [character(), { ...character(), id: 'b', x: 0, y: 1, enabled: false }] }, defaults), true);
  // legacy / imported entries without uc, enabled, x, y or id hydrate with defaults
  const legacy = { characters: [{ prompt: '1boy' }, { id: 'x', prompt: 'cat', x: '0.3', y: Infinity, enabled: 1, uc: null }] }, report = {};
  assert.equal(validateDefaults(legacy, defaults, report), true);
  assert.equal(report.discardedCharacters, 0);
  assert.equal(report.repairedCharacters, 2);
  assert.deepEqual(legacy.characters.map(({ id, ...c }) => c), [
    { prompt: '1boy', uc: '', x: 0.5, y: 0.5, enabled: true },
    { prompt: 'cat', uc: '', x: 0.5, y: 0.5, enabled: true },
  ]);
  assert.ok(legacy.characters.every((c) => typeof c.id === 'string' && c.id));
  // out-of-range coordinates are clamped; duplicate ids are made unique
  const odd = { characters: [{ ...character(), x: -1, y: 2 }, character()] };
  validateDefaults(odd, defaults);
  assert.deepEqual([odd.characters[0].x, odd.characters[0].y], [0, 1]);
  assert.notEqual(odd.characters[0].id, odd.characters[1].id);
  assert.equal(validateDefaults({}, defaults), true, 'legacy missing fields still hydrate');
});

test('only entries that cannot be a character (no string prompt) are dropped and counted', () => {
  const input = { characters: [character(), {}, null, { ...character(), prompt: 5 }] }, report = {};
  assert.equal(validateDefaults(input, { characters: [] }, report), true);
  assert.equal(report.discardedCharacters, 3);
  assert.deepEqual(input.characters.map((c) => c.prompt), ['1girl']);
});

test('queue snapshot fields reject incorrect types/ranges in jobs and lean history', () => {
  const params = { model: 'nai-diffusion-5-curated', prompt: 'cat', uc: '', width: 832, height: 1216,
    steps: 23, scale: 7, cfgRescale: 0, nSamples: 1, seed: '', characters: [character()] };
  assert.equal(validateQueue(queue(params)), true);
  assert.equal(validateQueue(queue({ prompt: 'legacy' })), true);
  for (const patch of [{ model: 1 }, { prompt: {} }, { uc: null }, { width: '832' }, { height: 0 },
    { width: 64.5 }, { steps: 0 }, { steps: Infinity }, { scale: -1 }, { cfgRescale: 1.1 },
    { nSamples: 0 }, { seed: -1 }, { seed: 4294967296 }, { seed: 'oops' }, { sampler: [] },
    { noiseSchedule: '' }, { qualityToggle: 1 }]) {
    const q = queue({ ...params, ...patch });
    assert.equal(validateQueue(q), false, JSON.stringify(patch));
    q.history = q.jobs; q.jobs = [];
    assert.equal(validateQueue(q), false, 'history: ' + JSON.stringify(patch));
  }
  // a queue whose snapshot has an odd character keeps all its jobs
  assert.equal(validateQueue(queue({ ...params, characters: [{}, { prompt: 'cat' }] })), true);
  for (const seed of [0, 4294967295, '42', '4294967295']) assert.equal(validateQueue(queue({ ...params, seed })), true);
});

test('corrupt params / queue fields use durable backup then sanitized error event', async () => {
  const originalDocument = globalThis.document;
  const events = [], rows = new Map();
  globalThis.document = new EventTarget();
  document.addEventListener('nf:persist-error', (event) => {
    assert.ok(rows.has(event.detail.backupKey), 'backup exists before notification');
    events.push(event.detail);
  });
  const storage = { get: (key) => rows.get(key), set: (key, value) => rows.set(key, structuredClone(value)) };
  try {
    const cases = [
      ['nf.params', { v: 1, data: { characters: 'not a list' } }, (d) => validateDefaults(d, { characters: [] }), {}],
      ['queue', { v: 1, data: queue({ steps: 'bad' }) }, validateQueue, { seq: 0, jobs: [], history: [] }],
    ];
    for (const [key, raw, validate, fallback] of cases) {
      rows.set(key, raw);
      assert.deepEqual(await readVersioned(key, { version: 1, validate, fallback, storage, json: false }), fallback);
      const event = events.at(-1);
      assert.equal(event.operation, 'validate');
      assert.deepEqual(rows.get(event.backupKey), raw);
      assert.deepEqual(rows.get(key), { v: 1, data: fallback });
      assert.equal(Object.hasOwn(event, 'data'), false);
    }
  } finally { globalThis.document = originalDocument; }
});
