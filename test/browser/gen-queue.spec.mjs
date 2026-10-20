import { mockLiveSource } from '../fixtures/mocklive.mjs';
export const options = { init: [mockLiveSource({ delay: 450 })] };

export default async ({ page, assert }) => {
  await page.run(async () => {
    const { state } = await import('/js/store.js');
    const q = await import('/js/queue.js');
    window.__snap = (prompt, extra = {}) => ({ params: { ...structuredClone(state.params), prompt, seed: '', ...extra }, base: null, vibes: [], refs: [] });
    state.settings.autoFreeOnly = true;
    window.__batch = q.enqueue(window.__snap('batch', { steps: 40, model: 'nai-diffusion-4-5-full' }), { count: 2, start: true });
  });
  await page.waitFor("import('/js/queue.js').then(q=>!q.queueRunning())");
  assert.equal(await page.eval('window.__gen'), 0, 'free-only guard sends no paid request');
  await page.run(async () => {
    (await import('/js/store.js')).state.settings.autoFreeOnly = false;
    (await import('/js/queue.js')).runQueue();
  });
  await page.waitFor('window.__gen === 1');
  await page.run(async () => {
    window.__cut = (await import('/js/queue.js')).cutIn(window.__snap('cut-in', { seed: '987' }));
  });
  await page.waitFor("window.__batch.status === 'done'");
  const order = await page.eval('window.__genBodies.map(b=>b.input)');
  assert.ok(order[0].startsWith('batch'));
  assert.ok(order[1].startsWith('cut-in'));
  assert.ok(order[2].startsWith('batch'));
  await page.run(async () => {
    const q = await import('/js/queue.js');
    window.__repeat = q.enqueue(window.__snap('same seeds'), { count: 2, seedFrom: window.__batch.id, start: true });
  });
  await page.waitFor("window.__repeat.status === 'done'");
  assert.deepEqual(await page.eval('window.__repeat.seeds'), await page.eval('window.__batch.seeds'));
  await page.run(async () => {
    const q = await import('/js/queue.js');
    const snap = window.__snap('grid');
    window.__cells = [];
    q.onQueue('xycell', (e) => window.__cells.push(e));
    window.__grid = q.enqueueXY({ gridId: 'g', snap, freeOnly: false, cells: [
      { key: 'a', x: 0, y: 0, seed: 101, params: { ...snap.params, scale: 3 } },
      { key: 'b', x: 1, y: 0, seed: 102, params: { ...snap.params, scale: 7 } },
    ] });
  });
  await page.waitFor("window.__grid.status === 'done'");
  assert.deepEqual(await page.eval('window.__cells.map(c=>c.key)'), ['a', 'b']);
  assert.deepEqual(await page.eval('window.__genBodies.slice(-2).map(b=>[b.parameters.seed,b.parameters.scale])'), [[101, 3], [102, 7]]);
  assert.equal(await page.eval('window.__gen'), 7);
};
