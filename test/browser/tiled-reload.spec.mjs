import { mockLiveSource } from '../fixtures/mocklive.mjs';

// The shared fixture uses thumbnails; composition requires the actual requested dimensions.
const mock = mockLiveSource({ tier: 3, delay: 100 })
  .replace('cv.width = 64;', 'cv.width = body.parameters.width;')
  .replace('cv.height = 96;', 'cv.height = body.parameters.height;')
  .replace('g.fillRect(0, 0, 64, 96);', 'g.fillRect(0, 0, cv.width, cv.height);');
export const options = { init: [mock] };

export default async ({ page, assert, log }) => {
  await page.run(async () => {
    const { state, emit } = await import('/js/store.js');
    Object.assign(state.params, { prompt: 'tiled recovery', width: 832, height: 1216, steps: 1, seed: '42' });
    emit('params');
    (await import('/js/ui/panel.js')).refreshAll();
    document.querySelector('#btnGenerate').click();
  });
  await page.waitFor("(async()=> (await (await import('/js/db.js')).images.list()).some(r=>r.kind==='gen'))()");
  const sourceId = await page.run(async () => (await (await import('/js/db.js')).images.list()).find((r) => r.kind === 'gen').id);
  for (const failCompose of [false, true]) {
    await page.run(async (sourceId) => {
      const { images } = await import('/js/db.js');
      const { state } = await import('/js/store.js');
      const q = await import('/js/queue.js');
      window.__q = q;
      const pause = () => { q.pauseQueue(); q.offQueue('tiledCell', pause); };
      q.onQueue('tiledCell', pause);
      await (await import('/js/ui/tiled.js')).openTiled(await images.get(sourceId), {
        getBlob: (r) => r.blob,
        snapshot: () => ({ params: { ...state.params, prompt: 'tiled recovery', steps: 1, seed: '42' }, vibes: [], refs: [] }),
      });
      document.querySelector('.tiled-start').click();
    }, sourceId);
    await page.waitFor("window.__q.queueJobs().some(j=>j.kind==='tiled'&&j.done===1)&&!window.__q.queueRunning()", 20000);
    const before = await page.run(async () => {
      const job = window.__q.queueJobs()[0];
      // Wait for the actual persisted checkpoint, not just in-memory progress.
      const { kv } = await import('/js/db.js');
      for (let i = 0; i < 30; i++) {
        if ((await kv.get('queue'))?.jobs.some((j) => j.id === job.id && j.done === 1)) return { id: job.tiledId, meta: job.meta, calls: window.__gen };
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('checkpoint not persisted');
    });
    assert.equal(before.meta.tiles.length, 2);
    assert.equal(before.meta.sourceId, sourceId);
    await page.reload();
    await page.run(async (failCompose) => {
      window.__q = await import('/js/queue.js');
      if (failCompose) {
        window.__originalImageData = CanvasRenderingContext2D.prototype.createImageData;
        CanvasRenderingContext2D.prototype.createImageData = function () { throw new Error('injected compose failure'); };
      }
      window.__q.runQueue();
    }, failCompose);
    if (failCompose) {
      await page.waitFor("!window.__q.queueRunning()&&window.__q.queueJobs()[0]?.stage==='compose'", 20000);
      const paused = await page.run(() => ({ status: window.__q.queueJobs()[0].status, done: window.__q.queueJobs()[0].done, calls: window.__gen }));
      assert.deepEqual(paused, { status: 'paused', done: 2, calls: 1 });
      await page.run(() => {
        CanvasRenderingContext2D.prototype.createImageData = window.__originalImageData;
        window.__q.runQueue();
      });
    }
    await page.waitFor("!window.__q.queueRunning()&&window.__q.queueJobs().length===0", 25000);
    assert.equal(await page.eval('window.__gen'), 1, 'only the remaining tile is generated after reload/retry');
    await page.waitFor("(async()=> (await (await import('/js/db.js')).kv.get('queue'))?.jobs.length===0)()");
    const result = await page.run(async (id) => {
      const { images, kv } = await import('/js/db.js');
      const all = await images.list();
      const job = (await kv.get('queue')).history.find((j) => j.tiledId === id);
      const finals = all.filter((r) => r.kind === 'upscale' && r.tiled?.id === id);
      // Re-enter the real finalizer; onResult must never be reached.
      const again = await (await import('/js/ui/tiled.js')).finalizeTiledJob(job, {
        findRecords: (pred) => all.filter(pred),
        onResult: () => { throw new Error('duplicate final result'); },
      });
      return { tiles: all.filter((r) => r.kind === 'tile' && r.tiled?.id === id).length,
        finals: finals.length, status: job.status, same: again.id === finals[0]?.id,
        dimensions: [finals[0]?.width, finals[0]?.height] };
    }, before.id);
    assert.deepEqual(result, { tiles: 2, finals: 1, status: 'done', same: true, dimensions: [before.meta.outW, before.meta.outH] });
    log(failCompose ? 'composition failure paused; retry generated zero additional tiles' : 'reload after tile 1 produced exactly one final upscale');
  }
};
