// Pure AI request, response and selectable edit plan. No DOM, store, tag DB or network.
import { segments, editables, planEdits, applyEdits, editKey, findRewrite, promptPosition, applyCharacterEdits, promptArtists, replaceArtists } from './promptedit.js';

export const CATS = ['subject', 'character', 'appearance', 'clothing', 'expression', 'action', 'composition', 'background', 'lighting', 'style', 'other'];
const DB_CAT = { 1: 'style', 3: 'character', 4: 'character' };

export const SYSTEM = `You turn image ideas into prompts for NovelAI Diffusion (V4.5 / V5 anime models trained on Danbooru tags).
Reply with ONE JSON object and nothing else:
{
  "tags": [{"tag": "1girl", "cat": "subject"}],
  "nl": ["Short English sentence"],
  "characters": [{"label": "girl on the left", "tags": ["..."], "position": "left"}],
  "present": ["subject"],
  "missing": ["background"],
  "conflicts": [{"tags": ["long hair", "short hair"], "note": "..."}],
  "remove": ["tag"],
  "replace": [{"from": "exact existing segment", "to": "new tag or sentence", "kind": "tag"}],
  "char_edits": [{"index": 2, "delete": true}, {"index": 1, "remove": [], "replace": [], "add": ["smile"], "position": {"x": 0.3, "y": 0.5}}, {"new": true, "label": "new person", "tags": ["1girl"], "position": {"x": 0.7, "y": 0.5}}],
  "artists": [{"tag": "artist:name", "why": "short reason"}],
  "note": "..."
}
cat is one of: subject, character, appearance, clothing, expression, action, composition, background, lighting, style, other.
Rules:
- Real Danbooru tags only, lowercase, spaces instead of underscores, common spellings with many posts. Prefer tags from the dictionary list when they fit.
- Start with the count tags (1girl, 2girls, 1boy, solo, no humans …).
- Named characters / series as their Danbooru tags (e.g. "hatsune miku", "vocaloid"). Artists as "artist:name" only when the user names one OR explicitly requests artist pairing.
- No quality or rating tags (masterpiece, best quality, nsfw …): the app adds them.
- "nl": 0–2 short English sentences, ONLY for what tags cannot express (who does what to whom, spatial relations, a specific interaction, written text). Never restate tags. When modifying, "nl" is only for a brand-new sentence: a changed version of an existing sentence is a replace, and a replace target is never repeated in "nl".
- "characters": only when 2+ people need different attributes; otherwise [].
- "present" / "missing": which of subject, appearance, clothing, expression, action, composition, background, lighting the prompt covers / still lacks for a complete image.
- Modify/check: "replace" = every existing segment whose content changes, swapped in place. A changed attribute is a tag replace; a sentence whose content changes at all (a scene change, or "three" → "two" people) is ONE replace with kind "nl". "remove" = only segments that are no longer needed at all, with nothing taking their place. Never put an old sentence in "remove" and its new version in "nl" (or an old tag in "remove" and its successor in "tags"): that pair is one replace. "tags" / "nl" = only brand-new content that replaces nothing. Copy "from" and "remove" exactly as the segment appears, same words and final punctuation, but WITHOUT weight syntax or {} / []. Never return a replace whose "to" equals its "from"; a segment that stays is simply not mentioned. Top-level remove/replace apply in base AND ALL characters, including disabled ones; use char_edits for targeted edits.
- "char_edits": index is the provided 1-based character number (including disabled entries), never renumber characters. delete removes that character, not merely its tags. remove/replace/add within an entry affect ONLY that character; replace has the same from/to/kind schema. new:true adds a character with tags and optional label. Respect the model's character limit and position support. Position is {x,y}, both 0.10–0.90 with 0.01 precision, left-to-right / top-to-bottom. Do not move characters unless requested or needed. Return only edits that are needed; the schema above illustrates alternatives, not default output.
- When deleting a character, also fix base count tags, interaction tags such as hetero, and rewrite (replace, kind "nl") sentences that mention that person or the old head count. Example: Base "2girls, 1boy, hetero, The three friends dance in the middle of the street."; Character 1 "1girl, long hair"; Character 2 "1boy, short hair"; Character 3 "1girl, kimono". Request "删掉图中的男人" → {"remove":["1boy","hetero"],"replace":[{"from":"The three friends dance in the middle of the street.","to":"The two girls dance in the middle of the street.","kind":"nl"}],"char_edits":[{"index":2,"delete":true}],"tags":[],"nl":[],"note":"删除角色 2，移除人数及互动标签，句子改为两人。"}. 2girls stays, so it appears in neither remove nor replace. Never delete another character just because a shared tag occurs there.
- With an attached image, character numbers refer to the supplied prompt entries and their declared positions. Use appearance and position together to identify a requested person. AI position means coordinates are not authoritative; if identification is ambiguous, ask for clarification in note instead of guessing a deletion.
- Artist pairing mode: return artists:[{tag:"artist:name",why:"short reason in user language"}] and note only. Propose a small compatible set (2–4), using real artist names; respect kept/rejected choices and feedback from preceding turns. Do not change scene or characters. No quality tags.
- "replace.kind": "tag" for a Danbooru tag, "nl" for a natural-language sentence. Each "to" must be a single tag or sentence.
- Example (modify). Current: "night, city street, She waits at the bus stop." Request: "a beach at noon" → "replace": [{"from": "night", "to": "day", "kind": "tag"}, {"from": "city street", "to": "beach", "kind": "tag"}, {"from": "She waits at the bus stop", "to": "She waits on the sand by the shore", "kind": "nl"}], "tags": [{"tag": "ocean", "cat": "background"}]. A rewritten sentence is ALWAYS a replace of the old one, never a remove plus an addition.
- "conflicts": contradictory tags; include an explicit replace (or a remove, when one side should simply go) resolving each conflict. Never delete both sides just because they conflict.
- Write new: return a complete new prompt; remove/replace must be [].
- When an image is attached, it was generated FROM the current prompt: the prompt is the intent, the image is one attempt. Never rewrite the prompt to describe the image. Compare them (and the request) and suggest minimal edits so the next image matches the intent better: stronger / more specific tags for ignored or weak elements, replace tags the model misread, remove tags that caused unwanted content. Leave everything that came out right unchanged; say in "note" what the image got wrong.
- "note": at most one short sentence, in the user's language.
- 15–35 tags in total for a new idea.`;

export function promptContext(params, model) {
  const modelLine = () => { const m = model; return `Model: ${m.name || m.id}; character limit: ${m.maxChars || 0}; positions supported: ${!!(m.v4 || m.v5)}`; };
  const currentText = () => {
    const P = params;
    return [modelLine(), 'Base prompt:\n' + (params.prompt || ''), ...(P.characters || []).map((c, i) => {
      const p = promptPosition(c) || { x: .5, y: .5 };
      const name = c.label || c.name;
      return `Character ${i + 1}${name ? ` (${name})` : ''} [enabled: ${c.enabled !== false}; position: ${P.aiChoice ? 'AI' : `x ${p.x.toFixed(2)} y ${p.y.toFixed(2)}`}]:\n${c.prompt || ''}`;
    })].join('\n\n');
  };
  return { modelLine: modelLine(), currentText: currentText() };
}

export function buildDictionaryQuery({ mode, merge, desc, params, model }) {
  const { currentText } = promptContext(params, model);
  return mode === 'gen' ? desc + (merge === 'modify' ? '\n' + currentText : '') : currentText;
}

/** Dictionary text and an optional image data URL are supplied by the caller. */
export function buildMessages({ mode = 'gen', merge = 'modify', desc = '', params = {}, model = {}, lang = 'zh', dict = '', attachedImage = null, artistHistory = [], artistSelection = [], splitChars = true } = {}) {
  const modifying = mode !== 'artists' && (mode === 'check' || merge === 'modify');
  const { modelLine, currentText } = promptContext(params, model);
  if (Array.isArray(dict)) dict = dict.length ? '\nDictionary tags found in the text (tag | 中文 | posts):\n' + dict.map((c) => `${c.tag} | ${c.zh || ''} | ${c.count}`).join('\n') : '';
  const user = mode === 'artists'
    ? `Artist pairing. Request: ${desc}\n${currentText}\nKept artists: ${JSON.stringify(artistSelection.filter((a) => a.kept).map((a) => a.tag))}\nRejected artists: ${JSON.stringify(artistSelection.filter((a) => !a.kept).map((a) => a.tag))}\nReturn artists and note only. User language: ${lang === 'zh' ? 'Chinese' : 'English'}${dict}`
    : mode === 'gen'
      ? `${modifying ? 'Modify current prompts' : 'Write a complete new prompt'}. Request: ${desc}\n${modifying ? currentText + '\nChanged segments go in replace (a changed sentence = one replace with kind "nl"); remove is only for segments dropped entirely. Copy from/remove exactly, without weights. tags/nl are ONLY brand-new content that replaces nothing; do not repeat unchanged content or replace targets. Use char_edits to delete/edit/add individual characters or positions; do not return the full characters field.\n' : modelLine + '\n' + (splitChars ? '' : 'Do not use characters.\n')}User language: ${lang === 'zh' ? 'Chinese' : 'English'}${dict}`
      : `Check these prompts. Return actionable edits: replace for segments that should change (a changed sentence = one replace with kind "nl"), remove only for segments to drop entirely; copy from/remove exactly, without weights. tags/nl = only brand-new content that replaces nothing. Use char_edits for targeted character edits and positions; do not return the full characters field.\n${currentText}\nUser language: ${lang === 'zh' ? 'Chinese' : 'English'}${dict}`;
  const content = attachedImage ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: attachedImage } }] : user;
  return [{ role: 'system', content: SYSTEM }, ...(mode === 'artists' ? artistHistory.flat() : []), { role: 'user', content }];
}

export function parsePlanJSON(text, { truncated = false, lang = 'zh' } = {}) {
  const T = (z, e) => lang === 'zh' ? z : e;
  if (typeof text !== 'string') throw new Error(T('模型未返回建议对象，请重试。', 'The model did not return a suggestions object. Please retry.'));
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1];
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0) throw new Error(T('模型返回的不是 JSON', 'The model did not return JSON'));
  if (b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch {}
  }
  const fixed = repairJSON(t.slice(a));
  if (fixed) return fixed;
  if (truncated) throw new Error(T('模型输出被截断，未能读取建议。请重试或关闭深度思考。', 'The output was cut off before suggestions could be read. Retry or disable deep thinking.'));
  throw new Error(T('模型返回的 JSON 不完整（可能被截断），请重试', 'The model returned broken JSON (probably cut off); try again'));
}

// Salvage a truncated JSON object: cut at the last top-level-safe comma and close the open brackets.
export function repairJSON(s) {
  const stack = [];
  const cuts = []; // [index, stackCopy] at each comma outside strings
  let str = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (str) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') (str = false), cuts.push([i + 1, stack.slice()]);
      continue;
    }
    if (ch === '"') str = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length) cuts.push([i + 1, stack.slice()]);
      else {
        try {
          return JSON.parse(s.slice(0, i + 1));
        } catch {
          break;
        }
      }
    } else if (ch === ',') cuts.push([i, stack.slice()]);
  }
  for (let k = cuts.length - 1; k >= 0 && k >= cuts.length - 80; k--) {
    const [i, st] = cuts[k];
    try {
      return JSON.parse(s.slice(0, i) + st.reverse().join(''));
    } catch {}
  }
  return null;
}

function characterEdits(raw, source, { model, snapshot, verify }) {
  if (!Array.isArray(raw)) return [];
  const groups = new Map();
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const c = Number.isInteger(e.index) && e.index > 0 ? source[e.index - 1] : null;
    if (e.new !== true && !c) continue;
    const key = e.new ? Symbol() : e.index;
    const g = groups.get(key) || { index: e.index, id: c?.id, new: e.new === true, label: typeof e.label === 'string' ? e.label : '', first: segments(c?.prompt)[0]?.core || '', on: true, remove: [], replace: [], add: [], deletion: null, position: null };
    const have = new Map(editables(c?.prompt).map((s) => [s.key, s.core]));
    if (!g.new && e.delete === true) g.deletion = { on: true };
    for (const tag of Array.isArray(e.remove) ? e.remove : []) {
      const text = typeof tag === 'string' && have.get(editKey(tag));
      if (text && !g.remove.some((r) => r.text === text)) g.remove.push({ text, on: true });
    }
    for (const r of Array.isArray(e.replace) ? e.replace : []) {
      if (typeof r?.from !== 'string' || typeof r.to !== 'string' || !r.to.trim()) continue;
      const from = have.get(editKey(r.from));
      if (!from || editKey(from) === editKey(r.to) || g.replace.some((p) => editKey(p.from) === editKey(from))) continue;
      // A replacement is one tag or one sentence; malformed multi-tag targets
      // remain unselected rather than bypassing per-tag dictionary validation.
      const v = r.kind === 'nl' ? null : verify(r.to);
      g.replace.push({ from, to: r.to.trim(), v, on: !v || !['unknown', 'checking'].includes(v.st) });
    }
    for (const tag of Array.isArray(g.new ? e.tags : e.add) ? (g.new ? e.tags : e.add) : []) {
      if (typeof tag !== 'string') continue;
      const v = verify(tag);
      if (v && !have.has(editKey(v.tag)) && !g.add.some((t) => editKey(t.v.tag) === editKey(v.tag))) g.add.push({ v, on: !['unknown', 'checking'].includes(v.st) });
    }
    const position = (model.v4 || model.v5) && promptPosition(e.position);
    if (position && (g.new || snapshot.aiChoice || c.x !== position.x || c.y !== position.y)) g.position = { value: position, on: true };
    if (g.deletion || g.position || g.remove.length || g.replace.length || g.add.length) groups.set(key, g);
  }
  return [...groups.values()];
}

/** All matching uses this snapshot, including disabled characters and original numbering.
 * verify(tag) returns {tag, st, ...}; verifyArtist(tag) returns {tag, known}.
 * Items have a stable plan-local id, on, source ranges, and a target document.
 * target.characterId === null identifies the base prompt; additions have an offset.
 */
export function compilePlan(json, { snapshot = {}, model = {}, mode = 'gen', merge = 'modify', splitChars = true, verify = () => null, verifyArtist = () => null, artistSelection = [], lang = 'zh' } = {}) {
  const j = typeof json === 'string' ? parsePlanJSON(json, { lang }) : json;
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error(lang === 'zh' ? '模型未返回建议对象，请重试。' : 'The model did not return a suggestions object. Please retry.');
  snapshot = { ...snapshot, prompt: snapshot.prompt || '', characters: (snapshot.characters || []).map((c) => ({ ...c })) };
  const modifying = mode !== 'artists' && (mode === 'check' || merge === 'modify');
  if (mode === 'artists') return compileArtists(j, snapshot, model, artistSelection, verifyArtist);
  const sourceChars = snapshot.characters || [];
  const have = new Map([snapshot.prompt, ...sourceChars.map((c) => c.prompt)].flatMap((p) => editables(p)).map((s) => [s.key, s.core]));
  const seen = new Set();
  const tags = [];
  for (const x of Array.isArray(j.tags) ? j.tags : []) {
    const raw = typeof x === 'string' ? x : x?.tag;
    const v = verify(raw);
    if (!v) continue;
    const key = editKey(v.tag);
    if (seen.has(key) || (modifying && have.has(key))) continue;
    seen.add(key);
    const cat = CATS.includes(x?.cat) ? x.cat : DB_CAT[v.dbCat] || 'other';
    tags.push({ tag: raw, cat, v, on: !['unknown', 'checking'].includes(v.st) });
  }
  const chars = !modifying && splitChars && Array.isArray(j.characters) && j.characters.length > 1 ? j.characters.filter((c) => c && typeof c === 'object').map((c) => ({ label: String(c.label || ''), tags: (Array.isArray(c.tags) ? c.tags : []).map((tag) => { const v = typeof tag === 'string' && verify(tag); return v ? { v, on: !['unknown', 'checking'].includes(v.st) } : null; }).filter(Boolean), position: promptPosition(c.position) })) : [];
  const replacements = [], claimed = new Set();
  for (const r of modifying && Array.isArray(j.replace) ? j.replace : []) {
    if (typeof r?.from !== 'string' || typeof r.to !== 'string' || !r.to.trim()) continue;
    const key = editKey(r.from);
    if (!have.has(key) || claimed.has(key) || key === editKey(r.to)) continue;
    let to = r.to.trim();
    // Explicit kind is preferred; older endpoints may omit it for sentences.
    const isNL = r.kind === 'nl' || (r.kind !== 'tag' && (/[.!?。！？]$/.test(to) || /[.!?。！？]$/.test(have.get(key))));
    if (!isNL && /[,，]/.test(to)) {
      // "crowd → crowd, silhouette": one swap at most, the other tags become additions
      const list = to.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      for (const extra of list.slice(1)) {
        const v = verify(extra);
        const k2 = v && editKey(v.tag);
        if (!v || seen.has(k2) || have.has(k2)) continue;
        seen.add(k2);
        tags.push({ tag: extra, cat: DB_CAT[v.dbCat] || 'other', v, on: !['unknown', 'checking'].includes(v.st) });
      }
      to = list[0] || '';
      if (!to || editKey(to) === key) continue;
    }
    claimed.add(key);
    const v = isNL ? null : verify(to);
    replacements.push({ from: have.get(key), to, v, on: !v || !['unknown', 'checking'].includes(v.st) });
  }
  const removals = [];
  for (const raw of modifying && Array.isArray(j.remove) ? j.remove : []) {
    if (typeof raw !== 'string') continue;
    const key = editKey(raw);
    if (!have.has(key) || claimed.has(key)) continue;
    claimed.add(key);
    removals.push({ text: have.get(key), on: true });
  }
  // Older endpoints sometimes return only a conflict. Offer each side as a choice,
  // without arbitrarily deciding which attribute the user wants to keep.
  for (const conflict of modifying && Array.isArray(j.conflicts) ? j.conflicts : []) {
    const members = (Array.isArray(conflict?.tags) ? conflict.tags : []).filter((s) => typeof s === 'string');
    if (members.some((s) => claimed.has(editKey(s)))) continue;
    for (const raw of members) {
      const key = editKey(raw);
      if (!have.has(key) || claimed.has(key)) continue;
      claimed.add(key);
      removals.push({ text: have.get(key), on: false });
    }
  }
  // Try the complete sentence before the legacy comma-part fallback, so a rewrite
  // owns the whole old sentence and retracts its paired removal.
  const nlParts = [];
  const removalAt = (key) => removals.findIndex((r) => editKey(r.text) === key);
  for (const s of (Array.isArray(j.nl) ? j.nl : []).filter((x) => typeof x === 'string' && x.trim()).slice(0, 3)) {
    if (modifying && have.has(editKey(s))) continue;
    const available = () => new Set([...claimed].filter((k) => removalAt(k) < 0));
    const wholeHave = new Map([...have].filter(([, text]) => text.includes(',')));
    const whole = modifying ? findRewrite(s, wholeHave, available()) || findRewrite(s, have, available()) : null;
    const kept = [];
    for (const part of whole || !modifying ? [s.trim()] : s.split(',').map((x) => x.trim()).filter(Boolean)) {
      if (modifying && have.has(editKey(part))) continue; // unchanged part of an existing sentence
      const old = whole || (modifying ? findRewrite(part, have, available()) : null);
      if (old) {
        const ri = removalAt(editKey(old));
        if (ri >= 0) removals.splice(ri, 1);
        claimed.add(editKey(old));
        replacements.push({ from: old, to: part, v: null, on: true });
      } else kept.push(part);
    }
    if (kept.length) nlParts.push(kept.join(', '));
  }
  // an addition that is already the target of a replacement would be listed (and counted) twice
  const toKeys = new Set(replacements.map((r) => editKey(r.v?.tag || r.to)));
  const result = {
    tags: tags.filter((t) => !toKeys.has(editKey(t.v.tag))),
    nl: nlParts.map((text) => ({ text, on: true })),
    chars,
    charEdits: modifying ? characterEdits(j.char_edits, sourceChars, { model, snapshot, verify }) : [],
    useChars: chars.length > 1,
    present: Array.isArray(j.present) ? j.present : [],
    missing: Array.isArray(j.missing) ? j.missing : [],
    conflicts: Array.isArray(j.conflicts) ? j.conflicts.filter((c) => c && typeof c === 'object') : [],
    remove: removals,
    replace: replacements,
    modifying,
    note: typeof j.note === 'string' ? j.note : '',
  };
  // Use the execution planner to discard overlaps before showing/counting chips.
  // Keep an operation if it has an effective occurrence in any of its documents.
  const normalize = (group, texts) => {
    const remove = group.remove.map((r) => r.text);
    const replace = group.replace.map((r) => ({ from: r.from, to: r.v?.tag || r.to }));
    const spans = texts.flatMap((text) => planEdits(text, { remove, replace }).spans);
    group.remove = group.remove.filter((_, i) => spans.some((s) => s.kind === 'remove' && s.index === i));
    group.replace = group.replace.filter((_, i) => spans.some((s) => s.kind === 'replace' && s.index === i));
  };
  if (modifying) {
    normalize(result, [snapshot.prompt, ...sourceChars.map((c) => c.prompt)]);
    for (const g of result.charEdits) if (!g.new) normalize(g, [sourceChars.find((c) => c.id === g.id)?.prompt || '']);
  }

  return identifyPlan(result, snapshot, model);
}

function compileArtists(j, snapshot, model, choices, verifyArtist) {
  const previous = new Map(choices.map((a) => [editKey(a.tag), a]));
  const proposals = (Array.isArray(j.artists) ? j.artists : []).map((a) => {
    const v = verifyArtist(a?.tag);
    return v ? { ...v, why: typeof a.why === 'string' ? a.why : '', on: previous.get(editKey(v.tag))?.on ?? v.known } : null;
  }).filter(Boolean);
  const keys = new Set(proposals.map((a) => editKey(a.tag)));
  const all = [...proposals, ...choices.filter((a) => !keys.has(editKey(a.tag))).map((a) => ({ ...a }))];
  const byKey = new Map(all.map((a) => [editKey(a.tag), a]));
  const artists = promptArtists(snapshot.prompt).map((a) => byKey.get(editKey(a.tag)) || { ...a, on: true, existing: true, why: '' });
  const existing = new Set(artists.map((a) => editKey(a.tag)));
  for (const a of all) if (!existing.has(editKey(a.tag))) { artists.push(a); existing.add(editKey(a.tag)); }
  return identifyPlan({ artists, proposalCount: proposals.length, note: typeof j.note === 'string' ? j.note : '', tags: [], nl: [], chars: [], charEdits: [], present: [], missing: [], conflicts: [], remove: [], replace: [] }, snapshot, model);
}

// IDs depend only on the source and plan order, so compiling/applying never consumes randomness.
function identifyPlan(plan, snapshot, model) {
  plan.snapshot = snapshot;
  plan.model = { ...model };
  let serial = 0;
  const reserved = new Set(snapshot.characters.map((c) => c.id));
  const newId = () => { let id; do { id = `ai-character-${++serial}`; } while (reserved.has(id)); reserved.add(id); return id; };
  const documents = [{ characterId: null, text: snapshot.prompt }, ...snapshot.characters.map((c) => ({ characterId: c.id, text: c.prompt }))];
  const target = (characterId) => ({ characterId, offset: (documents.find((d) => d.characterId === characterId)?.text || '').length });
  const mark = (item, id, docs = [], kind = null, characterId = null) => {
    item.id = id;
    item.on = !!item.on;
    item.target = target(characterId);
    item.characterId = characterId;
    item.sources = docs.flatMap((doc) => kind ? planEdits(doc.text, kind === 'remove' ? { remove: [item.text] } : { replace: [{ from: item.from, to: item.v?.tag || item.to }] }).spans.map(({ start, end }) => ({ characterId: doc.characterId, start, end })) : []);
  };
  for (const group of ['tags', 'nl', 'remove', 'replace', 'artists']) for (const [i, item] of (plan[group] || []).entries()) mark(item, `${group}:${i}`, documents, ['remove', 'replace'].includes(group) ? group : null);
  for (const [i, c] of plan.chars.entries()) {
    mark(c, `chars:${i}`, [], null, newId()); c.on = true;
    for (const [j, t] of c.tags.entries()) mark(t, `${c.id}:tags:${j}`, [], null, c.characterId);
  }
  for (const [i, g] of plan.charEdits.entries()) {
    // Separate selection identity from the original character identity.
    g.characterId = g.new ? newId() : g.id;
    g.id = `charEdits:${i}`;
    g.target = target(g.characterId);
    const docs = g.new ? [] : documents.filter((d) => d.characterId === g.characterId);
    for (const group of ['remove', 'replace', 'add']) for (const [j, item] of g[group].entries()) mark(item, `${g.id}:${group}:${j}`, docs, group === 'add' ? null : group, g.characterId);
    for (const key of ['deletion', 'position']) if (g[key]) mark(g[key], `${g.id}:${key}`, [], null, g.characterId);
  }
  return plan;
}

/** Count selected plan operations; the renderer never interprets model JSON. */
export function countPlan(result) {
  if (!result) return { remove: 0, replace: 0, add: 0 };
  const c = {
    remove: result.remove.filter((r) => r.on).length,
    replace: result.replace.filter((r) => r.on).length,
    add: result.tags.filter((t) => t.on).length + result.nl.filter((n) => n.on).length + (result.useChars ? result.chars.filter((c) => c.on).flatMap((c) => c.tags).filter((t) => t.on).length : 0),
  };
  for (const g of result.charEdits || []) {
    if (g.new) { if (g.on && g.add.some((t) => t.on)) c.add++; continue; }
    if (g.deletion?.on) { c.remove++; continue; }
    c.remove += g.remove.filter((r) => r.on).length;
    c.replace += g.replace.filter((r) => r.on).length + (g.position?.on ? 1 : 0);
    c.add += g.add.filter((t) => t.on).length;
  }
  return c;
}

/** Materialize a patch and application notices from the same selected plan. */
export function planOutcome(result, snapshot = result.snapshot, { model = result.model } = {}) {
  const P = snapshot;
  if (result.artists) return { patch: { prompt: replaceArtists(P.prompt, result.artists.filter((a) => a.on).map((a) => a.tag)) }, dropped: 0, skippedNL: false };
  const order = (t) => CATS.indexOf(t.cat);
  const add = result.tags.filter((t) => t.on).sort((a, b) => order(a) - order(b)).map((t) => t.v.tag);
  const v4 = model.v4 || model.v5;
  const nl = v4 ? result.nl.filter((n) => n.on).map((n) => n.text) : [];
  const remove = result.remove.filter((r) => r.on).map((r) => r.text);
  const replace = result.replace.filter((r) => r.on).map((r) => ({ from: r.from, to: r.v?.tag || r.to }));
  const prompt = applyEdits(result.modifying ? P.prompt : '', { remove, replace, add: [...add, ...nl] });
  const patch = result.modifying ? { prompt } : { prompt, characters: [] };
  let dropped = 0;
  const maxChars = model.maxChars || 0;
  if (result.modifying) {
    const edits = result.charEdits.filter((g) => !g.new || g.on).map((g) => ({
      index: g.index, id: g.characterId, new: g.new, label: g.label, delete: !!g.deletion?.on,
      remove: g.remove.filter((r) => r.on).map((r) => r.text),
      replace: g.replace.filter((r) => r.on && (v4 || r.v)).map((r) => ({ from: r.from, to: r.v?.tag || r.to })),
      add: g.add.filter((t) => t.on).map((t) => t.v.tag),
      ...(g.position?.on ? { position: g.position.value } : {}),
    }));
    const applied = applyCharacterEdits(P.characters, edits, { remove, replace, maxChars, supportsPosition: v4, idFactory: (e) => e.id });
    patch.characters = applied.characters;
    if (applied.positionChanged) patch.aiChoice = false;
    dropped = applied.dropped;
  }
  if (result.useChars && result.chars.length > 1) {
    dropped = Math.max(0, result.chars.filter((c) => c.on).length - maxChars);
    patch.characters = result.chars.filter((c) => c.on).slice(0, maxChars).map((c, i) => ({ id: c.characterId, label: c.label, prompt: c.tags.filter((t) => t.on).map((t) => t.v.tag).join(', '), uc: '', x: [0.3, 0.7, 0.5, 0.1, 0.9][i % 5], y: 0.5, ...(v4 && c.position || {}), enabled: true, tab: 'prompt' }));
    patch.aiChoice = !(v4 && result.chars.filter((c) => c.on).slice(0, maxChars).some((c) => c.position));
  }

  return { patch, dropped, skippedNL: !v4 && result.nl.some((n) => n.on) };
}

export function planToPatch(plan, snapshot = plan.snapshot, options = {}) {
  return planOutcome(plan, snapshot, options).patch;
}
