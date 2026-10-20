export default async ({ page, assert, log }) => {
  const load = (model, id, aiChoice = false) => page.run(async (model, id, aiChoice) => {
    const { applySnapshot } = await import('/js/app/editor.js');
    applySnapshot({ params: { model, aiChoice, characters: [{ id, prompt: '1girl', enabled: true, uc: '', x: .7, y: .5 }] } }, { undo: false });
  }, model, id, aiChoice);
  const open = () => page.run(async () => {
    const { state } = await import('/js/store.js');
    (await import('/js/ui/charpos.js')).openCharPositions(state.params.characters[0]);
  });
  await load('nai-diffusion-5-full', 'old'); await open();
  await load('nai-diffusion-4-5-full', 'v45');
  assert.equal(await page.eval("!!document.querySelector('.charpos')"), false, 'root snapshot closes unsupported model layer');
  await load('nai-diffusion-5-full', 'old'); await open();
  await page.run(() => {
    window.positionPaints = new MutationObserver(() => {});
    window.positionPaints.observe(document.querySelector('.charpos-tabs'), { childList: true, subtree: true });
  });
  await load('nai-diffusion-5-full', 'new');
  assert.deepEqual(await page.eval("[...document.querySelectorAll('.charpos-marker')].map(e=>e.dataset.characterId)"), ['new'], 'root snapshot repaints latest character IDs');
  const leafUpdate = await page.run(async () => {
    const { state, emit, on } = await import('/js/store.js');
    let notifications = 0;
    const stop = on('params', () => notifications++);
    state.params.characters[0].prompt = '1boy';
    emit('params.characters');
    const paints = window.positionPaints.takeRecords().filter(r => r.target.matches?.('[role=tab]')).length;
    stop(); window.positionPaints.disconnect();
    return { paints, notifications };
  });
  assert.deepEqual(leafUpdate, { paints: 1, notifications: 1 }, 'leaf updates bubble once with no double repaint or notification loop');
  await load('nai-diffusion-5-full', 'ai', true);
  assert.equal(await page.eval("!!document.querySelector('.charpos')"), false, 'root snapshot closes AI placement layer');
  log('production applySnapshot: V4.5 closure, V5 marker refresh and aiChoice closure');
};
