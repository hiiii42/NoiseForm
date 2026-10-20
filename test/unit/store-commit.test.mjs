import test from 'node:test';
import assert from 'node:assert/strict';
import { state, DEFAULT_PARAMS, commit, on, set, patch } from '../../public/js/store.js';

let pendingTimers;
test.beforeEach((t) => {
  state.params = structuredClone(DEFAULT_PARAMS);
  pendingTimers = [];
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => {
    const timer = { fn, ms };
    pendingTimers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer) => {
    const index = pendingTimers.indexOf(timer);
    if (index >= 0) pendingTimers.splice(index, 1);
  });
});

function watch(t, paths, fn) {
  t.after(on(paths, fn));
}

test('commit emits only changed top-level leaves, then one root and wildcard, with final state visible', (t) => {
  const events = [];
  for (const path of ['params.prompt', 'params.steps', 'params.uc', 'params', '*']) {
    watch(t, path, (value, emitted) => {
      events.push([path, emitted, structuredClone(value)]);
      assert.equal(state.params.prompt, 'new');
      assert.equal(state.params.steps, 28);
    });
  }
  assert.equal(commit('params', { prompt: 'new', steps: 28, uc: '' }), true);
  assert.deepEqual(events.map(([path, emitted]) => [path, emitted]), [
    ['params.prompt', 'params.prompt'], ['params.steps', 'params.steps'], ['params', 'params'], ['*', 'params'],
  ]);
  assert.equal(events[0][2], 'new');
  assert.equal(events[1][2], 28);
  assert.deepEqual(events[2][2], state.params);
});

test('commit deduplicates the same callback across leaves, root and wildcard', (t) => {
  const calls = [];
  watch(t, ['params.prompt', 'params.steps', 'params', '*'], (value, path, change) => calls.push({ value, path, change }));
  commit('params', { prompt: 'new', steps: 28 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'params.prompt');
  assert.deepEqual(calls[0].change, { root: 'params', keys: ['prompt', 'steps'] });
  assert.ok(Object.isFrozen(calls[0].change.keys));
});

test('equal arrays and reordered nested object keys do not notify or schedule persistence', (t) => {
  const character = { id: 'c', prompt: '1girl', position: { x: .2, y: .7 } };
  state.params.characters = [character];
  const timers = globalThis.setTimeout;
  watch(t, '*', () => assert.fail('unchanged commit must not notify'));
  assert.equal(commit('params', { characters: [{ position: { y: .7, x: .2 }, prompt: '1girl', id: 'c' }] }), false);
  assert.equal(state.params.characters[0], character, 'equal values retain live editor references');
  assert.equal(timers.mock.callCount(), 0);
});

test('mutating a draft detects nested array changes and retains root and unchanged references', (t) => {
  state.params.characters = [{ id: 'c', prompt: '1girl', x: .2 }];
  const params = state.params;
  const events = [];
  watch(t, ['params.characters', 'params'], (value, path) => events.push(path));
  commit('params', (draft) => { draft.characters[0].x = .8; });
  assert.equal(state.params, params);
  assert.equal(params.characters[0].x, .8);
  assert.deepEqual(events, ['params.characters']);
  const characters = params.characters;
  commit('params', { prompt: 'new' });
  assert.equal(params.characters, characters, 'unmodified characters keep editor callbacks attached to live objects');
});

test('a mutator that restores its original value is a no-op', (t) => {
  watch(t, '*', () => assert.fail('reverted draft must not notify'));
  assert.equal(commit('params', (draft) => { draft.steps++; draft.steps--; }), false);
});

test('replace removes omitted fields, emits removed leaves and preserves the root object', (t) => {
  const root = state.params;
  const removed = [];
  watch(t, 'params.steps', (value, path) => removed.push([path, value]));
  commit('params', { prompt: 'only' }, { replace: true });
  assert.equal(state.params, root);
  assert.deepEqual(root, { prompt: 'only' });
  assert.deepEqual(removed, [['params.steps', undefined]]);
});

test('merge clones supplied values so later caller mutations cannot silently change state', () => {
  const next = { characters: [{ id: 'c', prompt: '1girl' }] };
  commit('params', next);
  next.characters[0].prompt = 'caller edit';
  assert.equal(state.params.characters[0].prompt, '1girl');
  assert.equal(state.params.steps, DEFAULT_PARAMS.steps);
});

test('failed and asynchronous mutators leave live state untouched and do not notify', (t) => {
  const before = structuredClone(state.params);
  watch(t, '*', () => assert.fail('failed draft must not notify'));
  assert.throws(() => commit('params', (draft) => { draft.prompt = 'lost'; throw new Error('abort'); }), /abort/);
  assert.throws(() => commit('params', async (draft) => { draft.prompt = 'lost'; }), /synchronous/);
  assert.deepEqual(state.params, before);
});

test('one multi-field commit schedules exactly one persistence timer and writes once', async (t) => {
  const previous = globalThis.localStorage;
  const writes = [];
  globalThis.localStorage = { setItem: (key, value) => writes.push([key, JSON.parse(value)]) };
  t.after(() => { globalThis.localStorage = previous; });
  const timers = globalThis.setTimeout;
  commit('params', { prompt: 'new', steps: 28, scale: 5, characters: [{ id: 'c' }] });
  assert.equal(timers.mock.callCount(), 1);
  assert.equal(timers.mock.calls[0].arguments[1], 250);
  assert.equal(pendingTimers.length, 1);
  pendingTimers[0].fn();
  await Promise.resolve();
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'nf.params');
  assert.deepEqual(writes[0][1].data, state.params);
});

test('legacy set still bubbles; patch still emits supplied unchanged leaves and a separate root', (t) => {
  const paths = [];
  watch(t, ['params.prompt', 'params'], (value, path) => paths.push(path));
  set('params.prompt', 'new');
  assert.deepEqual(paths, ['params.prompt']);
  paths.length = 0;
  patch('params', { prompt: 'new' });
  assert.deepEqual(paths, ['params.prompt', 'params']);
});
