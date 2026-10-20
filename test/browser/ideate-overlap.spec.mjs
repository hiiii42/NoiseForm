export default async ({ page, assert, log }) => {
  await page.run(async () => {
    const { state, set } = await import('/js/store.js');
    (await import('/js/i18n.js')).setLang('zh');
    state.settings.llm = { base: 'https://overlap.invalid/v1', model: 'mock', key: '', think: false };
    set('params.model', 'nai-diffusion-5-full'); set('params.characters', []);
    (await import('/js/tagdb.js')).loadTagDBFromText('tree\t0\t1000\t');
    const original = fetch;
    window.fetch = async (url, init) => {
      if (String(url).includes('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(window.overlapAnswer) }, finish_reason: 'stop' }] }));
      return original(url, init);
    };
  });
  const old = 'The girls walk through the park, the boy waves beside them.';
  const next = 'The girls walk through the park, the girls wave beside them.';
  for (const answer of [
    { remove: [old], nl: [next] },
    { remove: [old.slice(0, -1)], nl: [next.slice(0, -1)] },
    { remove: [old], replace: [{ from: 'the boy waves beside them.', to: 'the girls wave beside them.', kind: 'nl' }] },
    { remove: ['the boy waves beside them.'], replace: [{ from: old, to: next, kind: 'nl' }, { from: 'the boy waves beside them.', to: 'discarded words here.', kind: 'nl' }] },
  ]) {
    await page.run(async (old, answer) => { (await import('/js/store.js')).set('params.prompt', 'tree, ' + old); window.overlapAnswer = answer; }, old, answer);
    await page.click('#btnIdeate');
    await page.run(() => { document.querySelector('.ide-ta').value = 'review'; document.querySelector('.ide-run').click(); });
    await page.waitFor("!document.querySelector('.ide-run').disabled");
    assert.equal(await page.eval("document.querySelector('.ide-apply').textContent"), '应用：删 0 · 换 1 · 加 0', 'preview counts only effective operations');
    assert.equal(await page.eval("document.querySelectorAll('.ide-removals .ide-t').length"), 0);
    await page.click('.ide-apply');
    const actual = await page.run(async () => (await import('/js/store.js')).state.params.prompt);
    assert.equal(actual.replace(/\.$/, ''), ('tree, ' + next).replace(/\.$/, ''));
  }
  log('remove + nl matches whole comma sentence; overlap preview counts agree with application');
};
