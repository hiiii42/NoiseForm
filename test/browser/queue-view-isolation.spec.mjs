// Fault-inject each rendering region while exercising the public queue facade.
// generate is an in-memory stub; no API calls or screenshots are needed.
export default async ({ page, assert, log }) => {
  const result = await page.run(async () => {
    const q = await import('/js/queue.js');
    const { state } = await import('/js/store.js');
    const { kv } = await import('/js/db.js');
    const expected = ['closeQueue', 'cutIn', 'endJob', 'enqueue', 'enqueueTiled', 'enqueueXY', 'headJob', 'initQueue',
      'loadQueue', 'offQueue', 'onQueue', 'paintAutoButton', 'paramDiff', 'pauseQueue', 'promptDiff', 'queueJobs',
      'queueRunning', 'runQueue', 'seedLabel', 'setAutoRunningQuery', 'setTiledFinalizer', 'toggleLoop', 'toggleQueue', 'xyJobState'];
    const missing = expected.filter((key) => typeof q[key] !== 'function');
    state.settings.autoFreeOnly = false;
    state.settings.autoMode = 'loop';
    const snapshot = () => ({ params: { ...structuredClone(state.params), prompt: 'render isolation', seed: '' } });
    let requests = 0, steps = 0;
    q.initQueue({ snapshot, applySnapshot() {}, generate: async ({ seed }) => ({ ok: true, recs: [{ id: `stub-${++requests}`, seed }] }) });
    const step = () => steps++;
    q.onQueue('step', step);
    q.toggleQueue(document.querySelector('#btnQueue'));
    const seen = new Set(), restore = [];
    const inject = (node, method, label) => {
      const original = node[method];
      node[method] = () => { throw new Error(`injected-${label}`); };
      restore.push(() => { node[method] = original; });
    };
    // Capture only the intentional failures; unrelated errors still reach the harness.
    const originalError = console.error;
    console.error = (...args) => {
      if (args[0] === '[queue] paint' && args[1]?.message?.startsWith('injected-')) seen.add(args[1].message);
      else originalError(...args);
    };
    let job;
    try {
      inject(document.querySelector('#btnAuto'), 'querySelector', 'auto');
      inject(document.querySelector('#btnQueue'), 'querySelector', 'badge');
      inject(document.querySelector('#lockStrip'), 'replaceChildren', 'strip');
      inject(document.querySelector('.queue-pop'), 'replaceChildren', 'popover');
      job = q.enqueue(snapshot(), { count: 2 });
      await q.runQueue();
    } finally {
      restore.reverse().forEach((fn) => fn());
      console.error = originalError;
      q.offQueue('step', step);
      q.closeQueue();
    }
    const disk = await kv.getRaw('queue');
    // A later batch proves the scheduler and DOM recover normally after the faults.
    const next = q.enqueue(snapshot(), { count: 1 });
    await q.runQueue();
    return { missing, seen: [...seen].sort(), requests, steps, status: job.status, done: job.done,
      running: q.queueRunning(), runner: disk.runner, history: disk.data.history[0].done, next: next.status };
  });
  assert.deepEqual(result, { missing: [], seen: ['injected-auto', 'injected-badge', 'injected-popover', 'injected-strip'],
    requests: 3, steps: 2, status: 'done', done: 2, running: false, runner: null, history: 2, next: 'done' });
  log('All four render faults stayed inside view.paint; progress persisted, lock released, next batch completed.');
};
