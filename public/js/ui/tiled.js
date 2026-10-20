import { t, bindCopy } from '../i18n.js';
import { h, uid, randomSeed, makeCanvas, loadImage } from '../util.js';
import { planTiles, cutTile, finalizeTiledJob as finalizeJob } from '../tiled.js';
import { enqueueTiled, onQueue, offQueue } from '../queue.js';
import { on } from '../store.js';
import { freeBlockers } from '../auto.js';
import { currentCost } from './panel.js';
import { openModal, toast } from './modal.js';

// Submitted jobs own composition; the dialog only observes progress.
export async function openTiled(rec, deps) {
  const snap = structuredClone(deps.snapshot());
  const source = await deps.getBlob(rec);
  if (!(source instanceof Blob)) throw new Error(t('copy.ui.tiled.0'));
  const sourceURL = URL.createObjectURL(source);
  let img;
  try { img = await loadImage(sourceURL); } catch (err) { URL.revokeObjectURL(sourceURL); throw err; }
  const width = img.naturalWidth, height = img.naturalHeight;
  let plan, active = false, closed = false, tiledId = null, subscriptions = [];
  const scale = h('select', { 'aria-label': () => (t('copy.ui.tiled.1')) },
    ...[['auto', () => t('copy.ui.tiled.2')], ['1', '1×'], ['1.5', '1.5×'], ['2', '2×']].map(([value, text]) => h('option', { value }, text)));
  const strength = h('input', { type: 'range', min: 0.05, max: 1, step: 0.05, value: '0.4', 'aria-label': () => (t('copy.ui.tiled.3')) });
  const noise = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: '0.4', 'aria-label': () => (t('copy.ui.tiled.4')) });
  const overlap = h('input', { type: 'number', min: 64, max: 512, step: 64, value: '128', 'aria-label': () => (t('copy.ui.tiled.5')) });
  const freeOnly = h('input', { type: 'checkbox', checked: true });
  const preview = h('div', { class: 'tiled-preview' }, h('img', { src: sourceURL, alt: () => (t('copy.ui.tiled.6')) }));
  const grid = h('div', { class: 'tiled-grid', 'aria-hidden': 'true' });
  preview.append(grid);
  const info = h('div', { class: 'tiled-info mono' });
  const warning = h('p', { class: 'tiled-warning', role: 'status' });
  const progress = h('span', { class: 'tiled-progress', role: 'status', 'aria-live': 'polite' });
  const start = h('button', { class: 'btn solid tiled-start' }, () => (t('copy.ui.tiled.7')));
  const slider = (title, input) => {
    const value = h('output', {}, '0.4');
    input.addEventListener('input', () => { value.textContent = Number(input.value).toFixed(2).replace(/0$/, ''); refresh(); });
    return h('label', { class: 'tiled-control' }, h('span', {}, title, value), input);
  };
  const controls = h('fieldset', { class: 'tiled-controls' },
    h('label', { class: 'tiled-control' }, h('span', {}, () => (t('copy.ui.tiled.1'))), scale),
    h('label', { class: 'tiled-focus' }, h('input', { type: 'checkbox', disabled: true }), () => (t('copy.ui.tiled.8')), h('small', {}, () => (t('copy.ui.tiled.9')))),
    slider(() => (t('copy.ui.tiled.3')), strength), slider(() => (t('copy.ui.tiled.4')), noise),
    h('details', { class: 'tiled-advanced' }, h('summary', {}, () => (t('copy.ui.tiled.10'))),
      h('label', { class: 'tiled-control' }, h('span', {}, () => (t('copy.ui.tiled.11'))), overlap),
      h('label', { class: 'tiled-free' }, freeOnly, () => (t('copy.ui.tiled.12')))),
    h('p', { class: 'tiled-note' }, () => (t('copy.ui.tiled.13'))), warning);
  const modal = openModal({ n: '↗', title: () => (t('copy.ui.tiled.7')), size: 'tiled-modal',
    body: h('div', { class: 'tiled-layout' }, h('div', { class: 'tiled-image' }, preview, info), controls),
    foot: [progress, start],
    onClose: () => { closed = true; unsubscribeAccount(); URL.revokeObjectURL(sourceURL); cleanup(); },
  });
  const unsubscribeAccount = on(['session.tier', 'session.live', 'settings.lang'], refresh);
  const say = (el, key, vars) => bindCopy(el, 'textContent', () => t(key, vars));
  function cleanup() {
    for (const [event, fn] of subscriptions) offQueue(event, fn);
    subscriptions = [];
  }
  function listen(event, fn) { onQueue(event, fn); subscriptions.push([event, fn]); }
  function context(tile) {
    return {
      params: { ...snap.params, width: tile.w, height: tile.h, nSamples: 1, steps: Math.max(1, Math.min(28, Number(snap.params.steps) || 28)) },
      base: { image: '', strength: Number(strength.value), noise: Number(noise.value), mask: null },
      vibes: snap.vibes || [], refs: snap.refs || [], nSamples: 1,
    };
  }
  function refresh() {
    if (active || closed) return;
    try {
      if (!overlap.checkValidity() || !Number(overlap.value)) throw new Error(t('copy.ui.tiled.14'));
      plan = planTiles({ width, height, scale: scale.value, overlap: Number(overlap.value) });
      const blockers = new Set();
      let cost = 0;
      for (const tile of plan.tiles) {
        const ctx = context(tile), c = currentCost(ctx), why = freeBlockers(ctx);
        why.forEach((s) => blockers.add(s));
        cost += why.length ? c.total : 0;
      }
      const tooMany = plan.tiles.length > 35;
      const noPrompt = !snap.params.prompt?.trim() && !(snap.params.characters || []).some((c) => c.enabled && c.prompt?.trim());
      bindCopy(warning, 'textContent', () => (tooMany ? t('copy.ui.tiled.15') : noPrompt ? t('copy.ui.tiled.16') : [...blockers].join('；')));
      start.disabled = tooMany || noPrompt || (freeOnly.checked && blockers.size > 0);
      say(start, 'tile.run', { count: plan.tiles.length, cost });
      bindCopy(start, 'title', () => t('tile.grid', { cols: plan.cols, rows: plan.rows }));
      bindCopy(info, 'textContent', () => `${width} × ${height} → ${plan.outW} × ${plan.outH} · ` + t('tile.grid', { cols: plan.cols, rows: plan.rows }));
      preview.style.aspectRatio = `${plan.outW} / ${plan.outH}`;
      preview.style.setProperty('--tiled-ratio', plan.outW / plan.outH);
      grid.replaceChildren(...plan.tiles.map((t, i) => h('div', { class: 'tiled-box', style: {
        left: `${100 * t.x / plan.outW}%`, top: `${100 * t.y / plan.outH}%`,
        width: `${100 * t.w / plan.outW}%`, height: `${100 * t.h / plan.outH}%`,
      } }, h('b', {}, String(i + 1)))));
    } catch (err) { start.disabled = true; warning.textContent = err.message; }
  }
  for (const input of [scale, overlap, freeOnly]) input.addEventListener('input', refresh);
  function release() { active = false; cleanup(); controls.disabled = false; if (!closed) refresh(); }
  start.onclick = async () => {
    if (active) return;
    refresh(); // Recheck current account/quota before freezing the job.
    if (start.disabled) return;
    active = true;
    controls.disabled = true;
    start.disabled = true;
    tiledId = uid();
    const runPlan = plan, feather = Number(overlap.value);
    const seed = snap.params.seed !== '' && snap.params.seed != null ? Number(snap.params.seed) >>> 0 : randomSeed();
    try {
      say(start, 'copy.ui.tiled.17');
      const canvas = makeCanvas(width, height);
      canvas.getContext('2d').drawImage(img, 0, 0);
      const cells = [];
      for (let i = 0; i < runPlan.tiles.length; i++) {
        const tile = runPlan.tiles[i], ctx = context(tile);
        ctx.base.image = cutTile(canvas, tile, runPlan.outW, runPlan.outH);
        cells.push({ key: String(i), params: ctx.params, base: ctx.base, seed });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      canvas.width = canvas.height = 0;
      // A closed dialog during preparation has not submitted any generation yet.
      if (closed) { release(); return; }
      listen('tiledCell', (e) => {
        if (e.tiledId !== tiledId) return;
        say(progress, 'tile.progress', { done: e.done, total: e.total });
        toast(progress.textContent, 'ok', 1800);
      });
      listen('end', (job) => {
        if (job.tiledId !== tiledId || job.status === 'done') return;
        say(progress, job.status === 'failed' ? 'copy.ui.tiled.18' : 'copy.ui.tiled.19');
        toast(job.reason || progress.textContent, 'warn');
        release();
      });
      listen('tiledPaused', (e) => {
        if (e.tiledId === tiledId) say(progress, 'copy.ui.tiled.20');
      });
      listen('step', (job) => {
        if (job.tiledId === tiledId) say(progress, 'tile.progress', { done: job.done, total: job.cells.length });
      });
      listen('tiledDone', (e) => {
        if (e.tiledId !== tiledId) return;
        cleanup();
        active = false;
        toast(() => (t('copy.ui.tiled.21')), 'ok');
        modal.close();
      });
      say(start, 'copy.ui.tiled.22');
      say(progress, 'tile.progress', { done: 0, total: cells.length });
      enqueueTiled({ tiledId, cells, snap, label: t('copy.ui.tiled.7'), freeOnly: freeOnly.checked,
        meta: { version: 1, ...runPlan, sourceId: rec.id, feather, overlap: feather,
          scale: scale.value, strength: Number(strength.value), noise: Number(noise.value), seed },
      });
    } catch (err) { toast(err.message, 'err'); release(); }
  };
  refresh();
  return modal;
}

// Kept at the UI entry point for main's startup registration; logic has no DOM dependencies.
export const finalizeTiledJob = finalizeJob;
