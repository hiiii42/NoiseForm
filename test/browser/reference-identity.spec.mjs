import { mockLiveSource } from '../fixtures/mocklive.mjs';
export const options = { init: [mockLiveSource({ delay: 10 })] };

export default async ({ page, assert }) => {
  const keys = await page.run(async () => {
    const g = await import('/js/app/generate.js');
    const { state } = await import('/js/store.js');
    const p = { ...structuredClone(state.params), model: 'nai-diffusion-4-5-full', seed: '42', prompt: 'reference identity' };
    const ref = { id: 'r', image: 'image-a', type: 'character', strength: 0.2, fidelity: 0.3 };
    const spec = { params: p, base: null, vibes: [], refs: [ref] };
    return [g.generationKeyFor(spec), ...[{ strength: 0.9 }, { fidelity: 0.8 }, { type: 'style' }, { image: 'image-b' }].map(change => g.generationKeyFor({ ...spec, refs: [{ ...ref, ...change }] }))];
  });
  assert.ok(keys[0]);
  for (const key of keys.slice(1)) assert.notEqual(key, keys[0], 'effective reference change must change the queue key');
  // Actual archived signature must match the queue prediction; same fixed seed still pauses.
  await page.run(async () => {
    const { state } = await import('/js/store.js');
    Object.assign(state.params, { prompt: 'same fixed output', seed: '42' });
    state.settings.autoFreeOnly = false;
    const q = await import('/js/queue.js');
    window.__job = q.enqueue({ params: structuredClone(state.params), base: null, refs: [], vibes: [] }, { count: 2, seedMode: 'fixed', start: true });
  });
  await page.waitFor("window.__job.status === 'paused' && import('/js/queue.js').then(q => !q.queueRunning())");
  assert.equal(await page.eval('window.__gen'), 1, 'identical fixed-seed queue output still triggers duplicate protection');
  assert.equal(await page.eval('window.__job.done'), 1);
  const archived = await page.run(async () => {
    const q = await import('/js/queue.js');
    q.endJob(window.__job.id);
    const { state } = await import('/js/store.js');
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    window.__ref = { id: 'r', image: cv.toDataURL(), type: 'character', strength: 0.2, fidelity: 0.3 };
    window.__spec = { params: { ...structuredClone(state.params), model: 'nai-diffusion-4-5-full', prompt: 'real reference pipeline', seed: '43' }, base: null, vibes: [], refs: [window.__ref] };
    const g = await import('/js/app/generate.js');
    await g.generate(window.__spec);
    const record = (await import('/js/app/records.js')).history[0];
    return { predicted: g.generationKeyFor(window.__spec), archived: (await import('/js/dupcheck.js')).recordKey(record) };
  });
  assert.equal(archived.archived, archived.predicted, 'archive keeps the complete effective reference signature');
  await page.run(async () => {
    window.__spec.refs = [{ ...window.__ref, strength: 0.9, fidelity: 0.8 }];
    window.__job = (await import('/js/queue.js')).enqueue(window.__spec, { count: 1, start: true });
  });
  await page.waitFor("window.__job.status === 'done' && import('/js/queue.js').then(q => !q.queueRunning())");
  assert.equal(await page.eval('window.__gen'), 3, 'changing reference parameters allows the queued comparison');
  await page.run(async () => { window.__job = (await import('/js/queue.js')).enqueue(window.__spec, { count: 1, start: true }); });
  await page.waitFor("window.__job.dupAck && import('/js/queue.js').then(q => !q.queueRunning())");
  const final = await page.run(async () => ({
    done: window.__job.done, predicted: (await import('/js/app/generate.js')).generationKeyFor(window.__spec),
    archived: (await import('/js/dupcheck.js')).recordKey((await import('/js/app/records.js')).history[0]),
  }));
  assert.equal(final.done, 0);
  assert.equal(final.archived, final.predicted);
  assert.equal(await page.eval('window.__gen'), 3, 'identical reference settings still pause before another request');
};
