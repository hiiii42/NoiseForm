export default async ({ page, assert }) => {
  const result = await page.run(async () => {
    const app = await import('/js/app/records.js');
    const stage = await import('/js/ui/stage.js');
    const compare = await import('/js/ui/compare.js');
    const post = await import('/js/ui/workbench.js');
    const { state } = await import('/js/store.js');
    Object.assign(state.settings, { fxReveal: false, autoSave: false });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    canvas.getContext('2d').fillRect(0, 0, 64, 64);
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    const add = (start, count) => app.addRecords(Array.from({ length: count }, (_, i) => ({
      id: 'cache-' + (start + i), batchId: null, blob, thumb: blob, width: 64, height: 64,
      model: state.params.model, kind: 'gen', demo: true, params: { ...state.params },
    })), { select: false, silent: true });
    const revoked = [];
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = function (url) { revoked.push(url); return revoke.call(URL, url); };
    try {
      await add(0, 50);
      const initialSize = app.recCache.size;
      await app.selectRecord('cache-0');
      const stageURL = stage.urlFor(await app.getRecord('cache-0'));
      await compare.openCompare(['cache-1', 'cache-2']);
      const compareURL = stage.urlFor(await app.getRecord('cache-1'));
      const evictedURL = stage.urlFor(await app.getRecord('cache-3'));
      await add(50, 50);
      const duringCompare = {
        size: app.recCache.size,
        current: app.recCache.has('cache-0'),
        compare: app.recCache.has('cache-1') && app.recCache.has('cache-2'),
        revoked: revoked.includes(evictedURL),
        displayedRevoked: revoked.includes(stageURL) || revoked.includes(compareURL),
        loadable: (await (await fetch(stageURL)).blob()).size === blob.size && (await (await fetch(compareURL)).blob()).size === blob.size,
      };
      // Updates of evicted records must not bypass the bound either.
      for (let i = 4; i < 50; i++) await app.updateRecord('cache-' + i, { flag: 1 });
      const updateSize = app.recCache.size;
      compare.closeCompare();
      await app.openPost(await app.getRecord('cache-0'));
      await app.selectRecord('cache-4');
      await add(100, 50);
      const duringPost = { size: app.recCache.size, source: app.recCache.has('cache-4'), active: post.postActive() };
      post.exitPost();
      // selectRecord triggered by onExit settles before pressure resumes.
      await app.selectRecord('cache-5');
      await add(150, 50);
      const releasedPost = !app.recCache.has('cache-4');
      await app.selectRecord('cache-4');
      const reloaded = !!document.querySelector('#view .frame img') && (await app.getRecord('cache-4')).blob.size === blob.size;
      return { initialSize, duringCompare, updateSize, duringPost, releasedPost, reloaded };
    } finally { URL.revokeObjectURL = revoke; }
  });
  assert.equal(result.initialSize, 40, 'continuous addRecords honors the default bound');
  assert.deepEqual(result.duringCompare, { size: 40, current: true, compare: true, revoked: true, displayedRevoked: false, loadable: true });
  assert.equal(result.updateSize, 40, 'updateRecord cannot grow the cache indefinitely');
  assert.deepEqual(result.duringPost, { size: 40, source: true, active: true });
  assert.equal(result.releasedPost, true, 'finished post source can be evicted');
  assert.equal(result.reloaded, true, 'evicted image remains retrievable from IndexedDB');
  assert.deepEqual(page.blocked, []);
};
