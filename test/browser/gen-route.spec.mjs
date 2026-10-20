import { mockLiveSource } from '../fixtures/mocklive.mjs';
export const options = { init: [mockLiveSource(), `
const upstream = window.fetch;
window.__posts = [];
window.fetch = async (url, opts = {}) => {
  if (String(url).endsWith('generate-image')) {
    window.__posts.push(String(url));
    await upstream(url, opts); // the upstream accepted and generated before the connection reset
    throw new TypeError('connection reset after acceptance');
  }
  return upstream(url, opts);
};`] };

export default async ({ page, assert }) => {
  await page.run(async () => {
    const { state } = await import('/js/store.js');
    const q = await import('/js/queue.js');
    state.settings.conn = 'auto';
    state.settings.autoFreeOnly = false;
    state.params.prompt = 'unknown result';
    window.__job = q.enqueue({ params: structuredClone(state.params), base: null, vibes: [], refs: [] }, { count: 1, start: true });
  });
  await page.waitFor("window.__job.status === 'paused' && import('/js/queue.js').then(q=>!q.queueRunning())");
  assert.equal(await page.eval('window.__gen'), 1);
  assert.equal(await page.eval('window.__posts.length'), 1);
  assert.match(await page.eval('window.__posts[0]'), /^https:\/\/image\.novelai\.net/);
  assert.equal(await page.eval('window.__job.stage'), 'unknown');
  assert.match(await page.eval('window.__job.reason'), /Anlas/);
  assert.equal(await page.eval('window.__job.done'), 0);
  // The injected network error is intentionally logged by generate(), no other page errors allowed.
  assert.equal(page.errors.filter((s) => !s.includes('结果未知')).length, 0);
  page.errors.length = 0;
};
