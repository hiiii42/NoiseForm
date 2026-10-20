export default async ({ page, assert, log }) => {
  await page.run(async () => {
    const frame = document.createElement('iframe');
    frame.id = 'causal-peer'; frame.src = '/'; document.body.append(frame);
    await new Promise(resolve => frame.onload = resolve);
  });
  await page.wait(1500);
  await page.run(async () => {
    const q = window.__q = await import('/js/queue.js');
    const { kv } = await import('/js/db.js');
    const { state } = await import('/js/store.js');
    const update = kv.updateRaw;
    let first = true;
    kv.updateRaw = async (...args) => {
      if (args[0] === 'queue' && first) {
        first = false;
        await new Promise(resolve => window.__release = resolve);
      }
      return update(...args);
    };
    const snap = prompt => ({ params: { ...structuredClone(state.params), prompt } });
    const a = q.enqueue(snap('removed before commit'), { count: 1 });
    q.endJob(a.id);
    const b = q.enqueue(snap('also removed'), { count: 1 });
    const c = q.enqueue(snap('retained local'), { count: 1 });
    const d = q.enqueue(snap('reordered local'), { count: 1 });
    q.toggleQueue(document.querySelector('#btnQueue'));
    document.querySelectorAll('.qj')[2].querySelector('[aria-label="Up"], [aria-label="上移"]').click();
    q.endJob(b.id);
    window.__expected = [d.id, c.id];
  });
  await page.waitFor('typeof window.__release === "function"');
  const remote = await page.run(async () => document.querySelector('#causal-peer').contentWindow.eval(`(async()=>{
    const q=await import('/js/queue.js'), {state}=await import('/js/store.js');
    const j=q.enqueue({params:{...structuredClone(state.params),prompt:'remote addition'}},{count:1});
    await q.loadQueue(); return j.id;
  })()`));
  const result = await page.run(async () => {
    window.__release();
    await window.__q.loadQueue();
    const disk = await (await import('/js/db.js')).kv.getRaw('queue');
    return { expected: window.__expected, memory: window.__q.queueJobs().map(j => j.id), disk: disk.data.jobs.map(j => j.id) };
  });
  assert.deepEqual(result.memory.filter(id => id !== remote), result.expected, 'local deletes and reorder survive queued writes');
  assert.deepEqual(result.disk, result.memory);
  assert.equal(result.disk.filter(id => id === remote).length, 1, 'concurrent remote addition survives');
  await page.run(async () => {
    const q = window.__q, { kv } = await import('/js/db.js'), { state } = await import('/js/store.js');
    const update = kv.updateRaw;
    let calls = 0;
    kv.updateRaw = async (...args) => {
      if (args[0] === 'queue' && ++calls <= 2) {
        const n = calls;
        await new Promise(resolve => window['__gate' + n] = resolve);
      }
      return update(...args);
    };
    const j = q.enqueue({ params: { ...structuredClone(state.params), prompt: 'delete during a pending refresh' } }, { count: 1 });
    window.__removedDuringLoad = j.id;
    window.__loading = q.loadQueue(); // captures the first pending write
    q.endJob(j.id);                  // appends a second pending write
  });
  await page.waitFor('typeof window.__gate1 === "function"');
  await page.run(() => window.__gate1());
  await page.waitFor('typeof window.__gate2 === "function"');
  await page.wait(150);
  assert.equal(await page.eval('window.__q.queueJobs().some(j=>j.id===window.__removedDuringLoad)'), false,
    'a refresh awaiting an earlier write must not resurrect a later pending delete');
  await page.run(async () => { window.__gate2(); await window.__loading; await window.__q.loadQueue(); });
  assert.equal(await page.eval('window.__q.queueJobs().some(j=>j.id===window.__removedDuringLoad)'), false);
  log('Delayed first write + enqueue/delete/reorder + independent peer addition: memory and disk agree.');
};
