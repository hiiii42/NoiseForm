// Prompt editor: transparent textarea over a syntax-highlight mirror, tag autocomplete,
// and Ctrl+↑/↓ emphasis shortcuts. NovelAI syntax: {up} [down] 1.5::weighted:: a|b, source#/target#.
import { h, debounce, clamp } from '../util.js';
import { searchTags } from '../tags.js';
import { tagDBReady, searchDB, searchSeries, charactersOf, searchArtists, lookup, loadTagDB } from '../tagdb.js';
import { matchSnippets, glossOf, noteUse, findChunk, chunkReferences } from './chunks.js';
import { attachArtistPeek } from './artistpeek.js';
import { getLang } from '../i18n.js';
import { readLocalVersioned, writeLocalVersioned } from '../persist.js';
import { normalizeBlur } from '../promptfmt.js';

const T = (zh, en) => getLang() === 'zh' ? zh : en;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// marks: optional sorted, non-overlapping [{ start, end, cls }] — each range is wrapped in
// <span class="mk …" data-m="index"> so the review column can find where a tag sits.
export function highlight(text, marks = null) {
  let out = '';
  let up = 0;
  let dn = 0;
  let w = 0;
  let runKey = null;
  let runMark = -1;
  let run = '';
  let mi = 0;
  const markAt = (i) => {
    if (!marks) return -1;
    while (mi < marks.length && marks[mi].end <= i) mi++;
    return mi < marks.length && marks[mi].start <= i ? mi : -1;
  };
  const wrap = (key, s) => {
    s = esc(s);
    if (key === 'n') return s;
    if (key[0] === 'u') return `<span class="hl-up" style="--d:${key.slice(1)}">${s}</span>`;
    if (key[0] === 'd') return `<span class="hl-dn" style="--d:${key.slice(1)}">${s}</span>`;
    return `<span class="hl-${key}">${s}</span>`;
  };
  const flush = () => {
    if (run) {
      const inner = wrap(runKey, run);
      out += runMark < 0 ? inner : `<span class="mk${marks[runMark].cls ? ' ' + marks[runMark].cls : ''}" data-m="${runMark}">${inner}</span>`;
    }
    run = '';
  };
  let at = 0; // index of the character being pushed
  const push = (key, s) => {
    const m = markAt(at);
    if (key !== runKey || m !== runMark) {
      flush();
      runKey = key;
      runMark = m;
    }
    run += s;
  };
  const weightRe = /-?\d+(?:\.\d+)?::/y;
  const actRe = /(?:source|target|mutual)#/y;
  let i = 0;
  const refs = chunkReferences(text);
  let ri = 0;
  while (i < text.length) {
    if (i === 0 || text[i - 1] === '\n') {
      const end = text.indexOf('\n', i);
      const line = text.slice(i, end < 0 ? text.length : end);
      const kind = /^\s*#/.test(line) ? 'comment' : /^\s*---\s*$/.test(line) ? 'divider' : null;
      if (kind) {
        flush();
        out += `<span class="hl-${kind}" data-line-start="${i}">${esc(line)}</span>`;
        i += line.length;
        while (refs[ri] && refs[ri].start < i) ri++;
        up = dn = w = 0;
        continue;
      }
    }
    if (refs[ri]?.start === i) {
      flush();
      const ref = refs[ri++];
      const cls = 'tok-chunk' + (findChunk(ref.name) ? '' : ' unknown');
      // Keep review marks intact even when their ranges split a chunk reference.
      for (let j = i; j < ref.end;) {
        const mark = markAt(j);
        let end = j + 1;
        while (end < ref.end && markAt(end) === mark) end++;
        const inner = `<span class="${cls}" data-chunk="${esc(ref.name).replace(/"/g, '&quot;')}">${esc(text.slice(j, end))}</span>`;
        out += mark < 0 ? inner : `<span class="mk${marks[mark].cls ? ' ' + marks[mark].cls : ''}" data-m="${mark}">${inner}</span>`;
        j = end;
      }
      i = ref.end;
      continue;
    }
    at = i;
    const prev = i ? text[i - 1] : ',';
    weightRe.lastIndex = i;
    let m;
    if (/[\s,{}[\]|:]/.test(prev) && (m = weightRe.exec(text))) {
      w = parseFloat(m[0]) < 1 ? -1 : 1;
      push('w', m[0]);
      i += m[0].length;
      continue;
    }
    if (text[i] === ':' && text[i + 1] === ':') {
      push('w', '::');
      w = 0;
      i += 2;
      continue;
    }
    actRe.lastIndex = i;
    if (/[\s,]/.test(prev) && (m = actRe.exec(text))) {
      push('act', m[0]);
      i += m[0].length;
      continue;
    }
    const c = text[i];
    if (c === '{') {
      push('b1', c);
      up++;
    } else if (c === '}') {
      up = Math.max(0, up - 1);
      push('b1', c);
    } else if (c === '[') {
      push('b2', c);
      dn++;
    } else if (c === ']') {
      dn = Math.max(0, dn - 1);
      push('b2', c);
    } else if (c === ',') push('c', c);
    else if (c === '|') push('pipe', c);
    else if (w) push(w > 0 ? 'wt' : 'wneg', c);
    else {
      const net = up - dn;
      push(net > 0 ? 'u' + Math.min(net, 4) : net < 0 ? 'd' + Math.min(-net, 4) : 'n', c);
    }
    i++;
  }
  flush();
  return out + '\n';
}

// Rough T5-style token estimate (NovelAI V4 limit: 512).
export function estimateTokens(text) {
  if (!text) return 0;
  const parts = text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) || [];
  let n = 0;
  for (const p of parts) {
    if (/[\p{L}\p{N}]/u.test(p)) {
      n += /[　-鿿]/.test(p) ? p.length : Math.max(1, Math.round(p.length / 4.2));
    } else n += 1;
  }
  return n;
}

// Color-only delimiters do not need inline layout boxes. Native highlights keep
// their colors without rounding each tiny span's advance separately in Blink.
// Background tokens, chunk previews and inspector .mk ranges keep their DOM.
const delimiterKinds = ['c', 'b1', 'b2', 'w', 'act', 'pipe'];
const delimiterRanges = new Map();
function paintDelimiters(hl) {
  if (!globalThis.CSS?.highlights || !globalThis.Highlight) return;
  const offsets = new Map();
  const walker = document.createTreeWalker(hl, NodeFilter.SHOW_TEXT);
  let node, offset = 0;
  while ((node = walker.nextNode())) { offsets.set(node, offset); offset += node.length; }
  const tokens = [];
  for (const kind of delimiterKinds) {
    for (const span of hl.querySelectorAll(`.hl-${kind}`)) {
      const first = span.firstChild;
      if (first?.nodeType !== Node.TEXT_NODE) continue;
      tokens.push({ kind, start: offsets.get(first), end: offsets.get(first) + first.length });
      span.replaceWith(...span.childNodes);
    }
  }
  hl.normalize();
  const runs = [], next = document.createTreeWalker(hl, NodeFilter.SHOW_TEXT);
  offset = 0;
  while ((node = next.nextNode())) { runs.push({ node, start: offset, end: offset + node.length }); offset += node.length; }
  const groups = new Map(delimiterKinds.map((kind) => [kind, []]));
  let cursor = 0;
  for (const token of tokens.sort((a, b) => a.start - b.start)) {
    while (runs[cursor]?.end <= token.start) cursor++;
    let last = cursor;
    while (runs[last]?.end < token.end) last++;
    if (!runs[cursor] || !runs[last]) continue;
    const range = document.createRange();
    range.setStart(runs[cursor].node, token.start - runs[cursor].start);
    range.setEnd(runs[last].node, token.end - runs[last].start);
    groups.get(token.kind).push(range);
  }
  delimiterRanges.set(hl, groups);
  for (const host of delimiterRanges.keys()) if (!host.isConnected) delimiterRanges.delete(host);
  for (const kind of delimiterKinds) {
    CSS.highlights.set(`nf-ed-${kind}`, new Highlight(...[...delimiterRanges.values()].flatMap((g) => g.get(kind))));
  }
}

// ---------------- autocomplete (singleton) ----------------
let ac = null;
let acState = null;
let remoteSuggest = null; // async (q) => [{tag, count, cat}]
let acSeq = 0;
let acFrame = 0;
const AC_LIMIT = 12;

export function setRemoteSuggest(fn) {
  remoteSuggest = fn;
}

export function closeAC() {
  ++acSeq; // Invalidate pending loads, remote responses and scheduled input work.
  cancelAnimationFrame(acFrame);
  hideAC();
}

function hideAC() {
  const ta = acState?.ed.ta;
  ta?.setAttribute('aria-expanded', 'false');
  ta?.removeAttribute('aria-controls');
  ta?.removeAttribute('aria-activedescendant');
  ac?.remove();
  ac = null;
  acState = null;
}

function fragmentAt(value, caret) {
  const segmentStart = Math.max(value.lastIndexOf(',', caret - 1), value.lastIndexOf('，', caret - 1), value.lastIndexOf('\n', caret - 1)) + 1;
  const segment = value.slice(segmentStart, caret);
  const chunk = segment.match(/@[^\s,，]*$/u);
  if (chunk && (!value[caret] || /[\s,，]/u.test(value[caret]))) return { start: segmentStart + chunk.index, end: caret, q: chunk[0] };
  let start = caret;
  while (start > 0 && !/[,，{}[\]|\n]/.test(value[start - 1])) {
    if (value[start - 1] === ':' && value[start - 2] === ':') break;
    start--;
  }
  const raw = value.slice(start, caret);
  const lead = raw.match(/^\s*(?:-?\d+(?:\.\d+)?::)?\s*/)[0];
  const next = value[caret];
  if (next && !/[\s,{}[\]|:]/.test(next)) return null;
  let from = start + lead.length;
  let q = raw.slice(lead.length);
  // Natural language between commas ("two girls holding hands. ex"): complete only what follows the last
  // sentence break, and only the last word once the text runs past a tag's length (> 4 words).
  let prose = false;
  const breakAt = [...q.matchAll(/[.!?;]\s+|[。！？；]\s*/g)].pop();
  if (breakAt) {
    from += breakAt.index + breakAt[0].length;
    q = q.slice(breakAt.index + breakAt[0].length);
    prose = true;
  }
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 4) {
    const last = q.match(/\S*$/)[0];
    from += q.length - last.length;
    q = last;
    prose = true;
  }
  return { start: from, end: caret, q, prose };
}

function caretXY(ta, mirrorCls, pos) {
  const cs = getComputedStyle(ta);
  const m = h('div', { class: mirrorCls });
  Object.assign(m.style, {
    position: 'absolute',
    visibility: 'hidden',
    left: '-9999px',
    top: '0',
    width: ta.clientWidth + 'px',
    font: cs.font,
    padding: cs.padding,
    lineHeight: cs.lineHeight,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  });
  m.textContent = ta.value.slice(0, pos);
  const mark = h('span', {}, '​');
  m.append(mark);
  document.body.append(m);
  const r = ta.getBoundingClientRect();
  const x = r.left + mark.offsetLeft;
  const y = r.top + mark.offsetTop - ta.scrollTop + parseFloat(cs.lineHeight);
  m.remove();
  return { x, y };
}

function renderAC(items, ed, frag, mode = 'tags', series = null) {
  items = items.slice(0, AC_LIMIT);
  if (!items.length && !['series', 'characters', 'empty'].includes(mode)) return hideAC();
  const previous = acState;
  const selected = previous?.items[previous.idx]?.tag;
  const same = previous?.ed === ed && previous.frag.q === frag.q && previous.mode === mode;
  const idx = same ? Math.max(0, items.findIndex((it) => it.tag === selected)) : 0;
  if (!ac) {
    ac = h('div', { class: 'ac ac2' });
    document.body.append(ac);
  }
  acState = { items, ed, frag, idx, mode, series, value: ed.ta.value };
  const title = () => series
    ? T(`作品：${series.zh || series.tag} · 选一个角色，Esc 返回`, `Series: ${series.tag} · Choose a character, Esc to go back`)
    : T('你是想输入…？', 'Did you mean…?');
  const list = h('div', { class: 'ac-list', id: 'nf-ac-list', role: 'listbox', 'aria-label': title });
  list.append(...items.map((it, i) => {
      const label = () => mode === 'series' ? T('作品', 'Series')
        : mode === 'characters' ? T('角色', 'Character')
        : mode === 'artist' ? T('画师', 'Artist') : it.snip ? T('块', 'Chunk') : '';
      const row = h(
        'div',
        { class: 'ac-i' + (i === idx ? ' on' : ''), role: 'option', id: `nf-ac-${i}`, 'aria-selected': String(i === idx) },
        h('i', { 'data-cat': it.cat ?? 0, 'aria-hidden': 'true' }),
        h('strong', { class: 'ac-tag' }, it.label ?? it.tag),
        h('em', { class: 'ac-zh' }, it.zh || lookup(it.tag)?.zh || ''),
        it.count != null ? h('small', { class: 'ac-count', title: String(it.count) }, compact(it.count)) : null,
        label() ? h('span', { class: 'ac-kind' }, label) : null
      );
      row.addEventListener('mouseenter', () => selectAC(i));
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        acceptAC(i);
      });
      return row;
    }));
  ac.replaceChildren(...[
    h('div', { class: 'ac-head' }, h('span', {}, title), h('small', {}, () => (T(`${items.length} 个匹配`, `${items.length} matches`)))),
    list,
    !items.length && mode !== 'empty' ? h('p', { class: 'ac-empty' }, () => (mode === 'characters'
      ? T('本地词库暂无关联角色，按 Esc 返回', 'No linked characters in the local dictionary; press Esc to go back')
      : T('未找到作品，请继续输入', 'No series found; keep typing'))) : null,
    ['series', 'characters', 'empty'].includes(mode) ? h('div', { class: 'ac-foot' }, () => (T('输入 =作品名，先选作品再选角色', 'Type =series, choose a series and then a character'))) : null
  ].filter(Boolean));
  ed.ta.setAttribute('aria-expanded', 'true');
  ed.ta.setAttribute('aria-controls', 'nf-ac-list');
  selectAC(idx);
  positionAC();
}

function positionAC() {
  if (!acState) return;
  const { ed, frag } = acState;
  const r = ed.ta.getBoundingClientRect();
  const { y } = caretXY(ed.ta, 'ed-hl', frag.end);
  ac.style.width = Math.min(r.width, innerWidth - 16) + 'px';
  ac.style.left = clamp(r.left, 8, Math.max(8, innerWidth - r.width - 8)) + 'px';
  const below = clamp(y + 6, 8, innerHeight - 8);
  const above = clamp(y - parseFloat(getComputedStyle(ed.ta).lineHeight) - 6, 8, innerHeight - 8);
  const down = innerHeight - below - 8;
  const up = above - 8;
  const useAbove = ac.scrollHeight > down && up > down;
  ac.style.maxHeight = Math.max(0, useAbove ? up : down) + 'px';
  ac.style.top = (useAbove ? Math.max(8, above - ac.offsetHeight) : below) + 'px';
}

function compact(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function moveAC(d) {
  if (!acState?.items.length) return;
  selectAC((acState.idx + d + acState.items.length) % acState.items.length);
  ac.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}

function selectAC(idx) {
  if (!acState) return;
  acState.idx = idx;
  ac.querySelectorAll('.ac-i').forEach((row, i) => {
    row.classList.toggle('on', i === idx);
    row.setAttribute('aria-selected', String(i === idx));
  });
  if (acState.items.length) acState.ed.ta.setAttribute('aria-activedescendant', `nf-ac-${idx}`);
  else acState.ed.ta.removeAttribute('aria-activedescendant');
}

function currentAC({ ed, frag, value }) {
  return document.activeElement === ed.ta && ed.ta.value === value
    && ed.ta.selectionStart === frag.end && ed.ta.selectionEnd === frag.end;
}

function escapeAC() {
  if (acState?.mode === 'characters' && currentAC(acState)) {
    const { ed, frag } = acState;
    ++acSeq;
    return renderAC(searchSeries(frag.q.slice(1), AC_LIMIT), ed, frag, 'series');
  }
  closeAC();
}

function acceptAC(i = acState?.idx) {
  if (!acState || !currentAC(acState)) return closeAC();
  const { items, ed, frag, mode } = acState;
  if (!items[i]) return;
  if (mode === 'series') {
    ++acSeq;
    return renderAC(charactersOf(items[i].tag, AC_LIMIT), ed, frag, 'characters', items[i]);
  }
  const tag = (mode === 'artist' ? 'artist:' : '') + items[i].tag;
  if (items[i].snip) noteUse(tag);
  const v = ed.ta.value;
  const after = v.slice(frag.end);
  const needsComma = !/^\s*[,，}\]|:]/.test(after) || after === '';
  const ins = tag + (needsComma && !/^\s*[}\]]/.test(after) ? ', ' : '');
  ed.ta.value = v.slice(0, frag.start) + ins + after;
  const caret = frag.start + ins.length;
  ed.ta.setSelectionRange(caret, caret);
  closeAC();
  ed.ta.dispatchEvent(new Event('input'));
}

// Only the remote lane is debounced. Local results render in the next animation frame.
const queryRemoteAC = debounce(async (q, valid, merge) => {
  if (!valid() || !remoteSuggest) return;
  try {
    const items = await remoteSuggest(q);
    if (valid()) merge(items || []);
  } catch { /* Keep the already visible local results. */ }
}, 140);

function queryAC(ed) {
  const seq = ++acSeq;
  cancelAnimationFrame(acFrame);
  acFrame = requestAnimationFrame(() => runQueryAC(ed, seq));
}

function runQueryAC(ed, seq) {
  if (ed.disposed || seq !== acSeq) return;
  const ta = ed.ta;
  if (document.activeElement !== ta || ta.selectionStart !== ta.selectionEnd || ed.composing) return closeAC();
  const frag = fragmentAt(ta.value, ta.selectionStart);
  if (!frag) return closeAC();
  // A click at the same caret must not reset the second step.
  if (acState?.ed === ed && acState.mode === 'characters' && currentAC(acState)) return;
  if (frag && frag.q.trimStart().startsWith('@')) {
    // @name → saved snippets
    const items = matchSnippets(frag.q.trim().slice(1)).map((s) => ({ tag: '@' + s.name, label: '@' + s.name, zh: glossOf(s.text) || s.text, cat: 'snip', snip: true }));
    return items.length ? renderAC(items, ed, frag, 'chunks') : closeAC();
  }
  const raw = frag.q.trim();
  const mode = raw.startsWith('=') ? 'series' : /^artist:/i.test(raw) ? 'artist' : raw ? 'tags' : 'empty';
  const q = mode === 'series' ? raw.slice(1).trim() : mode === 'artist' ? raw.slice(7).trim() : raw;
  const cjk = /[　-鿿]/.test(q);
  if (mode === 'empty') return closeAC(); // clicking into blank space never opens the list
  if (mode === 'tags' && q.length < (cjk ? 1 : 2)) return closeAC();
  const snapshot = { ed, frag, value: ta.value };
  const valid = () => !ed.disposed && seq === acSeq && currentAC(snapshot) && !ed.composing;
  let remote = [];
  const draw = () => {
    if (!valid()) return;
    const local = mode === 'series' ? searchSeries(q, AC_LIMIT)
      : mode === 'artist' ? searchArtists(q, AC_LIMIT)
      : mode === 'empty' ? []
      : tagDBReady() ? searchDB(q, AC_LIMIT) : searchTags(q, AC_LIMIT);
    const key = (tag) => tag.toLowerCase().replace(/[\s_]+/g, ' ');
    const seen = new Set(local.map((it) => key(it.tag)));
    const extra = remote.map((it) => {
      const tag = it.tag.replace(/^artist:/i, '').replace(/_/g, ' ');
      const known = lookup(tag);
      return { ...it, tag, cat: known?.cat ?? it.cat, zh: known?.zh || it.zh || '' };
    }).filter((it) => (mode !== 'artist' || +it.cat === 1) && !seen.has(key(it.tag)) && seen.add(key(it.tag)));
    let items = [...local, ...extra];
    // inside prose only offer confident completions: a word of the tag starts with what was typed
    if (frag.prose && mode === 'tags') {
      const lq = q.toLowerCase();
      items = items.filter((it) => it.tag.toLowerCase().replace(/_/g, ' ').split(/[\s()]+/).some((w) => w.startsWith(lq)));
    }
    renderAC(items, ed, frag, mode);
  };
  draw();
  if (mode !== 'empty' && !tagDBReady()) loadTagDB().then(() => draw()).catch(() => {});
  if (remoteSuggest && q && !cjk && ['tags', 'artist'].includes(mode)) {
    queryRemoteAC(mode === 'artist' ? 'artist:' + q : q, valid, (items) => { remote = items; draw(); });
  }
}

// Keep fixed-position suggestions attached when the editor or its scroll container moves.
window.addEventListener('resize', positionAC);
document.addEventListener('scroll', (e) => {
  if (ac?.contains(e.target)) return;
  positionAC();
}, true);

// Shared selection expansion for weight and tag-order shortcuts.
function tagRange(ta) {
  let s = ta.selectionStart;
  let e = ta.selectionEnd;
  const v = ta.value;
  if (s === e) {
    while (s > 0 && !/[,\n]/.test(v[s - 1])) s--;
    while (e < v.length && !/[,\n]/.test(v[e])) e++;
    while (s < e && /\s/.test(v[s])) s++;
    while (e > s && /\s/.test(v[e - 1])) e--;
  } else {
    while ((v[s - 1] === '{' && v[e] === '}') || (v[s - 1] === '[' && v[e] === ']')) { s--; e++; }
    const prefix = v.slice(0, s).match(/(?:^|[,\n]\s*)(-?\d+(?:\.\d+)?::)$/);
    if (prefix && v.slice(e, e + 2) === '::') { s -= prefix[1].length; e += 2; }
  }
  return { s, e };
}

function isNoteAt(text, position) {
  const start = position > 0 ? text.lastIndexOf('\n', position - 1) + 1 : 0;
  const end = text.indexOf('\n', start);
  return /^\s*(?:#|---\s*$)/.test(text.slice(start, end < 0 ? text.length : end));
}

// Keep native editing history, with an explicit fallback for browsers without insertText.
function replaceText(ta, s, e, text) {
  ta.setSelectionRange(s, e);
  const expected = ta.value.slice(0, s) + text + ta.value.slice(e);
  let inserted = false;
  try { inserted = document.execCommand('insertText', false, text); } catch { /* fallback below */ }
  if (!inserted || ta.value !== expected) {
    ta.value = expected;
    ta.setSelectionRange(s + text.length, s + text.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function emphasize(ta, dir) {
  const { s, e } = tagRange(ta);
  const v = ta.value;
  if (s === e || isNoteAt(v, s) || /^\s*(?:#|---\s*$)/m.test(v.slice(s, e))) return;
  let inner = v.slice(s, e);
  let weight = 1;
  const numeric = inner.match(/^(-?\d+(?:\.\d+)?)::([\s\S]*)::$/);
  if (numeric) { weight = Number(numeric[1]); inner = numeric[2]; }
  else {
    while ((inner.startsWith('{') && inner.endsWith('}')) || (inner.startsWith('[') && inner.endsWith(']'))) {
      weight *= inner[0] === '{' ? 1.1 : 1 / 1.1;
      inner = inner.slice(1, -1);
    }
  }
  // -3.0 … 3.0 in 0.1 steps; 0 is skipped (0.1 → -0.1), negative weights push a concept away (V4+)
  let tenths = clamp(Math.round(weight * 10) + dir, -30, 30);
  if (tenths === 0) tenths = dir;
  inner = tenths === 10 ? inner : `${(tenths / 10).toFixed(1)}::${inner}::`;
  replaceText(ta, s, e, inner);
  ta.setSelectionRange(s, s + inner.length);
}

function moveTag(ta, dir) {
  const { s, e } = tagRange(ta), v = ta.value;
  const tags = [...v.matchAll(/[^,\n]+/g)].map((m) => ({
    s: m.index + m[0].length - m[0].trimStart().length,
    e: m.index + m[0].trimEnd().length,
    text: m[0].trim(),
  })).filter((t) => t.text);
  const i = tags.findIndex((t) => t.s === s && t.e === e);
  const a = tags[i], b = tags[i + dir];
  if (!a || !b || isNoteAt(v, a.s) || isNoteAt(v, b.s)) return;
  // Keep delimiters/indentation in their slots; only exchange tag contents.
  const left = dir < 0 ? b : a, right = dir < 0 ? a : b;
  const between = v.slice(left.e, right.s);
  replaceText(ta, left.s, right.e, right.text + between + left.text);
  const start = dir < 0 ? left.s : left.s + right.text.length + between.length;
  ta.setSelectionRange(start, start + a.text.length);
}

function toggleComment(ta) {
  const v = ta.value;
  const s = ta.selectionStart > 0 ? v.lastIndexOf('\n', ta.selectionStart - 1) + 1 : 0;
  const end = ta.selectionEnd > ta.selectionStart && v[ta.selectionEnd - 1] === '\n' ? ta.selectionEnd - 1 : ta.selectionEnd;
  const next = v.indexOf('\n', end), e = next < 0 ? v.length : next;
  const lines = v.slice(s, e).split('\n');
  const remove = lines.every((line) => /^\s*#/.test(line));
  const text = lines.map((line) => remove ? line.replace(/^(\s*)# ?/, '$1') : line.replace(/^(\s*)/, '$1# ')).join('\n');
  replaceText(ta, s, e, text);
  ta.setSelectionRange(s, s + text.length);
}

// ---------------- editor factory ----------------
// The textarea receives pointer events; inspect mirror rectangles without intercepting selection.
let chunkTip = null;
const hideChunkTip = () => { if (chunkTip) chunkTip.hidden = true; };
document.addEventListener('scroll', hideChunkTip, true);
document.addEventListener('pointerdown', hideChunkTip, true);
window.addEventListener('resize', hideChunkTip);
document.addEventListener('nf:chunks', () => {
  hideChunkTip();
  document.querySelectorAll('.ed-ta').forEach((ta) => ta.dispatchEvent(new Event('nf:chunks')));
});
function previewChunk(e, hl) {
  if (e.buttons) return hideChunkTip();
  const token = [...hl.querySelectorAll('.tok-chunk')].find((el) => [...el.getClientRects()].some((r) => e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom));
  if (!token) return hideChunkTip();
  if (!chunkTip) { chunkTip = h('div', { class: 'chunk-tooltip', role: 'tooltip' }); document.body.append(chunkTip); }
  const name = token.dataset.chunk;
  chunkTip.replaceChildren(h('strong', {}, '@' + name), h('div', {}, () => (findChunk(name)?.text ?? T('未找到此提示词块', 'Unknown prompt chunk'))));
  chunkTip.hidden = false;
  chunkTip.style.left = Math.max(8, Math.min(e.clientX + 12, innerWidth - chunkTip.offsetWidth - 8)) + 'px';
  chunkTip.style.top = Math.max(8, Math.min(e.clientY + 20, innerHeight - chunkTip.offsetHeight - 8)) + 'px';
}

// Each key includes a same-title occurrence index: duplicate headings remain independent.
function sections(text) {
  const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter((m) => m[0]);
  const result = [], seen = new Map();
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i][0].replace(/\n$/, '');
    if (!/^\s*#/.test(header)) continue;
    const n = seen.get(header) || 0;
    seen.set(header, n + 1);
    let j = i + 1;
    while (j < lines.length && !/^\s*(?:#|---\s*$)/.test(lines[j][0])) j++;
    const start = lines[i].index, end = j < lines.length ? lines[j].index : text.length;
    const body = text.slice(start + header.length, end);
    result.push({ key: JSON.stringify([header, n]), header, body, start, end });
  }
  return result;
}

let editorSerial = 0;
function createFolds(ed, id, refresh) {
  const { ta, hl, el } = ed;
  const layer = h('div', { class: 'ed-fold-layer' });
  el.append(layer);
  const folds = new Map(), archive = new Map();
  const views = [];
  let viewCursor = -1;
  let changing = false;
  const remember = () => {
    const signature = JSON.stringify([...folds].map(([key, r]) => [key, r.original]));
    if (views[viewCursor]?.text === ta.value && views[viewCursor]?.signature === signature) return;
    views.splice(viewCursor + 1);
    views.push({ text: ta.value, folds: new Map(folds), signature });
    viewCursor = views.length - 1;
  };
  const readSaved = () => {
    try {
      const data = JSON.parse(localStorage.getItem('nf.folds') || '{}');
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch { return {}; }
  };
  const persist = () => {
    if (!id) return;
    try {
      const data = readSaved();
      data[id] = [...folds.keys()];
      localStorage.setItem('nf.folds', JSON.stringify(data));
    } catch { /* Editing works with disabled/full localStorage. */ }
  };
  const records = () => {
    const used = new Set(), found = [];
    const candidates = [...folds.values()].sort((a, b) => JSON.parse(a.key)[1] - JSON.parse(b.key)[1]);
    for (const line of ta.value.matchAll(/[^\n]+/g)) {
      const rec = candidates.find((r) => !used.has(r.key) && line[0] === r.placeholder);
      if (!rec) continue;
      used.add(rec.key);
      found.push({ ...rec, start: line.index, end: line.index + line[0].length });
    }
    return found;
  };
  const complete = () => {
    let text = ta.value;
    for (const r of records().reverse()) text = text.slice(0, r.start) + r.original + text.slice(r.end);
    return text;
  };
  const rekey = () => {
    const active = records(), seen = new Map();
    folds.clear();
    for (const line of ta.value.matchAll(/[^\n]+/g)) {
      if (!/^\s*#/.test(line[0])) continue;
      const rec = active.find((r) => r.start === line.index);
      const header = rec?.header || line[0];
      const occurrence = seen.get(header) || 0;
      seen.set(header, occurrence + 1);
      if (rec) {
        const key = JSON.stringify([header, occurrence]);
        const updated = { ...rec, key };
        folds.set(key, updated);
        archive.set(key, updated);
      }
    }
  };
  const viewEdit = (s, e, text) => {
    changing = true;
    // View changes are native edits too: undo can recover either representation.
    const active = document.activeElement;
    ta.focus({ preventScroll: true });
    replaceText(ta, s, e, text);
    if (active && active !== ta) active.focus({ preventScroll: true });
    changing = false;
    remember();
  };
  const expand = (selected) => {
    let s = ta.selectionStart, e = ta.selectionEnd;
    const direction = ta.selectionDirection;
    for (const r of selected.slice().reverse()) {
      const map = (p) => p < r.start ? p : p >= r.end ? p + r.original.length - r.placeholder.length
        : r.start + Math.min(p - r.start, r.header.length);
      s = map(s); e = map(e);
      folds.delete(r.key);
      viewEdit(r.start, r.end, r.original);
    }
    ta.setSelectionRange(s, e, direction);
    if (selected.length) { closeAC(); persist(); refresh(); }
  };
  const protect = (type = '') => {
    if (changing) return;
    const s = ta.selectionStart, e = ta.selectionEnd;
    let a = s, b = e;
    if (s === e && /Backward$/.test(type)) a--;
    if (s === e && /Forward$/.test(type)) b++;
    // Word/line deletions can cross more than one character. Expand first, then let
    // the browser calculate its native deletion range on the complete text.
    const broad = /delete(?:Word|SoftLine|HardLine|Entire)/.test(type);
    expand(records().filter((r) => broad || (a <= r.end && b >= r.start)));
  };
  const collapse = (section) => {
    if (!section.body.trim()) return;
    const count = section.body.split(/[,，\n]/).filter((t) => t.trim()).length;
    const placeholder = `${section.header} ⋯ (×${count})`;
    // Leave the separating newline in the view so following headings retain their line.
    const trailing = section.body.endsWith('\n') ? '\n' : '';
    const original = (section.header + section.body).slice(0, trailing ? -1 : undefined);
    const rec = { ...section, original, placeholder };
    folds.set(section.key, rec);
    archive.set(section.key, rec);
    const before = ta.selectionStart, after = ta.selectionEnd;
    const end = section.end - trailing.length;
    viewEdit(section.start, end, placeholder);
    const map = (p) => p <= section.start ? p : p >= end ? p + placeholder.length - original.length
      : section.start + Math.min(p - section.start, section.header.length);
    ta.setSelectionRange(map(before), map(after));
    closeAC(); persist(); refresh();
  };
  const paint = () => {
    const rect = el.getBoundingClientRect();
    const current = records();
    const fullSections = sections(complete());
    const displayedSections = sections(ta.value);
    layer.replaceChildren(...[...hl.querySelectorAll('.hl-comment')].flatMap((span) => {
      const start = Number(span.dataset.lineStart);
      const folded = current.find((r) => r.start === start);
      const display = displayedSections.find((s) => s.start === start);
      // Resolve keys against full text (earlier folded headings have display suffixes).
      const index = displayedSections.indexOf(display);
      const section = fullSections[index];
      if (!folded && !section?.body.trim()) return [];
      const r = span.getClientRects()[0];
      if (!r) return [];
      const label = () => `${folded ? T('展开', 'Expand') : T('折叠', 'Collapse')}: ${(folded || section).header.replace(/^\s*#\s*/, '')}`;
      const button = h('button', {
        type: 'button', class: 'ed-fold-toggle', title: label, 'aria-label': label,
        'aria-expanded': String(!folded), 'aria-controls': ta.id,
      }, folded ? '▸' : '▾');
      button.style.top = r.top - rect.top - el.clientTop + 'px';
      button.style.height = getComputedStyle(ta).lineHeight;
      button.addEventListener('mousedown', (e) => e.preventDefault());
      button.addEventListener('click', () => {
        ta.focus({ preventScroll: true });
        if (folded) expand([folded]);
        else {
          // The section start/end must use display offsets, not full-text offsets.
          collapse({ ...section, start: display.start, end: display.end });
        }
      });
      return [button];
    }));
  };
  return {
    get changing() { return changing; }, complete, paint, protect, remember,
    clear() { folds.clear(); archive.clear(); views.length = 0; viewCursor = -1; persist(); },
    restore() {
      const saved = readSaved()[id];
      if (!Array.isArray(saved)) return;
      for (const s of sections(ta.value).reverse()) if (saved.includes(s.key)) collapse(s);
    },
    format(text) {
      const keys = [...folds.keys()];
      expand(records());
      const s = ta.selectionStart, e = ta.selectionEnd;
      replaceText(ta, 0, ta.value.length, text);
      ta.setSelectionRange(Math.min(s, text.length), Math.min(e, text.length));
      for (const section of sections(ta.value).reverse()) if (keys.includes(section.key)) collapse(section);
    },
    input(event) {
      if (changing) return false;
      // Native undo/redo may restore a folded view; retain its body until setValue.
      if (/^history/.test(event.inputType || '')) {
        folds.clear();
        const step = event.inputType === 'historyUndo' ? -1 : 1;
        let found = -1;
        for (let i = viewCursor + step; i >= 0 && i < views.length; i += step) {
          if (views[i].text === ta.value) { found = i; break; }
        }
        if (found >= 0) {
          viewCursor = found;
          for (const [key, rec] of views[found].folds) folds.set(key, rec);
        } else {
          for (const [key, rec] of archive) if (ta.value.split('\n').includes(rec.placeholder)) folds.set(key, rec);
        }
      }
      rekey();
      if (!/^history/.test(event.inputType || '')) remember();
      persist();
      return true;
    },
  };
}

// Per-editor user heights (nf.edh): { promptEditor, ucEditor, char-prompt, char-uc } → px
const EDH_KEY = 'nf.edh';
let edh = null;
function editorHeights() {
  return (edh ||= readLocalVersioned(EDH_KEY, { version: 1, validate: (d) => !!d && typeof d === 'object' && Object.values(d).every((v) => Number.isFinite(v) && v > 0), fallback: {} }));
}
function saveEditorHeight(key, px) {
  if (!key) return;
  const next = { ...editorHeights() };
  if (px == null) delete next[key];
  else next[key] = px;
  edh = next;
  try { writeLocalVersioned(EDH_KEY, next, { version: 1 }); } catch { /* reported by persist.js */ }
}

export function createEditor(container, { placeholder = '', value = '', onChange, size, id } = {}) {
  container.classList.add('editor');
  if (size) container.classList.add(size);
  const hl = h('div', { class: 'ed-hl', 'aria-hidden': 'true' });
  const ta = h('textarea', { class: 'ed-ta', spellcheck: false, placeholder, rows: 3 });
  ta.id = `nf-editor-${++editorSerial}`;
  container.replaceChildren(hl, ta);
  const ed = { el: container, ta, hl };
  const lifetime = new AbortController();
  const listen = (type, fn) => ta.addEventListener(type, fn, { signal: lifetime.signal });
  let blurTimer = 0;
  let folding;

  // ed.marker(text) → marks for highlight(); ed.onsync() runs after the mirror is rebuilt
  let lastW = 0;
  const sync = () => {
    if (ed.disposed) return;
    hideChunkTip();
    hl.innerHTML = highlight(ta.value, ed.marker ? ed.marker(ta.value) : null);
    paintDelimiters(hl);
    const w = ta.clientWidth;
    if (w !== lastW) hl.style.width = (lastW = w) + 'px';
    hl.scrollTop = ta.scrollTop;
    folding?.paint();
    ed.onsync?.();
  };
  // Only reset to 'auto' (a second forced layout) when the text got shorter.
  let lastLen = 0;
  // A user-sized editor (bottom grip) keeps its height and scrolls inside; otherwise it grows with the text.
  const sizeKey = container.id || (id?.startsWith('char-') ? 'char-' + id.split('-').pop() : '');
  let userH = sizeKey ? editorHeights()[sizeKey] ?? null : null;
  const applyUserH = () => {
    ta.style.maxHeight = userH ? 'none' : '';
    if (userH) ta.style.height = userH + 'px';
  };
  const autosize = () => {
    if (ed.disposed) return;
    if (userH) return applyUserH(), sync();
    const shrink = ta.value.length < lastLen;
    lastLen = ta.value.length;
    if (shrink) {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 2 + 'px';
    } else if (ta.scrollHeight > ta.clientHeight) ta.style.height = ta.scrollHeight + 2 + 'px';
    sync();
  };
  ed.setValue = (v) => {
    if (ed.disposed) return;
    folding.clear();
    ta.value = v ?? '';
    folding.remember();
    lastLen = Infinity;
    autosize();
    ta.dispatchEvent(new Event('nf:set'));
  };
  ed.getValue = () => folding.complete();
  Object.defineProperty(ed, 'value', { get: ed.getValue, set: (v) => ed.setValue(v) });
  ed.focus = () => ta.focus();
  ed.refresh = autosize;
  ed.resync = sync;

  folding = createFolds(ed, id || container.id, autosize);
  const grip = h('div', { class: 'ed-grip', role: 'separator', 'aria-orientation': 'horizontal', tabindex: 0,
    title: () => T('拖动调整高度 · 双击恢复自动', 'Drag to resize · double-click for auto height'), 'aria-label': () => T('编辑框高度', 'Editor height') });
  container.append(grip);
  const setUserH = (px, save) => {
    userH = px == null ? null : Math.round(clamp(px, 48, Math.max(120, innerHeight * 0.85)));
    if (userH == null) {
      ta.style.maxHeight = '';
      lastLen = Infinity;
      autosize();
    } else (applyUserH(), sync());
    container.classList.toggle('sized', userH != null);
    if (save && sizeKey) saveEditorHeight(sizeKey, userH);
  };
  container.classList.toggle('sized', userH != null);
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const y0 = e.clientY, h0 = ta.offsetHeight;
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('ed-resizing');
    const move = (ev) => setUserH(h0 + ev.clientY - y0, false);
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      document.body.classList.remove('ed-resizing');
      if (userH != null) saveEditorHeight(sizeKey, userH);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  }, { signal: lifetime.signal });
  grip.addEventListener('dblclick', () => setUserH(null, true), { signal: lifetime.signal });
  grip.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    setUserH(ta.offsetHeight + (e.key === 'ArrowDown' ? 24 : -24), true);
  }, { signal: lifetime.signal });
  listen('beforeinput', (e) => {
    if (!/^history/.test(e.inputType || '')) folding.protect(e.inputType);
  });
  listen('input', (e) => {
    if (!folding.input(e)) return;
    autosize();
    onChange?.(ed.value);
    queryAC(ed);
  });
  listen('nf:chunks', sync);
  listen('pointermove', (e) => previewChunk(e, hl));
  listen('pointerleave', hideChunkTip);
  attachArtistPeek(ta);
  listen('scroll', () => { hl.scrollTop = ta.scrollTop; folding.paint(); });
  // pasted text goes in as-is (1.7.2: parentheses are part of tags like sunna_(zenless_zone_zero))
  listen('paste', () => folding.protect('insertFromPaste'));
  let formatting = false;
  listen('blur', (e) => {
    clearTimeout(blurTimer);
    blurTimer = setTimeout(closeAC, 120);
    if (formatting || folding.changing || ed.composing || window.__nfPromptFormat === false) return;
    const text = normalizeBlur(ed.value);
    if (text === ed.value) return;
    formatting = true;
    // Normalize complete text, then reapply the same folded headings.
    const nextFocus = e.relatedTarget;
    ta.focus({ preventScroll: true });
    folding.format(text);
    if (nextFocus?.focus) nextFocus.focus({ preventScroll: true });
    else ta.blur();
    formatting = false;
  });
  listen('click', () => {
    if (acState?.ed === ed && acState.mode === 'characters') return; // keep the series → character step
    closeAC();
  });
  listen('compositionstart', () => { ed.composing = true; closeAC(); });
  listen('compositionend', () => { ed.composing = false; queryAC(ed); });
  listen('keydown', (e) => {
    if (e.isComposing || ed.composing || e.keyCode === 229) return;
    if ((e.ctrlKey || e.metaKey) && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '/'].includes(e.key)) {
      e.preventDefault();
      closeAC();
      folding.protect();
      if (e.key === '/') toggleComment(ta);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') moveTag(ta, e.key === 'ArrowLeft' ? -1 : 1);
      else emphasize(ta, e.key === 'ArrowUp' ? 1 : -1);
      return;
    }
    if (acState && acState.ed === ed) {
      if (!currentAC(acState)) closeAC();
      else {
        if (e.key === 'ArrowDown' && !e.ctrlKey && !e.metaKey) return e.preventDefault(), moveAC(1);
        if (e.key === 'ArrowUp' && !e.ctrlKey && !e.metaKey) return e.preventDefault(), moveAC(-1);
        if (acState.items.length && ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab')) return e.preventDefault(), acceptAC();
        if (e.key === 'Escape') return e.preventDefault(), escapeAC();
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') closeAC();
      }
    }
  });
  const observer = new ResizeObserver(sync);
  observer.observe(ta);
  ed.dispose = () => {
    if (ed.disposed) return;
    ed.disposed = true;
    lifetime.abort();
    observer.disconnect();
    clearTimeout(blurTimer);
    cancelAnimationFrame(initialFrame);
    // Cancel artist hover work before the textarea is detached. Its remaining
    // element-local handlers can be collected together with the removed node.
    ta.dispatchEvent(new Event('pointerleave'));
    hideChunkTip();
    delimiterRanges.delete(hl);
    if (globalThis.CSS?.highlights && globalThis.Highlight) {
      for (const kind of delimiterKinds) {
        CSS.highlights.set(`nf-ed-${kind}`, new Highlight(...[...delimiterRanges.values()].flatMap((g) => g.get(kind))));
      }
    }
    if (acState?.ed === ed || document.activeElement === ta) closeAC();
    ed.marker = null;
    ed.onsync = null;
  };

  ta.value = value;
  folding.remember();
  const initialFrame = requestAnimationFrame(() => {
    if (ed.disposed) return;
    lastLen = Infinity;
    folding.restore();
    autosize();
  });
  return ed;
}
