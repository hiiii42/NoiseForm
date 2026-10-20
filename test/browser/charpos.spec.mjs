import { artifact } from './harness.mjs';
import { join } from 'node:path';

export const options = { width: 1600, height: 1000 };

export default async ({ page, assert, log }) => {
  await page.waitFor("document.querySelector('#promptEditor textarea')");
  await page.run(async () => {
    const { state, set } = await import('/js/store.js');
    const { renderChars, expandSection } = await import('/js/ui/panel.js');
    set('params.model', 'nai-diffusion-5-curated');
    state.params.characters = [];
    set('params.aiChoice', true);
    renderChars(); expandSection('chars');
  });
  await page.click('#btnAddChar'); await page.click('#btnAddChar');
  await page.wait(60);
  await page.run(async () => {
    const { state, emit } = await import('/js/store.js');
    const { renderChars } = await import('/js/ui/panel.js');
    state.params.characters[0].prompt = '1girl, silver hair';
    state.params.characters[1].prompt = '1boy, black hair';
    emit('params.characters'); renderChars();
  });
  // V5 opens while AI is enabled, turning on manual placement automatically.
  assert.equal(await page.eval("document.querySelector('.pos-btn').disabled"), false);
  await page.click('.pos-btn');
  await page.waitFor("document.querySelector('.charpos-board')?.offsetWidth > 100");
  assert.equal(await page.eval("document.querySelectorAll('.charpos-marker').length"), 2);
  assert.equal(await page.eval("document.querySelector('#aiChoice').checked"), false);
  const board = () => page.eval("(()=>{const r=document.querySelector('.charpos-board').getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}})()");
  const clickAt = async (x, y) => {
    const r = await board();
    await page.mouse('mousePressed', r.x + r.w * x, r.y + r.h * y);
    await page.mouse('mouseReleased', r.x + r.w * x, r.y + r.h * y);
  };
  await clickAt(0.28, 0.41);
  assert.deepEqual(await page.eval("import('/js/store.js').then(({state:s})=>[s.params.characters[0].x,s.params.characters[0].y])"), [0.28, 0.41]);
  assert.equal(await page.eval("document.querySelector('.pos-label').textContent"), '28·41');
  assert.equal(await page.eval("document.querySelector('.pos-btn').title"), 'x 28% · y 41%');
  await page.key('ArrowRight'); await page.key('ArrowDown', 8);
  assert.deepEqual(await page.eval("import('/js/store.js').then(({state:s})=>[s.params.characters[0].x,s.params.characters[0].y])"), [0.29, 0.46]);
  // Select and drag the second marker using real pointer capture.
  const r = await board();
  await page.mouse('mousePressed', r.x + r.w * 0.5, r.y + r.h * 0.5);
  await page.mouse('mouseMoved', r.x + r.w * 0.72, r.y + r.h * 0.61, { buttons: 1 });
  await page.mouse('mouseReleased', r.x + r.w * 0.72, r.y + r.h * 0.61);
  assert.deepEqual(await page.eval("import('/js/store.js').then(({state:s})=>[s.params.characters[1].x,s.params.characters[1].y])"), [0.72, 0.61]);
  await clickAt(0.99, 0.01);
  assert.deepEqual(await page.eval("import('/js/store.js').then(({state:s})=>[s.params.characters[1].x,s.params.characters[1].y])"), [0.9, 0.1]);
  const ratio = await page.run(async () => {
    const { state } = await import('/js/store.js');
    const r = document.querySelector('.charpos-board').getBoundingClientRect();
    return [r.width / r.height, state.params.width / state.params.height];
  });
  assert.ok(Math.abs(ratio[0] - ratio[1]) < 0.002, 'empty frame follows generation aspect ratio');
  await page.key('Escape');
  assert.equal(await page.eval("!!document.querySelector('.charpos')"), false);
  // Check image alignment with a local canvas, including stage zoom and resize.
  await page.run(async () => {
    const { showRecord } = await import('/js/ui/stage.js');
    const canvas = document.createElement('canvas'); canvas.width = 832; canvas.height = 1216;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 832, 1216);
    gradient.addColorStop(0, '#273049'); gradient.addColorStop(1, '#74617d');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 832, 1216);
    ctx.fillStyle = '#ffffff18'; ctx.fillRect(180, 200, 160, 820); ctx.fillRect(510, 300, 150, 720);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    showRecord({ id: 'charpos-local', blob, kind: 'import', width: 832, height: 1216, params: {}, createdAt: Date.now() });
    await document.querySelector('#view .frame-in img').decode();
    // Existing stage transforms must not offset the position overlay.
    document.querySelector('#view .frame-in img').style.transform = 'translate(12px, 8px) scale(1.1)';
  });
  await page.click('.pos-btn'); await page.wait(60);
  const aligned = () => page.eval("(()=>{const a=document.querySelector('.charpos-board').getBoundingClientRect(), b=document.querySelector('#view .frame-in img').getBoundingClientRect(); return ['left','top','width','height'].every(k=>Math.abs(a[k]-b[k])<1)})()");
  assert.ok(await aligned(), 'position canvas aligns with the visible image including zoom');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.wait(100);
  assert.ok(await aligned(), 'position canvas realigns after resize');
  await page.run(async () => {
    const { state, emit } = await import('/js/store.js');
    state.params.characters[1].enabled = false; emit('params.characters');
  });
  assert.equal(await page.eval("document.querySelectorAll('.charpos-marker').length"), 1, 'disabled characters have no marker');
  await page.run(async () => {
    const { state, emit } = await import('/js/store.js');
    state.params.characters[1].enabled = true; emit('params.characters');
    document.querySelectorAll('.charpos-marker')[1].focus();
  });
  await page.key('ArrowLeft');
  assert.equal(await page.eval("import('/js/store.js').then(({state:s})=>s.params.characters[1].x)"), 0.89, 'focused markers select the character for keyboard edits');
  await page.run(async () => {
    const { openModal } = await import('/js/ui/modal.js');
    openModal({ title: 'Test settings', body: document.createElement('div') });
  });
  await page.key('Escape');
  assert.equal(await page.eval("!!document.querySelector('.modal-bg')"), false);
  assert.equal(await page.eval("!!document.querySelector('.charpos')"), true, 'nested settings owns Escape before position editor');
  const output = artifact('.');
  const shot = join(output, 'charpos-v5.png'); await page.shot(shot); log('V5 screenshot: ' + shot);
  await page.click('.charpos-done');
  assert.equal(await page.eval("!!document.querySelector('.charpos')"), false);
  // V4.x retains its grid and resolves non-grid imported coordinates correctly.
  await page.run(async () => {
    const { state, set } = await import('/js/store.js');
    state.params.characters[0].x = 0.28; state.params.characters[0].y = 0.41;
    set('params.model', 'nai-diffusion-4-5-full');
  });
  assert.equal(await page.eval("document.querySelector('.pos-label').textContent"), 'B3');
  await page.click('.pos-btn');
  assert.equal(await page.eval("document.querySelectorAll('.pos-grid button').length"), 25);
  assert.equal(await page.eval("document.querySelector('.pos-grid button.on').title"), 'B3');
  const centers = await page.run(async () => {
    const { state } = await import('/js/store.js');
    const { modelById } = await import('/js/data.js');
    const { buildGenerateBody } = await import('/js/nai.js');
    const out = buildGenerateBody({ params: state.params, model: modelById(state.params.model), seed: 123 });
    return [out.parameters.characterPrompts[0].center, out.parameters.v4_prompt.caption.char_captions[0].centers[0], out.parameters.v4_negative_prompt.caption.char_captions[0].centers[0]];
  });
  assert.deepEqual(centers, Array.from({ length: 3 }, () => ({ x: 0.3, y: 0.5 })));
  log('click, drag, keyboard, AI toggle, image/resize alignment and V4.x request grid verified without generation requests');
};
