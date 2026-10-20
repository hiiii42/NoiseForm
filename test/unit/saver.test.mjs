import test from 'node:test';
import assert from 'node:assert/strict';
import { fileNameFor, fileExists, writeFile } from '../../public/js/saver.js';

const rec = { id: 'record-one', no: 1, seed: 42, kind: 'gen', params: { prompt: 'cat' }, blob: new Blob(['a']) };
test('record identity is stable and unique even on case-insensitive filesystems', () => {
  const ids = ['record-one', 'record-two', 'record-ONE', 'a/b', 'a?b'];
  const names = ids.map((id) => fileNameFor({ ...rec, id }).toLowerCase());
  assert.equal(new Set(names).size, ids.length);
  assert.equal(fileNameFor(rec), fileNameFor(structuredClone(rec)));
});
test('all filename fields are safe on Windows', () => {
  const name = fileNameFor({ ...rec, id: 'CON<>:"/\\|?*\u0000', no: '../', seed: 'x/y:', kind: 'AUX:?', params: { prompt: 'CON <>:"/\\|?*\n...' } });
  assert.doesNotMatch(name, /[<>:"/\\|?*\x00-\x1f]/);
  assert.ok(name.length <= 255);
  assert.throws(() => fileNameFor({ ...rec, id: '' }));
});
test('a legacy same-name file cannot shadow a new record; unique files independently round-trip', async () => {
  const files = new Map([['0001_cat_42.png', rec.blob]]);
  // the old scheme produced 0001_cat_42.png for every record with no=1/prompt=cat/seed=42
  assert.notEqual(fileNameFor(rec), '0001_cat_42.png');
  const dir = { async getFileHandle(name, options) {
    if (!files.has(name) && !options?.create) throw new Error('not found');
    return { async createWritable() { return { async write(blob) { files.set(name, blob); }, async close() {} }; } };
  } };
  assert.equal(await fileExists(dir, '0001_cat_42.png'), true); // a record that saved it itself still finds it
  for (const r of [rec, { ...rec, id: 'record-two', blob: new Blob(['b']) }]) {
    const name = fileNameFor(r);
    assert.equal(await fileExists(dir, name), false);
    await writeFile(dir, name, r.blob);
    assert.equal(await fileExists(dir, name), true);
    assert.equal(await files.get(name).text(), await r.blob.text());
  }
});

test('app-style ids stay readable and cannot collide with encoded ids', () => {
  const raw = fileNameFor({ ...rec, id: 'k3j9x0qa1mzt' });
  assert.match(raw, /_k3j9x0qa1mzt\.png$/);
  const enc = fileNameFor({ ...rec, id: 'A' });
  assert.match(enc, /_h-0041\.png$/);
  assert.notEqual(fileNameFor({ ...rec, id: '0041' }), fileNameFor({ ...rec, id: 'A' }));
});
