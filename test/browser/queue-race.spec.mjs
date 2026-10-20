// 1.6.4: a run requested while the previous run is still flushing (lock release / last write) must not be dropped.
import { mockLiveSource } from '../fixtures/mocklive.mjs';
export const options = { init: [mockLiveSource({ delay: 150 })] };
export default async ({ page, assert, log }) => {
  await page.run(async () => {
    const { state } = await import('/js/store.js');
    const q = await import('/js/queue.js');
    state.settings.autoFreeOnly = false;
    const snap = (prompt) => ({ params: { ...structuredClone(state.params), prompt, seed: '' }, base: null, vibes: [], refs: [] });
    window.__a = q.enqueue(snap('first'), { count: 1, start: true });
    const t = setInterval(() => {
      if (window.__a.status !== 'done') return;
      clearInterval(t);
      window.__flushing = q.queueRunning();
      window.__b = q.enqueue(snap('second'), { count: 1, start: true });
    }, 1);
  });
  await page.waitFor('window.__b && window.__b.status === "done"', 15000);
  assert.equal(await page.eval('window.__gen'), 2);
  log('second batch queued during the flush (running=' + (await page.eval('window.__flushing')) + ') still ran');
};
