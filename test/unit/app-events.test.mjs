import test from 'node:test';
import assert from 'node:assert/strict';
import { on, off, emit } from '../../public/js/app/events.js';
import { expandChunks, chunkReferences } from '../../public/js/domain/chunks.js';
import { generationSpec, vibeKey } from '../../public/js/domain/generation.js';

test('application events isolate sync throws and async rejections; await settles all views', async () => {
  const errors = [], seen = [], original = console.error;
  console.error = (...args) => errors.push(args);
  const remove = [
    on('test:isolation', () => { throw Error('sync'); }),
    on('test:isolation', async () => { await Promise.resolve(); throw Error('async'); }),
    on('test:isolation', async (a, b) => { await Promise.resolve(); seen.push(a + b); return 123; }),
  ];
  try {
    assert.equal(await emit('test:isolation', 2, 3), undefined);
    assert.deepEqual(seen, [5]);
    assert.equal(errors.length, 2);
  } finally { remove.forEach((fn) => fn()); console.error = original; }
  await emit('test:isolation', 8, 9);
  assert.deepEqual(seen, [5]);
});

test('dispatch snapshots listeners and off/unsubscribe are idempotent', async () => {
  const seen = [];
  const second = () => seen.push('second');
  const first = on('test:snapshot', () => { seen.push('first'); off('test:snapshot', second); });
  on('test:snapshot', second);
  await emit('test:snapshot');
  await emit('test:snapshot');
  first(); first();
  assert.deepEqual(seen, ['first', 'second', 'first']);
});

test('pure chunks preserve one-pass expansion, unknown refs and legacy names', () => {
  const rows = [{ name: '雨夜', text: '@nested, rain' }, { name: 'old name', text: 'legacy' }, { name: 'nested', text: 'expanded' }];
  assert.equal(expandChunks('@雨夜，@missing\n@old name, tail', rows), '@nested, rain，@missing\nlegacy, tail');
  assert.equal(expandChunks('', rows), '');
  assert.deepEqual(chunkReferences('@old name,', rows), [{ start: 0, end: 9, name: 'old name' }]);
});

test('explicit generation spec uses queued references and never leaks editor values', () => {
  const current = { params: { model: 'editor' }, base: { image: 'draft' }, refs: [1], vibes: [2] };
  assert.deepEqual(generationSpec({ params: { model: 'queue' } }, current, 'zh'), {
    params: { model: 'queue' }, base: undefined, refs: [], vibes: [], nSamples: undefined, lang: 'zh',
  });
  assert.equal(generationSpec(undefined, current, 'en').base, current.base);
  assert.equal(vibeKey('model', 0.567), 'model@0.57');
});
