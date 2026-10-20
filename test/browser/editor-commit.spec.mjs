export default async ({ page, assert, log }) => {
  await page.waitFor("document.querySelector('#promptEditor textarea')");
  await page.run(async () => {
    const { applySnapshot, editorSnapshot } = await import('/js/app/editor.js');
    const { state } = await import('/js/store.js');
    applySnapshot({ params: {
      model: 'nai-diffusion-5-curated', prompt: 'before', uc: 'old negative', aiChoice: false,
      characters: [{ id: 'old', prompt: '1girl', uc: '', enabled: true, x: .2, y: .4 }],
    } }, { undo: false });
    (await import('/js/ui/charpos.js')).openCharPositions(state.params.characters[0]);
    window.beforeCommit = editorSnapshot();
    const list = document.querySelector('#charList');
    const replace = list.replaceChildren;
    window.characterRenders = 0;
    list.replaceChildren = function (...nodes) {
      window.characterRenders++;
      return replace.apply(this, nodes);
    };
  });

  const loaded = await page.run(async () => {
    const { applySnapshot } = await import('/js/app/editor.js');
    const { on } = await import('/js/store.js');
    const roots = [];
    const stop = on('params', (value, path) => roots.push(path));
    applySnapshot({ params: {
      model: 'nai-diffusion-5-full', prompt: 'after', uc: 'new negative', aiChoice: false,
      width: 1024, height: 1024, sizePreset: 'normal-square', steps: 28, scale: 5,
      characters: [{ id: 'new', prompt: '1boy', uc: 'blur', enabled: true, x: .8, y: .6 }],
    } });
    stop();
    return {
      renders: window.characterRenders, roots,
      markers: [...document.querySelectorAll('.charpos-marker')].map((el) => [el.dataset.characterId, el.style.left, el.style.top]),
      prompt: document.querySelector('#charList textarea').value,
    };
  });
  assert.deepEqual(loaded, { renders: 1, roots: ['params'], markers: [['new', '80%', '60%']], prompt: '1boy' }, 'one snapshot renders characters once and updates the open layer');
  await page.click('#toasts .toast.act:last-child');
  assert.equal(await page.run(async () => {
    const { editorSnapshot } = await import('/js/app/editor.js');
    return JSON.stringify(editorSnapshot()) === JSON.stringify(window.beforeCommit);
  }), true, 'toast undo restores the complete snapshot');
  assert.deepEqual(await page.eval("[...document.querySelectorAll('.charpos-marker')].map(el => el.dataset.characterId)"), ['old']);
  assert.equal(await page.eval('window.characterRenders'), 2, 'undo also renders characters once');

  const reused = await page.run(async () => {
    const { reuseParams } = await import('/js/app/editor.js');
    const { state } = await import('/js/store.js');
    const params = {
      ...structuredClone(state.params), model: 'nai-diffusion-5-full', prompt: 'reused prompt', uc: 'reused negative',
      ucPreset: 1, qualityPreset: 1, qualityToggle: false, transparent: true,
      width: 1024, height: 1024, sizePreset: 'normal-square', nSamples: 2,
      steps: 28, scale: 5, cfgRescale: .3, seed: '1', sampler: 'k_dpmpp_2m', noiseSchedule: 'exponential',
      variety: true, smea: true, dyn: true, decrisp: true, normalizeVibes: false, aiChoice: false,
      characters: [{ id: 'reuse', prompt: '1boy, blue hair', uc: 'blur', enabled: true, x: .7, y: .3 }],
    };
    const start = window.characterRenders;
    reuseParams({ no: 7, seed: 12345, params });
    const value = (id) => document.getElementById(id).value;
    const checked = (id) => document.getElementById(id).checked;
    return {
      renders: window.characterRenders - start,
      model: document.querySelector('#modelName').textContent,
      text: ['#promptEditor textarea', '#ucEditor textarea', '#charList textarea'].map((s) => document.querySelector(s).value),
      selects: ['ucPreset', 'qualityPreset', 'sizePreset', 'sampler', 'noiseSchedule'].map(value),
      dimensions: ['width', 'height', 'seed'].map(value),
      samples: document.querySelector('#nSamples .on').dataset.v,
      sliders: ['steps', 'scale', 'cfgRescale'].map((key) => Number(document.querySelector(`.fld[data-slider="${key}"] .fv`).value)),
      checks: ['qualityToggle', 'transparent', 'variety', 'smea', 'dyn', 'decrisp', 'normalizeVibes', 'aiChoice'].map(checked),
      marker: document.querySelector('.charpos-marker').dataset.characterId,
    };
  });
  assert.equal(reused.renders, 1);
  assert.match(reused.model, /V5/);
  assert.deepEqual(reused.text, ['reused prompt', 'reused negative', '1boy, blue hair']);
  assert.deepEqual(reused.selects, ['1', '1', 'normal-square', 'k_dpmpp_2m', 'karras'], JSON.stringify(reused.selects));
  assert.deepEqual(reused.dimensions, ['1024', '1024', '12345']);
  assert.equal(reused.samples, '2');
  assert.deepEqual(reused.sliders, [28, 5, .3]);
  assert.deepEqual(reused.checks, [false, true, true, true, true, true, false, false]);
  assert.equal(reused.marker, 'reuse');

  const precise = await page.run(async () => {
    const { applyEditors, reuseParams, doRandomPrompt, applySnapshot, editorSnapshot } = await import('/js/app/editor.js');
    const { state, on } = await import('/js/store.js');
    reuseParams({ seed: 99, params: { seed: '88', steps: 24 } }, { keepSeed: true });
    const keptSeed = document.querySelector('#seed').value;
    applyEditors({ prompt: 'split prompt', uc: 'split uc', chars: [{ prompt: '1girl', uc: '', enabled: true }] });
    const split = ['#promptEditor textarea', '#ucEditor textarea', '#charList textarea'].map((s) => document.querySelector(s).value);
    const start = window.characterRenders;
    const leaves = [];
    const stop = on('params.prompt', () => leaves.push(state.params.prompt));
    doRandomPrompt();
    stop();
    const randomSynced = document.querySelector('#promptEditor textarea').value === state.params.prompt;
    const randomRenders = window.characterRenders - start;
    const snap = editorSnapshot();
    let notifications = 0;
    const off = on('params', () => notifications++);
    applySnapshot({ params: snap.params }, { undo: false });
    off();
    return { keptSeed, split, randomSynced, leaves: leaves.length, randomRenders, noOpRenders: window.characterRenders - start, notifications };
  });
  assert.deepEqual(precise, {
    keptSeed: '12345', split: ['split prompt', 'split uc', '1girl'], randomSynced: true,
    leaves: 1, randomRenders: 0, noOpRenders: 0, notifications: 0,
  }, 'all four bulk entry points use commit; unchanged snapshots do not redraw');

  await page.run(async () => {
    (await import('/js/app/editor.js')).applySnapshot({ params: { model: 'nai-diffusion-4-5-full' } }, { undo: false });
  });
  assert.equal(await page.eval("!!document.querySelector('.charpos')"), false, 'unsupported model closes the layer');
  const fixed = await page.run(async () => {
    const { applySnapshot } = await import('/js/app/editor.js');
    applySnapshot({ params: { model: 'nai-diffusion-5-full-medium', steps: 23, sampler: 'k_dpmpp_2m', noiseSchedule: 'exponential' } }, { undo: false });
    return ['.fld[data-slider="steps"] .fv', '#sampler', '#noiseSchedule'].map((selector) => document.querySelector(selector).value);
  });
  assert.deepEqual(fixed, ['14', 'k_euler_ancestral', 'karras'], 'model-fixed controls remain fixed after all changed leaves notify');
  log('commit entry points: complete field sync, one character redraw, layer refresh/closure, keepSeed, toast undo and no-op');
};
