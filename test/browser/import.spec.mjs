export const options = { init: [
  `localStorage.setItem('nf.settings', JSON.stringify({translate:false,spellcheck:false,artistPeek:false,fxBg:false}));`,
] };

export default async ({ page, assert, log }) => {
  await page.waitFor("document.querySelector('#promptEditor textarea')");
  await page.eval(`(async () => {
    const {state} = await import('/js/store.js');
    Object.assign(state.params, {seed:'1234', width:832, sampler:'k_euler', prompt:'before'});
    (await import('/js/ui/panel.js')).refreshAll();
    window.__executableNodes = [];
    const check = (el) => {
      if (['SCRIPT','IFRAME','OBJECT','EMBED'].includes(el.tagName) || [...el.attributes].some(a => /^on/i.test(a.name) || /^javascript:/i.test(a.value))) window.__executableNodes.push(el.outerHTML);
    };
    window.__importObserver = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) {
        check(node); node.querySelectorAll('*').forEach(check);
      }
    });
    window.__importObserver.observe(document.body, {childList:true, subtree:true});
    const {writeTextChunks} = await import('/js/png.js');
    const c = document.createElement('canvas'); c.width = c.height = 8;
    const blob = await new Promise(r => c.toBlob(r));
    const attack = '<img src=x onerror="window.__pwn=1">';
    const entries = {
      Source:'NovelAI V4.5 4BDE2A90', Description:'legitimate imported prompt',
      Comment:JSON.stringify({seed:attack, sampler:attack, width:attack, height:1024, steps:17, scale:5, noise_schedule:'karras', uc:'bad anatomy'})
    };
    const bytes = writeTextChunks(new Uint8Array(await blob.arrayBuffer()), entries);
    window.__importTestFile = new File([bytes], 'untrusted-metadata.png', {type:'image/png'});
    const dt = new DataTransfer(); dt.items.add(window.__importTestFile);
    window.dispatchEvent(new DragEvent('drop', {dataTransfer:dt, bubbles:true, cancelable:true}));
  })()`);
  await page.waitFor('document.querySelector(\'[data-import-action="meta"]\')');
  await page.click('[data-import-action="view"]');
  assert.ok(await page.eval("document.querySelector('.meta-pre').textContent.includes('window.__pwn')"), 'raw metadata remains inspectable as text');
  await page.click('#modalRoot .modal-bg:last-child .modal-x');
  await page.click('[data-import-action="meta"]');
  await page.waitFor("document.querySelector('#promptEditor textarea').value === 'legitimate imported prompt'");
  await page.wait(200);
  const result = await page.eval(`(async () => {
    const {state} = await import('/js/store.js');
    return {pwn:window.__pwn ?? null, executable:window.__executableNodes, injected:document.querySelectorAll('#slug img, #slug script, #slug iframe').length,
      params:{seed:state.params.seed,width:state.params.width,height:state.params.height,steps:state.params.steps,sampler:state.params.sampler,model:state.params.model,uc:state.params.uc},
      notice:[...document.querySelectorAll('.toast')].some(el => /已忽略 3 个无效字段|Ignored 3 invalid fields/.test(el.textContent))};
  })()`);
  assert.equal(result.pwn, null);
  assert.deepEqual(result.executable, []);
  assert.equal(result.injected, 0);
  assert.deepEqual(result.params, { seed:'1234', width:832, height:1024, steps:17, sampler:'k_euler', model:'nai-diffusion-4-5-full', uc:'bad anatomy' });
  assert.equal(result.notice, true, 'rejected fields are counted for the user');

  // The seed/composition shortcut is a separate entry point used by the stage.
  const shortcut = await page.eval(`(async () => {
    const {state} = await import('/js/store.js');
    const {applySeed} = await import('/js/ui/dialogs.js');
    const r = applySeed({Comment:{seed:'<img src=x onerror="window.__pwn=1">',width:'<script>',steps:19}}, {composition:true});
    return {seed:state.params.seed,width:state.params.width,steps:state.params.steps,discarded:r.discarded};
  })()`);
  assert.deepEqual(shortcut, { seed:'1234', width:832, steps:19, discarded:2 });

  // Free-parameter conversion must not coerce a rejected numeric string first.
  await page.eval(`(async () => {
    const {writeTextChunks} = await import('/js/png.js');
    const c = document.createElement('canvas'); c.width = c.height = 8;
    const blob = await new Promise(r => c.toBlob(r));
    const bytes = writeTextChunks(new Uint8Array(await blob.arrayBuffer()), {Comment:JSON.stringify({seed:4242,width:'1024',height:1024,steps:50})});
    const dt = new DataTransfer(); dt.items.add(new File([bytes], 'free-params.png', {type:'image/png'}));
    window.dispatchEvent(new DragEvent('drop', {dataTransfer:dt, bubbles:true, cancelable:true}));
  })()`);
  await page.waitFor('document.querySelector(\'[data-import-action="meta"]\')');
  await page.click('[data-import="free"]');
  await page.click('[data-import-action="meta"]');
  const free = await page.eval(`(async () => {
    const {state} = await import('/js/store.js');
    return {width:state.params.width,height:state.params.height,steps:state.params.steps,seed:state.params.seed};
  })()`);
  assert.deepEqual(free, {width:832,height:1024,steps:28,seed:'4242'});

  // Even state from an older saved draft must render literal text in the slug.
  const literal = await page.eval(`(async () => {
    const {state} = await import('/js/store.js');
    state.params.seed = '<img src=x onerror="window.__pwn=1">';
    (await import('/js/ui/panel.js')).refreshAll();
    return {text:document.querySelector('#slug').textContent, children:document.querySelector('#slug').querySelectorAll('img,script,iframe').length};
  })()`);
  assert.ok(literal.text.includes('<img src=x onerror="window.__pwn=1">'));
  assert.equal(literal.children, 0);
  assert.equal(await page.eval('window.__pwn ?? null'), null);
  assert.deepEqual(await page.eval('window.__executableNodes'), []);
  log('real PNG drop/import: 3 rejected fields; legal fields retained; seed shortcut, free parameters and literal slug rendering passed');
};
