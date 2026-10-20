import { mockLiveSource } from '../fixtures/mocklive.mjs';
export const options = { init: [mockLiveSource(), `
const mock = window.fetch;
window.fetch = async (url, opts = {}) => {
  const res = await mock(url, opts);
  if (!String(url).endsWith('generate-image') || JSON.parse(opts.body).parameters.n_samples !== 2) return res;
  const { unzip, zip } = await import('/js/zip.js');
  const files = await unzip(new Uint8Array(await res.arrayBuffer()));
  return new Response(zip([files[0], { ...files[0], name: 'image_1.png' }]));
};`] };

export default async ({ page, assert }) => {
  await page.run(async () => {
    const { state } = await import('/js/store.js');
    const { images } = await import('/js/db.js');
    const q = await import('/js/queue.js');
    state.params.prompt = 'quota recovery';
    state.settings.autoFreeOnly = false;
    window.__originalPut = images.put;
    window.__writes = 0;
    images.put = async () => { window.__writes++; throw new DOMException('test quota exhausted', 'QuotaExceededError'); };
    window.__job = q.enqueue({ params: structuredClone(state.params), base: null, refs: [], vibes: [] }, { count: 1, start: true });
  });
  await page.waitFor("window.__job.status === 'paused' && import('/js/queue.js').then(q=>!q.queueRunning())");
  assert.equal(await page.eval('window.__gen'), 1);
  assert.equal(await page.eval('window.__job.stage'), 'persist');
  assert.equal(await page.eval('window.__job.done'), 0);
  const saved = await page.run(async () => {
    const m = await import('/js/main.js');
    const p = m.getPendingSaves()[0];
    return { id: p.id, bytes: p.items[0].blob.size, stats: (await import('/js/stats.js')).today().n, records: (await (await import('/js/db.js')).images.list()).length };
  });
  assert.ok(saved.bytes > 0, 'original Blob is retrievable');
  assert.equal(saved.records, 0);
  assert.equal(saved.stats, 1, 'generation counted before archive commit');
  await page.click('#btnPendingSaves');
  assert.equal(await page.eval('document.querySelectorAll("[data-download-save]").length'), 1);
  await page.run(() => {
    window.__anchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { window.__download = { name: this.download, href: this.href }; };
  });
  await page.click('[data-download-save]');
  const downloaded = await page.run(async () => {
    HTMLAnchorElement.prototype.click = window.__anchorClick;
    const blob = await (await fetch(window.__download.href)).blob();
    return { name: window.__download.name, size: blob.size };
  });
  assert.match(downloaded.name, /^noiseform-.*\.png$/);
  assert.equal(downloaded.size, saved.bytes, 'download retrieves the original generated Blob');
  await page.run(async () => { (await import('/js/db.js')).images.put = window.__originalPut; });
  await page.click('[data-retry-save]');
  await page.waitFor("import('/js/main.js').then(m=>m.getPendingSaves().length === 0)");
  await page.run(async () => { (await import('/js/queue.js')).runQueue(); });
  await page.waitFor("window.__job.status === 'done'");
  assert.equal(await page.eval('window.__gen'), 1, 'UI retry followed by queue resume never regenerates');
  assert.equal(await page.eval('window.__job.done'), 1);
  assert.equal(await page.eval("import('/js/db.js').then(async m=>(await m.images.list()).length)"), 1);
  assert.equal(await page.eval("import('/js/stats.js').then(m=>m.today().n)"), 1, 'saving does not count twice');
  // A later image failing in a multi-image response must not duplicate the already-committed one.
  await page.run(async () => {
    const { state } = await import('/js/store.js');
    const { images } = await import('/js/db.js');
    document.querySelectorAll('.modal-x').forEach((b) => b.click());
    Object.assign(state.params, { prompt: 'partial batch', nSamples: 2 });
    window.__batchWrites = 0;
    images.put = async (rec) => {
      if (++window.__batchWrites === 2) throw new DOMException('second image quota', 'QuotaExceededError');
      return window.__originalPut(rec);
    };
    document.querySelector('#btnGenerate').click();
  });
  await page.waitFor("window.__gen === 2 && import('/js/store.js').then(m=>!m.state.session.generating)");
  const partial = await page.run(async () => {
    const m = await import('/js/main.js');
    const { images } = await import('/js/db.js');
    const entry = m.getPendingSaves()[0];
    const before = (await images.list()).length;
    images.put = window.__originalPut;
    const results = await Promise.all([m.retrySave(entry.id), m.retrySave(entry.id)]);
    return { before, after: (await images.list()).length, ids: results.map((r) => r.recs.map((x) => x.id)), stats: (await import('/js/stats.js')).today().n };
  });
  assert.equal(partial.before, 2);
  assert.equal(partial.after, 3);
  assert.deepEqual(partial.ids[0], partial.ids[1], 'concurrent retries share the same persisted result');
  assert.equal(partial.stats, 3);
  assert.equal(await page.eval('window.__gen'), 2, 'partial batch recovery does not generate again');
};
