export default async ({ page, assert, log }) => {
  await page.run(async () => {
    const { state, set } = await import('/js/store.js');
    (await import('/js/i18n.js')).setLang('zh');
    state.settings.llm = { base: 'https://rewrite.invalid/v1', model: 'mock', key: '', think: false };
    set('params.model', 'nai-diffusion-5-full');
    (await import('/js/tagdb.js')).loadTagDBFromText(['tree', 'no_humans', 'scenery', '1girl', '1boy', 'smile'].map(t => `${t}\t0\t1000\t`).join('\n'));
    const original = fetch;
    window.fetch = async (url, init) => {
      if (String(url).includes('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(window.rewriteAnswer) }, finish_reason: 'stop' }] }));
      return original(url, init);
    };
  });
  const ask = async (answer, fresh = false, split = true) => {
    await page.run((answer) => { window.rewriteAnswer = answer; }, answer);
    await page.click('#btnIdeate');
    if (fresh) await page.run((split) => {
      document.querySelectorAll('.ide-gen .seg button')[1].click();
      if (!split) document.querySelector('.ide-split input').click();
    }, split);
    await page.run(() => { document.querySelector('.ide-ta').value = 'review'; document.querySelector('.ide-run').click(); });
    await page.waitFor("!document.querySelector('.ide-run').disabled");
  };
  const params = () => page.run(async () => structuredClone((await import('/js/store.js')).state.params));
  const reset = () => page.run(async () => {
    const { set } = await import('/js/store.js');
    set('params.prompt', '1boy');
    set('params.characters', [{ id: 'old', prompt: '1boy, smile', enabled: true, uc: '', x: .3, y: .5 }]);
  });
  const scene = { tags: ['no humans', 'scenery', 'tree'], characters: [] };
  const people = [{ tags: ['1girl'] }, { tags: ['1boy'] }];
  for (const [characters, split] of [[[], true], [[people[0]], true], [people, false], [people, true]]) {
    await reset();
    await ask({ ...scene, characters }, true, split);
    const clears = !split || characters.length < 2;
    if (clears) assert.ok(await page.eval("document.querySelector('.ide-out').textContent.includes('将清除现有 1 个角色')"), 'preview explains character removal');
    await page.click('.ide-apply');
    assert.equal((await params()).characters.length, clears ? 0 : 2, 'write new explicitly replaces the character list');
    const requestChars = await page.run(async () => {
      const { state } = await import('/js/store.js');
      const { buildGenerateBody } = await import('/js/nai.js');
      return buildGenerateBody({ params: state.params, model: (await import('/js/data.js')).modelById(state.params.model), seed: 42 }).parameters.v4_prompt.caption.char_captions;
    });
    assert.equal(requestChars.length, clears ? 0 : 2);
    await page.click('.toast.act');
    assert.deepEqual((await params()).characters.map(c => c.id), ['old'], 'production applySnapshot undo restores old characters');
  }
  await reset(); await ask({ tags: ['tree'] }); await page.click('.ide-apply');
  assert.deepEqual((await params()).characters.map(c => c.id), ['old'], 'modify keeps untouched characters');
  log('complete rewrite: empty/single/multiple characters, split disabled, request serialization, undo and modify preservation');
};
