export const options = { init: [
  `localStorage.setItem('nf.settings', JSON.stringify({translate:false,spellcheck:false,artistPeek:false,fxBg:false}));
  window.__roTargets = new Map();
  const NativeRO = window.ResizeObserver;
  window.ResizeObserver = class extends NativeRO {
    constructor(cb) { super(cb); window.__roTargets.set(this, new Set()); }
    observe(target, options) { window.__roTargets.get(this).add(target); return super.observe(target, options); }
    unobserve(target) { window.__roTargets.get(this).delete(target); return super.unobserve(target); }
    disconnect() { window.__roTargets.get(this).clear(); return super.disconnect(); }
  };`,
] };

export default async ({ page, assert, log }) => {
  await page.waitFor("document.querySelector('#promptEditor textarea')");
  const result = await page.eval(`(async () => {
    const {state} = await import('/js/store.js');
    const {renderChars} = await import('/js/ui/panel.js');
    const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const targets = () => [...window.__roTargets.values()].flatMap(s => [...s]);
    const detachedRanges = () => CSS.highlights ? [...CSS.highlights].filter(([name]) => name.startsWith('nf-ed-')).flatMap(([,ranges]) => [...ranges]).filter(r => !r.startContainer.isConnected || !r.endContainer.isConnected).length : 0;
    const snapshot = () => ({live:targets().length, detached:targets().filter(t => !t.isConnected).length, ranges:detachedRanges()});
    const baseline = snapshot();
    const c = {id:'lifecycle-char',prompt:'{cat}, 1.2::red hair::',uc:'[hat]',x:0.5,y:0.5,enabled:true};
    state.params.characters = [c]; renderChars(); await frame();
    const first = snapshot();
    let maxDetached = 0;
    for (let i = 0; i < 20; i++) {
      // Real tab buttons rebuild the same character editor, including inspector.
      const tabs = document.querySelectorAll('#charList .char .seg button');
      tabs[(i + 1) % 2].click();
      if (i % 4 === 0) renderChars();
      await frame();
      maxDetached = Math.max(maxDetached, snapshot().detached, snapshot().ranges);
    }
    const repeated = snapshot();
    state.params.characters.push({ ...c, id:'lifecycle-second' }); renderChars(); await frame();
    document.querySelector('#charList .char button[title="Down"]').click(); await frame();
    const reordered = snapshot();
    state.params.characters = []; renderChars(); await frame();
    return {baseline,first,repeated,reordered,removed:snapshot(),maxDetached};
  })()`);
  assert.equal(result.first.live, result.baseline.live + 1);
  assert.equal(result.repeated.live, result.first.live, '20 tab rebuilds do not grow observer targets');
  assert.equal(result.reordered.live, result.baseline.live + 2);
  assert.equal(result.removed.live, result.baseline.live, 'removing all characters restores the baseline');
  assert.equal(result.maxDetached, 0);
  for (const s of Object.values(result).filter(v => v && typeof v === 'object')) {
    assert.equal(s.detached, 0, 'every observed target is in the DOM');
    assert.equal(s.ranges, 0, 'native highlights do not retain removed editors');
  }

  const direct = await page.eval(`(async () => {
    const {createEditor} = await import('/js/ui/editor.js');
    const host = document.createElement('div'); document.body.append(host);
    let changes = 0;
    const ed = createEditor(host, {value:'{cat}', onChange:() => changes++});
    ed.ta.focus(); ed.ta.blur();
    // Dispose before its first frame, then repeat disposal and dispatch stale input.
    ed.dispose(); ed.dispose(); host.remove();
    ed.ta.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 160));
    return {changes, detached:[...window.__roTargets.values()].flatMap(s => [...s]).filter(t => !t.isConnected).length,
      staleRanges:CSS.highlights ? [...CSS.highlights].filter(([name]) => name.startsWith('nf-ed-')).flatMap(([,ranges]) => [...ranges]).filter(r => !r.startContainer.isConnected).length : 0};
  })()`);
  assert.deepEqual(direct, { changes:0, detached:0, staleRanges:0 });
  log('20 tab rebuilds plus redraw/reorder/remove: connected observer targets and highlight ranges only; immediate/repeated disposal passed');
};
