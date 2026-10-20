// Prompt timeline: every prompt version you generated with (consecutive identical prompts merge),
// newest first, with the tags added / removed since the previous version. One click restores a
// version into the editors. Kept in IndexedDB independently of the images, so deleting images
// doesn't erase the history.
import { h, icon, pad, fmtTime } from '../util.js';
import { t, getLang } from '../i18n.js';
import { kv } from '../db.js';
import { modelById } from '../data.js';
import { openModal, toast } from './modal.js';
import { diffRow } from './compare.js';

const MAX = 1000;
let log = null; // newest last: [{ id, at, first, prompt, uc, chars: [{prompt, uc, enabled, x, y}], model, recs: [ids], n }]
let saving = null;

const zh = () => getLang() === 'zh';
const charsOf = (p) => (p.characters || []).map((c) => ({ prompt: c.prompt || '', uc: c.uc || '', enabled: c.enabled !== false, x: c.x, y: c.y }));
const keyOf = (e) => JSON.stringify([e.prompt.trim(), e.uc.trim(), e.chars.filter((c) => c.enabled).map((c) => [c.prompt.trim(), c.uc.trim()])]);

async function load(history) {
  if (log) return log;
  log = (await kv.get('promptLog').catch(() => null)) || null;
  if (!log) {
    // first run: rebuild from the archive (oldest → newest)
    log = [];
    for (const r of [...history].reverse()) if (r.params && ['gen', 'img2img', 'inpaint'].includes(r.kind)) push(r.params, r.model, [r.id], r.createdAt);
    persist();
  }
  return log;
}
function persist() {
  clearTimeout(saving);
  saving = setTimeout(() => kv.set('promptLog', log.slice(-MAX)).catch(() => {}), 400);
}
function push(params, model, recIds, at = Date.now()) {
  const e = { prompt: params.prompt || '', uc: params.uc || '', chars: charsOf(params) };
  const last = log.at(-1);
  if (last && keyOf(last) === keyOf(e)) {
    const fresh = recIds.filter((id) => !last.recs.includes(id)); // the first-run rebuild may already have them
    last.recs.push(...fresh);
    last.n += fresh.length;
    last.at = at;
    last.model = model;
    return;
  }
  log.push({ id: at.toString(36) + Math.random().toString(36).slice(2, 6), first: at, at, model, recs: recIds.slice(), n: recIds.length, ...e });
  if (log.length > MAX) log.splice(0, log.length - MAX);
}

// After a generation made from the editors.
export async function logPrompt(params, model, recIds, history) {
  await load(history);
  push(params, model, recIds);
  persist();
}

// deps: { history(), thumb(rec), current(): params, restore(entry), view(id) }
export async function openTimeline(deps) {
  const Z = zh();
  await load(deps.history());
  let q = '';
  let limit = 60;
  const listEl = h('div', { class: 'tl-list' });
  const search = h('input', { class: 'inp', type: 'search', placeholder: () => ((getLang() === 'zh') ? '筛选：包含某个 tag 的版本…' : 'Filter: versions containing…') });
  search.oninput = () => ((q = search.value.trim().toLowerCase()), (limit = 60), paint());
  const m = openModal({
    n: 'TL',
    title: () => ((getLang() === 'zh') ? t('copy.ui.timeline.0') : t('copy.ui.timeline.0')),
    sub: () => ((getLang() === 'zh') ? '提示词时间线 · 每次生成用过的版本' : 'Every prompt version you generated with'),
    body: h('div', { class: 'tl' }, search, listEl),
    onLang: () => paint(),
  });
  m.el.style.width = 'min(780px, 100%)';

  const byId = () => new Map(deps.history().map((r) => [r.id, r]));
  const block = (label, a, b) => diffRow(label, a, b);
  const diffs = (prev, e) => {
    const rows = [block((getLang() === 'zh') ? '提示词' : 'Prompt', prev?.prompt ?? '', e.prompt), block((getLang() === 'zh') ? '负面' : 'UC', prev?.uc ?? '', e.uc)];
    const n = Math.max(prev?.chars.length || 0, e.chars.length);
    for (let i = 0; i < n; i++) {
      const a = prev?.chars[i];
      const b = e.chars[i];
      rows.push(block(((getLang() === 'zh') ? '角色' : 'Char') + (i + 1), a?.enabled === false ? '' : a?.prompt || '', b?.enabled === false ? '' : b?.prompt || ''));
    }
    return rows.filter(Boolean);
  };

  function paint() {
    const recs = byId();
    const cur = deps.current();
    const curE = { prompt: cur.prompt || '', uc: cur.uc || '', chars: charsOf(cur) };
    const items = [];
    const latest = log.at(-1);
    // the editors right now, if they differ from the last generated version
    if (!q && latest && keyOf(latest) !== keyOf(curE)) {
      const d = diffs(latest, curE);
      items.push(h('div', { class: 'tl-item now' }, h('div', { class: 'tl-dot' }), h('div', { class: 'tl-body' }, h('div', { class: 'tl-h' }, h('b', {}, () => ((getLang() === 'zh') ? '当前编辑（尚未生成）' : 'Editing now (not generated)'))), d.length ? h('div', { class: 'tl-diff' }, ...d) : null)));
    }
    let shown = 0;
    let lastDay = '';
    for (let i = log.length - 1; i >= 0 && shown < limit; i--) {
      const e = log[i];
      if (q && !(e.prompt + ' ' + e.uc + ' ' + e.chars.map((c) => c.prompt).join(' ')).toLowerCase().includes(q)) continue;
      shown++;
      const prev = log[i - 1];
      const d = new Date(e.at);
      const day = `${d.getFullYear()}.${pad(d.getMonth() + 1, 2)}.${pad(d.getDate(), 2)}`;
      if (day !== lastDay) {
        lastDay = day;
        items.push(h('div', { class: 'tl-day mono' }, day));
      }
      const thumbs = e.recs
        .slice(-4)
        .reverse()
        .map((id) => recs.get(id))
        .filter(Boolean)
        .map((r) => h('button', { class: 'tl-th', title: '№' + pad(r.no || 0, 4), onclick: () => (deps.view(r.id), m.close()) }, h('img', { src: deps.thumb(r), alt: '' })));
      const df = prev ? diffs(prev, e) : [];
      const isCur = keyOf(e) === keyOf(curE);
      const full = h('pre', { class: 'tl-full mono', hidden: true }, e.prompt + (e.uc ? '\n\n— UC —\n' + e.uc : '') + e.chars.map((c, k) => `\n\n— C${k + 1} —\n${c.prompt}`).join(''));
      items.push(
        h(
          'div',
          { class: 'tl-item' + (isCur ? ' cur' : '') },
          h('div', { class: 'tl-dot' }),
          h(
            'div',
            { class: 'tl-body' },
            h(
              'div',
              { class: 'tl-h' },
              h('b', { class: 'mono' }, fmtTime(e.at)),
              e.first && e.at - e.first > 60e3 ? h('small', { class: 'mono' }, '← ' + fmtTime(e.first)) : null,
              h('span', { class: 'chip mono' }, '×' + e.n),
              h('small', { class: 'mono' }, modelById(e.model).short),
              isCur ? h('span', { class: 'chip ok mono' }, () => ((getLang() === 'zh') ? '当前' : 'CURRENT')) : null,
              h('span', { class: 'sp' }),
              h('button', { class: 'btn sm ghost', onclick: () => (full.hidden = !full.hidden) }, () => ((getLang() === 'zh') ? '全文' : 'Full')),
              h('button', { class: 'btn sm' + (isCur ? '' : ' solid'), disabled: isCur, onclick: () => (deps.restore(e), m.close()) }, icon('undo'), () => ((getLang() === 'zh') ? '恢复此版本' : 'Restore'))
            ),
            prev ? (df.length ? h('div', { class: 'tl-diff' }, ...df) : h('p', { class: 'hint' }, () => ((getLang() === 'zh') ? '提示词相同（参数不同）' : 'Same prompt'))) : h('p', { class: 'tl-first mono' }, e.prompt.slice(0, 220) + (e.prompt.length > 220 ? '…' : '')),
            full,
            thumbs.length ? h('div', { class: 'tl-ths' }, ...thumbs) : null
          )
        )
      );
    }
    if (!shown && !items.length) items.push(h('p', { class: 'hint' }, () => (q ? ((getLang() === 'zh') ? '没有匹配的版本' : 'No matching versions') : (getLang() === 'zh') ? '还没有记录：生成一次后这里会出现。' : 'Nothing yet — generate once.')));
    if (shown >= limit) items.push(h('button', { class: 'btn sm tl-more', onclick: () => ((limit += 100), paint()) }, () => ((getLang() === 'zh') ? '加载更多' : 'Load more')));
    listEl.replaceChildren(...items);
  }
  paint();
}

// Snapshot of the editors (for undoing a restore).
export const snapshotEditors = (p) => ({ prompt: p.prompt, uc: p.uc, chars: charsOf(p) });
