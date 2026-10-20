// 1.8.6: a queue event listener that throws (X/Y grid, tiled dialog, any UI) must not break the run loop.
export default async ({ page, assert, log }) => {
  const r = await page.run(async () => {
    const q = await import('/js/queue.js');
    const { state } = await import('/js/store.js');
    state.settings.autoFreeOnly = false;
    state.settings.autoMode = 'loop';
    const snapshot = () => ({ params: { ...structuredClone(state.params), prompt: 'listener isolation', seed: '' } });
    let requests = 0, healthy = 0;
    q.initQueue({ snapshot, applySnapshot() {}, generate: async ({ seed }) => ({ ok: true, recs: [{ id: 'stub-' + (++requests), seed }] }) });
    const bad = () => { throw new Error('injected-listener'); };
    const good = () => healthy++;
    q.onQueue('step', bad); q.onQueue('step', good);
    const logged = [], original = console.error;
    console.error = (...a) => { if (String(a[1]?.message).includes('injected-listener')) logged.push(a[0]); else original(...a); };
    let job;
    try {
      job = q.enqueue(snapshot(), { count: 3 });
      await q.runQueue();
    } finally { console.error = original; q.offQueue('step', bad); q.offQueue('step', good); }
    const done = q.queueJobs().find((j) => j.id === job.id) || null;
    return { requests, healthy, logged: logged.length, running: q.queueRunning(), left: done ? done.status : 'finished' };
  });
  assert.equal(r.requests, 3, 'all three images generated');
  assert.ok(r.healthy >= 3, 'the next listener still ran: ' + r.healthy);
  assert.ok(r.logged >= 3, 'the faulty listener was reported each time');
  assert.equal(r.running, false);
  assert.equal(r.left, 'finished');
  log('throwing step listener: 3/3 generated, healthy listener ran ' + r.healthy + '×, loop released');
};
