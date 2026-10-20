// Same-origin application iframes are independent realms sharing IDB, Web Locks
// and BroadcastChannel, and stay under the harness network interception.
export default async ({ page, assert, log }) => {
  await page.run(async () => {
    const frame = document.createElement('iframe');
    frame.id = 'peer';
    frame.src = '/';
    document.body.append(frame);
    await new Promise((resolve) => frame.onload = resolve);
  });
  await page.waitFor(`document.querySelector('#peer').contentDocument.querySelector('#btnQueue') &&
    document.querySelector('#peer').contentWindow.eval("import('/js/queue.js').then(q=>!!q.queueJobs())")`);
  await page.wait(1500);
  const start = await page.run(async () => {
    const q = window.__q = await import('/js/queue.js');
    const { state } = await import('/js/store.js');
    state.settings.autoFreeOnly = false;
    window.__calls = 0;
    q.initQueue({ snapshot: () => ({ params: structuredClone(state.params) }), generate: async () => {
      const n = ++window.__calls;
      if (n === 1) await new Promise((resolve) => window.__releaseImage = resolve);
      return { ok: true, recs: [{ id: 'record-' + n, seed: n }] };
    } });
    window.__job = q.enqueue({ params: { ...structuredClone(state.params), prompt: 'leader' } }, { count: 1, start: true });
    return window.__job.id;
  });
  await page.waitFor('window.__calls === 1');
  await page.waitFor(`document.querySelector('#peer').contentWindow.eval("import('/js/queue.js').then(q=>q.queueJobs().length===1)")`);
  const denied = await page.run(async () => {
    return document.querySelector('#peer').contentWindow.eval(`(async()=>{
      const q=window.__q=await import('/js/queue.js');
      const {state}=await import('/js/store.js'); window.__calls=0;
      q.initQueue({snapshot:()=>({params:structuredClone(state.params)}),generate:async()=>{window.__calls++;return {ok:true,recs:[{id:'wrong',seed:1}]}}});
      await q.runQueue();
      return {running:q.queueRunning(),calls:window.__calls,text:document.body.textContent};
    })()`);
  });
  assert.equal(denied.running, false);
  assert.equal(denied.calls, 0);
  assert.match(denied.text, /另一个标签页正在运行队列|Another tab is running the queue/);

  const added = await page.run(async () => document.querySelector('#peer').contentWindow.eval(`(async()=>{
    const q=window.__q, {state}=await import('/js/store.js');
    q.queueJobs()[0].done=999; // stale follower edit must not replace the runner
    return q.enqueue({params:{...structuredClone(state.params),prompt:'peer addition'}},{count:1}).id;
  })()`));
  await page.waitFor(`window.__q.queueJobs().some(j=>j.id===${JSON.stringify(added)})`);
  assert.equal(await page.eval('window.__job.done'), 0, 'runner progress wins conflicting follower writes');
  await page.run(() => window.__releaseImage());
  await page.waitFor('window.__calls === 2 && !window.__q.queueRunning()');
  await page.waitFor(`document.querySelector('#peer').contentWindow.eval("window.__q.queueJobs().length===0")`);
  const result = await page.run(async () => {
    const { kv } = await import('/js/db.js');
    return { disk: await kv.getRaw('queue'), followerCalls: document.querySelector('#peer').contentWindow.__calls };
  });
  assert.equal(result.followerCalls, 0);
  assert.deepEqual(result.disk.data.jobs, []);
  assert.deepEqual(new Set(result.disk.data.history.map((j) => j.id)), new Set([start, added]));
  assert.equal(result.disk.data.history.find((j) => j.id === start).done, 1);
  assert.ok(result.disk.revision > 0 && result.disk.updatedAt > 0);

  await page.run(async () => (await import('/js/store.js')).set('settings.theme', 'dusk'));
  await page.waitFor(`document.querySelector('#peer').contentWindow.eval("import('/js/store.js').then(s=>s.state.settings.theme==='dusk')")`);

  const fallback = await page.run(async () => {
    const { createTabCoordinator } = await import('/js/tabs.js');
    const a = createTabCoordinator({ locks: null, channelName: 'nf:test:fallback' });
    const b = await document.querySelector('#peer').contentWindow.eval(`import('/js/tabs.js').then(m=>window.__fallback=m.createTabCoordinator({locks:null,channelName:'nf:test:fallback'}))`);
    // Return an object only inside the browser; no CDP serialization boundary here.
    const releases = await Promise.all([a.acquireRunLock(), b.acquireRunLock()]);
    const winners = releases.filter(Boolean).length;
    await Promise.all(releases.filter(Boolean).map((release) => release()));
    const next = await b.acquireRunLock();
    const reacquired = !!next;
    await next?.();
    await a.close(); await b.close();
    return { winners, reacquired };
  });
  assert.deepEqual(fallback, { winners: 1, reacquired: true });
  log('Two independent app realms: one runner, conflict-safe queue writes, read-only peer refresh, settings sync; IDB/BroadcastChannel fallback also exclusive.');
};
