import test from 'node:test';
import assert from 'node:assert/strict';
import { invoke } from '../../public/js/callbacks.js';
import { state, on, set, commit } from '../../public/js/store.js';

const quiet = async (fn) => {
  const original = console.error, logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try { await fn(); } finally { console.error = original; }
  return logged;
};

test('invoke returns the value, swallows and reports a throw or a rejection', async () => {
  const logged = await quiet(async () => {
    assert.equal(invoke((a, b) => a + b, 'sum', 2, 3), 5);
    assert.equal(invoke(() => { throw new Error('boom'); }, 'x'), undefined);
    invoke(async () => { throw new Error('later'); }, 'y');
    await new Promise((r) => setTimeout(r, 0));
  });
  assert.equal(logged.length, 2);
  assert.match(logged[0], /"x".*boom/s);
  assert.match(logged[1], /"y".*later/s);
});

test('a throwing store subscriber does not stop later subscribers or the change itself', async () => {
  const seen = [];
  const offA = on('params.prompt', () => { throw new Error('bad listener'); });
  const offB = on('params.prompt', (v) => seen.push(v));
  const offC = on('params', () => seen.push('root'));
  const logged = await quiet(() => {
    set('params.prompt', 'one');
    commit('params', { prompt: 'two' });
  });
  offA(); offB(); offC();
  assert.equal(state.params.prompt, 'two');
  assert.deepEqual(seen, ['one', 'root', 'two', 'root']);
  assert.equal(logged.length, 2);
});
