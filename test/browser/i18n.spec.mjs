// Real local UI + DEMO generation; no external API calls are needed.
export const options = { init: [
  `if (!localStorage.getItem('nf.settings')) localStorage.setItem('nf.settings', JSON.stringify({lang:'zh',artistPeek:false,fxBg:false,fxReveal:false}));`,
] };

export default async ({ page, assert, log }) => {
  await page.waitFor("document.querySelector('#promptEditor textarea')");
  const lang = async value => {
    await page.run(async value => (await import('/js/store.js')).set('settings.lang', value), value);
    await page.wait(200);
  };
  const scan = async label => {
    const result = await page.run(() => {
      const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
      const visible = el => {
        const box = el.matches('option,optgroup') ? el.closest('select') : el;
        return box?.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !box.closest('script,style,svg, [hidden]');
      };
      // Only data-bearing leaves are exempt. Their surrounding UI and attributes
      // are still scanned. Stored example chunk names are editable @ references.
      const dataText = el => el.matches('.chunk-row > span, .chunk-row > small, .ac-zh, .dtag > i, .rt > i, .rt > s') ||
        el.closest('.ed-hl, .meta-pre, .tl-full, .tl-first');
      const bad = [], allowed = [];
      if (cjk.test(document.title)) bad.push({ at: 'document.title', text: document.title });
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) {
        const el = node.parentElement;
        if (!el || !visible(el) || !cjk.test(node.textContent)) continue;
        const row = { at: el.tagName + (el.id ? '#' + el.id : '') + '.' + el.className, text: node.textContent.trim() };
        // The language switch deliberately offers the other language as “中”.
        if ((el.id === 'btnLang' && node.textContent === '中') || dataText(el)) allowed.push(row);
        else bad.push(row);
      }
      for (const el of document.querySelectorAll('[title],[placeholder],[aria-label]')) {
        if (!visible(el)) continue;
        for (const attr of ['title', 'placeholder', 'aria-label']) {
          const value = el.getAttribute(attr) || '';
          if (!cjk.test(value)) continue;
          // Review-token tooltips include the source prompt / Chinese glossary.
          // Autocomplete and tag-diff tooltips also carry user tag translations.
          if (el.matches('.rt, .ac-i, .dtag')) allowed.push({ at: attr, text: value });
          else bad.push({ at: el.tagName + '#' + el.id + '.' + el.className + '[' + attr + ']', text: value });
        }
      }
      return { bad, allowed };
    });
    assert.deepEqual(result.bad, [], label + ': English UI contains CJK: ' + JSON.stringify(result.bad));
    log(label + ': clean (' + result.allowed.length + ' data/language-switch leaves exempt)');
  };
  // Test already-mounted content in both directions, not just fresh dialogs.
  const bilingual = async (label, selector, chinese) => {
    await lang('zh');
    assert.match(await page.run(sel => document.querySelector(sel)?.textContent || '', selector), chinese, label + ' Chinese');
    await lang('en');
    await scan(label);
    await lang('zh');
    assert.match(await page.run(sel => document.querySelector(sel)?.textContent || '', selector), chinese, label + ' switches back');
    await lang('en');
  };
  await bilingual('main', '#btnQueue', /队列/);
  await lang('zh');
  await page.click('#modelBtn');
  await bilingual('model menu', '#modelMenu', /精选|模型/);
  await page.key('Escape'); await lang('zh');
  await page.click('#btnTheme');
  await bilingual('appearance', '.appear-pop', /外观/);
  await page.key('Escape'); await lang('zh');
  await lang('zh');
  await page.click('#btnSettings');
  const token = await page.eval("document.querySelector('.token-row input').value");
  await page.eval("[...document.querySelectorAll('.modal button')].find(e => e.textContent === '获取模型').click()");
  assert.match(await page.eval("document.querySelector('.llm-model').closest('.field').textContent"), /先填接口地址/);
  await bilingual('settings', '.modal-t', /设置/);
  assert.equal(await page.eval("document.querySelector('.token-row input').value"), token, 'language change preserves token input');
  await page.key('Escape'); await lang('zh');

  await page.run(async () => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const blob = await new Promise(resolve => c.toBlob(resolve));
    const { writeTextChunks } = await import('/js/png.js');
    const data = writeTextChunks(new Uint8Array(await blob.arrayBuffer()), { Description: '1girl, smile', Comment: JSON.stringify({ seed: 42, steps: 23, width: 832, height: 1216 }) });
    await (await import('/js/ui/dialogs.js')).openImport(new File([data], 'fixture.png', { type: 'image/png' }), {});
  });
  await page.eval("document.querySelector('[data-import=seed]').click()");
  await bilingual('PNG import', '.modal-t', /想用这张图/);
  assert.equal(await page.eval("document.querySelector('[data-import=seed]').checked"), false, 'import choices survive language changes');
  await page.key('Escape'); await lang('zh');
  await page.click('#btnQueue');
  await bilingual('queue', '.queue-pop', /队列/);
  await page.key('Escape'); await lang('zh');
  await page.run(async () => { (await import('/js/store.js')).set('params.prompt', '1girl, smile'); });
  await page.click('#btnXY');
  await page.waitFor("document.querySelector('.xy-tpl button')");
  await page.eval("[...document.querySelectorAll('.xy-tpl button')].find(e => e.textContent === '步数').click()");
  await bilingual('X/Y', '.modal-t', /X\/Y/);
  // Generate under Chinese, then switch the mounted result and queue/history:
  // old persisted axis labels must not leak Chinese into an English session.
  await lang('zh');
  await page.click('.modal-f .solid');
  await page.waitFor("document.querySelector('.xy-view') && document.querySelectorAll('.xy-view .xy-cell.has').length === 3", 30000);
  await bilingual('X/Y results', '.xy-axes-l', /步数/);
  await page.key('Escape'); await lang('zh');
  await page.click('#btnQueue');
  await page.eval("[...document.querySelectorAll('.qp-tabs button')].find(e => /历史/.test(e.textContent)).click()");
  await bilingual('X/Y queue history', '.queue-pop', /步数/);
  await page.key('Escape'); await lang('zh');
  await page.click('#btnSnippets');
  await bilingual('chunks', '.chunk-pop header', /提示词块/);
  await page.key('Escape'); await lang('zh');
  await page.click('#btnIdeate');
  await bilingual('AI assistant', '.modal-t', /构思/);
  await page.key('Escape'); await lang('zh');

  await page.run(async () => {
    const { set } = await import('/js/store.js');
    set('params.prompt', '1girl, smile');
    document.querySelector('#btnGenerate').click();
  });
  await page.waitFor("(async()=> (await (await import('/js/db.js')).images.list()).length > 0)()", 25000);
  await page.waitFor("document.querySelector('#tools .tool.more') && !document.querySelector('#tools').hidden");
  await page.click('#tools .tool.more');
  await page.click('[data-tool=post]');
  await page.waitFor("document.body.classList.contains('post-mode') && document.querySelector('#postCanvas')");
  await bilingual('workbench color', '#postReset', /全部复位/);
  // Keep a real adjustment through language changes.
  await page.eval("(()=>{const e=document.querySelector('#postPanel input[data-path=\"light.exposure\"]');e.value='0.5';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await lang('zh'); await lang('en');
  assert.equal(await page.eval("document.querySelector('#postPanel input[data-path=\"light.exposure\"]').value"), '0.5');
  for (const tab of ['style', 'detail', 'retouch']) {
    await lang('zh');
    await page.click('#postTab-' + tab);
    await bilingual('workbench ' + tab, '#postReset', /全部复位/);
  }
  await page.run(async () => (await import('/js/ui/workbench.js')).exitPost());
  await lang('zh');
  await page.run(async () => {
    const { images } = await import('/js/db.js'); const rec = await images.get((await images.list())[0].id);
    const { state } = await import('/js/store.js');
    await (await import('/js/ui/tiled.js')).openTiled(rec, { getBlob: r => r.blob, snapshot: () => ({ params: structuredClone(state.params), vibes: [], refs: [] }) });
    document.querySelector('.tiled-advanced').open = true;
  });
  await bilingual('tiled upscale', '.modal-t', /分块放大/);
  await page.key('Escape'); await lang('zh');
  await page.run(() => document.querySelector('.thumb[data-id]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 })));
  await bilingual('archive context menu', '.ctx-menu', /收藏/);
  await page.key('Escape'); await lang('zh');
  await page.click('#btnTimeline');
  await bilingual('prompt history', '.modal-t', /历史/);
  await page.key('Escape'); await lang('zh');
  await page.click('#btnStorage');
  await bilingual('storage', '.modal-t', /存储/);
  await page.key('Escape'); await lang('zh');
  await page.run(async () => { (await import('/js/ui/tour.js')).startTour('main', { force: true }); });
  await bilingual('tour', '.tour-card', /提示词|生成|欢迎|开始/);
  for (const id of ['main', 'firstImage', 'post']) {
    if (id !== 'main') await page.run(async id => { (await import('/js/ui/tour.js')).startTour(id, { force: true }); }, id);
    for (let i = 0; i < 30 && await page.eval("!!document.querySelector('.tour-card')"); i++) {
      await scan(id + ' tour step ' + i);
      await page.click('.tour-next');
    }
    assert.equal(await page.eval("!!document.querySelector('.tour-card')"), false, id + ' tour finished');
  }
  await lang('en'); await page.wait(600); await page.reload();
  await page.waitFor("document.querySelector('#promptEditor textarea') && document.documentElement.lang === 'en'");
  await scan('fresh English boot');
  await page.click('#btnSettings'); await scan('fresh English settings');
  await page.key('Escape');
};

