// Every realm lacks native Web Locks. No generation calls leave the page.
export const options = { init: ["Object.defineProperty(navigator, 'locks', { value: undefined });"] };
export default async ({ page, assert, log }) => {
  await page.run(async () => {
    const frame = document.createElement('iframe'); frame.id = 'lease-peer'; frame.src = '/'; document.body.append(frame);
    await new Promise(resolve => frame.onload = resolve);
  });
  await page.wait(1200);
  await page.run(async () => {
    const q = window.__q = await import('/js/queue.js'), { state } = await import('/js/store.js');
    state.settings.autoFreeOnly = false;
    window.__calls = 0;
    q.initQueue({ snapshot: () => ({ params: structuredClone(state.params) }), generate: async () => {
      window.__calls++;
      await new Promise(resolve => window.__resumeOld = resolve);
      return { ok: true, recs: [{ id: 'stale-owner-result', seed: 1 }] };
    } });
    window.__old = q.enqueue({ params: { ...structuredClone(state.params), prompt: 'interrupted owner' } }, { count: 2, start: true });
  });
  await page.waitFor('window.__calls === 1');
  const takeover = await page.run(async () => {
    const { kv } = await import('/js/db.js');
    // Deterministic suspension boundary: the old owner stops heartbeating.
    const originalUpdate = (await import('/js/tabs.js')).tabs;
    window.__oldToken = originalUpdate.runToken();
    await kv.updateRaw('queue.runLock', row => ({ ...row, data: { ...row.data, expiresAt: 0 } }));
    return document.querySelector('#lease-peer').contentWindow.eval(`(async()=>{
      const q=window.__q=await import('/js/queue.js'), {state}=await import('/js/store.js');
      state.settings.autoFreeOnly=false; window.__calls=0;
      q.initQueue({snapshot:()=>({params:structuredClone(state.params)}),generate:async()=>{
        window.__calls++; await new Promise(resolve=>window.__resumeNew=resolve);
        return {ok:true,recs:[{id:'new-owner-result',seed:2}]};
      }});
      await q.runQueue();
      const old=q.queueJobs()[0]; const recovered={status:old.status,stage:old.stage,calls:window.__calls};
      q.endJob(old.id); await q.loadQueue();
      window.__new=q.enqueue({params:{...structuredClone(state.params),prompt:'new owner'}},{count:1,start:true});
      return recovered;
    })()`);
  });
  assert.deepEqual(takeover, { status: 'paused', stage: 'unknown', calls: 0 }, 'takeover must not replay the interrupted request');
  await page.waitFor("document.querySelector('#lease-peer').contentWindow.__calls === 1");
  await page.run(() => window.__resumeOld());
  await page.waitFor('!window.__q.queueRunning()');
  const fenced = await page.run(async () => {
    const { kv } = await import('/js/db.js');
    const disk = await kv.getRaw('queue');
    const peer = document.querySelector('#lease-peer').contentWindow;
    return { oldCalls: window.__calls, oldDone: window.__old.done, peerRunning: peer.__q.queueRunning(),
      jobs: disk.data.jobs.map(j => j.id), expected: peer.__new.id, stale: JSON.stringify(disk).includes('stale-owner-result') };
  });
  assert.equal(fenced.oldCalls, 1, 'resumed old owner must not execute the next image');
  assert.equal(fenced.oldDone, 0, 'resumed old owner must not accept stale progress');
  assert.equal(fenced.peerRunning, true);
  assert.deepEqual(fenced.jobs, [fenced.expected]);
  assert.equal(fenced.stale, false);
  await page.run(() => document.querySelector('#lease-peer').contentWindow.__resumeNew());
  await page.waitFor("document.querySelector('#lease-peer').contentWindow.__new.status === 'done'");
  log('Expired owner resumes while successor is running: no next request, no stale completion/write, successor remains owner.');
};
