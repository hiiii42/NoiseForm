import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeTiledJob, planTiles } from '../../public/js/tiled.js';

function fixture() {
  const meta = { version: 1, ...planTiles({ width: 832, height: 1216 }), sourceId: 'source',
    feather: 128, overlap: 128, scale: 'auto', strength: 0.4, noise: 0.4, seed: 42 };
  const job = { tiledId: 'job', meta, recs: meta.tiles.map((_, i) => 'tile' + i) };
  const archive = job.recs.map((id, i) => ({ id, kind: 'tile', tiled: { id: 'job', key: String(i) } }));
  let compositions = 0;
  const deps = {
    findRecords: (pred) => archive.filter(pred),
    getRecord: async (id) => archive.find((r) => r.id === id),
    getBlob: async () => new Blob(['tile']),
    composite: async (w, h, tiles, blobs, options) => {
      compositions++;
      assert.equal(w, meta.outW); assert.equal(h, meta.outH);
      assert.deepEqual(tiles, meta.tiles); assert.equal(blobs.length, tiles.length);
      assert.equal(options.feather, 128);
      return new Blob(['composite']);
    },
    onResult: async (result) => {
      const rec = { ...result, id: 'final', kind: 'upscale' };
      archive.push(rec);
      return rec;
    },
  };
  return { job, archive, deps, compositions: () => compositions };
}

test('persisted metadata reconstructs result and concurrent/reloaded finalizers are idempotent', async () => {
  const f = fixture();
  assert.equal(f.job.recs.length, 2);
  const [a, b] = await Promise.all([finalizeTiledJob(f.job, f.deps), finalizeTiledJob(structuredClone(f.job), f.deps)]);
  assert.equal(a, b);
  assert.deepEqual(a.tiled, { ...f.job.meta, id: 'job', recs: f.job.recs });
  assert.equal(a.sourceId, 'source');
  f.deps.getBlob = () => { throw new Error('must not read tiles again'); };
  assert.equal(await finalizeTiledJob(structuredClone(f.job), f.deps), a);
  assert.equal(f.compositions(), 1);
});

test('missing metadata, swapped records and missing blobs reject without creating a result', async () => {
  for (const corrupt of [
    (f) => { f.job.meta = null; },
    (f) => { f.job.recs.reverse(); },
    (f) => { f.deps.getBlob = async () => null; },
  ]) {
    const f = fixture(); corrupt(f);
    await assert.rejects(finalizeTiledJob(f.job, f.deps));
    assert.equal(f.archive.filter((r) => r.kind === 'upscale').length, 0);
  }
});

test('composition and result persistence failures can retry', async () => {
  for (const key of ['composite', 'onResult']) {
    const f = fixture(), original = f.deps[key];
    f.deps[key] = async () => { throw new Error('injected failure'); };
    await assert.rejects(finalizeTiledJob(f.job, f.deps), /injected/);
    f.deps[key] = original;
    await finalizeTiledJob(f.job, f.deps);
    assert.equal(f.archive.filter((r) => r.kind === 'upscale').length, 1);
  }
});
