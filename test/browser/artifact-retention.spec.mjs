import { mockLiveSource } from '../fixtures/mocklive.mjs';
export const options = { init: [mockLiveSource({ delay: 10 })] };

export default async ({ page, assert }) => {
  await page.run(async () => {
    const { state } = await import('/js/store.js');
    state.settings.autoFreeOnly = false;
    state.params.prompt = 'six successful outputs';
    const q = await import('/js/queue.js');
    window.__job = q.enqueue({ params: structuredClone(state.params), base: null, refs: [], vibes: [] }, { count: 6, start: true });
  });
  await page.waitFor("window.__job.status === 'done' && import('/js/queue.js').then(q => !q.queueRunning())", 25000);
  // Inspect the actual recovery Map, including persisted entries hidden by getPendingSaves().
  const proto = await page.send('Runtime.evaluate', { expression: 'Map.prototype', returnByValue: false });
  const maps = await page.send('Runtime.queryObjects', { prototypeObjectId: proto.result.result.objectId });
  const retained = await page.send('Runtime.callFunctionOn', {
    objectId: maps.result.objects.objectId, returnByValue: true,
    functionDeclaration: `function() { return this.reduce((n,m)=>n+[...m.values()].filter(v=>v?.stage==='persisted' && v?.context?.execution && Array.isArray(v.items)).length,0); }`,
  });
  assert.equal(retained.result.result.value, 0, 'successful queue outputs release recovery ownership');
  assert.equal(await page.eval('window.__gen'), 6);
  const recovery = await page.run(async () => {
    const { state } = await import('/js/store.js'), { images } = await import('/js/db.js');
    const q = await import('/js/queue.js');
    window.__put = images.put; window.__writes = 0;
    images.put = async () => { throw new DOMException('quota', 'QuotaExceededError'); };
    window.__job = q.enqueue({ params: { ...structuredClone(state.params), prompt: 'recover once' }, base: null, refs: [], vibes: [] }, { count: 1, start: true });
    return true;
  });
  assert.ok(recovery);
  await page.waitFor("window.__job.status === 'paused' && import('/js/queue.js').then(q => !q.queueRunning())");
  await page.run(async () => {
    const { images } = await import('/js/db.js');
    images.put = async r => { window.__writes++; return window.__put(r); };
  });
  await page.click('#btnPendingSaves');
  await page.click('[data-retry-save]');
  await page.waitFor("import('/js/app/generate.js').then(g => g.getPendingSaves().length === 0)");
  assert.equal(await page.eval("import('/js/app/generate.js').then(g => g.pendingSaveCount())"), 1, 'completed recovery stays available until queue consumes it');
  await page.run(async () => (await import('/js/queue.js')).runQueue());
  await page.waitFor("window.__job.status === 'done' && import('/js/queue.js').then(q => !q.queueRunning())");
  assert.equal(await page.eval('window.__gen'), 7);
  assert.equal(await page.eval('window.__writes'), 1, 'UI save and queue resume commit once');
  assert.equal(await page.eval("import('/js/app/generate.js').then(g => g.pendingSaveCount())"), 0);
};
