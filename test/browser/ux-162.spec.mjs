// 1.6.2: the page never scrolls (big text / zoom), 85% default text size + v1 migration, Ctrl+wheel zoom fills the stage.
export const options = { width: 1100, height: 560, init: ["if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('nf.settings', JSON.stringify({ v: 1, data: { fontScale: 'md', theme: 'ink' } })); }"] };
export default async ({ page, assert, log }) => {
  // v1 settings on the old default (100%) move to the new 85% default, first frame included
  assert.equal(await page.eval("getComputedStyle(document.documentElement).getPropertyValue('--fz').trim()"), '0.85');
  assert.equal(await page.run(async () => (await import('/js/store.js')).state.settings.fontScale), 's85');
  // an explicit choice after the migration is kept
  await page.run(async () => { const { set } = await import('/js/store.js'); const { applyAppearance } = await import('/js/themes.js'); set('settings.fontScale', 'xxl'); applyAppearance(); });
  await page.wait(400);
  await page.reload(3000);
  assert.equal(await page.eval("getComputedStyle(document.documentElement).getPropertyValue('--fz').trim()"), '1.5', 'explicit 150% survives reload');
  // at 150% in a small window the document must not be scrollable, and opening things must not lift it
  const doc = () => page.eval("({ sh: document.scrollingElement.scrollHeight, ch: document.scrollingElement.clientHeight, top: document.scrollingElement.scrollTop, app: Math.round(document.querySelector('.app').getBoundingClientRect().top) })");
  const d0 = await doc();
  assert.ok(d0.sh <= d0.ch + 1, 'document does not overflow: ' + JSON.stringify(d0));
  await page.run(async () => { const { set } = await import('/js/store.js'); set('params.prompt', '1girl'); set('params.width', 1216); set('params.height', 832); });
  await page.click('#btnGenerate');
  await page.waitFor("(async()=>{const {images}=await import('/js/db.js'); return (await images.list()).length>=1})()", 20000, 300);
  await page.wait(1200);
  await page.click('#tools .tool.more'); await page.wait(300);
  await page.eval("document.querySelector('.tools-more button')?.scrollIntoView(); document.querySelector('.sec[data-sec] .sec-h')?.scrollIntoView(); window.scrollTo(0, 400); 1");
  await page.wait(200);
  const d1 = await doc();
  assert.equal(d1.top, 0, 'page did not scroll');
  assert.equal(d1.app, d0.app, 'layout did not move');
  await page.key('Escape');
  // back to a roomy window for zoom
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.run(async () => { const { set } = await import('/js/store.js'); const { applyAppearance } = await import('/js/themes.js'); set('settings.fontScale', 's85'); applyAppearance(); });
  await page.wait(500);
  const r = await page.eval("(()=>{const b=document.querySelector('.frame-in img').getBoundingClientRect(); return [b.left+b.width*0.8, b.top+b.height*0.5]})()");
  for (let i = 0; i < 6; i++) { await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r[0], y: r[1], deltaX: 0, deltaY: -120, modifiers: 2 }); await page.wait(50); }
  await page.wait(200);
  const g = await page.eval("(()=>{const i=document.querySelector('.frame-in img').getBoundingClientRect(); const m=document.querySelector('#stage').getBoundingClientRect(); const s=document.querySelector('.view-slug').getBoundingClientRect(); const t=document.querySelector('#tools').getBoundingClientRect(); const top=(r)=>document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return { i: [i.left, i.top, i.right, i.bottom], m: [m.left, m.top, m.right, m.bottom], badge: document.querySelector('.zoom-badge').textContent, slugOnTop: !!top(s).closest('.view-slug'), toolsOnTop: !!top(t).closest('#tools') }})()");
  assert.ok(g.i[0] <= g.m[0] + 1 && g.i[2] >= g.m[2] - 1 && g.i[1] <= g.m[1] + 1 && g.i[3] >= g.m[3] - 1, 'Ctrl+wheel zoom fills the whole stage: ' + JSON.stringify(g));
  assert.ok(g.slugOnTop && g.toolsOnTop, 'slug line and toolbar stay above the zoomed image');
  // the zoom badge is a "back to fit" button
  await page.click('.zoom-badge');
  await page.wait(200);
  assert.equal(await page.eval("document.querySelector('.frame-in img').style.transform"), '', 'badge resets the zoom');
  assert.equal(await page.eval("document.querySelector('.zoom-badge').hidden"), true, 'badge hides at 100%');
  assert.equal(await page.eval("document.querySelector('#stage').classList.contains('zooming')"), false);
  log('no page scroll at 150%/1100×560; 85% default; Ctrl+wheel ' + g.badge + ' fills the stage');
};
