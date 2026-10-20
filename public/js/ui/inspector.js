// Prompt review: a column beside each editor, one row per visual line of the editor, showing
// the Chinese for every tag on that line (translation) and fixes for unknown / alias tags
// (spell check, also drawn as underlines in the editor). The two features toggle separately;
// the column collapses to a rail that still marks lines with problems.
import { h, debounce } from '../util.js';
import { state, on, set } from '../store.js';
import { bindCopy, t, getLang } from '../i18n.js';
import { modelById } from '../data.js';
import { loadTagDB, tagDBReady, lookup, aliasOf, suggest, pretty, translateOnline, cachedTranslation, translating, canTranslate, naiKnown, canVerify, verifyNAI } from '../tagdb.js';

const WEIGHT_RE = /^-?\d+(?:\.\d+)?::/;
const ACT_RE = /^(?:source|target|mutual)#/i;

// → [{ start, end, text, weight }] where start/end index the core text inside the prompt.
export function segment(text) {
  const out = [];
  let i = 0;
  let depthUp = 0;
  let depthDn = 0;
  let weight = 1;
  while (i < text.length) {
    let j = i;
    while (j < text.length && !/[,\n|]/.test(text[j])) j++;
    let s = i;
    let e = j;
    const take = () => {
      while (s < e && /\s/.test(text[s])) s++;
      while (e > s && /\s/.test(text[e - 1])) e--;
    };
    take();
    let loop = true;
    while (loop && s < e) {
      loop = false;
      const rest = text.slice(s, e);
      const m = rest.match(WEIGHT_RE);
      if (m) {
        weight = parseFloat(m[0]);
        s += m[0].length;
        loop = true;
      } else if (rest[0] === '{') (depthUp++, s++, (loop = true));
      else if (rest[0] === '[') (depthDn++, s++, (loop = true));
      else if (ACT_RE.test(rest)) (s += rest.match(ACT_RE)[0].length, (loop = true));
      take();
    }
    let closeW = false;
    let ups = depthUp;
    let dns = depthDn;
    loop = true;
    while (loop && e > s) {
      loop = false;
      const c = text[e - 1];
      if (c === '}') (depthUp = Math.max(0, depthUp - 1), e--, (loop = true));
      else if (c === ']') (depthDn = Math.max(0, depthDn - 1), e--, (loop = true));
      else if (c === ':' && text[e - 2] === ':') (e -= 2, (closeW = true), (loop = true));
      take();
    }
    const core = text.slice(s, e);
    if (/^te?xt:/i.test(core)) break; // the rest is literal text for the image
    if (core && !/^[\d.\s]+$/.test(core)) out.push({ start: s, end: e, text: core, weight: weight !== 1 ? weight : null, ups: Math.max(ups, depthUp), dns: Math.max(dns, depthDn) });
    if (closeW) weight = 1;
    i = j + 1;
  }
  return out;
}

export function classify(text) {
  let core = text;
  let prefix = '';
  const am = core.match(/^artist:\s*/i);
  if (am) {
    prefix = 'artist:';
    core = core.slice(am[0].length);
  }
  if (/["“「]/.test(core)) return { kind: 'text', core, prefix };
  const known = lookup(core) || (prefix ? null : lookup(text));
  if (known) return { kind: 'known', core, prefix, e: known };
  const al = aliasOf(core);
  if (al) return { kind: 'alias', core, prefix, e: al };
  const words = core.split(/[\s_]+/).filter(Boolean).length;
  if (words >= 4 || /[.!?]$/.test(core) || /\b(the|a|an|is|are|with|of|in|on|and)\b/i.test(core)) return { kind: 'nl', core, prefix };
  if (/[　-鿿]/.test(core)) return { kind: 'cjk', core, prefix };
  const nk = naiKnown(core);
  if (nk) return { kind: 'nai', core, prefix, count: nk };
  return { kind: 'unknown', core, prefix, pending: nk == null };
}

// Classification is a handful of Map lookups, but it runs on every keystroke for every tag,
// and typo suggestions scan the whole dictionary — both are memoized.
const memo = new Map();
const classOf = (text) => {
  let c = memo.get(text);
  if (!c) {
    c = classify(text);
    if (memo.size > 4000) memo.clear();
    memo.set(text, c);
  }
  return c;
};
const suggMemo = new Map();
const suggestionsFor = (core) => {
  let s = suggMemo.get(core);
  if (!s) suggMemo.set(core, (s = suggest(core, 3)));
  return s;
};

const CAT = { 0: 'gen', 1: 'art', 3: 'cpy', 4: 'chr', 5: 'meta' };
const CAT_ZH = { 0: '一般', 1: '画师', 3: '作品', 4: '角色', 5: '元' };
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n));
const TYPING_GRACE = 1500; // don't flag the tag under the caret while it is being typed

// ---------------------------------------------------------------- shared queues
const live = new Set();
const resyncAll = () => live.forEach((x) => x.resync());

let trPending = new Set();
const flushTr = debounce(async () => {
  const list = [...trPending].slice(0, 8);
  trPending = new Set();
  await Promise.all(list.map((x) => translateOnline(x)));
  live.forEach((x) => x.render());
}, 600);
const queueTranslate = (text) => canTranslate(text) && (trPending.add(text), flushTr());

let nvPending = new Set();
const flushVerify = debounce(async () => {
  const list = [...nvPending].slice(0, 10);
  nvPending = new Set();
  const m = modelById(state.params.model);
  await Promise.all(list.map((x) => verifyNAI(x, m.suggestModel || state.params.model)));
  memo.clear();
  resyncAll();
}, 500);
const queueVerify = (text) => canVerify(text) && (nvPending.add(text), flushVerify());

on(['settings.translate', 'settings.spellcheck', 'settings.reviewOpen', 'params.model'], () => resyncAll());
// This module loads before boot installs the dictionary listener.
on('settings.lang', () => queueMicrotask(resyncAll));

// ---------------------------------------------------------------- instance
export function attachInspector(ed, host, { onIssues } = {}) {
  const { ta, hl } = ed;
  const zh = () => getLang() === 'zh';
  const rows = h('div', { class: 'rv-rows' });
  const rv = h('div', { class: 'rv' }, h('div', { class: 'rv-clip' }, rows));
  const pair = h('div', { class: 'ed-pair' });
  host.replaceWith(pair);
  pair.append(host, rv);

  let view = null; // { segs, cls: [classification], typing: index | -1 }
  let lastInput = 0;
  const flags = () => ({ tr: state.settings.translate !== false, sp: state.settings.spellcheck !== false, open: state.settings.reviewOpen !== false });

  // --- marks for the editor mirror (runs inside the editor's sync, i.e. per keystroke)
  ed.marker = (text) => {
    const { tr, sp } = flags();
    if ((!tr && !sp) || !tagDBReady()) return (view = null);
    const segs = segment(text);
    const caret = document.activeElement === ta && Date.now() - lastInput < TYPING_GRACE ? ta.selectionStart : -1;
    const v5 = modelById(state.params.model).v5;
    const cls = segs.map((sg) => classOf(sg.text));
    const typing = segs.findIndex((sg) => caret >= sg.start && caret <= sg.end);
    view = { segs, cls, typing };
    return segs.map((sg, i) => {
      const c = cls[i];
      let k = '';
      if (sp && i !== typing) {
        if (c.kind === 'unknown' || (c.kind === 'cjk' && !v5)) k = 'mk-unk';
        else if (c.kind === 'alias') k = 'mk-alias';
      }
      return { start: sg.start, end: sg.end, cls: k };
    });
  };
  ed.onsync = () => scheduleRender();
  ta.addEventListener('input', () => {
    lastInput = Date.now();
    regrace();
  });
  // once typing pauses, flag the tag that was under the caret too
  const regrace = debounce(() => ed.resync(), TYPING_GRACE + 50);

  // --- review column
  const scheduleRender = debounce(() => render(), 90);
  let lh = 20;
  let padTop = 11;

  function tokenFor(i, sg, c, tr, sp, v5) {
    const issue = sp && i !== view.typing && (c.kind === 'unknown' || (c.kind === 'cjk' && !v5));
    const isAlias = sp && c.kind === 'alias';
    if (!tr && !issue && !isAlias) return null;
    const title = [sg.text];
    let text = '';
    let cls = 'rt';
    let extra = [];
    if (c.kind === 'known') {
      cls += ' c-' + (CAT[c.e.cat] || 'gen');
      text = c.e.zh || '';
      if (c.prefix || c.e.cat === 1) text = (zh() ? '画师' : 'artist') + (c.e.zh ? '·' + c.e.zh : '');
      else if (!text && c.e.cat === 4) text = (zh() ? '角色 ' : 'char ') + pretty(c.core);
      if (!text) (text = pretty(c.core)), (cls += ' raw');
      title.push((zh() ? CAT_ZH[c.e.cat] || '' : CAT[c.e.cat] || '') + (c.e.count ? ' · ' + fmt(c.e.count) : ''));
    } else if (c.kind === 'alias') {
      cls += ' c-' + (CAT[c.e.cat] || 'gen');
      text = tr ? c.e.zh || pretty(c.e.tag) : '';
      if (isAlias) {
        cls += ' alias';
        extra.push(h('button', { class: 'fix', 'data-i': i, 'data-to': c.prefix + pretty(c.e.tag), title: () => (zh() ? '替换为标准标签' : 'Use canonical tag') }, '→ ' + pretty(c.e.tag)));
      }
    } else if (c.kind === 'nai') {
      cls += ' c-gen';
      const tx = cachedTranslation(c.core);
      if (tr && !tx) queueTranslate(c.core);
      text = tx || pretty(c.core);
      if (!tx) cls += ' raw';
      title.push(zh() ? 'NovelAI 词表中存在（Danbooru 已弃用或改名）' : 'Known to NovelAI (renamed on Danbooru)');
    } else if (c.kind === 'unknown') {
      if (sp && c.pending) queueVerify(c.core);
      const tx = cachedTranslation(c.core);
      if (tr && !tx) queueTranslate(c.core);
      text = tr && tx ? '≈' + tx : '';
      if (issue) {
        cls += ' unk';
        const sugg = suggestionsFor(c.core);
        extra = sugg.length
          ? sugg.map((e) => h('button', { class: 'fix', 'data-i': i, 'data-to': c.prefix + pretty(e.tag), title: e.zh || '' }, pretty(e.tag)))
          : [h('small', {}, () => (t('rv.notTag')))];
        title.push(zh() ? '词库中没有这个标签，可能拼写错误' : 'Not in the dictionary — possible typo');
      } else if (!text) (text = pretty(c.core)), (cls += ' raw');
    } else {
      // nl / text / cjk
      cls += ' nl';
      if (c.kind === 'cjk') {
        text = !v5 && sp ? t('rv.oldCjk') : t('rv.cjk');
        if (issue) cls += ' unk';
      } else {
        const tx = cachedTranslation(c.core);
        if (tr && !tx) queueTranslate(c.core);
        if (tx) text = tx;
        else if (trPending.has(c.core) || translating(c.core)) text = '…';
        else (text = c.core), (cls += ' raw'); // translation unavailable
      }
    }
    if (!tr && !issue) text = '';
    return h('span', { class: cls, 'data-i': i, title: title.filter(Boolean).join('\n') }, issue ? h('s', {}, pretty(c.core)) : null, text ? h('i', {}, text) : null, ...extra);
  }

  function render() {
    const { tr, sp, open } = flags();
    const on_ = tr || sp;
    pair.classList.toggle('rv-on', on_);
    pair.classList.toggle('rv-min', on_ && !open);
    bindCopy(rv, 'title', () => (on_ && !open ? t('rv.railTip') : ''));
    hidePop();
    if (!on_) {
      rows.replaceChildren();
      return onIssues?.(0);
    }
    if (!tagDBReady()) {
      rows.replaceChildren(h('div', { class: 'rv-load mono' }, () => (t('rv.loading'))));
      loadTagDB().then(() => (memo.clear(), ed.resync()), () => rows.replaceChildren(h('div', { class: 'rv-load mono' }, 'tags.tsv ✕')));
      return;
    }
    if (!view) return ed.resync(); // marks not computed yet (DB just loaded / features just enabled)
    const cs = getComputedStyle(ta);
    lh = parseFloat(cs.lineHeight) || 20;
    padTop = parseFloat(cs.paddingTop) || 0;
    // the first mirror span of each tag gives its visual line
    const lineOf = new Map();
    for (const el of hl.querySelectorAll('.mk')) {
      const i = +el.dataset.m;
      if (!lineOf.has(i)) lineOf.set(i, Math.max(0, Math.round((el.offsetTop - padTop) / lh)));
    }
    const v5 = modelById(state.params.model).v5;
    const lines = new Map(); // line → { toks: [], bad: 0, warn: 0 }
    let issues = 0;
    view.segs.forEach((sg, i) => {
      const c = view.cls[i];
      const ln = lineOf.get(i);
      if (ln == null) return;
      const bad = sp && i !== view.typing && (c.kind === 'unknown' || (c.kind === 'cjk' && !v5));
      if (bad) issues++;
      let L = lines.get(ln);
      if (!L) lines.set(ln, (L = { toks: [], lead: 0, bad: 0, warn: 0 }));
      if (bad) L.bad++;
      if (sp && c.kind === 'alias') L.warn++;
      if (open) {
        const tok = tokenFor(i, sg, c, tr, sp, v5);
        // problems go first so a crowded line never truncates them away
        if (tok && (bad || (sp && c.kind === 'alias'))) L.toks.splice(L.lead++, 0, tok);
        else if (tok) L.toks.push(tok);
      }
    });
    const out = [];
    for (const [ln, L] of lines) {
      const top = padTop + ln * lh;
      if (!open) {
        if (L.bad || L.warn) out.push(h('i', { class: 'rv-dot' + (L.bad ? ' bad' : ''), style: { top: top + 'px', height: lh + 'px' } }));
        continue;
      }
      if (!L.toks.length) continue;
      out.push(h('div', { class: 'rv-row' + (L.bad ? ' bad' : ''), style: { top: top + 'px', height: lh + 'px', lineHeight: lh + 'px' } }, ...L.toks));
    }
    rows.replaceChildren(...out);
    rows.style.transform = `translateY(${-ta.scrollTop}px)`;
    markCaret();
    onIssues?.(issues);
  }

  // --- interaction: hover ↔ editor highlight, click → select / fix, overflowing row → popover
  const hot = (i, on_) => {
    for (const el of hl.querySelectorAll(`.mk[data-m="${i}"]`)) el.classList.toggle('hot', on_);
  };
  let pop = null;
  const hidePop = () => {
    pop?.remove();
    pop = null;
  };
  rv.addEventListener('mouseover', (e) => {
    const tok = e.target.closest('.rt');
    if (tok) hot(tok.dataset.i, true);
    const row = e.target.closest('.rv-row');
    if (row && !row.classList.contains('rv-pop') && row.scrollWidth > row.clientWidth + 1 && pop?.src !== row) {
      hidePop();
      pop = row.cloneNode(true);
      pop.src = row;
      pop.classList.add('rv-pop');
      pop.style.top = row.offsetTop - ta.scrollTop + 'px';
      pop.style.height = 'auto';
      pop.addEventListener('mouseleave', hidePop);
      rv.append(pop);
    }
  });
  rv.addEventListener('mouseout', (e) => {
    const tok = e.target.closest('.rt');
    if (tok && !tok.contains(e.relatedTarget)) hot(tok.dataset.i, false);
  });
  rv.addEventListener('mouseleave', hidePop);
  rv.addEventListener('click', (e) => {
    if (pair.classList.contains('rv-min')) return set('settings.reviewOpen', true);
    const fix = e.target.closest('.fix');
    const tok = e.target.closest('.rt');
    if (!tok || !view) return;
    const sg = view.segs[+tok.dataset.i];
    if (!sg || ta.value.slice(sg.start, sg.end) !== sg.text) return ed.resync(); // stale
    ta.focus();
    if (fix) {
      const to = fix.dataset.to;
      ta.value = ta.value.slice(0, sg.start) + to + ta.value.slice(sg.end);
      ta.setSelectionRange(sg.start, sg.start + to.length);
      ta.dispatchEvent(new Event('input'));
      lastInput = 0; // a fix is not typing
      hidePop();
    } else ta.setSelectionRange(sg.start, sg.end);
  });

  // caret position → highlight its token
  let curI = -1;
  function markCaret() {
    if (!view) return;
    const c = ta.selectionStart;
    const i = document.activeElement === ta ? view.segs.findIndex((sg) => c >= sg.start && c <= sg.end) : -1;
    if (i === curI && rows.querySelector('.rt.cur')) return;
    rows.querySelector('.rt.cur')?.classList.remove('cur');
    curI = i;
    if (i >= 0) rows.querySelector(`.rt[data-i="${i}"]`)?.classList.add('cur');
  }
  ta.addEventListener('keyup', markCaret);
  ta.addEventListener('click', markCaret);
  ta.addEventListener('blur', markCaret);
  ta.addEventListener('scroll', () => {
    rows.style.transform = `translateY(${-ta.scrollTop}px)`;
    hidePop();
  });

  const inst = {
    render,
    resync: () => ed.resync(),
  };
  live.add(inst);
  ed.resync();
  return {
    render,
    el: rv,
    dispose: () => {
      live.delete(inst);
      ed.marker = null;
      ed.onsync = null;
    },
  };
}
