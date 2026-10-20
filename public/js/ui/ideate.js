// The model proposes selectable edits; dictionary/NovelAI vocabulary verifies tag targets.
import { h, icon } from '../util.js';
import { state } from '../store.js';
import { bindCopy, t, getLang } from '../i18n.js';
import { modelById } from '../data.js';
import { openModal, toast } from './modal.js';
import { chatEx, llmReady } from '../llm.js';
import { loadTagDB, tagDBReady, lookup, aliasOf, suggest, pretty, naiKnown, canVerify, verifyNAI, termsIn } from '../tagdb.js';
import { effectiveModel } from './panel.js';
import { attachPeekTo, siteUrl } from './artistpeek.js';
import { promptPosition } from '../promptedit.js';
import { CATS, buildMessages, buildDictionaryQuery, parsePlanJSON, compilePlan, countPlan, planOutcome, planToPatch } from '../aiplan.js';

const T = (z, e) => (getLang() === 'zh' ? z : e);
const CAT_L = {
  subject: ['主体', 'Subject'],
  character: ['角色 / 作品', 'Character'],
  appearance: ['外貌', 'Appearance'],
  clothing: ['服装', 'Clothing'],
  expression: ['表情', 'Expression'],
  action: ['动作姿势', 'Pose / action'],
  composition: ['构图视角', 'Composition'],
  background: ['背景场景', 'Background'],
  lighting: ['光照氛围', 'Lighting'],
  style: ['画风', 'Style'],
  other: ['其他', 'Other'],
};
const FACETS = ['subject', 'appearance', 'clothing', 'expression', 'action', 'composition', 'background', 'lighting'];
const catL = (c) => (CAT_L[c] || CAT_L.other)[getLang() === 'zh' ? 0 : 1];
const positionLabel = (p) => p ? `${Math.round(p.x * 100)}·${Math.round(p.y * 100)}` : '';

let lastText = '';

let lastAttach = false;
// In-memory only, shared across dialog openings; never persist image data or API keys.
let artistHistory = [], artistChoices = null;

async function imageData(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, 768 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally { bitmap.close(); }
}

export function openIdeate({ apply, currentImage }) {
  if (!tagDBReady()) loadTagDB().catch(() => {});
  let mode = 'gen';
  const curPrompt = () => state.params.prompt || '';
  const enabledChars = () => (state.params.characters || []).filter((c) => c.enabled !== false);
  // What the user sees in 「检查」: just the prompts, numbered like the panel (C1 …), with position.
  const shownText = () => {
    const P = state.params;
    return [curPrompt(), ...(P.characters || []).map((c, i) => {
      const p = promptPosition(c) || { x: .5, y: .5 };
      return `C${i + 1}${c.enabled === false ? T('（停用）', ' (off)') : ''} · ${P.aiChoice ? 'AI' : positionLabel(p)}\n${c.prompt || ''}`;
    })].filter((s) => s.trim()).join('\n\n');
  };
  const hasPrompt = () => [curPrompt(), ...enabledChars().map((c) => c.prompt)].some((p) => p?.trim());
  let merge = hasPrompt() ? 'modify' : 'new';
  let splitChars = true;
  let result = null;
  let busy = false;
  let closed = false;
  let image = null;

  const ta = h('textarea', { class: 'inp ide-ta', rows: 3, placeholder: () => T('描述画面，或说想怎么改：换成农村场景 / 让她穿和服 / 更有电影感', 'Describe a scene or ask for a change: countryside / a kimono / more cinematic') });
  ta.value = lastText;
  const status = h('p', { class: 'ide-status', 'aria-live': 'polite' });
  const out = h('div', { class: 'ide-out' });
  const insertBtn = h('button', { class: 'btn solid ide-apply', disabled: true }, () => T('应用', 'Apply'));
  const runBtn = h('button', { class: 'btn solid ide-run' }, icon('sparkle'), () => T('提建议', 'Suggest'));
  const segBtn = (opts, cur, onPick) => {
    const el = h('div', { class: 'seg' });
    const paint = (v) => el.replaceChildren(...opts.map(([val, label, title]) => h('button', { class: val === v ? 'on' : '', 'aria-pressed': String(val === v), disabled: busy, title: title || '', onclick: () => { if (!busy) { onPick(val); paint(val); } } }, label)));
    paint(cur);
    return el;
  };
  const splitToggle = (() => {
    const ck = h('input', { type: 'checkbox', checked: splitChars });
    ck.onchange = () => (splitChars = ck.checked);
    return h('label', { class: 'tgl ide-split', hidden: merge !== 'new' }, ck, h('span', { class: 'sw' }), h('span', { class: 'cn' }, () => T('多人时拆到角色', 'Split characters')));
  })();
  const attachCheck = h('input', { type: 'checkbox', checked: lastAttach, onchange: () => (lastAttach = attachCheck.checked) });
  const attachToggle = h('label', { class: 'tgl ide-attach', hidden: true }, attachCheck, h('span', { class: 'sw' }), h('span', { class: 'cn' }, () => T('附带当前图片', 'Attach current image')));
  const genBox = h(
    'div',
    { class: 'ide-gen' },
    ta,
    h(
      'div',
      { class: 'row wrap gap' },
      segBtn([['modify', () => T('修改当前', 'Modify current')], ['new', () => T('重新写', 'Write new')]], merge, (v) => { merge = v; splitToggle.hidden = v !== 'new'; result = null; paint(); }),
      splitToggle,
      h('span', { class: 'sp' }),
      runBtn
    )
  );
  const checkBtn = h('button', { class: 'btn solid ide-check' }, icon('check'), () => (T('检查', 'Check')));
  const checkBox = h('div', { class: 'ide-gen', hidden: true }, h('p', { class: 'ide-cur mono' }), h('div', { class: 'row' }, h('span', { class: 'sp' }), checkBtn));
  const artistInput = h('textarea', { class: 'inp ide-artist-input', rows: 2, placeholder: () => T('想要什么画风？例如：更厚涂、饱和度低一点', 'Desired style? e.g. more painterly, less saturated') });
  const artistRun = h('button', { class: 'btn solid ide-artist-run', onclick: () => run() }, () => artistHistory.length ? T('再调', 'Refine') : T('搭配', 'Suggest'));
  const artistReset = h('button', { class: 'btn ide-artist-reset', onclick: () => {
    if (busy) return;
    artistHistory = []; artistChoices = null; artistInput.value = '';
    result = artistResult(); paint(); bindCopy(status, 'textContent', () => '');
  } }, () => T('重新开始', 'Start over'));
  const artistBox = h('div', { class: 'ide-gen ide-artists-box', hidden: true }, artistInput, h('div', { class: 'row gap' }, artistReset, h('span', { class: 'sp' }), artistRun));
  const modeSeg = segBtn([['gen', () => T('提需求', 'Ask')], ['check', () => (T('检查当前提示词', 'Check my prompt'))], ['artists', () => T('搭画师', 'Pair artists')]], mode, (v) => {
    mode = v;
    genBox.hidden = v !== 'gen';
    checkBox.hidden = v !== 'check';
    artistBox.hidden = v !== 'artists';
    bindCopy(checkBox.querySelector('.ide-cur'), 'textContent', () => hasPrompt() ? shownText() : T('（提示词是空的）', '(the prompt is empty)'));
    result = v === 'artists' ? artistResult() : null;
    status.className = 'ide-status';
    bindCopy(status, 'textContent', () => '');
    paint();
  });

  function artistResult(proposals = null) {
    const plan = compilePlan({ artists: proposals || [] }, { mode: 'artists', snapshot: state.params, model: modelById(state.params.model), artistSelection: proposals === null ? (artistChoices || []) : proposals, verifyArtist });
    artistChoices = plan.artists;
    return plan;
  }
  function verifyArtist(raw) {
    if (typeof raw !== 'string') return null;
    const name = raw.trim().replace(/^artist:\s*/i, '');
    if (!name || /[,\n\r]/.test(name)) return null;
    const e = lookup(name) || aliasOf(name);
    return { tag: 'artist:' + (e?.cat === 1 ? pretty(e.tag) : name), known: e?.cat === 1 };
  }

  // ---------------------------------------------------------------- verification
  const pending = new Set();
  function verify(tag) {
    let t = String(tag || '').trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
    if (!t) return null;
    const art = t.startsWith('artist:');
    const name = art ? t.slice(7).trim() : t;
    const pre = art ? 'artist:' : '';
    const e = lookup(name);
    if (e) return { tag: pre + pretty(e.tag), st: e.count < 100 ? 'rare' : 'ok', count: e.count, zh: e.zh, dbCat: e.cat };
    const nv = naiKnown(name);
    if (nv > 0) return { tag: t, st: 'nai', count: nv };
    const a = aliasOf(name);
    if (nv === undefined && canVerify(name)) pending.add(name);
    if (a) return { tag: pre + pretty(a.tag), st: 'alias', from: t, count: a.count, zh: a.zh, dbCat: a.cat };
    const s = suggest(name, 1)[0];
    return { tag: t, st: nv === undefined && canVerify(name) ? 'checking' : 'unknown', fix: s ? pre + pretty(s.tag) : null };
  }
  function flushPending() {
    if (!pending.size) return;
    const list = [...pending];
    pending.clear();
    const m = effectiveModel();
    const owner = result;
    Promise.all(list.map((x) => verifyNAI(x, m.suggestModel || state.params.model).catch(() => null))).then(() => {
      if (!result || result !== owner || closed) return;
      for (const t of [...result.tags, ...result.replace.filter((r) => r.v), ...result.chars.flatMap((c) => c.tags), ...(result.charEdits || []).flatMap((c) => [...c.add, ...c.replace.filter((r) => r.v)])]) {
        if (t.v.st !== 'checking' && t.v.st !== 'alias') continue;
        t.v = verify(t.v.from || t.v.tag);
        // A user's explicit choice survives verification. Pending tags start off.
        if (!t.touched) t.on = !['unknown', 'checking'].includes(t.v.st);
      }
      paint();
    });
  }

  // ---------------------------------------------------------------- ask the model
  async function run() {
    if (busy) return;
    if (!llmReady()) return (status.className = 'ide-status err'), (bindCopy(status, 'textContent', () => (T('先在「设置 → AI 构思」里填接口地址、key 和模型。', 'Set the endpoint, key and model in Settings → AI assistant first.'))));
    const attached = attachCheck.checked && image;
    const desc = mode === 'artists' ? (artistInput.value.trim() || T('搭配适合当前画面的画师', 'Pair artists for the current scene')) : ta.value.trim() || (attached ? T('对照这张图优化提示词：保留原意，修正没画出来或画错的地方', 'Use this image to improve the prompt: keep the intent, fix what is missing or wrong') : '');
    if (mode === 'gen' && !desc) return ta.focus();
    if (mode === 'check' && !hasPrompt()) return bindCopy(status, 'textContent', () => T('提示词是空的', 'The prompt is empty'));
    if (mode === 'gen') lastText = desc;
    const snapshot = { ...state.params, characters: (state.params.characters || []).map((c) => ({ ...c })) };
    const artistSelection = (artistChoices || []).map((a) => ({ tag: a.tag, kept: !!a.on }));
    busy = true;
    result = null;
    paint();
    body.querySelectorAll('.seg button, .tgl input').forEach((el) => (el.disabled = true));
    runBtn.disabled = checkBtn.disabled = artistRun.disabled = artistReset.disabled = true;
    status.className = 'ide-status busy';
    bindCopy(status, 'textContent', () => (T('正在请求模型…', 'Asking the model…')));
    await loadTagDB().catch(() => {});
    const model = modelById(snapshot.model);
    const dict = termsIn(buildDictionaryQuery({ mode, merge, desc, params: snapshot, model }), 60);
    try {
      const messages = buildMessages({ mode, merge, desc, params: snapshot, model, lang: getLang(), dict, attachedImage: attached ? await imageData(attached) : null, artistHistory, artistSelection, splitChars });
      const user = Array.isArray(messages.at(-1).content) ? messages.at(-1).content[0].text : messages.at(-1).content;
      const { text, truncated } = await chatEx(messages);
      if (closed) return;
      let j;
      try { j = parsePlanJSON(text, { truncated, lang: getLang() }); } catch (err) {
        if (truncated) throw new Error(T('模型输出被截断，未能读取建议。请重试或关闭深度思考。', 'The output was cut off before suggestions could be read. Retry or disable deep thinking.'));
        throw err;
      }
      result = compilePlan(j, { snapshot, model, mode, merge, splitChars, verify, verifyArtist, artistSelection: artistChoices || [], lang: getLang() });
      if (mode === 'artists') {
        artistChoices = result.artists;
        if (!result.proposalCount) result.note ||= T('没有画师建议，可补充想要的画风后重试。', 'No artist suggestions. Describe the desired style and try again.');
        artistHistory.push([{ role: 'user', content: user }, { role: 'assistant', content: text }]);
        artistHistory = artistHistory.slice(-6);
        status.className = truncated ? 'ide-status err' : 'ide-status';
        bindCopy(status, 'textContent', () => truncated ? T('模型输出被截断，建议可能不完整。', 'The output was cut off; suggestions may be incomplete.') : '');
        return;
      }
      status.className = truncated ? 'ide-status err' : 'ide-status';
      bindCopy(status, 'textContent', () => (truncated ? T('模型输出被截断，下面只是前半部分。可重试，或在设置里关掉「深度思考」。', 'The output was cut off; this is only the first part. Retry, or turn off “Deep thinking” in Settings.') : ''));
      flushPending();
    } catch (err) {
      status.className = 'ide-status err';
      bindCopy(status, 'textContent', () => (T('失败：', 'Failed: ') + (err.message || err)));
    } finally {
      busy = false;
      body.querySelectorAll('.seg button, .tgl input').forEach((el) => (el.disabled = false));
      runBtn.disabled = checkBtn.disabled = artistRun.disabled = artistReset.disabled = false;
      paint();
    }
  }
  runBtn.onclick = run;
  checkBtn.onclick = run;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), e.stopPropagation(), run());
  });
  artistInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), e.stopPropagation(), run());
  });

  // ---------------------------------------------------------------- results
  const ST = {
    ok: ['', ''],
    rare: ['冷门', 'rare'],
    nai: ['NAI', 'NAI'],
    alias: ['≈', '≈'],
    checking: ['…', '…'],
    unknown: ['?', '?'],
  };
  const stTip = (v) =>
    ({
      ok: T(`词库 ${v.count} 张图`, `${v.count} posts`),
      rare: T(`冷门：只有 ${v.count} 张图，模型可能不认识`, `Rare: ${v.count} posts, the model may not know it`),
      nai: T('Danbooru 词库没有，但 NovelAI 认识', 'Not in the Danbooru list, but NovelAI knows it'),
      alias: T(`「${v.from}」是旧写法，已换成规范写法`, `“${v.from}” is an alias; using the canonical tag`),
      checking: T('正在向 NovelAI 确认…', 'Checking with NovelAI…'),
      unknown: T('词库和 NovelAI 都查不到，默认不插入', 'Unknown to both lists; off by default') + (v.fix ? T(`，可能是「${v.fix}」`, ` — maybe “${v.fix}”`) : ''),
    })[v.st] || '';
  const counts = () => countPlan(result);
  const toggle = (item) => { item.on = !item.on; item.touched = true; paint(); };
  function paint() {
    const c = counts();
    bindCopy(artistRun, 'textContent', () => artistHistory.length ? T('再调', 'Refine') : T('搭配', 'Suggest'));
    if (result?.artists) {
      const selected = result.artists.filter((a) => a.on).map((a) => a.tag);
      insertBtn.disabled = busy || planToPatch(result).prompt === result.snapshot.prompt;
      bindCopy(insertBtn, 'textContent', () => T(`应用画师 · ${selected.length}`, `Apply artists · ${selected.length}`));
      const chip = (a) => {
        const b = h('button', { class: 'ide-t ide-artist' + (!a.known && !a.existing ? ' st-unknown' : ''), 'aria-pressed': String(a.on), title: [a.why, !a.known && !a.existing ? T('本地画师词库未确认，默认关闭', 'Not verified in the local artist dictionary; off by default') : ''].filter(Boolean).join(' · '), onclick: () => toggle(a) }, a.tag, !a.known && !a.existing ? ' ?' : '');
        attachPeekTo(b, a.tag); // hover = nax.moe sample card (same as the editor)
        return h('span', { class: 'ide-artist-choice' }, b,
          h('a', { class: 'ide-artist-link', href: siteUrl(a.tag), target: '_blank', rel: 'noopener noreferrer', title: () => T('在 nax.moe 打开', 'Open on nax.moe'), 'aria-label': () => T(`在 nax.moe 打开 ${a.tag}`, `Open ${a.tag} on nax.moe`) }, '↗'));
      };
      out.replaceChildren(
        h('div', { class: 'ide-grp ide-artist-group' }, h('span', { class: 'ide-gl' }, () => T('画师', 'Artists')), h('div', { class: 'ide-tags' }, ...result.artists.map(chip))),
        h('p', { class: 'ide-note' }, result.note || (!result.artists.length ? T('描述画风，挑选喜欢的画师，再反馈微调。', 'Describe a style, choose artists, then refine with feedback.') : ''))
      );
      return;
    }
    insertBtn.disabled = busy || !(c.remove + c.replace + c.add);
    bindCopy(insertBtn, 'textContent', () => result ? T(`应用：删 ${c.remove} · 换 ${c.replace} · 加 ${c.add}`, `Apply: −${c.remove} · ⇄${c.replace} · +${c.add}`) : T('应用', 'Apply'));
    if (!result) return out.replaceChildren();
    const parts = [];
    if (!result.modifying && (state.params.characters || []).length) {
      const n = state.params.characters.length;
      parts.push(h('p', { class: 'ide-warn ide-character-reset' }, result.useChars && result.chars.length > 1
        ? T(`将替换现有 ${n} 个角色`, `Will replace ${n} existing characters`)
        : T(`将清除现有 ${n} 个角色`, `Will clear ${n} existing characters`)));
    }
    // coverage
    const covered = new Set([...result.present, ...result.tags.filter((t) => t.on).map((t) => t.cat)]);
    parts.push(
      h(
        'div',
        { class: 'ide-facets' },
        ...FACETS.map((f) => h('span', { class: 'ide-f' + (covered.has(f) ? ' on' : result.missing.includes(f) ? ' miss' : ''), title: () => (covered.has(f) ? T('已覆盖', 'covered') : result.missing.includes(f) ? T('还缺', 'missing') : '') }, (covered.has(f) ? '✓ ' : result.missing.includes(f) ? '+ ' : '') + catL(f)))
      )
    );
    if (result.note) parts.push(h('p', { class: 'ide-note' }, result.note));
    for (const c of result.conflicts) parts.push(h('p', { class: 'ide-warn' }, '⚠ ' + (Array.isArray(c.tags) ? c.tags.join(' × ') : '') + (c.note ? ' — ' + c.note : '')));
    if (result.remove.length) parts.push(h('div', { class: 'ide-grp ide-removals' }, h('span', { class: 'ide-gl' }, () => T('删除', 'Delete')),
      h('div', { class: 'ide-tags' }, ...result.remove.map((r) => h('button', { class: 'ide-t ide-remove', 'aria-pressed': String(r.on), title: () => r.on ? T('将删除 · 点击保留', 'Will delete · click to keep') : T('保留 · 点击删除', 'Keep · click to delete'), onclick: () => toggle(r) }, r.text)))));
    if (result.replace.length) parts.push(h('div', { class: 'ide-grp ide-replacements' }, h('span', { class: 'ide-gl' }, () => T('替换', 'Replace')),
      h('div', { class: 'ide-tags' }, ...result.replace.map((r) => h('button', { class: 'ide-t ide-replace' + (r.v ? ' st-' + r.v.st : ' nl'), 'aria-pressed': String(r.on), title: r.v ? stTip(r.v) : '', onclick: () => toggle(r) }, h('span', { class: 'ide-from' }, r.from), h('span', { class: 'ide-arrow', 'aria-hidden': 'true' }, '→'), h('span', {}, r.v?.tag || r.to), r.v && ST[r.v.st][0] ? h('i', {}, ST[r.v.st][getLang() === 'zh' ? 0 : 1]) : null)))));
    // tags by category
    for (const cat of CATS) {
      const list = result.tags.filter((t) => t.cat === cat);
      if (!list.length) continue;
      parts.push(
        h(
          'div',
          { class: 'ide-grp' },
          h('span', { class: 'ide-gl' }, catL(cat)),
          h(
            'div',
            { class: 'ide-tags' },
            ...list.map((t) => {
              const v = t.v;
              const b = h('button', { class: 'ide-t st-' + v.st, 'aria-pressed': String(t.on), title: stTip(v) + (v.zh ? ' · ' + v.zh : ''), onclick: () => toggle(t) }, v.tag, ST[v.st][0] ? h('i', {}, () => (ST[v.st][getLang() === 'zh' ? 0 : 1])) : null);
              if (v.st === 'unknown' && v.fix)
                return h('span', { class: 'ide-fixwrap' }, b, h('button', { class: 'ide-fix', title: () => (T('换成这个', 'Use this')), onclick: () => { t.v = verify(v.fix); t.on = !['unknown', 'checking'].includes(t.v.st); t.touched = true; paint(); flushPending(); } }, '→ ' + v.fix));
              return b;
            })
          )
        )
      );
    }
    if (result.nl.length)
      parts.push(
        h(
          'div',
          { class: 'ide-grp' },
          h('span', { class: 'ide-gl' }, () => (T('自然语言', 'Sentences'))),
          h('div', { class: 'ide-tags' }, ...result.nl.map((n) => h('button', { class: 'ide-t nl', 'aria-pressed': String(n.on), onclick: () => ((n.on = !n.on), paint()) }, n.text)))
        )
      );
    for (const g of result.charEdits || []) {
      const title = g.new ? T('新增角色', 'New character') + (g.label ? ' · ' + g.label : '') : T(`角色 ${g.index}`, `Character ${g.index}`) + (g.first ? ' · ' + g.first : '');
      const tags = h('div', { class: 'ide-tags' });
      if (g.new) tags.append(h('button', { class: 'ide-t ide-char-new', 'aria-pressed': String(g.on), onclick: () => toggle(g) }, () => T('新增角色', 'Add character')));
      if (g.deletion) tags.append(h('button', { class: 'ide-t ide-remove ide-char-delete', 'aria-pressed': String(g.deletion.on), onclick: () => toggle(g.deletion) }, () => T('删除角色', 'Delete character')));
      const disabled = g.new ? !g.on : !!g.deletion?.on;
      for (const r of g.remove) tags.append(h('button', { class: 'ide-t ide-remove', disabled, 'aria-pressed': String(r.on), onclick: () => toggle(r) }, '− ' + r.text));
      for (const r of g.replace) tags.append(h('button', { class: 'ide-t ide-replace' + (r.v ? ' st-' + r.v.st : ' nl'), disabled, 'aria-pressed': String(r.on), title: r.v ? stTip(r.v) : '', onclick: () => toggle(r) }, h('span', { class: 'ide-from' }, r.from), ' → ', r.v?.tag || r.to));
      for (const t of g.add) tags.append(h('button', { class: 'ide-t ide-char-add st-' + t.v.st, disabled, 'aria-pressed': String(t.on), title: stTip(t.v), onclick: () => toggle(t) }, '+ ' + t.v.tag));
      if (g.position) tags.append(h('button', { class: 'ide-t ide-position', disabled, 'aria-pressed': String(g.position.on), onclick: () => toggle(g.position) }, () => T('位置 → ', 'Position → ') + positionLabel(g.position.value)));
      parts.push(h('section', { class: 'ide-character-edits', 'data-character-index': g.new ? 'new' : String(g.index) }, h('h3', { class: 'ide-character-title' }, title), tags));
    }
    if (result.chars.length > 1) {
      const ck = h('input', { type: 'checkbox', checked: result.useChars });
      ck.onchange = () => { result.useChars = ck.checked; paint(); };
      parts.push(
        h(
          'div',
          { class: 'ide-grp' },
          h('label', { class: 'tgl ide-gl' }, ck, h('span', { class: 'sw' }), h('span', { class: 'cn' }, () => (T('写入角色提示词', 'Character prompts')))),
          h('div', { class: 'ide-chars' }, ...result.chars.map((c, i) => h('div', {}, h('p', { class: 'mono' }, `${i + 1}. ${c.label}${c.position ? ' · ' + positionLabel(c.position) : ''}`), h('div', { class: 'ide-tags' }, ...c.tags.map((t) => h('button', { class: 'ide-t st-' + t.v.st, 'aria-pressed': String(t.on), title: stTip(t.v), onclick: () => toggle(t) }, t.v.tag))))))
        )
      );
    }
    if (!result.tags.length && !result.nl.length && !result.remove.length && !result.replace.length && !result.chars.length && !result.charEdits?.length) parts.push(h('p', { class: 'hint ide-empty' }, () => T('没有可应用的建议，可补充角色编号或更具体的修改要求后重试。', 'No actionable suggestions. Try a character number or a more specific request.')));
    out.replaceChildren(...parts);
  }

  insertBtn.onclick = () => {
    if (!result || busy || insertBtn.disabled) return;
    const { patch, dropped, skippedNL } = planOutcome(result);
    const maxChars = result.model.maxChars || 0;
    apply(patch);
    m.close();
    if (dropped) toast(() => T(`模型最多支持 ${maxChars} 个角色，已略过 ${dropped} 个新增角色`, `This model supports ${maxChars} characters; skipped ${dropped} additions`), 'warn', 4000);
    if (skippedNL) toast(() => (T('这个模型不太懂自然语言，句子没有插入', 'This model handles sentences poorly, so they were skipped')), 'warn', 4000);
  };

  const body = h('div', { class: 'ide' }, modeSeg, genBox, checkBox, artistBox, attachToggle, status, out);
  const m = openModal({ n: 'AI', title: () => (t('copy.ui.ideate.0')), sub: () => T('描述需求 · 选择删改 · 应用提示词', 'Ask · select edits · apply'), body, onClose: () => { closed = true; }, onLang: () => paint(), foot: [h('button', { class: 'btn', onclick: () => m.close() }, () => (T('取消', 'Cancel'))), insertBtn] });
  m.el.classList.add('ide-modal');
  m.el.style.width = 'min(780px, 100%)';
  if (!llmReady()) {
    status.className = 'ide-status err';
    bindCopy(status, 'textContent', () => (T('还没设置模型接口：设置 → AI 构思（OpenAI 兼容接口）。', 'No endpoint yet: Settings → AI assistant (OpenAI-compatible).')));
  }
  setTimeout(() => ta.focus(), 50);
  if (currentImage) Promise.resolve().then(currentImage).then((blob) => {
    if (closed || !blob) return;
    image = blob;
    attachToggle.hidden = false;
  }).catch(() => {});
}
