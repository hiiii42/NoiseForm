import { artifact } from './harness.mjs';

export default async ({ page, assert, log }) => {
  const base = '# keep city, crowd\n1girl, 1.2::city_street::, {-1::crowd::}, She stands in a city plaza., [blue sky], @city_chunk';
  const answer = {
    remove: ['crowd', 'BLUE_SKY', 'not actually present'],
    replace: [
      { from: 'city street', to: 'countryside', kind: 'tag' },
      { from: 'She stands in a city plaza.', to: 'She stands by a village well.', kind: 'nl' },
      { from: 'long hair', to: 'unlisted outfit xyz', kind: 'tag' },
      { from: 'not present', to: 'tree' },
    ],
    tags: [{ tag: 'tree', cat: 'background' }, { tag: '1girl', cat: 'subject' }, { tag: 'unknown tag xyz', cat: 'other' }],
    nl: [], present: ['subject', 'appearance', 'background'], missing: ['lighting'],
    note: '换成乡村，并改写旧的广场描述。',
  };
  await page.run(async (base, answer) => {
    const { state, set } = await import('/js/store.js');
    const { setLang } = await import('/js/i18n.js');
    setLang('zh');
    state.settings.llm = { base: 'https://ideate.invalid/v1', model: 'mock-vision', key: '', think: false };
    set('params.model', 'nai-diffusion-4-5-full');
    set('params.prompt', base);
    set('params.characters', [
      { id: 'left', label: '左侧角色', enabled: true, prompt: '1.4::city_street::, crowd, {long hair}', uc: '', x: .3, y: .5 },
      { id: 'hidden', enabled: false, prompt: 'city street, crowd, hidden secret', uc: '', x: .7, y: .5 },
    ]);
    const { loadTagDBFromText } = await import('/js/tagdb.js');
    loadTagDBFromText(['1girl', '1boy', 'countryside', 'tree', 'kimono', 'long_hair', 'short_hair', 'blue_sky', 'sky'].map((s) => `${s}\t0\t1000\t`).join('\n'));
    window.ideAnswer = answer;
    window.ideRequests = [];
    window.ideErrors = [];
    const original = window.fetch;
    window.fetch = async (url, init) => {
      const path = String(url);
      if (path.includes('/chat/completions')) {
        window.ideRequests.push(JSON.parse(init.body));
        const error = window.ideErrors.shift();
        return new Response(JSON.stringify(error ? { error: { message: error.message } } : { choices: [{ message: { content: JSON.stringify(window.ideAnswer) }, finish_reason: 'stop' }] }), { status: error?.status || 200 });
      }
      if (path.startsWith('https://image.novelai.net/')) return new Response(JSON.stringify({ tags: [] }));
      return original(url, init);
    };
  }, base, answer);
  const run = async (text = '将当前提示词替换为农村场景') => {
    await page.run((text) => { const ta = document.querySelector('.ide-ta'); ta.value = text; ta.focus(); }, text);
    await page.key('Enter', 2); // Ctrl+Enter
    await page.waitFor("document.querySelector('.ide-out .ide-grp') && !document.querySelector('.ide-run').disabled");
  };
  const prompt = () => page.run(async () => (await import('/js/store.js')).state.params.prompt);
  const tab = async (index) => page.run((index) => document.querySelectorAll('.ide > .seg button')[index].click(), index);
  await page.click('#btnIdeate');
  assert.equal(await page.eval("document.querySelector('.ide-gen .seg .on').textContent"), '修改当前');
  assert.equal(await page.eval("document.querySelector('.ide-attach').hidden"), true, 'no image toggle without an image');
  await run();
  const request = await page.eval('window.ideRequests[0].messages[1].content');
  assert.ok(request.includes(base) && request.includes('Character 1 (左侧角色)') && request.includes('1.4::city_street::'), 'base and labelled enabled character carried');
  assert.ok(request.includes('hidden secret') && request.includes('enabled: false'), 'disabled character stays numbered and explicitly marked');
  assert.equal(await page.eval("document.querySelectorAll('.ide-remove').length"), 2, 'unmatched removal hidden');
  assert.equal(await page.eval("document.querySelectorAll('.ide-replace').length"), 3, 'unmatched replacement hidden');
  await page.waitFor("document.querySelector('.ide-replace.st-unknown')");
  assert.equal(await page.eval("document.querySelector('.ide-replace.st-unknown').getAttribute('aria-pressed')"), 'false', 'unknown target off');
  assert.equal(await page.eval("document.querySelector('.ide-t.st-unknown:not(.ide-replace)').getAttribute('aria-pressed')"), 'false', 'unknown addition off');
  assert.equal(await page.eval("document.querySelector('.ide-apply').textContent"), '应用：删 2 · 换 2 · 加 1');
  await page.click('.ide-remove');
  assert.ok((await page.eval("document.querySelector('.ide-apply').textContent")).includes('删 1'));
  await page.click('.ide-remove');
  await page.click('.ide-replace');
  assert.ok((await page.eval("document.querySelector('.ide-apply').textContent")).includes('换 1'));
  await page.click('.ide-replace');
  for (const theme of ['paper', 'novelai']) {
    await page.run(async (theme) => { const { state } = await import('/js/store.js'); state.settings.theme = theme; (await import('/js/themes.js')).applyAppearance(); }, theme);
    await page.wait(150);
    await page.shot(artifact(`ideate-modify-${theme}.png`));
    assert.ok(await page.eval("(()=>{const e=document.querySelector('.ide'); return e.scrollWidth<=e.clientWidth+1})()"), 'dialog has no horizontal overflow');
  }
  await page.click('.ide-apply');
  assert.equal(await prompt(), '# keep city, crowd\n1girl, 1.2::countryside::, She stands by a village well., @city_chunk, tree');
  const chars = await page.run(async () => (await import('/js/store.js')).state.params.characters);
  assert.equal(chars[0].prompt, '1.4::countryside::, {long hair}');
  assert.equal(chars[1].prompt, 'countryside, hidden secret', 'edits apply to every character without enabling it');
  assert.equal(chars[1].enabled, false);

  // Check uses the same actionable removals and replacements, including conflict-only output.
  await page.run(async () => {
    const { set } = await import('/js/store.js');
    set('params.prompt', 'long hair, short hair, 1.2::city street::');
    set('params.characters', []);
    window.ideAnswer = { tags: [], conflicts: [{ tags: ['long hair', 'short hair'], note: '选择要保留的发型' }], replace: [{ from: 'city street', to: 'countryside', kind: 'tag' }] };
  });
  await page.click('#btnIdeate'); await tab(1); await page.click('.ide-check');
  await page.waitFor("document.querySelectorAll('.ide-remove').length === 2");
  assert.equal(await page.eval("document.querySelectorAll('.ide-remove[aria-pressed=true]').length"), 0, 'conflict alternatives await a choice');
  await page.click('.ide-remove'); await page.click('.ide-apply');
  assert.equal(await prompt(), 'short hair, 1.2::countryside::');
  await page.run(() => { window.ideAnswer = { tags: [], remove: ['short hair'] }; });
  await page.click('#btnIdeate'); await tab(1); await page.click('.ide-check');
  await page.waitFor("document.querySelector('.ide-remove')");
  await page.click('.ide-remove');
  assert.equal(await page.eval("document.querySelector('.ide-apply').disabled"), true, 'nothing selected disables apply');
  await page.click('.ide-remove'); await page.click('.ide-apply');
  assert.equal(await prompt(), '1.2::countryside::', 'deletion-only result applies');

  // Empty base with a populated enabled character still defaults to Modify current.
  await page.run(async () => {
    const { set } = await import('/js/store.js'); set('params.prompt', '');
    set('params.characters', [{ id: 'only', enabled: true, prompt: '1girl' }]);
  });
  await page.click('#btnIdeate');
  assert.equal(await page.eval("document.querySelector('.ide-gen .seg .on').textContent"), '修改当前');
  await page.key('Escape');

  // Write new keeps character splitting, including verified selectable character tags.
  await page.run(async () => {
    const { set } = await import('/js/store.js'); set('params.characters', []);
    window.ideAnswer = { tags: [{ tag: 'tree', cat: 'background' }], characters: [{ label: 'girl', tags: ['1girl', 'kimono'], position: 'left' }, { label: 'boy', tags: ['1boy'], position: 'right' }] };
  });
  await page.click('#btnIdeate');
  assert.equal(await page.eval("document.querySelector('.ide-gen .seg .on').textContent"), '重新写');
  await run('两个人在树下'); await page.click('.ide-apply');
  const split = await page.run(async () => (await import('/js/store.js')).state.params.characters);
  assert.equal(split.length, 2); assert.equal(split[0].prompt, '1girl, kimono'); assert.equal(split[0].x, .3); assert.equal(split[1].x, .7);

  // Test the real main.js opener with a local canvas image, without generation.
  await page.run(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 1536; canvas.height = 1024;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#839c78'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    const { images } = await import('/js/db.js');
    await images.put({ id: 'ideate-vision', blob, createdAt: Date.now() });
    const { state } = await import('/js/store.js'); state.session.currentId = 'ideate-vision';
    window.ideAnswer = { tags: [{ tag: 'sky', cat: 'background' }] };
  });
  await page.click('#btnIdeate'); await page.waitFor("!document.querySelector('.ide-attach').hidden");
  assert.equal(await page.eval("document.querySelector('.ide-attach input').checked"), false);
  await page.click('.ide-attach input'); await run('');
  const imageRequest = await page.eval('window.ideRequests.at(-1).messages[1].content');
  assert.equal(imageRequest[0].type, 'text'); assert.ok(imageRequest[0].text.includes('对照这张图优化提示词'));
  assert.equal(imageRequest[1].type, 'image_url'); assert.ok(imageRequest[1].image_url.url.startsWith('data:image/jpeg;base64,'));
  const size = await page.run(async (url) => { const img = new Image(); img.src = url; await img.decode(); return [img.width, img.height]; }, imageRequest[1].image_url.url);
  assert.deepEqual(size, [768, 512]);
  await page.key('Escape');
  await page.click('#btnIdeate'); await page.waitFor("!document.querySelector('.ide-attach').hidden");
  assert.equal(await page.eval("document.querySelector('.ide-attach input').checked"), true, 'image choice remembered');
  const before = await page.eval('window.ideRequests.length');
  await page.run(() => { window.ideErrors = [{ status: 400, message: 'Invalid image_url: vision input is not supported' }]; });
  await page.click('.ide-run'); await page.waitFor("document.querySelector('.ide-status.err')?.textContent.includes('当前模型不支持识图')");
  assert.equal(await page.eval('window.ideRequests.length'), before + 1, 'image rejection is not retried by stripping optional fields');
  await page.click('.ide-attach input'); await page.click('.ide-run');
  await page.waitFor("document.querySelector('.ide-out .ide-grp') && !document.querySelector('.ide-run').disabled");
  const textRetry = await page.eval('window.ideRequests.at(-1)');
  assert.equal(typeof textRetry.messages[1].content, 'string');
  assert.ok(textRetry.thinking && textRetry.response_format, 'vision error does not poison optional-field cache');
  await page.key('Escape');

  // Optional-field retries still work for text-only direct endpoints.
  const retry = await page.run(async () => {
    const { state } = await import('/js/store.js'); state.session.proxy = false;
    state.settings.llm.base = 'https://ideate-direct.invalid/v1';
    window.ideErrors = [{ status: 422, message: 'response_format is unsupported' }, { status: 400, message: 'thinking is unsupported' }];
    const from = window.ideRequests.length;
    await (await import('/js/llm.js')).chatEx([{ role: 'user', content: 'test optional fields' }]);
    return window.ideRequests.slice(from);
  });
  assert.equal(retry.length, 3); assert.ok(retry[1].thinking && !retry[1].response_format); assert.ok(!retry[2].thinking && !retry[2].response_format);
  log('mock: weighted edits, sentences, all characters, conflict choices, deletion only, split characters, 768px vision, error recovery and optional-field retries; paper/novelai screenshots saved');
};
