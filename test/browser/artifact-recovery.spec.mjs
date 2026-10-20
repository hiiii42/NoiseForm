import { mockLiveSource } from '../fixtures/mocklive.mjs';
export const options = { init: [mockLiveSource({ delay: 10 })] };

export default async ({ page, assert }) => {
  await page.run(async () => {
    const { state } = await import('/js/store.js');
    Object.assign(state.params, { prompt: 'artifact source', width: 64, height: 64 });
    await (await import('/js/app/generate.js')).generate();
    const { images } = await import('/js/db.js');
    window.__put = images.put;
    images.put = async () => { throw new DOMException('quota', 'QuotaExceededError'); };
    const cv = document.createElement('canvas'); cv.width = cv.height = 256;
    cv.getContext('2d').fillRect(0, 0, 256, 256);
    window.__scaled = await new Promise(resolve => cv.toBlob(resolve));
    const original = window.fetch;
    window.__upscales = 0;
    window.fetch = async (url, opts) => {
      if (String(url).endsWith('/ai/upscale')) { window.__upscales++; return new Response(window.__scaled); }
      return original(url, opts);
    };
    window.__toolDone = false;
    (await import('/js/app/tools.js')).runTool('upscale').then(() => window.__toolDone = true);
  });
  await page.waitFor("document.querySelector('.modal-f .solid')");
  await page.click('.modal-f .solid');
  await page.waitFor('window.__toolDone');
  assert.equal(await page.eval("import('/js/app/generate.js').then(g => g.getPendingSaves().length)"), 1, 'upscale output survives archive failure');
  await page.click('#btnPendingSaves');
  await page.run(() => {
    HTMLAnchorElement.prototype.click = function () { window.__download = this.href; };
  });
  await page.click('[data-download-save]');
  assert.equal(await page.run(async () => (await (await fetch(window.__download)).blob()).size), await page.eval('window.__scaled.size'));
  await page.run(async () => { (await import('/js/db.js')).images.put = window.__put; });
  await page.click('[data-retry-save]');
  await page.waitFor("import('/js/app/generate.js').then(g => g.getPendingSaves().length === 0)");
  assert.equal(await page.eval('window.__upscales'), 1, 'save recovery never calls upscale again');
  const records = await page.run(async () => (await (await import('/js/db.js')).images.list()).map(r => ({ kind: r.kind, width: r.width })));
  assert.deepEqual(records.map(r => r.kind).sort(), ['gen', 'upscale']);
  assert.equal(records.find(r => r.kind === 'upscale').width, 256);
  // Director outputs have params:null; their recovery dialog must remain usable too.
  await page.run(async () => {
    document.querySelectorAll('.modal-x').forEach(b => b.click());
    const { images } = await import('/js/db.js');
    images.put = async () => { throw new DOMException('director quota', 'QuotaExceededError'); };
    const original = window.fetch;
    window.__augments = 0;
    window.fetch = async (url, opts) => {
      if (String(url).endsWith('/ai/augment-image')) { window.__augments++; return new Response(window.__scaled); }
      return original(url, opts);
    };
    await (await import('/js/app/tools.js')).runTool('director');
  });
  await page.click('.dir-side .solid');
  await page.waitFor("document.querySelector('.dir-view img.after')");
  await page.run(async () => {
    try { await document.querySelector('.modal-f .solid').onclick(); }
    catch (err) { window.__directorSaveError = err.message; }
  });
  assert.equal(await page.eval('window.__directorSaveError'), 'director quota');
  assert.equal(await page.eval("import('/js/app/generate.js').then(g => g.getPendingSaves()[0].items[0].kind)"), 'director');
  await page.run(() => document.querySelectorAll('.modal-x').forEach(b => b.click()));
  await page.click('#btnPendingSaves');
  assert.equal(await page.eval('document.querySelectorAll("[data-download-save]").length'), 1);
  await page.run(async () => { (await import('/js/db.js')).images.put = window.__put; });
  await page.click('[data-retry-save]');
  await page.waitFor("import('/js/app/generate.js').then(g => g.getPendingSaves().length === 0)");
  assert.equal(await page.eval('window.__augments'), 1, 'director save recovery never calls augment again');
};
