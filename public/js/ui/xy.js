// X/Y grid: mark variables directly on the prompt's tags (with / without, weight, replace, insert before)
// or on a setting (steps, CFG, rescale, sampler, seed). Every combination runs as one queue job with a
// fixed seed and is laid out as a labelled grid. Cell prompts are rebuilt from the original text, so a
// removal is a real removal and nothing else moves.
import { $, h, icon, randomSeed, makeCanvas, canvasToBlob, downloadBlob, loadImage, pad } from '../util.js';
import { state, on } from '../store.js';
import { bindCopy, t, getLang } from '../i18n.js';
import { SAMPLERS } from '../data.js';
import { currentCost } from './panel.js';
import { freeBlockers } from '../auto.js';
import { kv } from '../db.js';
import { openModal, toast, confirmDialog, lightbox } from './modal.js';
import { notifyAlert } from '../notify.js';
import { enqueueXY, onQueue, xyJobState, endJob, queueJobs } from '../queue.js';
import { addToCompare } from './compare.js';
import { xyAxisCopy, xyValueCopy } from './xy-copy.js';

const zh = () => getLang() === 'zh';
const MAX_CELLS = 100;
let deps = null; // { snapshot(), apply(snap), get(id), urlFor(rec), thumb(id), view(id), currentSeed() }
let viewEl = null;

export function initXY(d) {
  deps = d;
  on('settings.lang', xyRefresh);
  $('#btnXY').onclick = () => openXYDialog();
  bindCopy($('#btnXY'), 'title', () => (zh() ? 'X/Y 对比网格：固定种子，在提示词里标出要比较的地方' : 'X/Y grid: fixed seed, mark what to compare on the prompt'));
  onQueue('xycell', ({ gridId, key, id }) => updateGrid(gridId, (g) => (g.cells[key] = id)));
  onQueue('xyfail', ({ gridId, key, msg }) => updateGrid(gridId, (g) => ((g.failed ||= {}), (g.failed[key] = msg))));
  onQueue('step', (job) => job.kind === 'xy' && shown?.id === job.gridId && paintView());
  onQueue('end', async (job) => {
    if (job.kind !== 'xy') return;
    const g = await updateGrid(job.gridId, () => {});
    live.delete(job.gridId);
    const Z = zh();
    const n = g ? Object.keys(g.cells).length : job.done;
    const msg = () => job.status === 'done' ? ((getLang() === 'zh') ? 'X/Y 网格完成：' + n + ' 格' : 'X/Y grid done: ' + n + ' cells') : ((getLang() === 'zh') ? 'X/Y 网格已停止：' + n + ' 格' : 'X/Y grid stopped: ' + n + ' cells') + (job.reason ? ' · ' + job.reason : '');
    toast(msg, job.status === 'done' ? 'ok' : 'warn', 6000, () => g && showView(g));
    notifyAlert(msg());
  });
}

// ---------------------------------------------------------------- grids
const live = new Map(); // grids whose job is queued / running
const loadGrids = async () => (await kv.get('xyGrids').catch(() => null)) || [];
async function saveGrid(g) {
  const list = (await loadGrids()).filter((x) => x.id !== g.id);
  list.unshift(g);
  await kv.set('xyGrids', list.slice(0, 12)).catch(() => {});
}
async function updateGrid(id, fn) {
  const g = live.get(id) || (shown?.id === id ? shown : (await loadGrids()).find((x) => x.id === id));
  if (!g) return null;
  fn(g);
  live.set(id, g);
  await saveGrid(g);
  if (shown?.id === id) {
    shown = g;
    paintView();
  }
  return g;
}

// ---------------------------------------------------------------- prompt tokens
// Split at top-level commas / newlines (not inside { } [ ] or an open "1.2::…::" group), keeping offsets.
export function tokenize(s) {
  const out = [];
  let depth = 0;
  let inW = false;
  let start = 0;
  const push = (end) => {
    const raw = s.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text) out.push({ start: start + lead, end: start + lead + text.length, text });
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && depth > 0) depth--;
    else if (c === ':' && s[i + 1] === ':') {
      inW = !inW;
      i++;
    } else if ((c === ',' || c === '\n') && !depth && !inW) {
      push(i);
      start = i + 1;
    }
  }
  push(s.length);
  return out;
}
export const core = (t) => {
  let c = t.trim();
  const m = c.match(/^-?\d*\.?\d+::([\s\S]*?)(::)?$/);
  if (m) c = m[1].trim();
  while (/^[{[]/.test(c) && /[}\]]$/.test(c)) c = c.slice(1, -1).trim();
  return c;
};
const weighted = (t, w) => (Number(w) === 1 ? core(t) : w + '::' + core(t) + '::');
// edits: index → null (remove) | text; inserts: index → [texts] placed before that token (index = length → end)
export function rebuild(src, toks, edits, inserts) {
  if (!toks.length) return (inserts.get(0) || []).filter(Boolean).join(', ') || src;
  let out = src.slice(0, toks[0].start);
  let first = true;
  const put = (text, sep) => {
    out += (first ? '' : /[,\n]/.test(sep || '') ? sep : ', ') + text;
    first = false;
  };
  toks.forEach((t, i) => {
    for (const x of inserts.get(i) || []) if (x) put(x, ', ');
    const e = edits.has(i) ? edits.get(i) : t.text;
    if (e != null) put(e, i ? src.slice(toks[i - 1].end, t.start) : '');
  });
  for (const x of inserts.get(toks.length) || []) if (x) put(x, ', ');
  return out + src.slice(toks[toks.length - 1].end);
}
const escRe = (s) => s.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- axes
const TAG_KINDS = ['toggle', 'weight', 'replace'];
const KINDS = {
  toggle: ['有 / 无', 'with / without'],
  weight: ['权重', 'weight'],
  replace: ['替换', 'replace'],
  insert: ['插入', 'insert'],
  steps: ['步数', 'steps'],
  scale: ['CFG', 'CFG'],
  cfgRescale: ['引导重缩放', 'CFG rescale'],
  sampler: ['采样器', 'sampler'],
  seed: ['种子', 'seed'],
};
const NUM_DEFAULT = { weight: '0.5, 0.8, 1, 1.2, 1.5', steps: '16, 23, 28', scale: '4, 5, 6, 7', cfgRescale: '0, 0.2, 0.4' };
const randomSeeds = (n) => Array.from({ length: n }, randomSeed).join(', ');

function axisValues(ax) {
  if (!ax) return [null];
  if (ax.kind === 'toggle') return [true, false];
  if (ax.kind === 'replace' || ax.kind === 'insert') {
    const list = [...new Set((ax.text || '').split(/[|\n]/).map((s) => s.trim()).filter(Boolean))];
    return ax.kind === 'insert' && ax.blank ? ['', ...list] : list;
  }
  if (ax.kind === 'sampler') return (ax.samplers || []).slice();
  const nums = (ax.text || '').split(/[\s,，、|]+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n));
  return [...new Set(ax.kind === 'seed' ? nums.map((n) => Math.floor(Math.abs(n)) >>> 0) : nums)];
}
function valueLabel(ax, v) {
  const Z = zh();
  switch (ax.kind) {
    case 'toggle':
      return (v ? ((getLang() === 'zh') ? '有 ' : 'with ') : (getLang() === 'zh') ? '无 ' : 'without ') + ax.core;
    case 'weight':
      return ax.core.replace(/^artist:/, '') + ' ×' + v;
    case 'replace':
      return v;
    case 'insert':
      return v ? v.replace(/^artist:/, '') : (getLang() === 'zh') ? '（不加）' : '(none)';
    case 'steps':
      return v + ((getLang() === 'zh') ? ' 步' : ' steps');
    case 'scale':
      return 'CFG ' + v;
    case 'cfgRescale':
      return ((getLang() === 'zh') ? '重缩放 ' : 'rescale ') + v;
    case 'sampler':
      return SAMPLERS.find((s) => s.id === v)?.label || v;
    case 'seed':
      return 'seed ' + v;
  }
  return String(v);
}
function axisName(ax) {
  const Z = zh();
  const k = KINDS[ax.kind][(getLang() === 'zh') ? 0 : 1];
  if (TAG_KINDS.includes(ax.kind)) return ax.core + ' · ' + k;
  if (ax.kind === 'insert') return k + (ax.before ? ((getLang() === 'zh') ? '（' + ax.before + ' 前）' : ' (before ' + ax.before + ')') : (getLang() === 'zh') ? '（开头）' : ' (at start)');
  return k;
}

// All cells, row-major: { key, x, y, params, seed, changed[] }
function buildCells(cfg) {
  const P = state.params;
  const src = P.prompt || '';
  const toks = tokenize(src);
  const find = (c) => toks.findIndex((t) => core(t.text) === c);
  const xs = axisValues(cfg.x);
  const ys = axisValues(cfg.y);
  const cells = [];
  ys.forEach((yv, j) =>
    xs.forEach((xv, i) => {
      const params = structuredClone(P);
      params.nSamples = 1;
      let seed = cfg.seed;
      const edits = new Map();
      const inserts = new Map();
      const changed = [];
      for (const [ax, v] of [[cfg.x, xv], [cfg.y, yv]]) {
        if (!ax || v === null) continue;
        if (TAG_KINDS.includes(ax.kind)) {
          const k = find(ax.core);
          if (k < 0) continue;
          if (ax.kind === 'toggle') {
            if (!v) (edits.set(k, null), changed.push({ t: '−' + ax.core, c: 'rem' }));
          } else {
            const nt = ax.kind === 'weight' ? weighted(toks[k].text, v) : v;
            if (nt !== toks[k].text) (edits.set(k, nt), changed.push({ t: nt, c: 'add' }));
          }
        } else if (ax.kind === 'insert') {
          if (!v) continue;
          const k = ax.before ? Math.max(0, find(ax.before)) : 0;
          inserts.set(k, [...(inserts.get(k) || []), v]);
          changed.push({ t: '+' + v, c: 'add' });
        } else if (ax.kind === 'seed') {
          seed = v;
          changed.push({ t: 'seed ' + v, c: 'par' });
        } else {
          params[ax.kind] = v;
          changed.push({ t: valueLabel(ax, v), c: 'par' });
        }
      }
      params.prompt = rebuild(src, toks, edits, inserts);
      cells.push({ key: i + ',' + j, x: i, y: j, params, seed, changed });
    })
  );
  return { xs, ys, cells };
}

function costOf(cells, snap) {
  if (!state.session.live) return { total: 0, paid: 0, reasons: [] };
  let total = 0;
  let paid = 0;
  const reasons = new Set();
  for (const c of cells) {
    const ctx = { params: c.params, base: snap.base, vibes: snap.vibes, refs: snap.refs, nSamples: 1 };
    const k = currentCost(ctx).total;
    total += k;
    if (k) {
      paid++;
      for (const r of freeBlockers(ctx)) reasons.add(r);
    }
  }
  return { total, paid, reasons: [...reasons] };
}

// ---------------------------------------------------------------- dialog
const CFG_KEY = 'nf.xy2';
function loadCfg() {
  try {
    return JSON.parse(localStorage.getItem(CFG_KEY) || 'null') || {};
  } catch {
    return {};
  }
}

async function openXYDialog() {
  const Z = zh();
  const P = state.params;
  const toks = tokenize(P.prompt || '');
  const has = (c) => toks.some((t) => core(t.text) === c);
  const valid = (ax) => !!ax && !!KINDS[ax.kind] && (TAG_KINDS.includes(ax.kind) ? has(ax.core) : ax.kind === 'insert' ? !ax.before || has(ax.before) : true);
  const saved = loadCfg();
  const cfg = {
    x: valid(saved.x) ? saved.x : null,
    y: valid(saved.y) ? saved.y : null,
    seed: Number(P.seed) || deps.currentSeed() || randomSeed(),
    freeOnly: saved.freeOnly ?? state.settings.autoFreeOnly !== false,
  };
  let sel = [0, 0];
  let pick = null;
  let pop = null;
  const snapNow = deps.snapshot();

  const hintEl = h('span', { class: 't-label xy-pl' });
  const pline = h('div', { class: 'xy-pline' });
  const pwrap = h('div', { class: 'xy-pwrap' }, pline);
  const axesEl = h('div', { class: 'xy-axes2' });
  const prevEl = h('div', { class: 'xy-prev' });
  const detEl = h('div', { class: 'xy-det mono', 'aria-live': 'polite' });
  const sumEl = h('div', { class: 'xy-sum' });
  const startBtn = h('button', { class: 'btn solid' }, icon('xy'), () => ((getLang() === 'zh') ? '加入队列并开始' : 'Queue & start'));

  const setAxis = (ax, prefer) => {
    const a = prefer || (!cfg.x ? 'x' : 'y');
    const other = a === 'x' ? 'y' : 'x';
    cfg[a] = ax;
    if (cfg[other] && TAG_KINDS.includes(ax.kind) && TAG_KINDS.includes(cfg[other].kind) && cfg[other].core === ax.core) cfg[other] = null;
    sel = [0, 0];
    paintAll();
  };
  const tpl = (label, title, fn) => h('button', { class: 'btn sm', title, onclick: fn }, label);
  const tplRow = h(
    'div',
    { class: 'row wrap gap xy-tpl' },
    tpl(() => ((getLang() === 'zh') ? '画师权重' : 'Artist weight'), () => ((getLang() === 'zh') ? '给提示词里第一个 artist: 标签扫一组权重' : 'Sweep the weight of the first artist: tag'), () => {
      const t = toks.find((x) => core(x.text).startsWith('artist:'));
      if (!t) return toast(() => ((getLang() === 'zh') ? '提示词里没有 artist: 开头的 tag。点任意 tag 选「权重」也可以。' : 'No artist: tag in the prompt — click any tag and choose Weight.'), 'warn', 4000);
      cfg.y = null;
      setAxis({ kind: 'weight', core: core(t.text), text: NUM_DEFAULT.weight }, 'x');
    }),
    tpl(() => ((getLang() === 'zh') ? '这个 tag 有没有用' : 'Does this tag matter'), () => ((getLang() === 'zh') ? '点一个 tag：有 / 无 × 2 个种子' : 'Click a tag: with / without × 2 seeds'), () => {
      pick = 'toggle';
      paintPrompt();
    }),
    tpl(() => ((getLang() === 'zh') ? '步数' : 'Steps'), () => ((getLang() === 'zh') ? '步数 16 / 23 / 28（超过 28 不免费）' : 'Steps 16 / 23 / 28 (over 28 is not free)'), () => ((cfg.y = null), setAxis({ kind: 'steps', text: NUM_DEFAULT.steps }, 'x'))),
    tpl('CFG', 'CFG 4 / 5 / 6 / 7', () => ((cfg.y = null), setAxis({ kind: 'scale', text: NUM_DEFAULT.scale }, 'x'))),
    tpl(() => ((getLang() === 'zh') ? '多个种子' : 'Seeds'), () => ((getLang() === 'zh') ? '同一提示词，4 个随机种子挑构图' : 'Same prompt, 4 random seeds'), () => ((cfg.y = null), setAxis({ kind: 'seed', text: randomSeeds(4) }, 'x'))),
    tpl(() => ((getLang() === 'zh') ? '画师对比' : 'Artists'), () => ((getLang() === 'zh') ? '在开头插入不同画师，加一列「不加」对照' : 'Insert different artists at the start, plus a “none” column'), () => ((cfg.y = null), setAxis({ kind: 'insert', before: null, text: '', blank: true }, 'x')))
  );
  const prm = (kind) =>
    h('button', { class: 'btn sm ghost', onclick: () => setAxis(kind === 'sampler' ? { kind, samplers: ['k_euler_ancestral', 'k_dpmpp_2m_sde'] } : kind === 'seed' ? { kind, text: randomSeeds(4) } : { kind, text: NUM_DEFAULT[kind] }) }, () => ('+ ' + KINDS[kind][(getLang() === 'zh') ? 0 : 1]));
  const prmRow = h('div', { class: 'row wrap gap xy-prm' }, h('span', { class: 't-label' }, () => ((getLang() === 'zh') ? '参数轴' : 'Setting axis')), prm('steps'), prm('scale'), prm('cfgRescale'), prm('sampler'), prm('seed'));

  // --- prompt line + popover
  const chipText = (ax) => {
    const vals = axisValues(ax);
    if (ax.kind === 'toggle') return ax.core + ' | —';
    if (ax.kind === 'weight') return ax.core + ' ×' + vals.join(' / ');
    if (ax.kind === 'insert') return vals.map((v) => v || '—').join(' | ') || ((getLang() === 'zh') ? '（待填）' : '(empty)');
    return vals.join(' | ');
  };
  function paintPrompt() {
    bindCopy(hintEl, 'textContent', () => (pick ? ((getLang() === 'zh') ? '点一个 tag 测试它有没有用' : 'Click a tag to test it') : (getLang() === 'zh') ? '提示词 · 点 tag 设为变量（只作用于基础提示词）' : 'Prompt · click a tag to make it a variable (base prompt only)'));
    pline.classList.toggle('picking', !!pick);
    if (!toks.length) return pline.replaceChildren(h('span', { class: 'hint' }, () => ((getLang() === 'zh') ? '基础提示词是空的' : 'The base prompt is empty')));
    const parts = [];
    const insAt = (i) => {
      for (const a of ['x', 'y']) {
        const ax = cfg[a];
        if (ax?.kind !== 'insert') continue;
        const k = ax.before ? Math.max(0, toks.findIndex((t) => core(t.text) === ax.before)) : 0;
        if (k === i) parts.push(h('span', { class: 'xy-var v-' + a }, h('b', {}, a.toUpperCase()), chipText(ax)));
      }
    };
    toks.forEach((t, i) => {
      insAt(i);
      const a = ['x', 'y'].find((k) => cfg[k] && TAG_KINDS.includes(cfg[k].kind) && cfg[k].core === core(t.text));
      parts.push(
        a
          ? h('button', { type: 'button', class: 'xy-var v-' + a, 'data-i': i }, h('b', {}, a.toUpperCase()), chipText(cfg[a]))
          : h('button', { type: 'button', class: 'xy-tok', 'data-i': i, 'aria-haspopup': 'dialog' }, t.text)
      );
    });
    pline.replaceChildren(...parts.flatMap((p, i) => (i ? [h('span', { class: 'xy-cm' }, ', '), p] : [p])));
  }
  const closePop = () => {
    pop?.remove();
    pop = null;
  };
  function openPop(i, anchor) {
    closePop();
    const t = toks[i];
    const c = core(t.text);
    const cur = ['x', 'y'].find((k) => cfg[k] && TAG_KINDS.includes(cfg[k].kind) && cfg[k].core === c);
    let axis = cur || (!cfg.x ? 'x' : 'y');
    const inp = h('input', { class: 'inp mono grow', 'aria-label': () => ((getLang() === 'zh') ? '替换 / 插入的值，用 | 分隔' : 'Values, separated by |'), value: c + ' | ' });
    const err = h('p', { class: 'xy-err', role: 'alert' });
    const axBtns = ['x', 'y'].map((k) =>
      h(
        'button',
        {
          type: 'button',
          'aria-pressed': String(k === axis),
          class: k === axis ? 'on' : '',
          onclick: () => {
            axis = k;
            axBtns.forEach((b, n) => (b.setAttribute('aria-pressed', String(['x', 'y'][n] === axis)), b.classList.toggle('on', ['x', 'y'][n] === axis)));
          },
        },
        () => (k === 'x' ? ((getLang() === 'zh') ? 'X 列' : 'X cols') : (getLang() === 'zh') ? 'Y 行' : 'Y rows')
      )
    );
    const done = (ax) => (closePop(), setAxis(ax, axis));
    const values = (kind) => {
      let raw = inp.value;
      if (kind === 'insert') raw = raw.replace(new RegExp('^\\s*' + escRe(c) + '\\s*\\|?'), '');
      const vals = [...new Set(raw.split(/[|\n]/).map((s) => s.trim()).filter(Boolean))];
      if (kind === 'replace' && vals.length < 2) return (bindCopy(err, 'textContent', () => ((getLang() === 'zh') ? '至少写两个值，用 | 分隔（第一个通常是原文）' : 'At least two values, separated by |'))), null;
      if (kind === 'insert' && !vals.length) return (bindCopy(err, 'textContent', () => ((getLang() === 'zh') ? '写上要插入的内容，多个用 | 分隔' : 'Enter what to insert; separate several with |'))), null;
      return vals.join(' | ');
    };
    pop = h(
      'div',
      { class: 'xy-pop', role: 'dialog', 'aria-label': c, 'data-for': String(i) },
      h('div', { class: 'row gap' }, h('b', { class: 'mono xy-pop-t' }, t.text), h('span', { class: 'sp' }), h('span', { class: 'seg' }, ...axBtns)),
      h(
        'div',
        { class: 'row wrap gap' },
        h('button', { class: 'btn sm', onclick: () => done({ kind: 'toggle', core: c }) }, () => ((getLang() === 'zh') ? '有 / 无' : 'With / without')),
        h('button', { class: 'btn sm', onclick: () => done({ kind: 'weight', core: c, text: NUM_DEFAULT.weight }) }, () => ((getLang() === 'zh') ? '权重 0.5–1.5' : 'Weight 0.5–1.5'))
      ),
      h('div', { class: 'row gap' }, inp),
      h(
        'div',
        { class: 'row wrap gap' },
        h('button', { class: 'btn sm', onclick: () => { const v = values('replace'); if (v) done({ kind: 'replace', core: c, text: v }); } }, () => ((getLang() === 'zh') ? '替换为这些值' : 'Replace with these')),
        h('button', { class: 'btn sm', onclick: () => { const v = values('insert'); if (v) done({ kind: 'insert', before: i ? c : null, text: v, blank: true }); } }, () => ((getLang() === 'zh') ? '在它前面插入' : 'Insert before it')),
        cur ? h('button', { class: 'btn sm ghost danger', onclick: () => ((cfg[cur] = null), closePop(), paintAll()) }, () => ((getLang() === 'zh') ? '移除变量' : 'Remove variable')) : null
      ),
      err
    );
    pwrap.append(pop);
    const w = pwrap.getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(0, Math.min(r.left - w.left, w.width - pop.offsetWidth)) + 'px';
    pop.style.top = r.bottom - w.top + 6 + 'px';
    pop.querySelector('.btn').focus();
  }
  pline.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    const i = Number(b.dataset.i);
    if (pick === 'toggle') {
      pick = null;
      cfg.x = { kind: 'toggle', core: core(toks[i].text) };
      cfg.y = { kind: 'seed', text: cfg.seed + ', ' + randomSeed() };
      sel = [0, 0];
      return paintAll();
    }
    if (pop && pop.dataset.for === String(i)) return closePop();
    openPop(i, b);
  });
  pwrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pop) (e.stopPropagation(), closePop());
  });

  // --- axis editors
  function axisRow(a) {
    const ax = cfg[a];
    const k = h('span', { class: 'xy-k ' + a }, a.toUpperCase());
    if (!ax) return h('div', { class: 'xy-ax empty' }, k, h('span', { class: 'hint' }, () => (a === 'x' ? ((getLang() === 'zh') ? '列：未设置 — 点上面的 tag，或用快速开始' : 'Columns: not set — click a tag or use a quick start') : (getLang() === 'zh') ? '行：可选' : 'Rows: optional')));
    const parts = [k, h('span', { class: 'xy-an' }, axisName(ax))];
    if (ax.kind === 'sampler') {
      ax.samplers ||= [];
      parts.push(
        h(
          'div',
          { class: 'row wrap gap grow' },
          ...SAMPLERS.filter((s) => !s.v3only).map((s) => {
            const ck = h('input', { type: 'checkbox', checked: ax.samplers.includes(s.id) });
            ck.onchange = () => ((ax.samplers = SAMPLERS.filter((x) => (x.id === s.id ? ck.checked : ax.samplers.includes(x.id))).map((x) => x.id)), update());
            return h('label', { class: 'tgl' }, ck, h('span', { class: 'sw' }), h('span', { class: 'mono' }, s.label));
          })
        )
      );
    } else if (ax.kind !== 'toggle') {
      const ph = { weight: '0.5, 0.8, 1, 1.2, 1.5', replace: 'a | b | c', insert: 'artist:a | artist:b', seed: '123, 456', steps: '16, 23, 28', scale: '4, 5, 6', cfgRescale: '0, 0.2' }[ax.kind];
      const inp = h('input', { class: 'inp mono grow', value: ax.text || '', placeholder: ph, 'aria-label': axisName(ax) });
      inp.oninput = () => ((ax.text = inp.value), update());
      parts.push(inp);
      if (ax.kind === 'seed') parts.push(h('button', { class: 'btn sm sq ghost', title: () => ((getLang() === 'zh') ? '换 4 个随机种子' : '4 random seeds'), onclick: () => ((ax.text = inp.value = randomSeeds(4)), update()) }, icon('dice')));
      if (ax.kind === 'insert') {
        const ck = h('input', { type: 'checkbox', checked: !!ax.blank });
        ck.onchange = () => ((ax.blank = ck.checked), update());
        parts.push(h('label', { class: 'tgl' }, ck, h('span', { class: 'sw' }), h('span', { class: 'cn' }, () => ((getLang() === 'zh') ? '加「不加」对照' : '“none” column'))));
      }
    }
    parts.push(h('button', { class: 'btn sm sq ghost', 'aria-label': () => ((getLang() === 'zh') ? '清除' : 'Clear'), onclick: () => ((cfg[a] = null), paintAll()) }, icon('close')));
    return h('div', { class: 'xy-ax' }, ...parts);
  }
  function paintAxes() {
    if (!cfg.x && cfg.y) (cfg.x = cfg.y), (cfg.y = null);
    axesEl.replaceChildren(axisRow('x'), axisRow('y'));
  }

  // --- preview + summary
  function update() {
    paintPrompt();
    const { xs, ys, cells } = buildCells(cfg);
    const any = !!cfg.x;
    const c = any ? costOf(cells, snapNow) : { total: 0, paid: 0, reasons: [] };
    if (sel[0] >= xs.length || sel[1] >= ys.length) sel = [0, 0];
    const SHOW_X = 8;
    const SHOW_Y = 6;
    if (!any || !xs.length || !ys.length) {
      prevEl.replaceChildren();
      detEl.replaceChildren();
    } else {
      const seedAxis = cfg.x?.kind === 'seed' || cfg.y?.kind === 'seed';
      const head = h('tr', {}, cfg.y ? h('td', {}) : null, ...xs.slice(0, SHOW_X).map((v) => h('th', { scope: 'col', title: valueLabel(cfg.x, v) }, valueLabel(cfg.x, v))));
      const rows = ys.slice(0, SHOW_Y).map((yv, j) =>
        h(
          'tr',
          {},
          cfg.y ? h('th', { scope: 'row', title: valueLabel(cfg.y, yv) }, valueLabel(cfg.y, yv)) : null,
          ...xs.slice(0, SHOW_X).map((_, i) => {
            const cell = cells[j * xs.length + i];
            const on = sel[0] === i && sel[1] === j;
            const ch = cell.changed.filter((x) => seedAxis || !/^seed /.test(x.t));
            return h(
              'td',
              {},
              h(
                'button',
                { class: 'xy-pc', 'aria-pressed': String(on), onclick: () => ((sel = [i, j]), update()) },
                ...(ch.length ? ch.map((x) => h('span', { class: x.c }, x.t)) : [h('span', { class: 'base' }, () => ((getLang() === 'zh') ? '原提示词' : 'original'))])
              )
            );
          })
        )
      );
      const more = xs.length > SHOW_X || ys.length > SHOW_Y ? h('p', { class: 'hint' }, () => ((getLang() === 'zh') ? '预览只显示前 ' + Math.min(SHOW_X, xs.length) + ' × ' + Math.min(SHOW_Y, ys.length) + ' 格' : 'Showing the first ' + Math.min(SHOW_X, xs.length) + ' × ' + Math.min(SHOW_Y, ys.length))) : null;
      prevEl.replaceChildren(...[h('table', { class: 'xy-pt' }, h('thead', {}, head), h('tbody', {}, ...rows)), more].filter(Boolean));
      const cell = cells[sel[1] * xs.length + sel[0]];
      if (cell) {
        const smp = SAMPLERS.find((s) => s.id === cell.params.sampler)?.label || cell.params.sampler;
        detEl.replaceChildren(h('span', {}, cell.params.prompt || '—'), h('br'), h('span', { class: 'dim' }, () => ('seed ' + cell.seed + ' · CFG ' + cell.params.scale + ' · ' + cell.params.steps + ((getLang() === 'zh') ? ' 步 · ' : ' steps · ') + smp)));
      }
    }
    const warn = [];
    if (cells.length > MAX_CELLS) warn.push((getLang() === 'zh') ? '最多 ' + MAX_CELLS + ' 格' : 'At most ' + MAX_CELLS + ' cells');
    if (any && (!xs.length || !ys.length)) warn.push((getLang() === 'zh') ? '有一个轴还没有值' : 'An axis has no values');
    if (cfg.freeOnly && c.paid) warn.push(((getLang() === 'zh') ? '「仅免费」已开启，有 ' + c.paid + ' 格要花 Anlas：' : '“Free only” is on and ' + c.paid + ' cells cost Anlas: ') + c.reasons.join((getLang() === 'zh') ? '；' : '; '));
    if (any && (P.characters || []).some((x) => x.enabled && x.prompt.trim()) && [cfg.x, cfg.y].some((ax) => ax && (TAG_KINDS.includes(ax.kind) || ax.kind === 'insert'))) warn.push((getLang() === 'zh') ? '变量只改基础提示词，角色提示词保持不变' : 'Variables change the base prompt only; character prompts stay');
    const noPrompt = !(P.prompt || '').trim() && !(P.characters || []).some((x) => x.enabled && x.prompt.trim());
    startBtn.disabled = !any || !xs.length || !ys.length || cells.length > MAX_CELLS || (cfg.freeOnly && c.paid > 0) || noPrompt;
    const n = any && xs.length && ys.length ? cells.length : 0;
    sumEl.replaceChildren(
      h('div', { class: 'xy-n' }, h('b', {}, n), h('span', {}, () => ((getLang() === 'zh') ? '格（' + (any ? xs.length : 0) + ' 列 × ' + ys.length + ' 行）' : 'cells (' + (any ? xs.length : 0) + ' × ' + ys.length + ')'))),
      h('div', { class: 'xy-n ' + (c.total ? 'warn' : 'ok') }, h('b', {}, state.session.live ? '◈ ' + c.total : 'DEMO'), h('span', {}, () => (state.session.live ? (c.total ? ((getLang() === 'zh') ? c.paid + ' 格付费' : c.paid + ' paid') : (getLang() === 'zh') ? '全部免费' : 'all free') : (getLang() === 'zh') ? '演示模式不消耗' : 'no cost in demo'))),
      h('div', { class: 'xy-notes' }, ...warn.map((w) => h('p', { class: 'hint warn' }, w)))
    );
  }
  function paintAll() {
    paintAxes();
    update();
  }

  // --- seed row
  const seedInp = h('input', { class: 'inp mono', value: cfg.seed, 'aria-label': () => ((getLang() === 'zh') ? '固定种子' : 'Fixed seed') });
  seedInp.oninput = () => ((cfg.seed = Number(seedInp.value.replace(/\D/g, '')) >>> 0), update());
  const stageSeed = deps.currentSeed();
  const freeCk = h('input', { type: 'checkbox', checked: cfg.freeOnly });
  freeCk.onchange = () => ((cfg.freeOnly = freeCk.checked), update());
  const seedRow = h(
    'div',
    { class: 'row wrap gap xy-opts' },
    h('span', { class: 't-label' }, () => ((getLang() === 'zh') ? '固定种子' : 'Fixed seed')),
    seedInp,
    h('button', { class: 'btn sm sq ghost', title: () => ((getLang() === 'zh') ? '换一个' : 'Reroll'), onclick: () => ((seedInp.value = cfg.seed = randomSeed()), update()) }, icon('dice')),
    stageSeed != null ? h('button', { class: 'btn sm ghost', title: () => ((getLang() === 'zh') ? '用正在看的那张图的种子' : 'Use the seed of the image on stage'), onclick: () => ((seedInp.value = cfg.seed = stageSeed), update()) }, icon('seed'), () => ((getLang() === 'zh') ? '当前图的种子' : 'Seed on stage')) : null,
    h('span', { class: 'sp' }),
    h('label', { class: 'tgl', title: () => ((getLang() === 'zh') ? '任何一格要花 Anlas 就不开始；运行中变得不免费会暂停队列' : 'Refuse to start (and pause) if any cell costs Anlas') }, freeCk, h('span', { class: 'sw' }), h('span', { class: 'cn' }, () => ((getLang() === 'zh') ? '仅免费' : 'Free only')))
  );

  const recent = await loadGrids();
  const body = h(
    'div',
    { class: 'xy-cfg' },
    h('div', { class: 'field' }, h('span', { class: 't-label' }, () => ((getLang() === 'zh') ? '快速开始' : 'Quick start')), tplRow),
    h('div', { class: 'field' }, hintEl, pwrap, prmRow),
    axesEl,
    seedRow,
    h('div', { class: 'field' }, h('span', { class: 't-label' }, () => ((getLang() === 'zh') ? '预览 · 点格子看完整提示词' : 'Preview · click a cell for its prompt')), prevEl, detEl),
    sumEl,
    recent.length
      ? h(
          'div',
          { class: 'xy-recent' },
          h('span', { class: 't-label' }, () => ((getLang() === 'zh') ? '最近的网格' : 'Recent grids')),
          ...recent.slice(0, 6).map((g) => h('button', { class: 'btn sm ghost', onclick: () => (m.close(), showView(g)) }, new Date(g.at).toLocaleString() + ' · ' + Object.keys(g.cells).length + '/' + g.xs.length * g.ys.length))
        )
      : null
  );
  const m = openModal({ n: 'XY', title: () => (t('copy.ui.xy.0')), sub: () => ((getLang() === 'zh') ? '固定种子，在提示词里标出要比较的地方' : 'Fixed seed — mark what to compare on the prompt'), body, onLang: () => paintAll(), foot: [h('button', { class: 'btn', onclick: () => m.close() }, () => ((getLang() === 'zh') ? '取消' : 'Cancel')), startBtn] });
  m.el.style.width = 'min(900px, 100%)';
  body.addEventListener('pointerdown', (e) => {
    if (pop && !pop.contains(e.target) && !e.target.closest('[data-i]')) closePop();
  });
  paintAll();

  startBtn.onclick = async () => {
    const { xs, ys, cells } = buildCells(cfg);
    const snap = deps.snapshot();
    const c = costOf(cells, snap);
    if (c.total && !(await confirmDialog(() => ((getLang() === 'zh') ? '这个网格共 ' + cells.length + ' 格，预计消耗 ◈ ' + c.total + ' Anlas。继续？' : cells.length + ' cells, about ◈ ' + c.total + ' Anlas. Continue?')))) return;
    localStorage.setItem(CFG_KEY, JSON.stringify({ x: cfg.x, y: cfg.y, freeOnly: cfg.freeOnly }));
    const grid = {
      id: Date.now().toString(36),
      at: Date.now(),
      x: { kind: cfg.x.kind, name: axisName(cfg.x) },
      y: cfg.y ? { kind: cfg.y.kind, name: axisName(cfg.y) } : null,
      xs: xs.map((v) => valueLabel(cfg.x, v)),
      ys: cfg.y ? ys.map((v) => valueLabel(cfg.y, v)) : [''],
      seed: cfg.seed,
      w: P.width,
      h: P.height,
      cells: {},
      failed: {},
    };
    live.set(grid.id, grid);
    await saveGrid(grid);
    m.close();
    const ahead = queueJobs().filter((j) => j.kind !== 'oneoff').length;
    enqueueXY({ gridId: grid.id, cells: cells.map(({ key, x, y, params, seed }) => ({ key, x, y, params, seed })), snap, freeOnly: cfg.freeOnly, label: 'X/Y · ' + grid.x.name + (grid.y ? ' × ' + grid.y.name : '') });
    showView(grid);
    if (ahead) toast(() => ((getLang() === 'zh') ? '已加入队列：前面还有 ' + ahead + ' 个任务' : 'Queued behind ' + ahead + ' job(s)'), 'ok', 3000);
  };
}

// ---------------------------------------------------------------- view
let shown = null;
export const xyOpen = () => !!viewEl;
export const xyRunning = () => queueJobs().some((j) => j.kind === 'xy');

function showView(grid) {
  shown = grid;
  if (!viewEl) {
    viewEl = h('div', { class: 'xy-view' });
    $('#stage').append(viewEl);
    document.addEventListener('keydown', onKey, true);
  }
  paintView();
}
function closeView() {
  viewEl?.remove();
  viewEl = null;
  document.removeEventListener('keydown', onKey, true);
}
function onKey(e) {
  if (e.key === 'Escape' && !document.querySelector('.modal-bg, .lightbox, .cmp-view')) {
    e.stopPropagation();
    closeView();
  }
}

// a new archive record may belong to the grid being shown: repaint cheaply
export function xyRefresh() {
  if (viewEl) paintView();
}

function paintView() {
  if (!viewEl || !shown) return;
  const Z = zh();
  const g = shown;
  const xs = g.xs.map(v => xyValueCopy(g.x.kind, v));
  const ys = g.ys.map(v => xyValueCopy(g.y?.kind, v));
  const st = xyJobState(g.id);
  const live = !!st;
  const total = g.xs.length * g.ys.length;
  const done = Object.keys(g.cells).length;
  const head = h(
    'div',
    { class: 'xy-head' },
    h('span', { class: 'cmp-t' }, 'X/Y'),
    h('span', { class: 'mono xy-axes-l' }, `X: ${xyAxisCopy(g.x.name)}` + (g.y ? `  ·  Y: ${xyAxisCopy(g.y.name)}` : '') + `  ·  SEED ${g.seed}`),
    h('span', { class: 'mono xy-prog' + (live ? ' on' : '') }, `${done}/${total}`),
    h('span', { class: 'sp' }),
    live ? h('button', { class: 'btn sm danger', onclick: () => (endJob(st.jobId), toast(() => ((getLang() === 'zh') ? '当前一格完成后停止' : 'Stopping after this cell'))) }, () => ((getLang() === 'zh') ? '■ 停止' : '■ STOP')) : null,
    h('button', { class: 'btn sm', disabled: !done, onclick: () => exportPNG(g) }, icon('download'), () => ((getLang() === 'zh') ? '导出网格 PNG' : 'Export PNG')),
    h('button', { class: 'btn sm sq ghost', title: () => ((getLang() === 'zh') ? '关闭 (Esc)' : 'Close (Esc)'), onclick: closeView }, icon('close'))
  );
  const cols = g.xs.length;
  const gridEl = h('div', { class: 'xy-grid' + (g.y ? ' has-y' : ''), style: { '--cols': cols, '--ar': `${g.w}/${g.h}` } });
  if (g.y) gridEl.append(h('span', { class: 'xy-corner' }));
  for (const x of xs) gridEl.append(h('span', { class: 'xy-xl mono', title: x }, x));
  ys.forEach((yl, j) => {
    if (g.y) gridEl.append(h('span', { class: 'xy-yl mono', title: yl }, yl));
    g.xs.forEach((_, i) => {
      const key = i + ',' + j;
      const id = g.cells[key];
      let inner;
      const url = id ? deps.thumb(id) : '';
      if (id && url) {
        const act = (label, title, fn) => h('button', { class: 'xy-act', title, onclick: (e) => (e.stopPropagation(), fn()) }, label);
        inner = [
          h('button', { class: 'xy-img', 'aria-label': () => ((getLang() === 'zh') ? '查看大图' : 'View'), onclick: async () => { const rec = await deps.get(id); if (rec) lightbox(deps.urlFor(rec)); } }, h('img', { src: url, alt: '' })),
          h(
            'div',
            { class: 'xy-acts' },
            act(() => ((getLang() === 'zh') ? '采用' : 'Use'), () => ((getLang() === 'zh') ? '把这一格的提示词、参数和种子载入编辑区' : 'Load this cell’s prompt, settings and seed'), async () => {
              const rec = await deps.get(id);
              if (rec?.params) deps.apply({ params: { ...rec.params, seed: rec.seed != null ? String(rec.seed) : '' } });
            }),
            act(() => ((getLang() === 'zh') ? '对比' : 'Cmp'), () => ((getLang() === 'zh') ? '加入对比视图' : 'Add to compare'), () => addToCompare(id)),
            act('↗', () => ((getLang() === 'zh') ? '在档案中打开' : 'Open in archive'), () => (closeView(), deps.view(id)))
          ),
        ];
      } else if (id) inner = [h('span', { class: 'hint' }, () => ((getLang() === 'zh') ? '已删除' : 'deleted'))];
      else if (live && st.cur === key) inner = [h('span', { class: 'xy-spin' }), h('span', { class: 'mono' }, () => ((getLang() === 'zh') ? '生成中' : 'GEN'))];
      else if (g.failed?.[key]) inner = [h('span', { class: 'hint', title: g.failed[key] }, '✕')];
      else inner = [h('span', { class: 'hint mono' }, () => (live ? ((getLang() === 'zh') ? '排队' : 'queued') : '—'))];
      gridEl.append(
        h(
          'div',
          {
            class: 'xy-cell' + (id ? ' has' : '') + (live && st.cur === key ? ' cur' : ''),
            title: `${xs[i]}${g.y ? ' × ' + ys[j] : ''}`,
          },
          ...inner
        )
      );
    });
  });
  viewEl.replaceChildren(head, h('div', { class: 'xy-body' }, gridEl));
}

// One PNG: labels on top / left, cells scaled so the long side is at most 512 px.
async function exportPNG(g) {
  const Z = zh();
  toast(() => ((getLang() === 'zh') ? '正在拼接网格…' : 'Composing grid…'));
  const s = Math.min(1, 512 / Math.max(g.w, g.h));
  const cw = Math.round(g.w * s);
  const ch = Math.round(g.h * s);
  const top = 44;
  const left = g.y ? 190 : 0;
  const head = 34;
  const gap = 4;
  const W = left + g.xs.length * (cw + gap) + gap;
  const H = head + top + g.ys.length * (ch + gap) + gap;
  const c = makeCanvas(W, H);
  const x = c.getContext('2d');
  x.fillStyle = '#0b0a0e';
  x.fillRect(0, 0, W, H);
  await document.fonts.load('500 14px "JetBrains Mono"').catch(() => {});
  const font = (px, w = 500) => (x.font = `${w} ${px}px "JetBrains Mono", monospace`);
  const fit = (text, max) => {
    let t = text;
    while (t.length > 1 && x.measureText(t).width > max) t = t.slice(0, -1);
    return t === text ? t : t.slice(0, -1) + '…';
  };
  x.fillStyle = '#c8ff2e';
  font(13, 700);
  x.textBaseline = 'middle';
  x.fillText(fit(`NOISEFORM X/Y · X: ${xyAxisCopy(g.x.name)}${g.y ? ' · Y: ' + xyAxisCopy(g.y.name) : ''} · SEED ${g.seed} · ${new Date(g.at).toLocaleString()}`, W - 20), 10, head / 2);
  x.fillStyle = '#ede8da';
  font(14);
  g.xs.forEach((l, i) => x.fillText(fit(xyValueCopy(g.x.kind, l), cw - 8), left + gap + i * (cw + gap) + 4, head + top / 2));
  for (let j = 0; j < g.ys.length; j++) {
    if (g.y) x.fillText(fit(xyValueCopy(g.y.kind, g.ys[j]), left - 14), 8, head + top + gap + j * (ch + gap) + ch / 2);
    for (let i = 0; i < g.xs.length; i++) {
      const id = g.cells[i + ',' + j];
      const px = left + gap + i * (cw + gap);
      const py = head + top + gap + j * (ch + gap);
      x.fillStyle = '#1a1820';
      x.fillRect(px, py, cw, ch);
      x.fillStyle = '#ede8da';
      if (!id) continue;
      const rec = await deps.get(id);
      if (!rec?.blob) continue;
      const img = await loadImage(URL.createObjectURL(rec.blob));
      x.drawImage(img, px, py, cw, ch);
      URL.revokeObjectURL(img.src);
    }
  }
  const d = new Date(g.at);
  downloadBlob(await canvasToBlob(c), `noiseform_xy_${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}_${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}.png`);
}
