// UI characterization: these expectations also pass before the domain extraction.
export default async ({ page, assert, log }) => {
  const rows = await page.run(async () => {
    const { state, emit } = await import('/js/store.js');
    const { currentCost, effectiveModel } = await import('/js/ui/panel.js');
    const cases = [
      ['V4.5 free', {}, {}, 'nai-diffusion-4-5-full'],
      ['V5 free', {}, {}, 'nai-diffusion-5-full'],
      ['two samples', { nSamples: 2 }, {}, 'nai-diffusion-4-5-full'],
      ['29 steps', { steps: 29 }, {}, 'nai-diffusion-4-5-full'],
      ['V5 exhausted', {}, { usageNegative: true }, 'nai-diffusion-5-full'],
      ['non Opus', {}, { tier: 2 }, 'nai-diffusion-4-5-full'],
      ['DEMO', {}, { live: false }, 'nai-diffusion-5-full'],
    ];
    return cases.map(([name, params, account, model]) => {
      Object.assign(state.params, { model, width: 1024, height: 1024, steps: 28, nSamples: 1 }, params);
      Object.assign(state.session, { tier: 3, active: true, live: true, freeBlocked: false, usageNegative: false }, account);
      state.base = null; state.refs = []; state.vibes = [];
      emit('params');
      return { name, text: document.querySelector('#genCost').textContent, free: document.querySelector('.gen-r').classList.contains('free'), cost: currentCost(), model: effectiveModel().id };
    });
  });
  assert.deepEqual(rows.map(r => [r.text, r.free]), [['20', true], ['30', true], ['20', false], ['21', false], ['30', false], ['20', false], ['0', false]]);
  log(JSON.stringify(rows.map(({ name, text, free }) => ({ name, text, free }))));
  const mismatches = await page.run(async () => {
    const { estimateCost, effectiveModel } = await import('/js/domain/cost.js');
    const { generationCost } = await import('/js/nai.js');
    const { MODELS } = await import('/js/data.js');
    const errors = [];
    for (const selected of MODELS) for (const tier of [0, 3]) for (const steps of [14, 28, 29, 50]) for (const nSamples of [1, 3]) for (const extra of [
      {}, { base: { strength: 0.35 } }, { base: { strength: 0.35, mask: 'mask' } },
      { vibes: [{ enabled: true, ie: 0.7 }] }, { refs: [{}] },
    ]) {
      const spec = { params: { model: selected.id, width: 1024, height: 1024, steps, nSamples, smea: true, dyn: true }, ...extra };
      const model = effectiveModel(spec);
      const account = { tier, active: true, live: true, usageNegative: true };
      const vibes = model.vibes && !(extra.base?.mask && model.v4) && !extra.refs?.length ? extra.vibes || [] : [];
      const old = generationCost({ model, width: 1024, height: 1024, steps: model.fixed?.steps || steps, nSamples, smea: true, dyn: true,
        strength: extra.base?.strength ?? 1, isInpaint: !!extra.base?.mask,
        newVibeEncodes: model.v3 ? 0 : vibes.length, vibeCount: vibes.length, refCount: model.refs ? extra.refs?.length || 0 : 0, account });
      if (JSON.stringify(old) !== JSON.stringify(estimateCost(spec, account))) errors.push({ spec, old });
    }
    return errors;
  });
  assert.deepEqual(mismatches, [], 'domain pricing agrees with the unchanged transport entry point');

  await page.run(async () => {
    const { state } = await import('/js/store.js');
    const auto = await import('/js/auto.js');
    const queue = await import('/js/queue.js');
    Object.assign(state.session, { live: false, generating: false });
    Object.assign(state.settings, { autoMode: 'change', autoCount: 1, autoFreeOnly: false });
    auto.initAuto({ generate: () => new Promise(resolve => { window.__releaseAuto = () => resolve({ ok: true }); }) });
    window.__autoDone = auto.startAuto();
    window.__queued = queue.enqueue({ params: { ...state.params }, base: null, refs: [], vibes: [] }, { count: 1, start: true });
  });
  assert.equal(await page.eval("import('/js/queue.js').then(q => q.queueRunning())"), false, 'auto excludes queue');
  await page.run(async () => {
    (await import('/js/auto.js')).stopAuto();
    (await import('/js/queue.js')).runQueue();
  });
  assert.equal(await page.eval("import('/js/queue.js').then(q => q.queueRunning())"), false, 'stop request retains ownership until completion');
  await page.run(async () => {
    window.__releaseAuto();
    await window.__autoDone;
    const queue = await import('/js/queue.js');
    queue.initQueue({ generate: () => new Promise(resolve => { window.__releaseQueue = () => resolve({ ok: true, recs: [{ id: 'mutex-test', seed: 42 }] }); }) });
    queue.runQueue();
    window.__queueClaimedSynchronously = queue.queueRunning();
    await (await import('/js/auto.js')).startAuto();
  });
  assert.equal(await page.eval('window.__queueClaimedSynchronously'), true, 'queue claims local ownership in the start call, before browser lock acquisition');
  assert.equal(await page.eval("import('/js/auto.js').then(a => a.autoRunning())"), false, 'queue excludes auto');
  await page.waitFor("typeof window.__releaseQueue === 'function'");
  await page.eval('window.__releaseQueue()');
  await page.waitFor("import('/js/queue.js').then(q => !q.queueRunning())", 20000);
  assert.equal(await page.eval('window.__queued.status'), 'done', 'released auto allows queue to complete');
};
