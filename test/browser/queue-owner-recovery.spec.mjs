import { mockLiveSource } from '../fixtures/mocklive.mjs';
export const options = { init: [mockLiveSource({ delay: 60000 })] };
export default async ({ page, assert, log }) => {
  await page.run(async () => {
    const q = await import('/js/queue.js'), { state } = await import('/js/store.js');
    state.settings.autoFreeOnly = false;
    q.enqueue({ params: { ...structuredClone(state.params), prompt: 'reload during request' } }, { count: 1, start: true });
  });
  await page.waitFor('window.__gen === 1');
  const liveOwner = await page.run(async () => {
    const { kv } = await import('/js/db.js');
    const before = (await kv.getRaw('queue')).runner;
    const frame = document.createElement('iframe'); frame.src = '/'; document.body.append(frame);
    await new Promise(resolve => frame.onload = resolve);
    await new Promise(resolve => setTimeout(resolve, 500));
    const peer = await frame.contentWindow.eval(`(async()=>{
      const q=await import('/js/queue.js'); await q.loadQueue(); await q.runQueue();
      return {status:q.queueJobs()[0].status,running:q.queueRunning(),calls:window.__gen};
    })()`);
    return { before, after: (await kv.getRaw('queue')).runner, peer };
  });
  assert.equal(liveOwner.after, liveOwner.before, 'recovery cannot clear an active native-lock owner');
  assert.deepEqual(liveOwner.peer, { status: 'running', running: false, calls: 0 });
  await page.reload();
  const recovered = await page.run(async () => {
    const q = await import('/js/queue.js'), { kv } = await import('/js/db.js');
    await q.loadQueue();
    return { job: q.queueJobs()[0], runner: (await kv.getRaw('queue')).runner, running: q.queueRunning() };
  });
  assert.equal(recovered.running, false);
  assert.equal(recovered.runner, null, 'released native lock clears stale runner');
  assert.equal(recovered.job.status, 'paused');
  assert.equal(recovered.job.stage, 'unknown', 'in-flight work requires human reconciliation');
  await page.run(async () => {
    const q = await import('/js/queue.js');
    await q.runQueue();
  });
  assert.equal(await page.eval('window.__gen'), 0, 'Run must not replay an uncertain request');
  const removed = await page.run(async () => {
    const q = await import('/js/queue.js'), { kv } = await import('/js/db.js');
    q.endJob(q.queueJobs()[0].id); await q.loadQueue();
    return { memory: q.queueJobs().length, disk: (await kv.getRaw('queue')).data.jobs.length };
  });
  assert.deepEqual(removed, { memory: 0, disk: 0 });
  log('Native-lock reload: unknown/paused, no replay on Run, deletion remains durable.');
};
