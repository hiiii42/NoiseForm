// Pure prompt edits. Offsets/line endings and protected lines survive unchanged edits.
const special = (line) => /^\s*(?:#|---\s*$)/.test(line);
// Sentences (3+ words) match with or without their final punctuation; short tags such as "!?" keep it.
export const editKey = (text) => {
  const key = unwrap(String(text).trim()).core.toLowerCase().replace(/[_\s]+/g, ' ').trim();
  return /\s\S+\s/.test(key) ? key.replace(/\s*[.!?。！？]+$/, '') : key;
};
const TERMINAL = /[.!?。！？]["'”’)\]]?$/;
const MAX_SPAN = 6;

function unwrap(text) {
  let core = text, before = '', after = '';
  for (;;) {
    // After peeling an outer group, its body may contain several sibling groups.
    if (parts(core).length !== 1) break;
    const m = core.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+)::)([\s\S]*)::$/);
    const bracket = (core.startsWith('{') && core.endsWith('}')) || (core.startsWith('[') && core.endsWith(']'));
    if (!m && !bracket) break;
    before += m ? m[1] : core[0];
    after = (m ? '::' : core.at(-1)) + after;
    core = (m ? m[2] : core.slice(1, -1)).trim();
  }
  return { core, before, after };
}

// Split only outside complete wrappers; recurse inside them to expose each tag.
function parts(text) {
  const out = [], stack = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    const weight = text.slice(i).match(/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)::/);
    if (weight && (i === 0 || /[\s,{\[]/.test(text[i - 1]))) {
      stack.push('::'); i += weight[0].length - 1;
    } else if (text.slice(i, i + 2) === '::' && stack.at(-1) === '::') { stack.pop(); i++; }
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === stack.at(-1)) stack.pop();
    else if (c === ',' && !stack.length) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out;
}

function leaves(text) {
  return parts(text).flatMap((part) => {
    const { core, before } = unwrap(part.trim());
    if (!core) return [];
    if (before) return leaves(core);
    return [{ text: part.trim(), core, key: editKey(core) }];
  });
}

/** Editable comma/newline segments; comments and divider lines are excluded. */
export function segments(text) {
  return String(text || '').split(/\r\n|\n|\r/).flatMap((line, i) => special(line) ? [] : leaves(line).map((s) => ({ ...s, line: i })));
}

// A sentence that itself contains commas ("They dance on a path, the boy in the center.") is split into
// several segments; expose each such run as one more editable unit so an edit can name the whole sentence.
// Sentence-like only: starts capitalised or with 4+ words, ends with terminal punctuation, and no earlier
// part ends a sentence. Tag runs ("rural, farm, rice paddy") are never offered.
function sentenceSpans(text) {
  const ps = parts(text).map((p) => p.trim());
  const out = [];
  for (let i = 0; i < ps.length; i++) {
    const first = ps[i];
    if (!first || TERMINAL.test(first) || !(/^[A-Z]/.test(first) || first.split(/\s+/).length >= 4)) continue;
    for (let len = 2; len <= MAX_SPAN && i + len <= ps.length; len++) {
      const last = ps[i + len - 1];
      if (!last) break;
      if (TERMINAL.test(last)) {
        const core = ps.slice(i, i + len).join(', ');
        out.push({ text: core, core, key: editKey(core) });
        break;
      }
    }
  }
  for (const p of ps) {
    const { core, before } = unwrap(p);
    if (before && core) out.push(...sentenceSpans(core));
  }
  return out;
}

/** segments() plus whole comma-containing sentences: what remove / replace "from" may name. */
export function editables(text) {
  return String(text || '').split(/\r\n|\n|\r/).flatMap((line, i) => special(line) ? [] : [...leaves(line), ...sentenceSpans(line)].map((s) => ({ ...s, line: i })));
}

/** Compile against original source ranges. Whole replacements win; a partial replacement
 * cancels an enclosing deletion. For the same single tag, explicit removal still wins. */
export function planEdits(text, { remove = [], replace = [] } = {}) {
  const removed = new Map(remove.map((s, i) => [editKey(s), i]));
  const swaps = new Map(replace.flatMap((r, i) => r && typeof r.from === 'string' && typeof r.to === 'string' ? [[editKey(r.from), i]] : []));
  const candidates = [];
  const offer = (key, start, end) => {
    if (!key) return;
    const whole = key.includes(',');
    if (swaps.has(key) && (whole || !removed.has(key))) candidates.push({ kind: 'replace', index: swaps.get(key), start, end });
    if (removed.has(key)) candidates.push({ kind: 'remove', index: removed.get(key), start, end });
  };
  const walk = (src, offset) => {
    let at = offset;
    const ps = parts(src).map((part) => {
      const trimmed = part.trim();
      const item = { trimmed, start: at + part.indexOf(trimmed), end: at + part.trimEnd().length };
      at += part.length + 1;
      return item;
    });
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (!p.trimmed) continue;
      const { core, before } = unwrap(p.trimmed);
      offer(editKey(core), p.start, p.end);
      if (before && core) walk(core, p.start + p.trimmed.indexOf(core, before.length));
      for (let len = 2; len <= MAX_SPAN && i + len <= ps.length; len++) {
        const run = ps.slice(i, i + len);
        if (run.some((x) => !x.trimmed)) break;
        offer(editKey(run.map((x) => x.trimmed).join(', ')), p.start, run.at(-1).end);
      }
    }
  };
  let offset = 0;
  for (const line of String(text || '').split(/(\r\n|\n|\r)/)) {
    if (!special(line)) walk(line, offset);
    offset += line.length;
  }
  // A longer replacement owns its entire range, independent of response order.
  candidates.sort((a, b) => Number(b.kind === 'replace') - Number(a.kind === 'replace') || (b.end - b.start) - (a.end - a.start));
  const spans = [];
  for (const c of candidates) if (!spans.some((s) => c.start < s.end && s.start < c.end)) spans.push(c);
  return {
    spans,
    remove: remove.filter((_, i) => spans.some((s) => s.kind === 'remove' && s.index === i)),
    replace: replace.filter((_, i) => spans.some((s) => s.kind === 'replace' && s.index === i)),
  };
}

/** Replacements match original ranges without cascading; preview can use the same plan. */
export function applyEdits(text, { remove = [], replace = [], add = [] } = {}) {
  const { spans } = planEdits(text, { remove, replace });
  const edit = (src, offset) => {
    let changed = false;
    const ps = parts(src);
    const starts = [];
    let at = offset;
    for (const p of ps) { starts.push(at); at += p.length + 1; }
    const operation = (i, len = 1) => spans.find((s) => s.start === starts[i] + ps[i].indexOf(ps[i].trim()) && s.end === starts[i + len - 1] + ps[i + len - 1].trimEnd().length);
    const target = (op) => op.kind === 'remove' ? '' : replace[op.index].to.trim();
    const kept = [];
    for (let i = 0; i < ps.length; i++) {
      // a removed / replaced run of comma parts (one sentence that contains commas), longest first
      let run = 0;
      for (let len = Math.min(MAX_SPAN, ps.length - i); len >= 2 && !run; len--) {
        const op = operation(i, len);
        if (op) { run = len; if (target(op)) kept.push(target(op)); }
      }
      if (run) { changed = true; i += run - 1; continue; }
      kept.push(one(ps[i], i));
    }
    function one(part, i) {
      const trimmed = part.trim();
      if (!trimmed) return part;
      const { core, before, after } = unwrap(trimmed);
      const op = operation(i);
      if (op) {
        changed = true;
        return target(op) ? before + target(op) + after : null;
      }
      if (before) {
        const inner = edit(core, starts[i] + part.indexOf(trimmed) + trimmed.indexOf(core, before.length));
        if (inner !== core) { changed = true; return inner.trim() ? before + inner.trim() + after : null; }
      }
      return part;
    }
    if (!changed) return src;
    const body = kept.filter((p) => p != null).map((p) => p.trim()).filter(Boolean).join(', ');
    return body ? (src.match(/^\s*/)?.[0] || '') + body : '';
  };
  const lines = String(text || '').split(/(\r\n|\n|\r)/);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const original = lines[i];
    if (i % 2 === 0 && !special(original)) lines[i] = edit(original, offset);
    offset += original.length;
  }
  let out = lines.join('');
  const have = new Set(segments(out).map((s) => s.key));
  const additions = [];
  const dedupe = (src) => parts(src).map((part) => {
    const tag = part.trim(), { core, before, after } = unwrap(tag);
    if (!tag) return '';
    if (before) {
      const inner = dedupe(core);
      return inner ? before + inner + after : '';
    }
    const key = editKey(core);
    if (!key || have.has(key)) return '';
    have.add(key);
    return tag;
  }).filter(Boolean).join(', ');
  for (const value of add) {
    if (typeof value !== 'string') continue;
    const clean = dedupe(value);
    if (clean) additions.push(clean);
  }
  if (!additions.length) return out;
  const newline = out.match(/\r\n|\n|\r/)?.[0] || '\n';
  let at = lines.length - 1;
  // keep a trailing artist-only line last: additions go to the content line above it
  const artistOnly = (line) => { const s = leaves(line); return s.length > 0 && s.every((x) => /^artist:/i.test(x.core)); };
  let li = lines.length - 1;
  while (li > 0 && !lines[li].trim()) li -= 2;
  if (li >= 0 && !special(lines[li]) && artistOnly(lines[li])) {
    let k = li - 2;
    while (k >= 0 && !lines[k].trim()) k -= 2;
    if (k >= 0 && !special(lines[k]) && !artistOnly(lines[k])) at = k;
  }
  const last = lines[at];
  if (special(last)) return out + newline + additions.join(', ');
  lines[at] = last.trimEnd().replace(/,\s*$/, '') + (last.trim().replace(/,\s*$/, '') ? ', ' : '') + additions.join(', ');
  return lines.join('');
}

// the existing sentence segment a new sentence rewrites: ≥ 2 shared content words, overlap ≥ 1/3
const STOP = new Set('a an the in on at of to and with by for from into onto over under between is are was were be her his their its this that while as'.split(' '));
const content = (s) => new Set((String(s).toLowerCase().match(/[a-z']+/g) || []).filter((w) => !STOP.has(w)));
/** The existing sentence segment (value of `have`, a key → text map) that `sentence` rewrites, or null. */
export function findRewrite(sentence, have, claimed = new Set()) {
  const A = content(sentence);
  let best = null;
  let score = 0;
  for (const [key, text] of have) {
    if (claimed.has(key) || text.trim().split(/\s+/).length < 4) continue;
    const B = content(text);
    let n = 0;
    for (const w of A) if (B.has(w)) n++;
    const jac = n / Math.max(1, A.size + B.size - n);
    if (n >= 2 && jac >= 0.3 && jac > score) (best = text), (score = jac);
  }
  return best;
}

/** Shared UI coordinates; older model snapping happens at request serialization. */
export function promptPosition(value) {
  if (typeof value === 'string') {
    const positions = { left: [.3, .5], center: [.5, .5], middle: [.5, .5], right: [.7, .5], top: [.5, .3], bottom: [.5, .7] };
    const pair = positions[value.toLowerCase()];
    return pair ? { x: pair[0], y: pair[1] } : null;
  }
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
  const clamp = (n) => Math.round(Math.max(.1, Math.min(.9, n)) * 100) / 100;
  return { x: clamp(value.x), y: clamp(value.y) };
}

/** Indices refer to the original list, never to the list after preceding deletions. */
export function applyCharacterEdits(characters = [], edits = [], { remove = [], replace = [], maxChars = Infinity, supportsPosition = true, idFactory = (/** @type {any} */ _edit) => Math.random().toString(36).slice(2) } = {}) {
  let positionChanged = false, dropped = 0;
  const next = characters.flatMap((c, i) => {
    const own = edits.filter((e) => !e.new && (e.id != null ? e.id === c.id : e.index === i + 1));
    if (own.some((e) => e.delete)) return [];
    let prompt = applyEdits(c.prompt, { remove, replace });
    let position = null;
    for (const e of own) {
      prompt = applyEdits(prompt, e);
      position = (supportsPosition && promptPosition(e.position)) || position;
    }
    if (position) positionChanged = true;
    return [{ ...c, prompt, ...position }];
  });
  for (const e of edits.filter((e) => e.new)) {
    const prompt = applyEdits('', { add: e.tags || e.add || [] });
    if (!prompt.trim()) continue;
    if (next.length >= maxChars) { dropped++; continue; }
    const position = supportsPosition && promptPosition(e.position);
    if (position) positionChanged = true;
    next.push({ id: idFactory(e), label: e.label || '', prompt, uc: '', enabled: true, tab: 'prompt', x: .5, y: .5, ...position });
  }
  return { characters: next, positionChanged, dropped };
}

/** Retain inherited weight syntax when showing existing artists as individual choices. */
export function promptArtists(text) {
  const out = [], seen = new Set();
  const walk = (src, prefix = '', suffix = '') => {
    for (const p of parts(src)) {
      const { core, before, after } = unwrap(p.trim());
      if (before) walk(core, prefix + before, after + suffix);
      else if (/^artist:\s*\S/i.test(core) && !seen.has(editKey(core))) {
        seen.add(editKey(core));
        out.push({ tag: core, text: prefix + core + suffix });
      }
    }
  };
  for (const line of String(text || '').split(/\r\n|\n|\r/)) if (!special(line)) walk(line);
  return out;
}

/** Replace only active artist tags, at the first artist's location (or a new last line, the
 *  app's artist-line convention, see applyEdits); preserve other weights. */
export function replaceArtists(text, selected = []) {
  text = String(text || '');
  const existing = promptArtists(text), originals = new Map(existing.map((a) => [editKey(a.tag), a.text]));
  const seen = new Set(), chosen = [];
  for (const value of selected) {
    if (typeof value !== 'string') continue;
    const key = editKey(value);
    if (!/^artist:\s*\S/.test(key) || seen.has(key)) continue;
    seen.add(key);
    chosen.push(originals.get(key) || value.trim());
  }
  if (existing.length === chosen.length && existing.every((a, i) => editKey(a.tag) === editKey(chosen[i]))) return text;
  if (!existing.length) return chosen.length ? (text.trim() ? text.replace(/[\s,]+$/, '') + '\n' : '') + chosen.join(', ') : text;
  // A slot bubbles out of enclosing weights so a new artist cannot inherit an old
  // artist's weight. Splitting a mixed weighted group preserves its non-artist tags.
  let placed = false;
  const walk = (src) => parts(src).flatMap((part) => {
    const { core, before, after } = unwrap(part.trim());
    if (before) {
      const inner = walk(core), chunks = [], run = [];
      const flush = () => { if (run.length) chunks.push(before + run.splice(0).join(', ') + after); };
      for (const item of inner) {
        if (item === null) { flush(); chunks.push(null); } else if (item) run.push(item);
      }
      flush();
      return chunks;
    }
    if (/^artist:\s*\S/i.test(core)) {
      if (!placed) { placed = true; return [null]; }
      return [];
    }
    return core ? [part.trim()] : [];
  });
  const lines = text.split(/(\r\n|\n|\r)/);
  for (let i = 0; i < lines.length; i += 2) {
    if (special(lines[i]) || !segments(lines[i]).some((s) => /^artist:/i.test(s.core))) continue;
    lines[i] = walk(lines[i]).flatMap((s) => s === null ? chosen : [s]).join(', ');
  }
  return lines.join('');
}
