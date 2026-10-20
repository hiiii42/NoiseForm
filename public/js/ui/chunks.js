// Named prompt references. Expansion is deliberately one pass, never recursive.
import { h, icon, uid } from '../util.js';
import { bindCopy, getLang } from '../i18n.js';
import { lookup } from '../tagdb.js';
import { toast } from './modal.js';

const T = (zh, en) => getLang() === 'zh' ? zh : en;
const KEY = 'nf.chunks';
let list = null;
const validName = (name) => !!name && !/[\s,，]/u.test(name);
function clean(rows) {
  if (!Array.isArray(rows)) throw new Error('array');
  const names = new Set();
  return rows.map((row) => {
    if (!row || typeof row.name !== 'string' || typeof row.text !== 'string' || !row.name.trim()) throw new Error('chunk');
    if (names.has(row.name)) throw new Error('duplicate');
    names.add(row.name);
    return { id: uid(), name: row.name, text: row.text };
  });
}
// First run (and the "add examples" button in an empty panel): a few chunks that show the idea.
const examples = () => [
  { name: 'V5质量', text: 'very aesthetic, masterpiece, no text' },
  { name: '水手服', text: 'serafuku, pleated skirt, white shirt, red neckerchief' },
  { name: '画师串', text: 'artist:ningen mame, artist:ciloranko, artist:sho (sho lwlw)' },
  { name: '雨夜城市', text: 'night, rain, city lights, neon lights, reflection, wet' },
].map((r) => ({ id: uid(), ...r }));
// old snippet names may contain spaces / commas, which @name can't reference: make them valid and unique
function fixNames(rows) {
  const used = new Set();
  return rows.map((r) => {
    let base = r.name.trim().replace(/[\s,，]+/gu, '_') || 'chunk';
    let n = base;
    for (let i = 2; used.has(n); i++) n = base + i;
    used.add(n);
    return { ...r, name: n };
  });
}
function load() {
  if (list) return list;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw !== null) {
      const rows = JSON.parse(raw);
      list = clean(rows).map((row, i) => ({ ...row, id: typeof rows[i].id === 'string' ? rows[i].id : row.id }));
    } else {
      const old = localStorage.getItem('nf.snippets');
      list = old === null ? examples() : clean(fixNames(JSON.parse(old)));
      localStorage.setItem(KEY, JSON.stringify(list));
    }
  } catch {
    list = [];
    toast(() => (T('提示词块读取失败，原始数据未改动', 'Could not read chunks; original data was preserved')), 'error');
  }
  return list;
}
function save(next) {
  try { localStorage.setItem(KEY, JSON.stringify(next)); }
  catch { toast(() => (T('保存失败：本地存储不可用或已满', 'Save failed: local storage unavailable or full')), 'error'); return false; }
  list = next;
  document.dispatchEvent(new Event('nf:chunks'));
  return true;
}
export const chunkNames = () => load().map((s) => s.name);
export const findChunk = (name) => {
  const chunk = load().find((s) => s.name === name);
  return chunk ? { ...chunk } : undefined;
};
// Shared lexer for expansion and highlighting; legacy names containing spaces remain usable.
export function chunkReferences(text) {
  const legacy = chunkNames().filter((n) => /\s/u.test(n)).sort((a, b) => b.length - a.length);
  const refs = [];
  const re = /@([^\s,，]+)/gu;
  let m;
  while ((m = re.exec(text))) {
    const old = legacy.find((n) => text.startsWith(n, m.index + 1) && (!text[m.index + 1 + n.length] || /[,，\r\n]/.test(text[m.index + 1 + n.length])));
    const name = old || m[1];
    const end = m.index + 1 + name.length;
    refs.push({ start: m.index, end, name });
    re.lastIndex = end;
  }
  return refs;
}
export function expandChunks(text) {
  let out = '', end = 0;
  for (const ref of chunkReferences(text)) {
    out += text.slice(end, ref.start) + (findChunk(ref.name)?.text ?? text.slice(ref.start, ref.end));
    end = ref.end;
  }
  return out + text.slice(end);
}
export const matchSnippets = (q) => load().filter((s) => (s.name + ' ' + s.text).toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8).map((s) => ({ ...s }));
export const noteUse = () => {}; // compatibility; chunks have no usage ranking
export const glossOf = (text) => text.split(',').map((s) => lookup(s.replace(/^\s*artist:/i, ''))?.zh || '').filter(Boolean).slice(0, 4).join('·');

let lastTa = null;
document.addEventListener('focusin', (e) => { if (e.target.classList?.contains('ed-ta')) lastTa = e.target; });
const target = () => lastTa?.isConnected ? lastTa : document.querySelector('#promptEditor textarea');
export function insertText(ta, text) {
  if (!ta) return;
  text = text.trim().replace(/^,+|,+$/g, '').trim();
  const v = ta.value, s = ta.selectionStart ?? v.length, e = ta.selectionEnd ?? v.length;
  const before = v.slice(0, s).replace(/\s+$/, ''), after = v.slice(e).replace(/^\s+/, '');
  const pre = before ? (/[,\n]$/.test(before) ? ' ' : ', ') : '';
  const post = after ? (/^[,\n]/.test(after) ? '' : ', ') : '';
  ta.value = before + pre + text + post + after;
  const caret = (before + pre + text).length;
  ta.focus();
  ta.setSelectionRange(caret, caret);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

let pop = null, anchorEl = null, commitDraft = null, readDraft = null, pendingDraft = null;
export function toggleChunks(anchor) {
  if (pop) return closeChunks();
  const ta = target();
  const selection = ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : '';
  let selected = selection ? null : pendingDraft ? pendingDraft.id : load()[0]?.id;
  const name = h('input', { class: 'inp', 'aria-label': () => (T('块名称', 'Chunk name')), placeholder: () => (T('名称（不含空格或逗号）', 'Name (no spaces or commas)')) });
  const body = h('textarea', { class: 'inp mono chunk-text', rows: 7, 'aria-label': () => (T('块内容', 'Chunk text')), placeholder: () => (T('提示词内容', 'Prompt text')) });
  const status = h('small', { class: 'chunk-status', role: 'status' });
  const rows = h('div', { class: 'chunk-list', 'aria-label': () => (T('提示词块列表', 'Prompt chunks')) });
  const persist = (redraw = true) => {
    if (!name.value && !body.value && !selected) return true;
    const nm = name.value.trim();
    const current = load().find((s) => s.id === selected);
    if ((!validName(nm) && nm !== current?.name) || !nm || load().some((s) => s.name === nm && s.id !== selected)) {
      bindCopy(status, 'textContent', () => (T('名称不能为空、重复，或含空格 / 逗号', 'Use a unique name without spaces or commas')));
      name.setAttribute('aria-invalid', 'true');
      return false;
    }
    const row = { id: selected || uid(), name: nm, text: body.value };
    const next = current ? load().map((s) => s.id === selected ? row : s) : [...load(), row];
    if (!save(next)) return false;
    selected = row.id;
    name.removeAttribute('aria-invalid');
    bindCopy(status, 'textContent', () => (T('已自动保存', 'Saved automatically')));
    if (redraw) paintList();
    return true;
  };
  const paintList = () => rows.replaceChildren(...(load().length ? load().map((s) => h('button', {
    class: 'chunk-row' + (s.id === selected ? ' on' : ''), type: 'button', 'aria-pressed': s.id === selected ? 'true' : 'false',
    onclick: () => { if (persist()) { selected = s.id; fill(); } },
  }, h('span', {}, s.name), h('small', {}, s.text.replace(/\s+/g, ' ')))) : [h('p', { class: 'hint' }, () => (T('还没有提示词块', 'No chunks yet'))), h('button', { class: 'btn sm', type: 'button', onclick: () => { if (save(examples())) { selected = load()[0]?.id; fill(); } } }, () => (T('添加示例', 'Add examples')))]));
  const fill = () => {
    const s = load().find((s) => s.id === selected);
    name.value = s?.name || ''; body.value = s?.text || '';
    bindCopy(status, 'textContent', () => (T('编辑后自动保存 · 输入 @名称 引用', 'Edits save automatically · Reference with @name')));
    name.removeAttribute('aria-invalid'); paintList();
  };
  const changed = () => { persist(false); setTimeout(() => { if (rows.isConnected) paintList(); }, 0); };
  name.addEventListener('change', changed);
  body.addEventListener('change', changed);
  const button = (label, glyph, fn) => h('button', { class: 'btn sm sq ghost', title: label, 'aria-label': label, onclick: fn }, icon(glyph));
  const importer = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  importer.onchange = async () => {
    try {
      if (!importer.files[0] || !persist()) return;
      const imported = clean(JSON.parse(await importer.files[0].text()));
      if (imported.some((s) => /[,，\r\n]/u.test(s.name))) throw new Error('name');
      const next = [...load()];
      for (const row of imported) {
        const base = row.name; let n = 2;
        while (next.some((s) => s.name === row.name)) row.name = base + '-' + n++;
        next.push(row);
      }
      if (save(next)) { selected = imported[0]?.id || selected; fill(); }
    } catch { toast(() => (T('导入失败：需要包含 name、text 的 JSON 数组，且名称唯一', 'Import failed: expected a JSON array with unique names and text')), 'error'); }
    finally { importer.value = ''; }
  };
  pop = h('div', { class: 'snip-pop chunk-pop', role: 'dialog', 'aria-label': () => (T('提示词块', 'Prompt chunks')) },
    h('header', {}, h('span', { class: 'st-t' }, () => (T('提示词块', 'Prompt chunks'))), button(() => (T('关闭', 'Close')), 'close', () => closeChunks())),
    h('div', { class: 'chunk-layout' }, rows, h('div', { class: 'chunk-form' },
      h('label', {}, () => (T('名称', 'Name')), name), h('label', {}, () => (T('内容', 'Text')), body), status,
      h('footer', {},
        h('button', { class: 'btn sm', onclick: () => { if (persist()) { selected = null; fill(); name.focus(); } } }, () => (T('新增', 'New'))),
        h('button', { class: 'btn sm solid', disabled: !ta, onclick: () => { if (persist() && selected) { insertText(ta, '@' + name.value.trim()); closeChunks(); } } }, () => (T('插入', 'Insert'))),
        button(() => (T('删除', 'Delete')), 'trash', () => { if (selected && save(load().filter((s) => s.id !== selected))) { selected = load()[0]?.id; fill(); } }),
        button(() => (T('导入 JSON', 'Import JSON')), 'upload', () => importer.click()),
        button(() => (T('导出 JSON', 'Export JSON')), 'download', () => {
          if (!persist()) return;
          const url = URL.createObjectURL(new Blob([JSON.stringify(load(), null, 2)], { type: 'application/json' }));
          const a = h('a', { href: url, download: 'noiseform-chunks.json' }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        }), importer))));
  fill();
  if (selection) body.value = selection;
  else if (pendingDraft) { name.value = pendingDraft.name; body.value = pendingDraft.text; }
  pendingDraft = null;
  readDraft = () => ({ id: selected, name: name.value, text: body.value });
  commitDraft = persist; anchorEl = anchor;
  document.body.append(pop);
  const r = anchor?.getBoundingClientRect() || { left: 8, bottom: 8 };
  pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.left)) + 'px';
  pop.style.top = Math.max(8, Math.min(innerHeight - pop.offsetHeight - 8, r.bottom + 6)) + 'px';
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', onKey, true);
}
function outside(e) { if (pop && !pop.contains(e.target) && !anchorEl?.contains(e.target)) closeChunks(); }
function onKey(e) { if (e.key === 'Escape' && pop) { e.stopPropagation(); closeChunks(); } }
export function closeChunks() {
  if (commitDraft) pendingDraft = commitDraft() ? null : readDraft();
  pop?.remove(); pop = null; anchorEl = null; commitDraft = null; readDraft = null;
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('keydown', onKey, true);
}
window.addEventListener('storage', (e) => {
  if (e.key === KEY || e.key === null) { list = null; document.dispatchEvent(new Event('nf:chunks')); }
});
