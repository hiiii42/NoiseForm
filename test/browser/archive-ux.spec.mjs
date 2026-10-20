// 1.5.1: narrow-archive pending card, letter shortcuts, Alt clicks, right-click menu, chunk examples.
export default async ({ page, assert, log }) => {
  const recs = () => page.eval("(async()=>{const {images}=await import('/js/db.js'); return (await images.list()).sort((a,b)=>a.no-b.no).map(r=>({id:r.id,no:r.no,flag:r.flag||0,seed:r.seed}))})()");
  // chunk examples on a fresh profile
  const names = await page.run(async () => (await import('/js/ui/chunks.js')).chunkNames());
  assert.ok(names.includes('水手服') && names.every((n) => !/[\s,，]/.test(n)), 'fresh profile gets valid example chunks');
  // 8 DEMO images so the narrow list overflows
  await page.run(async () => { const { set } = await import('/js/store.js'); set('params.nSamples', 4); set('params.prompt', '1girl, smile'); });
  for (let i = 0; i < 2; i++) {
    await page.click('#btnGenerate');
    await page.waitFor(`(async()=>{const {images}=await import('/js/db.js'); return (await images.list()).length >= ${(i + 1) * 4}})()`, 25000, 300);
    await page.wait(800);
  }
  await page.run(async () => (await import('/js/ui/archive.js')).setPending({ w: 832, h: 1216, progress: 0.5, label: 'TEST', n: 1 }));
  const ph = await page.eval("document.querySelector('.thumb.pending').getBoundingClientRect().height");
  assert.ok(ph > 100, 'pending card keeps its height in the overflowing narrow list (' + ph + ')');
  await page.run(async () => (await import('/js/ui/archive.js')).setPending(null));
  // no hover seed/params buttons
  assert.equal(await page.eval("document.querySelectorAll('.thumb .thumb-action').length"), 0, 'hover buttons removed');
  // F after Esc from the prompt editor, and with an IME reporting key=Process
  await page.eval("document.querySelector('#promptEditor textarea').focus()");
  await page.key('Escape');
  assert.equal(await page.eval("document.activeElement === document.body"), true, 'Esc leaves the editor');
  const cur = await page.eval("(async()=>{const {state}=await import('/js/store.js'); return state.session.currentId})()");
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70 });
  await page.wait(300);
  assert.equal((await recs()).find((r) => r.id === cur).flag, 1, 'F stars the current image');
  await page.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', code: 'KeyU', bubbles: true }))");
  await page.wait(300);
  assert.equal((await recs()).find((r) => r.id === cur).flag, 0, 'U works when an IME reports key=Process');
  // Alt+click → seed only; Alt+right-click → parameters, seed kept
  const list = await recs();
  const target = list[0];
  await page.run(async () => { const { set } = await import('/js/store.js'); set('params.seed', ''); set('params.prompt', 'changed prompt'); });
  await page.eval(`document.querySelector('.thumb[data-id="${target.id}"]').dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))`);
  await page.wait(300);
  let P = await page.run(async () => { const { state } = await import('/js/store.js'); return { seed: String(state.params.seed), prompt: state.params.prompt, cur: state.session.currentId }; });
  assert.equal(P.seed, String(target.seed), 'Alt+click imports the seed');
  assert.equal(P.prompt, 'changed prompt', 'Alt+click leaves the prompt alone');
  await page.run(async () => { const { set } = await import('/js/store.js'); set('params.seed', '12345'); });
  await page.eval(`document.querySelector('.thumb[data-id="${target.id}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, altKey: true, clientX: 100, clientY: 100 }))`);
  await page.wait(300);
  P = await page.run(async () => { const { state } = await import('/js/store.js'); return { seed: String(state.params.seed), prompt: state.params.prompt }; });
  assert.equal(P.prompt, '1girl, smile', 'Alt+right-click imports the parameters');
  assert.equal(P.seed, '12345', 'Alt+right-click keeps the seed');
  assert.equal(await page.eval("!!document.querySelector('.ctx-menu')"), false, 'Alt+right-click opens no menu');
  // right-click: single menu, then multi-select menu → star all
  await page.eval(`document.querySelector('.thumb[data-id="${list[1].id}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }))`);
  assert.ok((await page.eval("document.querySelectorAll('.ctx-menu .ctx-item').length")) >= 6, 'single-image menu');
  await page.key('Escape');
  assert.equal(await page.eval("!!document.querySelector('.ctx-menu')"), false, 'Esc closes the menu');
  for (const r of list.slice(2, 5)) await page.eval(`document.querySelector('.thumb[data-id="${r.id}"]').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))`);
  assert.match(await page.eval("document.querySelector('#archSel').innerText"), /3/, 'selection strip shows the count');
  await page.eval(`document.querySelector('.thumb[data-id="${list[3].id}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }))`);
  await page.eval("[...document.querySelectorAll('.ctx-menu .ctx-item')].find(b=>/收藏|Star/.test(b.textContent)).click()");
  await page.wait(400);
  const starred = (await recs()).filter((r) => r.flag === 1).map((r) => r.id).sort();
  assert.deepEqual(starred, list.slice(2, 5).map((r) => r.id).sort(), 'menu acts on the whole selection');
  log('pending card ' + Math.round(ph) + 'px; F / U(Process) / Alt / menus ok');
};
