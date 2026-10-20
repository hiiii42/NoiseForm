// 1.7.0: the generation progress ("data ocean") sits above the previous image, lands on the frame where the
// new image will be shown, hands over cleanly, and stays out of the way while the user browses.
export const options = { width: 1600, height: 1000 };
export default async ({ page, assert, log }) => {
  const count = () => page.eval("(async()=>{const {images}=await import('/js/db.js'); return (await images.list()).length})()");
  const waitCount = (n) => page.waitFor(`(async()=>{const {images}=await import('/js/db.js'); return (await images.list()).length >= ${n}})()`, 25000, 150);
  const overlay = () => page.eval(`(()=>{const d=document.querySelector('#developing'); const s=document.querySelector('#stage').getBoundingClientRect();
    const hit=document.elementFromPoint(s.left+s.width/2, s.top+s.height/2);
    return { hidden: d.hidden, ocean: d.classList.contains('ocean'), z: getComputedStyle(d).zIndex, onTop: !!hit && d.contains(hit), kids: d.children.length, read: d.querySelector('.oc-read')?.textContent || '' }})()`);
  await page.run(async () => { const { set } = await import('/js/store.js'); set('params.prompt', '1girl, city, neon lights'); set('params.width', 1216); set('params.height', 832); });
  await page.click('#btnGenerate');
  await waitCount(1);
  await page.wait(1200);

  // 1) a second job over the shown image: the progress view must be on top of it (1.6.4 bug: covered by the <img>)
  await page.click('#btnGenerate');
  await page.wait(700);
  const o = await overlay();
  assert.equal(o.hidden, false, 'progress view visible');
  assert.ok(o.ocean && Number(o.z) >= 6, 'data ocean above the image view: ' + JSON.stringify(o));
  assert.ok(o.onTop, 'the stage centre hits the progress view, not the previous image');
  assert.ok(/◎/.test(o.read), 'reticle read-out present');
  await waitCount(2);
  await page.wait(900);
  const after = await overlay();
  assert.ok(after.hidden && !after.ocean && after.kids === 0, 'progress view released after the hand-over: ' + JSON.stringify(after));
  const shown = await page.run(async () => { const { state } = await import('/js/store.js'); const { images } = await import('/js/db.js'); const list = (await images.list()).sort((a, b) => b.no - a.no); return { cur: state.session.currentId, newest: list[0].id }; });
  assert.equal(shown.cur, shown.newest, 'the new image is shown');
  // the landing frame approximates the real image frame (a FLIP absorbs the rest)
  const fit = await page.run(async () => {
    const { finalRect } = await import('/js/develop.js');
    const s = document.querySelector('#stage').getBoundingClientRect();
    const i = document.querySelector('.frame-in').getBoundingClientRect();
    const f = finalRect(s.width, s.height, 1216, 832);
    return { dx: Math.round(i.left - s.left - f.x), dy: Math.round(i.top - s.top - f.y), dw: Math.round(i.width - f.w), dh: Math.round(i.height - f.h), transform: getComputedStyle(document.querySelector('.frame-in')).transform };
  });
  assert.ok(Math.abs(fit.dx) <= 30 && Math.abs(fit.dy) <= 30 && Math.abs(fit.dw) <= 40 && Math.abs(fit.dh) <= 40, 'landing frame ≈ image frame ' + JSON.stringify(fit));
  assert.equal(fit.transform, 'none', 'FLIP finished');

  // 2) browsing during a job hides the progress view; the finished image does not steal the stage
  const first = await page.run(async () => { const { images } = await import('/js/db.js'); return (await images.list()).sort((a, b) => a.no - b.no)[0].id; });
  await page.click('#btnGenerate');
  await page.wait(500);
  await page.click(`#archList .thumb[data-id="${first}"] .thumb-open`);
  await page.wait(200);
  assert.equal((await overlay()).hidden, true, 'progress view hidden while browsing');
  await waitCount(3);
  await page.wait(700);
  const browse = await overlay();
  assert.ok(browse.hidden && browse.kids === 0, 'no overlay left after a browsed job');
  assert.equal(await page.run(async () => (await import('/js/store.js')).state.session.currentId), first, 'the browsed image stays on stage');

  // 3) reveal animation off: no landing, the overlay goes away right after the job
  await page.run(async () => { const { set } = await import('/js/store.js'); set('settings.fxReveal', false); });
  await page.click(`#archList .thumb:not(.pending)`); // newest → follow again
  await page.wait(300);
  await page.click('#btnGenerate');
  await waitCount(4);
  await page.wait(450);
  const plain = await overlay();
  assert.ok(plain.hidden && plain.kids === 0, 'overlay released without animation');
  assert.equal(page.errors.length, 0, 'no page errors: ' + page.errors.join(' | '));
  log('overlay z=' + o.z + ' on top; landing offset ' + JSON.stringify({ dx: fit.dx, dy: fit.dy, dw: fit.dw, dh: fit.dh }));
};
