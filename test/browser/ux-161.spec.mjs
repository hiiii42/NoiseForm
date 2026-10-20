// 1.6.1: wide-archive pending card, S / Alt seed toggle, queue duplicate stop, prose autocomplete, notifications.
import { mockLiveSource } from '../fixtures/mocklive.mjs';
export const options = { init: [mockLiveSource({ tier: 3, delay: 100 }), "window.__notes=[]; window.Notification = class { static permission='granted'; static requestPermission(){ return Promise.resolve('granted') } constructor(t,o){ window.__notes.push({ t, tag: o && o.tag, renotify: o && o.renotify }) } close(){} };"] };
export default async ({ page, assert, log }) => {
  const P = () => page.run(async () => { const { state } = await import('/js/store.js'); return { seed: String(state.params.seed) }; });
  await page.run(async () => { const { set } = await import('/js/store.js'); set('params.prompt', '1girl, smile'); set('settings.autoFreeOnly', false); set('settings.notify', true); });
  // --- queue: fixed seed batch of 3 pauses before image 2 (identical to image 1)
  await page.run(async () => { const { set } = await import('/js/store.js'); set('params.seed', '777'); const q = await import('/js/queue.js'); const { editorSnapshot } = await import('/js/app/editor.js'); window.__job = q.enqueue(editorSnapshot(), { count: 3, start: true }); });
  await page.waitFor("window.__gen >= 1 && !(window.__qr = null)", 15000);
  await page.waitFor("(async()=>{const q=await import('/js/queue.js'); return !q.queueRunning()})()", 15000);
  assert.equal(await page.eval('window.__gen'), 1, 'only the first identical image was generated');
  assert.match(await page.eval('window.__job.reason || ""'), /0001|№/, 'job says which image it duplicates');
  // resume = generate anyway: the rest of the batch runs without pausing again
  await page.run(async () => (await import('/js/queue.js')).runQueue());
  await page.waitFor("window.__gen >= 3", 15000);
  await page.waitFor("(async()=>{const q=await import('/js/queue.js'); return !q.queueRunning()})()", 15000);
  assert.equal(await page.eval('window.__gen'), 3, 'resume acknowledges the duplicate');
  // a random-seed batch is never treated as a duplicate
  await page.run(async () => { const { set } = await import('/js/store.js'); set('params.seed', ''); const q = await import('/js/queue.js'); const { editorSnapshot } = await import('/js/app/editor.js'); q.enqueue(editorSnapshot(), { count: 2, start: true }); });
  await page.waitFor("window.__gen >= 5", 15000);
  await page.waitFor("(async()=>{const q=await import('/js/queue.js'); return !q.queueRunning()})()", 15000);
  // --- S toggles the seed lock of the stage image
  await page.eval('document.activeElement && document.activeElement.blur()');
  const cur = await page.run(async () => { const { state } = await import('/js/store.js'); const { images } = await import('/js/db.js'); return (await images.list()).find((r) => r.id === state.session.currentId)?.seed; });
  await page.key('s', 0, 'KeyS'); await page.wait(300);
  assert.equal((await P()).seed, String(cur), 'S locks the seed');
  await page.key('s', 0, 'KeyS'); await page.wait(300);
  assert.equal((await P()).seed, '', 'S again unlocks');
  // Alt+click toggles too
  const id = await page.eval("document.querySelector('.thumb[data-id]').dataset.id");
  const click = `document.querySelector('.thumb[data-id="${id}"]').dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))`;
  await page.eval(click); await page.wait(200);
  assert.notEqual((await P()).seed, '', 'Alt+click locks');
  await page.eval(click); await page.wait(200);
  assert.equal((await P()).seed, '', 'Alt+click again unlocks');
  // --- wide archive, two columns: the pending card gets its own row
  await page.click('.arch-wide-btn'); await page.wait(400);
  await page.eval("document.documentElement.style.setProperty('--thumb','140px'); document.body.style.setProperty('--arch-wide-w','320px')"); await page.wait(300);
  await page.run(async () => (await import('/js/ui/archive.js')).setPending({ w: 832, h: 1216, progress: 0.5, label: 'T', n: 1 }));
  await page.wait(200);
  const geo = await page.eval("(()=>{const e=document.querySelector('.thumb.pending'); const b=e.getBoundingClientRect(); const n=e.nextElementSibling.getBoundingClientRect(); return { h: b.height, bottom: b.bottom, next: n.top }})()");
  assert.ok(geo.h > 100 && geo.next >= geo.bottom, 'pending card is not overlapped: ' + JSON.stringify(geo));
  await page.run(async () => (await import('/js/ui/archive.js')).setPending(null));
  await page.click('.arch-wide-btn');
  // --- autocomplete after a sentence completes the last word only
  await page.run(async () => { const { loadTagDB } = await import('/js/tagdb.js'); await loadTagDB(); });
  await page.eval("(()=>{const ta=document.querySelector('#promptEditor textarea'); ta.focus(); ta.value='two girls are holding hands under the rain. smi'; ta.setSelectionRange(ta.value.length, ta.value.length); ta.dispatchEvent(new Event('input',{bubbles:true})); return 1})()");
  await page.waitFor("document.querySelector('.ac2 .ac-i')", 5000);
  const first = await page.eval("document.querySelector('.ac2 .ac-i .ac-tag').textContent");
  assert.match(first, /^smil/i, 'completes the word after the sentence: ' + first);
  await page.key('Enter'); await page.wait(200);
  assert.match(await page.eval("document.querySelector('#promptEditor textarea').value"), /under the rain\. smil/, 'only the last word is replaced');
  // --- notifications: a later finish pops again (renotify) after the throttle window
  const notes = await page.eval('window.__notes');
  assert.ok(notes.length >= 1, 'notifications were sent while away? ' + JSON.stringify(notes));
  log('dup stop at image 2, resume ok; S/Alt toggle; wide pending ' + Math.round(geo.h) + 'px; AC "' + first + '"; notes ' + notes.length);
};
