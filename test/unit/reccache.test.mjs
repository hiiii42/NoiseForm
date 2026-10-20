import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordCache } from '../../public/js/app/reccache.js';

const record = (id) => ({ id, blob: new Blob([id]) });

test('reads refresh LRU order; insertion and metadata updates share the limit', () => {
  const released = [];
  const cache = createRecordCache({ limit: 2, dispose: id => released.push(id) });
  cache.set('a', record('a')).set('b', record('b'));
  assert.equal(cache.get('a').id, 'a');
  cache.set('c', record('c'));
  assert.deepEqual([...cache.keys()], ['a', 'c']);
  assert.deepEqual(released, ['b']);
  cache.set('a', { ...cache.get('a'), saved: true });
  cache.set('d', record('d'));
  assert.equal(cache.get('a').saved, true);
  assert.deepEqual(released, ['b', 'c']);
  for (let i = 0; i < 100; i++) cache.set(String(i), record(String(i)));
  assert.equal(cache.size, 2);
});

test('independent pins survive pressure and release trims temporary overflow', () => {
  const released = [];
  const cache = createRecordCache({ limit: 1, dispose: id => released.push(id) });
  cache.pin('stage', ['a']);
  cache.pin('compare', ['a', 'b']);
  const finish = cache.retain('b');
  cache.set('a', record('a')).set('b', record('b')).set('c', record('c'));
  assert.deepEqual(released, ['c']);
  assert.equal(cache.size, 2, 'only pinned records may exceed the limit');
  cache.pin('compare', []);
  assert.equal(cache.size, 2, 'post operation still holds b');
  finish();
  finish();
  assert.deepEqual(released, ['c', 'b'], 'release is idempotent');
  assert.ok(cache.has('a'));
  cache.pin('stage', []);
  cache.set('d', record('d'));
  assert.deepEqual(released, ['c', 'b', 'a']);
});

test('incoming consumers can pin before asynchronous loading completes', () => {
  const incoming = new Set(['compare']);
  const cache = createRecordCache({ limit: 1, isPinned: id => incoming.has(id) });
  cache.set('compare', record('compare'));
  cache.set('other', record('other'));
  assert.ok(cache.has('compare'));
  incoming.clear();
  cache.set('other', record('other'));
  assert.ok(!cache.has('compare'));
});

test('delete and clear release each cached URL exactly once, including pinned records', () => {
  const released = [];
  const cache = createRecordCache({ dispose: id => released.push(id) });
  cache.pin('stage', ['a']);
  cache.set('a', record('a')).set('b', record('b'));
  assert.equal(cache.delete('a'), true);
  assert.equal(cache.delete('a'), false);
  cache.clear();
  cache.clear();
  assert.deepEqual(released, ['a', 'b']);
  assert.equal(cache.size, 0);
});

test('default bound is 40 and lowering the configured limit evicts immediately', () => {
  const cache = createRecordCache();
  for (let i = 0; i < 60; i++) cache.set(i, record(i));
  assert.equal(cache.size, 40);
  cache.limit = 2;
  assert.deepEqual([...cache.keys()], [58, 59]);
  for (const limit of [0, -1, 1.5, Infinity, NaN]) {
    assert.throws(() => createRecordCache({ limit }), RangeError);
    assert.throws(() => { cache.limit = limit; }, RangeError);
  }
  assert.equal(cache.limit, 2);
});
