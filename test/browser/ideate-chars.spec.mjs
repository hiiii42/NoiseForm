import { artifact } from './harness.mjs';

export default async ({ page, assert, log }) => {
  await page.run(async () => {
    const { state, set } = await import('/js/store.js');
    (await import('/js/i18n.js')).setLang('zh');
    state.settings.llm = { base: 'https://ideate-chars.invalid/v1', model: 'mock', key: '', think: false };
    set('params.model', 'nai-diffusion-5-full');
    set('params.prompt', '2girls, 1boy, hetero, tree');
    set('params.aiChoice', false);
    set('params.characters', [
      { id: 'girl-a', prompt: '1girl, long hair', x: .3, y: .5, enabled: true, uc: '' },
      { id: 'man', prompt: '1boy, short hair', x: .5, y: .5, enabled: true, uc: '' },
      { id: 'girl-b', prompt: '1girl, kimono', x: .7, y: .5, enabled: false, uc: '' },
    ]);
    (await import('/js/tagdb.js')).loadTagDBFromText([
      ...['1girl', '1boy', '2girls', 'long_hair', 'short_hair', 'kimono', 'smile', 'tree'].map((tag) => `${tag}\t0\t1000\t`),
      ...['artist_a', 'artist_b', 'artist_c'].map((tag) => `${tag}\t1\t1000\t`),
    ].join('\n'));
    window.charRequests = [];
    window.charAnswer = { remove: ['1boy', 'hetero'], char_edits: [{ index: 2, delete: true }] };
    window.charFinish = 'stop';
    const original = window.fetch;
    window.fetch = async (url, init) => {
      if (String(url).includes('/chat/completions')) {
        window.charRequests.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: window.charRaw ?? JSON.stringify(window.charAnswer) }, finish_reason: window.charFinish }] }));
      }
      if (String(url).startsWith('https://image.novelai.net/')) return new Response(JSON.stringify({ tags: [] }));
      return original(url, init);
    };
  });
  const ask = async (text) => {
    await page.run((text) => { document.querySelector('.ide-ta').value = text; document.querySelector('.ide-run').click(); }, text);
    await page.waitFor("!document.querySelector('.ide-run').disabled");
  };
  const tab = (index) => page.run((index) => document.querySelectorAll('.ide > .seg button')[index].click(), index);
  const params = () => page.run(async () => JSON.parse(JSON.stringify((await import('/js/store.js')).state.params)));

  await page.click('#btnIdeate');
  await ask('删掉图中的男人');
  assert.equal(await page.eval("document.querySelector('.ide-character-title').textContent"), '角色 2 · 1boy');
  assert.equal(await page.eval("document.querySelector('.ide-apply').textContent"), '应用：删 3 · 换 0 · 加 0');
  const request = await page.eval('window.charRequests.at(-1).messages.at(-1).content');
  assert.ok(request.includes('character limit: 32') && request.includes('positions supported: true'));
  assert.ok(request.includes('x 0.30 y 0.50') && request.includes('Character 3') && request.includes('enabled: false'));
  await page.wait(250);
  await page.shot(artifact('ideate-delete-character.png'));
  await page.click('.ide-apply');
  let p = await params();
  assert.equal(p.prompt, '2girls, tree');
  assert.deepEqual(p.characters.map((c) => c.id), ['girl-a', 'girl-b']);
  assert.equal(p.characters[1].enabled, false);

  // "remove old sentence + add rewritten sentence" (seen from deepseek-flash) becomes one replace chip.
  await page.run(async () => {
    (await import('/js/store.js')).set('params.prompt', '2girls, tree, The three friends dance in the middle of the street.');
    window.charAnswer = { remove: ['The three friends dance in the middle of the street.'], nl: ['The two girls dance together in the middle of the street.'] };
  });
  await page.click('#btnIdeate'); await ask('删掉男人');
  assert.equal(await page.eval("document.querySelectorAll('.ide-removals .ide-t').length"), 0, 'paired removal is not listed twice');
  assert.equal(await page.eval("document.querySelector('.ide-replacements .ide-from').textContent"), 'The three friends dance in the middle of the street.');
  assert.equal(await page.eval("document.querySelector('.ide-apply').textContent"), '应用：删 0 · 换 1 · 加 0');
  await page.click('.ide-apply');
  assert.equal((await params()).prompt, '2girls, tree, The two girls dance together in the middle of the street.');
  await page.run(async () => (await import('/js/store.js')).set('params.prompt', '2girls, tree'));

  // Bug (1.8.2): a sentence containing a comma was split into two segments, so a replace / remove naming the
  // whole sentence (what the model returns) matched nothing and silently disappeared. Raw answers from deepseek-flash.
  const RURAL = '2girls, streetwear, dancing, hip hop\nartist:ningen mame, rural, rice paddy, golden hour, The three teenagers dance together on a dirt path between rice paddies, the boy in the center between the two girls., depth of field, Low sun casts long shadows across the paddy path behind the two girls., ';
  const OLD = 'The three teenagers dance together on a dirt path between rice paddies, the boy in the center between the two girls.';
  for (const [answer, label] of [
    [{ replace: [{ from: OLD, to: 'The two girls dance together on a dirt path between rice paddies.', kind: 'nl' }] }, 'replace'],
    [{ replace: [{ from: OLD.slice(0, -1), to: 'The two girls dance together on a dirt path between rice paddies.', kind: 'nl' }] }, 'replace without final period'],
    [{ remove: [OLD], nl: ['The two girls dance together on a dirt path between rice paddies.'] }, 'remove + nl'],
  ]) {
    await page.run(async (prompt, answer) => { (await import('/js/store.js')).set('params.prompt', prompt); window.charAnswer = answer; }, RURAL, answer);
    await page.click('#btnIdeate'); await ask('删掉图中的男人');
    assert.equal(await page.eval("document.querySelector('.ide-replacements .ide-from')?.textContent"), OLD, label + ': whole sentence offered');
    assert.equal(await page.eval("document.querySelectorAll('.ide-removals .ide-t').length"), 0, label + ': not also listed as a deletion');
    await page.click('.ide-apply');
    const after = (await params()).prompt;
    assert.ok(after.includes('golden hour, The two girls dance together on a dirt path between rice paddies., depth of field'), label + ': ' + after);
    assert.ok(!after.includes('the boy in the center'), label + ': old second half gone');
  }
  await page.run(async () => (await import('/js/store.js')).set('params.prompt', '2girls, tree'));

  // Check mode supports targeted prompt changes, coordinates, and new character groups.
  await page.run(async () => {
    (await import('/js/store.js')).set('params.aiChoice', true);
    window.charAnswer = { char_edits: [
      { index: 1, replace: [{ from: 'long hair', to: 'short hair', kind: 'tag' }], add: ['smile'], position: { x: .326, y: .674 } },
      { new: true, label: '新角色', tags: ['1boy'], position: { x: .9, y: .5 } },
    ] };
  });
  await page.click('#btnIdeate'); await tab(1); await page.click('.ide-check');
  await page.waitFor("document.querySelector('.ide-position') && !document.querySelector('.ide-check').disabled");
  assert.ok((await page.eval('window.charRequests.at(-1).messages.at(-1).content')).includes('position: AI'));
  assert.equal(await page.eval("document.querySelector('.ide-position').textContent"), '位置 → 33·67');
  await page.click('.ide-char-new');
  assert.equal(await page.eval("document.querySelector('[data-character-index=new] .ide-char-add').disabled"), true);
  for (const theme of ['paper', 'novelai']) {
    await page.run(async (theme) => { (await import('/js/store.js')).state.settings.theme = theme; (await import('/js/themes.js')).applyAppearance(); }, theme);
    await page.wait(250);
    await page.shot(artifact(`ideate-character-edits-${theme}.png`));
    assert.ok(await page.eval("(()=>{const e=document.querySelector('.ide'); return e.scrollWidth<=e.clientWidth+1})()"));
  }
  await page.click('.ide-apply');
  p = await params();
  assert.equal(p.characters.length, 2);
  assert.equal(p.characters[0].prompt, '1girl, short hair, smile');
  assert.equal(p.characters[1].prompt, '1girl, kimono');
  assert.deepEqual([p.characters[0].x, p.characters[0].y, p.aiChoice], [.33, .67, false]);

  // Additions are capped to the model's capacity; coordinates remain unsnapped in UI state.
  await page.run(async () => {
    const { set } = await import('/js/store.js');
    set('params.model', 'nai-diffusion-4-5-full');
    set('params.characters', Array.from({ length: 5 }, (_, i) => ({ id: 'c' + i, prompt: '1girl', enabled: true, x: .5, y: .5 })));
    window.charAnswer = { char_edits: [
      { new: true, label: 'last', tags: ['1boy'], position: { x: .427, y: .581 } },
      { new: true, label: 'overflow', tags: ['1girl'] },
    ] };
  });
  await page.click('#btnIdeate'); await ask('再加两个人'); await page.click('.ide-apply');
  p = await params();
  assert.equal(p.characters.length, 6);
  assert.deepEqual([p.characters[5].x, p.characters[5].y], [.43, .58]);
  assert.ok(await page.eval("document.body.textContent.includes('已略过 1 个新增角色')"));

  // Empty / malformed / truncated outputs are visible and cannot apply an empty patch.
  await page.run(() => { window.charAnswer = {}; });
  await page.click('#btnIdeate'); await ask('删掉图中的男人');
  assert.ok(await page.eval("document.querySelector('.ide-empty').textContent.includes('没有可应用的建议')"));
  assert.equal(await page.eval("document.querySelector('.ide-apply').disabled"), true);
  await page.run(() => { window.charRaw = '{broken'; }); await ask('重试');
  assert.ok(await page.eval("document.querySelector('.ide-status.err').textContent.includes('失败')"));
  await page.run(() => { window.charFinish = 'length'; }); await ask('重试');
  assert.ok(await page.eval("document.querySelector('.ide-status.err').textContent.includes('截断')"));
  await page.key('Escape');

  // New prompt accepts coordinate objects as well as legacy left/right strings.
  await page.run(async () => {
    const { set } = await import('/js/store.js'); set('params.prompt', ''); set('params.characters', []);
    window.charRaw = null; window.charFinish = 'stop';
    window.charAnswer = { characters: [{ tags: ['1girl'], position: { x: .34, y: .62 } }, { tags: ['1boy'], position: 'right' }] };
  });
  await page.click('#btnIdeate'); await ask('两个人'); await page.click('.ide-apply');
  p = await params();
  assert.deepEqual([p.characters[0].x, p.characters[0].y, p.characters[1].x], [.34, .62, .7]);

  // Artist pairing: local category validation, weighted existing chips, two turns,
  // rejected list, reopen persistence, image attachment and explicit reset.
  await page.run(async () => {
    const { set, state } = await import('/js/store.js');
    set('params.prompt', '1girl, 1.2::artist:artist_a::, tree');
    window.charAnswer = { artists: [{ tag: 'artist:artist_b', why: '厚涂' }, { tag: 'artist:unlisted', why: '未知' }, { tag: 'artist:tree', why: '非画师分类' }] };
    const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 100;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    await (await import('/js/db.js')).images.put({ id: 'artist-vision', blob, createdAt: Date.now() });
    state.session.currentId = 'artist-vision';
  });
  const refine = async (text) => {
    await page.run((text) => { document.querySelector('.ide-artist-input').value = text; document.querySelector('.ide-artist-run').click(); }, text);
    await page.waitFor("!document.querySelector('.ide-artist-run').disabled");
  };
  await page.click('#btnIdeate'); await tab(2);
  assert.equal(await page.eval("document.querySelector('.ide-artist').getAttribute('aria-pressed')"), 'true', 'existing weighted artist enabled');
  await page.waitFor("!document.querySelector('.ide-attach').hidden");
  await page.click('.ide-attach input');
  await refine('更厚涂');
  assert.equal(await page.eval("document.querySelectorAll('.ide-artist.st-unknown[aria-pressed=false]').length"), 2);
  await page.run(() => [...document.querySelectorAll('.ide-artist')].find((e) => e.textContent === 'artist:artist b').click());
  await page.key('Escape');
  await page.click('#btnIdeate'); await tab(2);
  assert.equal(await page.eval("[...document.querySelectorAll('.ide-artist')].find(e=>e.textContent==='artist:artist b').getAttribute('aria-pressed')"), 'false');
  await page.waitFor("!document.querySelector('.ide-attach').hidden");
  await page.run(() => { window.charAnswer = { artists: [{ tag: 'artist:artist_c', why: '低饱和厚涂' }] }; });
  await refine('饱和度低一点');
  const second = await page.eval('window.charRequests.at(-1).messages');
  assert.equal(second.length, 4);
  assert.ok(second[1].content.includes('更厚涂'));
  assert.ok(second[2].content.includes('artist_b'));
  assert.equal(second.at(-1).content[1].type, 'image_url');
  const text = second.at(-1).content[0].text;
  assert.ok(text.includes('Rejected artists: ["artist:artist b","artist:unlisted","artist:tree"]'));
  assert.ok(text.includes('Kept artists: ["artist:artist_a"]'));
  assert.ok(second.slice(1, -1).every((m) => typeof m.content === 'string'), 'historical images are not retained or resent');
  for (const theme of ['paper', 'novelai']) {
    await page.run(async (theme) => { (await import('/js/store.js')).state.settings.theme = theme; (await import('/js/themes.js')).applyAppearance(); }, theme);
    await page.wait(250);
    await page.shot(artifact(`ideate-artists-${theme}.png`));
  }
  await page.click('.ide-apply');
  assert.equal((await params()).prompt, '1girl, 1.2::artist:artist_a::, artist:artist c, tree');
  await page.click('#btnIdeate'); await tab(2); await page.click('.ide-artist-reset');
  await refine('重新搭配');
  assert.equal(await page.eval('window.charRequests.at(-1).messages.length'), 2);
  for (let i = 0; i < 7; i++) await refine(`微调 ${i}`);
  assert.equal(await page.eval('window.charRequests.at(-1).messages.length'), 14, 'at most six complete historical turns plus system/current request');
  // paint() rebuilds the list after each click, so use the live first selected chip.
  await page.run(() => { while (document.querySelector('.ide-artist[aria-pressed=true]')) document.querySelector('.ide-artist[aria-pressed=true]').click(); });
  assert.equal(await page.eval("document.querySelector('.ide-apply').disabled"), false, 'clear all artists is actionable');
  await page.click('.ide-apply');
  assert.equal((await params()).prompt, '1girl, tree');
  await page.click('#btnIdeate'); await tab(2); await page.click('.ide-artist-reset');
  assert.equal(await page.eval("document.querySelectorAll('.ide-artist').length"), 0);
  await page.key('Escape');
  log('mock: character deletion, targeted edits, coordinates, cap, empty/error/truncated output, artist categories, two-turn feedback, persistence, vision and reset; screenshots in the run artifact directory');
};
