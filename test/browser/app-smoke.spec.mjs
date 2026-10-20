// Uses the standard harness: external requests and /proxy/* are blocked.
export default async ({ page, assert }) => {
  assert.equal(await page.eval("document.querySelector('#conn').dataset.mode"), 'demo');
  await page.run(async () => {
    const { state } = await import('/js/store.js');
    Object.assign(state.params, { prompt: 'application smoke', width: 256, height: 256, nSamples: 1, seed: '' });
    Object.assign(state.settings, { fxReveal: false, autoSave: false });
    window.__downloads = [];
    HTMLAnchorElement.prototype.click = function () { window.__downloads.push({ name: this.download, href: this.href }); };
    const main = await import('/js/main.js');
    window.__exports = ['getPendingSaves', 'retrySave', 'downloadPendingSave', 'applyI18n', 'currentCost'].every(key => typeof main[key] === 'function');
  });
  assert.equal(await page.eval('window.__exports'), true);
  await page.click('#btnGenerate');
  await page.waitFor("import('/js/store.js').then(m => !m.state.session.generating && !!m.state.session.currentId)");
  assert.equal(await page.eval("import('/js/db.js').then(async m => (await m.images.list()).length)"), 1);
  assert.equal(await page.eval("document.querySelectorAll('#archList .thumb[data-id]').length"), 1);
  assert.ok(await page.eval("document.querySelector('#view .frame img').naturalWidth > 0"));
  for (const [key, flag] of [['f', 1], ['x', -1], ['u', 0]]) {
    await page.key(key, 0, 'Key' + key.toUpperCase());
    await page.waitFor(`import('/js/db.js').then(async m => (await m.images.list())[0]?.flag === ${flag})`);
  }
  await page.click('[data-tool="upscale"]');
  await page.waitFor("import('/js/db.js').then(async m => (await m.images.list()).some(r => r.kind === 'upscale'))", 20000);
  await page.waitFor("import('/js/store.js').then(m => !m.state.session.generating)");
  const up = await page.eval("import('/js/db.js').then(async m => (await m.images.list()).find(r => r.kind === 'upscale'))");
  assert.equal(up.width, 1024);
  assert.equal(up.height, 1024);
  assert.equal(up.demo, true);
  // Select the original to keep the variation small and exercise archive selection.
  await page.run(async () => {
    const app = await import('/js/app/records.js');
    await app.userSelect(app.history.find(r => r.kind === 'gen').id);
  });
  await page.click('[data-tool="variations"]');
  await page.waitFor("import('/js/db.js').then(async m => (await m.images.list()).some(r => r.kind === 'variation'))", 20000);
  await page.waitFor("import('/js/store.js').then(m => !m.state.session.generating)");
  await page.key('Delete');
  await page.waitFor("document.querySelector('.modal-bg .danger')");
  await page.click('.modal-bg .danger');
  await page.waitFor("import('/js/db.js').then(async m => (await m.images.list()).length === 2)");
  // The archive's ZIP action asks for a scope; capture and inspect the actual download.
  await page.run(async () => { void (await import('/js/app/records.js')).zipAll(); });
  await page.waitFor("document.querySelector('.opt-grid .opt')");
  await page.click('.opt-grid .opt:last-child');
  await page.waitFor('window.__downloads.length === 1');
  const download = await page.run(async () => {
    const { unzip } = await import('/js/zip.js');
    const d = window.__downloads[0];
    const files = await unzip(new Uint8Array(await (await fetch(d.href)).arrayBuffer()));
    return { name: d.name, names: files.map(f => f.name), lengths: files.map(f => f.data.length) };
  });
  assert.match(download.name, /^noiseform_.*\.zip$/);
  assert.equal(download.names.length, 2);
  assert.ok(download.names.every(n => n.endsWith('.png')));
  assert.ok(download.lengths.every(n => n > 0));
  await page.waitFor("import('/js/db.js').then(async m => (await m.images.list()).every(r => r.saved?.via === 'zip'))");
  assert.deepEqual(page.blocked, [], 'DEMO never attempted an external or paid request');
};
