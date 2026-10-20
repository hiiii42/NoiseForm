// Control panel: binds every left-column control to the store.
import { $, $$, h, icon, clamp, uid, pickFile, blobToDataURL, loadImage, fmtNum } from '../util.js';
import { state, set, on, emit } from '../store.js';
import { bindCopy, t, applyI18n, getLang } from '../i18n.js';
import { MODELS, modelById, SIZE_PRESETS, COMPOSITIONS, SAMPLERS, NOISE_SCHEDULES, CHAR_COLORS, POS_VALUES, POS_COLS, posLabel, posSnap, posTitle } from '../data.js';
import { ucPresetsFor } from '../nai.js';
import { generationSpec as specFor, vibeKey } from '../domain/generation.js';
export { vibeKey } from '../domain/generation.js';
import { effectiveModel as resolveModel, estimateCost, freeBlockers as costBlockers } from '../domain/cost.js';
import { createEditor, estimateTokens } from './editor.js';
import { toast } from './modal.js';
import { attachInspector } from './inspector.js';
import { openCharPositions } from './charpos.js';

const P = state.params;
let editors = {};
let hooks = {};

export function initPanel(h_) {
  hooks = h_ || {};
  initSections();
  initModelMenu();
  initPrompt();
  initChars();
  initSize();
  initSampling();
  renderBase();
  renderVibes();
  renderRefs();
  on(['params', 'base', 'vibes', 'refs', 'session.tier', 'session.live'], updateCost);
  on(['params.model', 'params.characters', 'params.aiChoice'], syncParamStructure);
  on('params', syncCommittedEditors);
  on('base', renderBase);
  on('vibes', renderVibes);
  on('refs', renderRefs);
  applyModel();
  updateCost();
}

// A commit may change model + characters together. This shared callback is
// deduplicated by the store, so applyModel's character render happens only once.
function syncParamStructure(value, path, change) {
  if (path === 'params.model' || change?.keys.includes('model')) applyModel();
  else if (change?.keys.includes('characters')) renderChars();
  else syncCharPositions(); // typing / dragging uses the existing lightweight path
}

function syncCommittedEditors(value, path, change) {
  if (!change) return;
  refreshEditors();
  const m = modelById(P.model);
  $('#sampler').value = m.fixed?.sampler || P.sampler;
  $('#noiseSchedule').value = m.forceKarras ? 'karras' : P.noiseSchedule;
  if (m.fixed?.steps) $('.fld[data-slider="steps"] .fv').value = m.fixed.steps;
}

// ctx (optional) = a queued snapshot { params, base, vibes, refs }; default = the live editor
const generationSpec = (ctx) => specFor(ctx, state, getLang());
export const effectiveModel = (ctx) => resolveModel(generationSpec(ctx));
export const freeBlockers = (ctx) => costBlockers(generationSpec(ctx), state.session);

// ------------------------------------------------------------ sections
function initSections() {
  for (const sec of $$('.sec')) {
    const key = sec.dataset.sec;
    if (state.settings.collapsed[key]) sec.classList.add('collapsed');
    sec.querySelector('.sec-h').addEventListener('click', (e) => {
      if (e.target.closest('.sec-x button:not(.sec-tog), .sec-x label')) return;
      sec.classList.toggle('collapsed');
      state.settings.collapsed = { ...state.settings.collapsed, [key]: sec.classList.contains('collapsed') };
      emit('settings.collapsed');
    });
  }
}

export function expandSection(key) {
  const sec = $(`.sec[data-sec="${key}"]`);
  if (!sec) return;
  sec.classList.remove('collapsed');
  sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ------------------------------------------------------------ model menu
function initModelMenu() {
  const btn = $('#modelBtn');
  const menu = $('#modelMenu');
  const close = () => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  const render = () => {
    let n = 0;
    const groups = ['NEW', 'LEGACY'];
    menu.replaceChildren(
      ...groups.flatMap((g) => [
        h('div', { class: 't-label', style: { padding: '8px 8px 4px' } }, () => t('model.' + g) + (g === 'NEW' ? ' — V5' : '')),
        ...MODELS.filter((m) => (m.group || 'LEGACY') === g).map((m) =>
          h(
            'button',
            {
              class: 'model-opt' + (m.id === P.model ? ' on' : ''),
              role: 'option',
              onclick: () => {
                set('params.model', m.id);
                close();
              },
            },
            h('span', { class: 'mo-n' }, String(++n).padStart(2, '0')),
            h('span', {}, h('span', { class: 'mo-t' }, m.short), h('span', { class: 'mo-d' }, () => t('model.desc.' + m.id))),
            h('span', { class: 'mo-tag' }, () => t('model.' + m.tag))
          )
        ),
      ])
    );
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!menu.hidden) return close();
    render();
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && close());
}

function applyModel() {
  const m = modelById(P.model);
  $('#modelName').textContent = m.name.toUpperCase();
  // UC presets
  const presets = ucPresetsFor(m.id);
  if (P.ucPreset >= presets.length) P.ucPreset = 0;
  const sel = $('#ucPreset');
  sel.replaceChildren(...presets.map(([label], i) => h('option', { value: i }, () => t('preset.' + label))));
  sel.value = P.ucPreset;
  sel.disabled = !!m.forcedUC;
  // samplers / schedules
  const samp = $('#sampler');
  samp.replaceChildren(...SAMPLERS.filter((s) => !s.v3only || m.v3).map((s) => h('option', { value: s.id }, s.label)));
  if (![...samp.options].some((o) => o.value === P.sampler)) P.sampler = 'k_euler_ancestral';
  samp.value = m.fixed?.sampler || P.sampler;
  samp.disabled = !!m.fixed?.sampler;
  const ns = $('#noiseSchedule');
  ns.replaceChildren(...NOISE_SCHEDULES.filter((s) => !s.v3only || m.v3).map((s) => h('option', { value: s.id }, s.label)));
  if (!m.v3 && P.noiseSchedule === 'native') P.noiseSchedule = 'karras';
  ns.value = m.forceKarras ? 'karras' : P.noiseSchedule;
  ns.disabled = !!m.forceKarras;
  // visibility flags
  for (const el of $$('[data-v3]')) el.hidden = !m.v3;
  for (const el of $$('[data-v5]')) el.hidden = !m.v5;
  for (const el of $$('[data-v4]')) el.hidden = !m.varietyBase;
  const resc = $('.fld[data-slider="cfgRescale"]');
  if (resc) resc.hidden = !!m.noRescale;
  // steps fixed?
  const stepsFld = $('.fld[data-slider="steps"]');
  stepsFld.classList.toggle('locked', !!m.fixed?.steps);
  for (const i of stepsFld.querySelectorAll('input')) i.disabled = !!m.fixed?.steps;
  if (m.fixed?.steps) stepsFld.querySelector('.fv').value = m.fixed.steps;
  else syncSlider('steps');
  // characters
  $('#secChars').classList.toggle('disabled', !m.v4);
  $('#charV3Hint').hidden = !!m.v4;
  $('#btnAddChar').disabled = !m.v4;
  // token limits
  updateTokens();
  renderChars();
  renderVibes();
  renderRefs();
  updateSlug();
}

// ------------------------------------------------------------ prompt / uc
function updateTokens() {
  const lim = modelById(P.model).tokenLimit || 512;
  for (const [id, text] of [
    ['#promptTok', P.prompt],
    ['#ucTok', P.uc],
  ]) {
    const n = estimateTokens(text);
    const el = $(id);
    el.textContent = `~${n} / ${lim}`;
    el.classList.toggle('warn', n > lim);
  }
}

function initPrompt() {
  editors.prompt = createEditor($('#promptEditor'), {
    placeholder: () => t('copy.ui.panel.0'),
    value: P.prompt,
    onChange: (v) => {
      P.prompt = v;
      emit('params.prompt');
      updateTokens();
    },
  });
  editors.uc = createEditor($('#ucEditor'), {
    placeholder: () => t('copy.ui.panel.1'),
    value: P.uc,
    size: 'small',
    onChange: (v) => {
      P.uc = v;
      emit('params.uc');
      updateTokens();
    },
  });
  bindCheck('#qualityToggle', 'qualityToggle');
  bindCheck('#transparent', 'transparent');
  const qp = $('#qualityPreset');
  qp.value = P.qualityPreset;
  qp.onchange = () => set('params.qualityPreset', Number(qp.value));
  const ucp = $('#ucPreset');
  ucp.onchange = () => set('params.ucPreset', Number(ucp.value));
  $('#btnRandomPrompt').onclick = (e) => {
    e.stopPropagation();
    hooks.randomPrompt?.();
  };
  // review column: translation and spell check toggle independently; ⇥ collapses the column
  const S = state.settings;
  const tog = (label, key, tip) => {
    const b = h('button', { class: 'btn sm sq ghost tr-btn', title: () => (t(tip)), 'data-i18n-title': tip }, label);
    b.onclick = (e) => {
      e.stopPropagation();
      set('settings.' + key, S[key] === false);
    };
    return b;
  };
  const trBtn = tog(() => t('review.translate'), 'translate', 'act.translate');
  const spBtn = tog(() => t('review.check'), 'spellcheck', 'act.spellcheck');
  const rvBtn = tog('', 'reviewOpen', 'act.review');
  rvBtn.classList.add('rv-btn');
  const syncReview = () => {
    const tr = S.translate !== false;
    const sp = S.spellcheck !== false;
    const open = S.reviewOpen !== false;
    trBtn.classList.toggle('on', tr);
    spBtn.classList.toggle('on', sp);
    rvBtn.hidden = !tr && !sp;
    rvBtn.textContent = open ? '⇤' : '⇥';
    document.body.classList.toggle('rv-wide', (tr || sp) && open);
    document.body.classList.toggle('tr-off', !tr);
  };
  on(['settings.translate', 'settings.spellcheck', 'settings.reviewOpen'], syncReview);
  syncReview();
  $('#btnRandomPrompt').before(trBtn, spBtn, rvBtn);
  attachInspector(editors.prompt, $('#promptEditor'), { onIssues: (n) => issueBadge('prompt', n) });
  attachInspector(editors.uc, $('#ucEditor'), { onIssues: (n) => issueBadge('uc', n) });
  updateTokens();
}

const issueCounts = {};
function issueBadge(sec, n) {
  issueCounts[sec] = n;
  const x = $(`.sec[data-sec="${sec}"] .sec-x`);
  let b = x.querySelector('.issues');
  if (!b) {
    b = h('span', { class: 'badge mono issues', title: () => (t('hint.issues')) });
    x.prepend(b);
  }
  b.hidden = !n;
  b.textContent = '⚠ ' + n;
}

export function refreshEditors() {
  editors.prompt.setValue(P.prompt);
  editors.uc.setValue(P.uc);
  $('#ucPreset').value = P.ucPreset;
  $('#qualityToggle').checked = P.qualityToggle;
  $('#qualityPreset').value = P.qualityPreset;
  $('#transparent').checked = !!P.transparent;
  updateTokens();
}

function bindCheck(sel, key) {
  const el = $(sel);
  el.checked = !!P[key];
  el.addEventListener('change', () => set('params.' + key, el.checked));
  on('params.' + key, () => (el.checked = !!P[key]));
}

// ------------------------------------------------------------ characters

const charEditors = new Map();
const charIssues = {};
let posPop = null;

function initChars() {
  $('#btnAddChar').onclick = () => {
    const m = modelById(P.model);
    if (!m.v4) return toast(() => (t('toast.v4Only')), 'warn');
    if (P.characters.length >= (m.maxChars || 6)) return toast(() => t('toast.maxChars', { n: m.maxChars || 6 }), 'warn');
    P.characters.push({ id: uid(), prompt: '', uc: '', x: 0.5, y: 0.5, enabled: true, tab: 'prompt' });
    emit('params.characters');
    renderChars();
    setTimeout(() => charEditors.get(P.characters.at(-1).id)?.focus(), 30);
  };
  const ai = $('#aiChoice');
  ai.checked = P.aiChoice;
  ai.onchange = () => {
    set('params.aiChoice', ai.checked);
    renderChars();
  };
  renderChars();
}

function syncCharPositions() {
  const m = modelById(P.model);
  $('#aiChoice').checked = P.aiChoice;
  for (const btn of $$('#charList .pos-btn')) {
    const c = P.characters.find((c) => c.id === btn.dataset.characterId);
    if (!c) continue;
    btn.disabled = !m.v5 && P.aiChoice;
    btn.querySelector('.pos-label').textContent = P.aiChoice ? 'AI' : posLabel(c.x, c.y, m.v5);
    btn.title = m.v5 ? posTitle(c.x, c.y) : t('copy.ui.panel.5');
  }
}

export function renderChars() {
  const list = $('#charList');
  const m = modelById(P.model);
  $('#charCount').textContent = `${P.characters.length}/${m.maxChars || 6}`;
  $('#charCount').classList.toggle('on', P.characters.length > 0);
  $('#aiChoice').checked = P.aiChoice;
  const keep = new Set();
  list.replaceChildren(
    ...P.characters.map((c, i) => {
      keep.add(c.id);
      const color = CHAR_COLORS[i % CHAR_COLORS.length];
      const edHost = h('div');
      const tabP = h('button', { class: c.tab !== 'uc' ? 'on' : '' }, () => (t('copy.ui.panel.3')));
      const tabU = h('button', { class: c.tab === 'uc' ? 'on' : '' }, () => (t('copy.ui.panel.4')));
      const ed = createEditor(edHost, {
        id: `char-${c.id}-${c.tab === 'uc' ? 'uc' : 'prompt'}`,
        placeholder: () => c.tab === 'uc' ? t('copy.ui.panel.2') : t('char.prompt', { n: i + 1 }),
        value: c.tab === 'uc' ? c.uc : c.prompt,
        size: 'tiny',
        onChange: (v) => {
          if (c.tab === 'uc') c.uc = v;
          else c.prompt = v;
          emit('params.characters');
        },
      });
      charEditors.get(c.id)?.dispose?.();
      charEditors.set(c.id, ed);
      const switchTab = (tab) => {
        c.tab = tab;
        renderChars();
      };
      tabP.onclick = () => switchTab('prompt');
      tabU.onclick = () => switchTab('uc');
      const pos = h(
        'button',
        { class: 'btn sm pos-btn', 'data-character-id': c.id, title: () => m.v5 ? posTitle(c.x, c.y) : t('copy.ui.panel.5'), disabled: !m.v5 && P.aiChoice, onclick: (e) => openPos(e.currentTarget, c, color) },
        icon('grid'),
        h('span', { class: 'pos-label' }, P.aiChoice ? 'AI' : posLabel(c.x, c.y, m.v5))
      );
      const vis = h(
        'button',
        { class: 'btn sm sq ghost', title: () => (t('copy.ui.panel.6')), onclick: () => ((c.enabled = !c.enabled), emit('params.characters'), renderChars()) },
        icon(c.enabled ? 'eye' : 'eyeoff')
      );
      // Preserve legacy direction-key titles used by integrations; accessible names localize.
      const up = h('button', { class: 'btn sm sq ghost', title: 'Up', 'aria-label': () => t('copy.ui.panel.7'), disabled: i === 0, onclick: () => moveChar(i, -1) }, icon('up'));
      const dn = h('button', { class: 'btn sm sq ghost', title: 'Down', 'aria-label': () => t('copy.ui.panel.8'), disabled: i === P.characters.length - 1, onclick: () => moveChar(i, 1) }, icon('down'));
      const del = h(
        'button',
        { class: 'btn sm sq ghost danger', title: () => (t('act.remove')), onclick: () => ((P.characters.splice(i, 1), emit('params.characters')), renderChars()) },
        icon('close')
      );
      const card = h(
        'div',
        { class: 'char' + (c.enabled ? '' : ' off'), style: { '--cc': color } },
        h('div', { class: 'char-h' }, h('span', { class: 'char-n' }, 'C' + (i + 1)), h('div', { class: 'seg' }, tabP, tabU), h('span', { class: 'sp' }), pos, vis, up, dn, del),
        edHost
      );
      const disposeEditor = ed.dispose;
      const disposeInspector = attachInspector(ed, edHost, { onIssues: (n) => ((charIssues[c.id] = n), issueBadge('chars', Object.values(charIssues).reduce((a, b) => a + b, 0))) }).dispose;
      let disposed = false;
      ed.dispose = () => {
        if (disposed) return;
        disposed = true;
        try { disposeInspector(); }
        finally { disposeEditor(); }
      };
      return card;
    })
  );
  for (const id of charEditors.keys()) if (!keep.has(id)) (charEditors.get(id).dispose?.(), charEditors.delete(id), delete charIssues[id]);
  issueBadge('chars', Object.values(charIssues).reduce((a, b) => a + b, 0));
}

function moveChar(i, d) {
  const arr = P.characters;
  [arr[i], arr[i + d]] = [arr[i + d], arr[i]];
  emit('params.characters');
  renderChars();
}

function openPos(anchor, c, color) {
  posPop?.remove();
  posPop = null;
  if (modelById(P.model).v5) return openCharPositions(c);
  const grid = h('div', { class: 'pos-grid' }, h('span'), ...POS_COLS.map((l) => h('span', {}, l)));
  POS_VALUES.forEach((y, ri) => {
    grid.append(h('span', {}, String(ri + 1)));
    POS_VALUES.forEach((x) => {
      const on = posSnap(c.x) === x && posSnap(c.y) === y;
      const taken = P.characters.some((o) => o !== c && posSnap(o.x) === x && posSnap(o.y) === y);
      grid.append(
        h('button', {
          class: (on ? 'on' : '') + (taken ? ' taken' : ''),
          title: posLabel(x, y),
          onclick: () => {
            c.x = x;
            c.y = y;
            emit('params.characters');
            posPop.remove();
            posPop = null;
            renderChars();
          },
        })
      );
    });
  });
  posPop = h('div', { class: 'pos-pop', style: { '--cc': color } }, grid);
  document.body.append(posPop);
  const r = anchor.getBoundingClientRect();
  posPop.style.left = clamp(r.left - 120, 8, innerWidth - 220) + 'px';
  posPop.style.top = r.bottom + 6 + 'px';
  setTimeout(() => {
    const off = (e) => {
      if (posPop && !posPop.contains(e.target)) {
        posPop.remove();
        posPop = null;
        document.removeEventListener('mousedown', off);
      }
    };
    document.addEventListener('mousedown', off);
  });
}

// ------------------------------------------------------------ size
const T = (zh, en) => getLang() === 'zh' ? zh : en;

function initSize() {
  const sel = $('#sizePreset');
  const custom = $('#width').closest('.wh');
  custom.id = 'compositionCustom';
  const readout = h('button', {
    id: 'compositionReadout', class: 'composition-readout mono', type: 'button',
    'aria-controls': custom.id, 'aria-expanded': 'false',
    onclick: () => showCustomSize(custom.hidden),
  });
  const range = h('input', {
    id: 'compositionRange', class: 'rng composition-range', type: 'range',
    min: 0, max: COMPOSITIONS.length - 1, step: 1,
    oninput: () => {
      const { w, h } = COMPOSITIONS[Number(range.value)];
      showCustomSize(false);
      setSize(w, h);
    },
  });
  const random = h('button', {
    id: 'compositionRandom', class: 'btn sq composition-random', type: 'button',
    onclick: () => {
      const { w, h } = COMPOSITIONS[Math.floor(Math.random() * COMPOSITIONS.length)];
      showCustomSize(false);
      setSize(w, h);
    },
  }, icon('dice'));
  const presetRow = h('div', { class: 'composition-presets' });
  sel.before(presetRow);
  presetRow.append(sel, random);
  custom.before(
    readout,
    h('div', { id: 'compositionTrack', class: 'composition-track' },
      h('span', { class: 'composition-orientation is-landscape', 'aria-hidden': 'true' }),
      range,
      h('span', { class: 'composition-orientation is-portrait', 'aria-hidden': 'true' })
    )
  );
  showCustomSize(P.sizePreset === 'custom');
  const groups = [...new Set(SIZE_PRESETS.map((p) => p.group))];
  sel.replaceChildren(
    ...groups.map((g) =>
      h(
        'optgroup',
        { label: () => t('size.' + g) },
        ...SIZE_PRESETS.filter((p) => p.group === g).map((p) => h('option', { value: p.id }, () => p.id === 'custom' ? t('size.CUSTOM') : `${t('size.' + g)} ${t('size.' + p.label)} · ${p.w}×${p.h}`))
      )
    )
  );
  sel.onchange = () => {
    const p = SIZE_PRESETS.find((x) => x.id === sel.value);
    showCustomSize(p?.id === 'custom');
    if (p && p.w) setSize(p.w, p.h);
    else if (p?.id === 'custom') set('params.sizePreset', 'custom');
  };
  const W = $('#width');
  const H = $('#height');
  const commit = () => setSize(Number(W.value), Number(H.value));
  W.onchange = commit;
  H.onchange = commit;
  $('#btnSwap').onclick = () => setSize(P.height, P.width);
  const seg = $('#nSamples');
  seg.onclick = (e) => {
    const b = e.target.closest('button');
    if (b) set('params.nSamples', Number(b.dataset.v));
  };
  on(['params.width', 'params.height', 'params.sizePreset', 'params.nSamples'], syncSize);
  syncSize();
}

function showCustomSize(open) {
  const custom = $('#compositionCustom');
  custom.hidden = !open;
  $('#compositionReadout').setAttribute('aria-expanded', String(open));
  if (open) {
    $('#width').focus();
    $('#width').select();
  }
}

export function setSize(w, h) {
  w = clamp(Math.round((w || 64) / 64) * 64, 64, 2048);
  h = clamp(Math.round((h || 64) / 64) * 64, 64, 2048);
  while (w * h > 3145728) {
    if (w >= h) w -= 64;
    else h -= 64;
  }
  P.width = w;
  P.height = h;
  const pre = SIZE_PRESETS.find((p) => p.w === w && p.h === h);
  P.sizePreset = pre ? pre.id : 'custom';
  emit('params.width');
  emit('params.height');
  emit('params.sizePreset');
}

function syncSize() {
  $('#width').value = P.width;
  $('#height').value = P.height;
  $('#sizePreset').value = P.sizePreset;
  for (const preset of SIZE_PRESETS) {
    bindCopy($(`#sizePreset option[value="${preset.id}"]`), 'textContent', () => (preset.id === 'custom'
      ? t('size.CUSTOM') : `${t('size.' + preset.group)} ${t('size.' + preset.label)} · ${preset.w}×${preset.h}`));
  }
  $('#sizePreset').setAttribute('aria-label', T('尺寸预设', 'Size preset'));
  const readout = $('#compositionReadout');
  readout.textContent = `${P.width} × ${P.height}`;
  bindCopy(readout, 'title', () => (T('点击切换自定义尺寸输入', 'Click to toggle custom size inputs')));
  readout.setAttribute('aria-label', `${readout.textContent} · ${readout.title}`);
  const random = $('#compositionRandom');
  bindCopy(random, 'title', () => (T('随机构图（≤1MP）', 'Random composition (≤1MP)')));
  random.setAttribute('aria-label', random.title);
  $('#width').setAttribute('aria-label', T('宽度', 'Width'));
  $('#height').setAttribute('aria-label', T('高度', 'Height'));
  bindCopy($('#btnSwap'), 'title', () => (T('交换宽高', 'Swap width and height')));
  const exact = COMPOSITIONS.findIndex(({ w, h }) => w === P.width && h === P.height);
  // Log-ratio distance treats reciprocal landscape/portrait ratios symmetrically.
  const distance = ({ w, h }) => Math.abs(Math.log((w / h) / (P.width / P.height)));
  const nearest = exact >= 0 ? exact : COMPOSITIONS.reduce((best, c, i) => distance(c) < distance(COMPOSITIONS[best]) ? i : best, 0);
  const range = $('#compositionRange');
  range.value = nearest;
  range.style.setProperty('--p', (nearest / (COMPOSITIONS.length - 1)) * 100 + '%');
  range.setAttribute('aria-label', T('构图：从横图到竖图', 'Composition: landscape to portrait'));
  const c = COMPOSITIONS[nearest];
  const outside = P.width * P.height > 1048576;
  const track = $('#compositionTrack');
  track.classList.toggle('is-approximate', exact < 0);
  track.classList.toggle('is-outside', outside);
  bindCopy(track, 'title', () => (outside
    ? T('当前尺寸超过 1MP；拖动切换到 1MP 内构图', 'Current size exceeds 1MP; drag to choose a composition within 1MP')
    : exact < 0 ? T('近似比例；拖动应用对应构图', 'Approximate ratio; drag to apply this composition') : ''));
  range.setAttribute('aria-valuetext', `${exact < 0 ? T('近似 ', 'Approx. ') : ''}${c.w} × ${c.h}`);
  const s = 60 / Math.max(P.width, P.height);
  const box = $('#sizePreview i');
  box.style.width = Math.round(P.width * s) + 'px';
  box.style.height = Math.round(P.height * s) + 'px';
  $('#sizeMP').textContent = ((P.width * P.height) / 1e6).toFixed(2) + 'MP';
  for (const b of $$('#nSamples button')) b.classList.toggle('on', Number(b.dataset.v) === P.nSamples);
}

// ------------------------------------------------------------ sliders + sampling
const sliders = {};

export function makeSlider(host, { label, min, max, step, get, set: setV, fmt }) {
  const fv = h('input', { class: 'fv', type: 'number', min, max, step });
  const rng = h('input', { class: 'rng', type: 'range', min, max, step });
  if (label) host.append(h('label', {}, label));
  host.append(fv, rng);
  const dec = String(step).includes('.') ? String(step).split('.')[1].length : 0;
  const paint = (v) => {
    rng.value = v;
    fv.value = fmt ? fmt(v) : Number(v).toFixed(dec);
    rng.style.setProperty('--p', ((v - min) / (max - min)) * 100 + '%');
  };
  rng.addEventListener('input', () => {
    const v = Number(rng.value);
    setV(v);
    paint(v);
  });
  fv.addEventListener('change', () => {
    const v = clamp(Number(fv.value) || 0, min, max);
    setV(v);
    paint(v);
  });
  paint(get());
  return { sync: () => paint(get()) };
}

function syncSlider(key) {
  sliders[key]?.sync();
}

function initSampling() {
  for (const fld of $$('.fld[data-slider]')) {
    const key = fld.dataset.slider;
    sliders[key] = makeSlider(fld, {
      min: Number(fld.dataset.min),
      max: Number(fld.dataset.max),
      step: Number(fld.dataset.step),
      get: () => P[key],
      set: (v) => set('params.' + key, v),
    });
    on('params.' + key, () => syncSlider(key));
  }
  const seed = $('#seed');
  seed.value = P.seed;
  seed.addEventListener('input', () => {
    seed.value = seed.value.replace(/\D/g, '').slice(0, 10);
    const n = seed.value ? Math.min(Number(seed.value), 4294967295) : '';
    set('params.seed', n === '' ? '' : String(n));
    syncSeedLock();
  });
  $('#btnSeedRandom').onclick = () => {
    set('params.seed', '');
    seed.value = '';
    syncSeedLock();
  };
  $('#btnSeedLock').onclick = () => {
    if (P.seed) set('params.seed', '');
    else set('params.seed', String(state.session.lastSeed ?? Math.floor(Math.random() * 4294967295)));
    seed.value = P.seed;
    syncSeedLock();
  };
  on('params.seed', () => {
    seed.value = P.seed;
    syncSeedLock();
  });
  syncSeedLock();
  // where the current seed came from (an archive image / an imported file); hidden once it is edited
  const from = $('#seedFrom');
  const paintFrom = () => {
    const f = state.session.seedFrom;
    const show = !!P.seed && !!f && f.seed === P.seed;
    from.hidden = !show;
    if (show) {
      from.textContent = f.label;
      bindCopy(from, 'title', () => ((getLang() === 'zh' ? '种子来自 ' : 'Seed from ') + f.label));
    }
  };
  on(['params.seed', 'params'], paintFrom);
  paintFrom();
  $('#sampler').onchange = (e) => set('params.sampler', e.target.value);
  $('#noiseSchedule').onchange = (e) => set('params.noiseSchedule', e.target.value);
  for (const k of ['variety', 'smea', 'dyn', 'decrisp']) bindCheck('#' + k, k);
  bindCheck('#normalizeVibes', 'normalizeVibes');
}

function syncSeedLock() {
  const b = $('#btnSeedLock');
  b.classList.toggle('on', !!P.seed);
  b.querySelector('use').setAttribute('href', P.seed ? '#i-lock' : '#i-unlock');
}

export function refreshAll() {
  refreshEditors();
  for (const k of Object.keys(sliders)) syncSlider(k);
  syncSize();
  $('#seed').value = P.seed;
  syncSeedLock();
  for (const k of ['variety', 'smea', 'dyn', 'decrisp', 'normalizeVibes', 'qualityToggle', 'transparent']) {
    const el = $('#' + k);
    if (el) el.checked = !!P[k];
  }
  applyModel();
  updateCost();
}

// ------------------------------------------------------------ image slots
async function readImageFile(file) {
  const url = await blobToDataURL(file);
  const img = await loadImage(url);
  return { url, w: img.naturalWidth, h: img.naturalHeight };
}

function slot(labelKey, onFile) {
  const b = h('button', { class: 'slot' }, icon('upload'), h('span', {}, () => (t(labelKey))));
  b.onclick = async () => {
    const f = await pickFile();
    if (f) onFile(f);
  };
  b.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    b.classList.add('over');
  });
  b.addEventListener('dragleave', () => b.classList.remove('over'));
  b.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    b.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) onFile(f);
  });
  return b;
}

export async function setBaseImage(src, { size = true } = {}) {
  const url = typeof src === 'string' ? src : (await readImageFile(src)).url;
  const img = await loadImage(url);
  state.base = { image: url, w: img.naturalWidth, h: img.naturalHeight, strength: 0.7, noise: 0, mask: null };
  if (size) setSize(img.naturalWidth, img.naturalHeight);
  emit('base');
  expandSection('base');
}

function renderBase() {
  const body = $('#baseBody');
  const b = state.base;
  if (!b) {
    body.replaceChildren(slot('act.upload', (f) => setBaseImage(f)));
    return;
  }
  const thumb = h('div', { class: 'ref-thumb' }, h('img', { src: b.image, alt: '' }));
  if (b.mask) thumb.append(h('img', { class: 'mask', src: b.maskPreview || b.mask, alt: '' }));
  const ctl = h('div', { class: 'ref-ctl' });
  ctl.append(
    h(
      'div',
      { class: 'ref-top' },
      h('span', { class: 'mode' }, () => t(b.mask ? 'base.mode.inpaint' : 'base.mode.img2img')),
      h('button', { class: 'btn sm sq ghost danger', title: () => (t('act.remove')), onclick: () => ((state.base = null), emit('base')) }, icon('close'))
    )
  );
  const f1 = h('div', { class: 'fld' });
  makeSlider(f1, { label: () => (t('f.strength')), min: 0.01, max: 0.99, step: 0.01, get: () => b.strength, set: (v) => ((b.strength = v), updateCost()) });
  const f2 = h('div', { class: 'fld' });
  makeSlider(f2, { label: () => (t('f.noiseAmt')), min: 0, max: 0.99, step: 0.01, get: () => b.noise, set: (v) => (b.noise = v) });
  const acts = h(
    'div',
    { class: 'row wrap', style: { gap: '6px' } },
    h('button', { class: 'btn sm', onclick: () => hooks.openInpaint?.() }, icon('brush'), () => (t(b.mask ? 'act.editMask' : 'act.paintMask'))),
    b.mask ? h('button', { class: 'btn sm', onclick: () => ((b.mask = null), (b.maskPreview = null), emit('base')) }, icon('close'), () => (t('copy.ui.panel.9'))) : null
  );
  ctl.append(f1, f2, acts);
  body.replaceChildren(h('div', { class: 'refcard' }, thumb, ctl), h('p', { class: 'hint' }, () => (t(b.mask ? 'hint.inpaint' : 'hint.img2img'))));
}

// vibe transfer
export async function addVibe(src) {
  if (state.vibes.length >= 16) return toast(() => (t('toast.maxVibes')), 'warn');
  const url = typeof src === 'string' ? src : (await readImageFile(src)).url;
  const m = effectiveModel();
  state.vibes.push({ id: uid(), image: url, ie: m.vibeIE || 1, strength: 0.6, enabled: true, enc: {} });
  emit('vibes');
  expandSection('vibe');
}

function renderVibes() {
  const list = $('#vibeList');
  const m = modelById(P.model);
  const eff = effectiveModel();
  $('#vibeCount').textContent = String(state.vibes.length);
  $('#vibeCount').classList.toggle('on', state.vibes.some((v) => v.enabled));
  list.replaceChildren(
    ...state.vibes.map((v, i) => {
      const f1 = h('div', { class: 'fld' });
      makeSlider(f1, { label: () => (t('f.ie')), min: 0.01, max: 1, step: 0.01, get: () => v.ie, set: (x) => ((v.ie = x), emit('vibes'), updateEncTag()) });
      const f2 = h('div', { class: 'fld' });
      makeSlider(f2, { label: () => (t('f.refStrength')), min: -1, max: 1, step: 0.01, get: () => v.strength, set: (x) => ((v.strength = x), emit('vibes')) });
      const enc = h('span', { class: 'vibe-enc' });
      const updateEncTag = () => {
        if (eff.v3) {
          enc.textContent = 'RAW · V3';
          enc.className = 'vibe-enc ok';
          return;
        }
        const has = v.enc?.[vibeKey(eff.id, v.ie)];
        enc.textContent = has ? 'ENCODED ✓' : 'ENCODE · 2◈';
        enc.className = 'vibe-enc' + (has ? ' ok' : '');
      };
      updateEncTag();
      return h(
        'div',
        { class: 'refcard compact' + (v.enabled ? '' : ' off'), style: { opacity: v.enabled ? 1 : 0.45 } },
        h('div', { class: 'ref-thumb' }, h('img', { src: v.image, alt: '' })),
        h(
          'div',
          { class: 'ref-ctl' },
          h(
            'div',
            { class: 'ref-top' },
            h('span', { class: 'mode' }, 'V' + String(i + 1).padStart(2, '0')),
            enc,
            h('button', { class: 'btn sm sq ghost', onclick: () => ((v.enabled = !v.enabled), emit('vibes')) }, icon(v.enabled ? 'eye' : 'eyeoff')),
            h('button', { class: 'btn sm sq ghost danger', onclick: () => (state.vibes.splice(i, 1), emit('vibes')) }, icon('close'))
          ),
          f1,
          f2
        )
      );
    })
  );
  const hint = $('#vibeHint');
  const notes = [];
  const vibeOk = !!m.vibes;
  if (!vibeOk) notes.push(lang5('vibe'));
  else {
    if ((state.refs || []).length) notes.push(t('hint.refVibeConflict'));
    notes.push(eff.v3 ? t('hint.vibeV3') : t('hint.vibeV4'));
  }
  hint.textContent = notes.join(' ');
  unsupportedSection('secVibe', !vibeOk, state.vibes.length > 0);
  $('#btnAddVibe').onclick = async () => {
    const files = await pickFile('image/*', true);
    for (const f of files || []) await addVibe(f);
  };
}

function lang5(kind) {
  const zh = document.documentElement.lang.startsWith('zh');
  const what = kind === 'vibe' ? ((getLang() === 'zh') ? '氛围迁移' : 'Vibe Transfer') : (getLang() === 'zh') ? '精确参考' : 'Precise Reference';
  return (getLang() === 'zh') ? `当前模型不支持${what}。已添加的会让这次生成改用 V4.5。` : `${what} is not available on this model; anything already added makes the generation fall back to V4.5.`;
}

// Grey out a section the selected model cannot use. Items already added stay removable (and trigger
// the official V4.5 fallback), new ones cannot be added.
function unsupportedSection(id, off, hasItems) {
  const sec = $('#' + id);
  if (!sec) return;
  sec.classList.toggle('disabled', off);
  sec.classList.toggle('has-items', hasItems);
  let chip = sec.querySelector('.sec-h .unsup');
  if (off && !chip) {
    chip = h('span', { class: 'badge unsup' }, () => getLang() === 'zh' ? '此模型不支持' : 'not on this model');
    sec.querySelector('.sec-h .sec-x')?.before(chip);
  } else if (!off && chip) chip.remove();
}



// precise reference
export async function addRef(src) {
  const url = typeof src === 'string' ? src : (await readImageFile(src)).url;
  state.refs = state.refs || [];
  state.refs.push({ id: uid(), image: url, type: 'character&style', strength: 1, fidelity: 1 });
  emit('refs');
  expandSection('ref');
}

function renderRefs() {
  const body = $('#refBody');
  const m = modelById(P.model);
  const supported = !!m.refs;
  const refs = state.refs || [];
  const cards = refs.map((r, i) => {
    const typeSeg = h(
      'div',
      { class: 'seg', style: { width: '100%' } },
      ...[
        ['character', 'ref.character'],
        ['style', 'ref.style'],
        ['character&style', 'ref.both'],
      ].map(([v, k]) =>
        h('button', { class: r.type === v ? 'on' : '', style: { flex: 1 }, onclick: () => ((r.type = v), emit('refs')) }, () => (t(k)))
      )
    );
    const f1 = h('div', { class: 'fld' });
    makeSlider(f1, { label: () => (t('f.refStrength')), min: 0, max: 1, step: 0.01, get: () => r.strength, set: (x) => ((r.strength = x), saveRefs()) });
    const f2 = h('div', { class: 'fld' });
    makeSlider(f2, { label: () => (t('f.fidelity')), min: 0, max: 1, step: 0.01, get: () => r.fidelity, set: (x) => ((r.fidelity = x), saveRefs()) });
    return h(
      'div',
      { class: 'refcard' },
      h('div', { class: 'ref-thumb' }, h('img', { src: r.image, alt: '' })),
      h(
        'div',
        { class: 'ref-ctl' },
        h('div', { class: 'ref-top' }, h('span', { class: 'mode' }, 'REF ' + String(i + 1).padStart(2, '0')), h('button', { class: 'btn sm sq ghost danger', onclick: () => (refs.splice(i, 1), emit('refs')) }, icon('close'))),
        typeSeg,
        f1,
        f2
      )
    );
  });
  const add = slot('act.uploadRef', (f) => addRef(f));
  const notes = [];
  if (!supported) notes.push(m.v5 ? lang5('ref') : t('hint.refOnly45'));
  else notes.push(document.documentElement.lang.startsWith('zh') ? '每张参考图每次生成 +5 Anlas，且不享受 Opus 免费额度。' : '+5 Anlas per reference per image; disables Opus free generations.');
  body.replaceChildren(...cards, supported && refs.length < 16 ? add : null, h('p', { class: 'hint' }, notes.join(' ')));
  unsupportedSection('secRef', !supported, refs.length > 0);
}

const saveRefs = () => emit('refs');

// ------------------------------------------------------------ cost / generate button
export function currentCost(ctx) {
  return estimateCost(generationSpec(ctx), state.session);
}

function updateCost() {
  const c = currentCost();
  const live = state.session.live;
  const n = P.nSamples;
  bindCopy($('#genCount'), 'textContent', () => (`${n} ${n > 1 ? t('gen.images') : t('gen.image')}` + (state.base ? (state.base.mask ? ' · INPAINT' : ' · IMG2IMG') : '')));
  const r = $('.gen-r');
  $('#genCost').textContent = live ? fmtNum(c.opusFree && c.total === 0 ? c.per : c.total) : '0';
  r.classList.toggle('free', live && c.opusFree && c.total === 0);
  // only notes that change what happens; demo / free state is already on the top bar and the cost
  const eff = effectiveModel();
  const m = modelById(P.model);
  const bits = [];
  if (eff !== m) bits.push('→ ' + eff.short);
  if (c.tooLarge) bits.push('> 140◈ / IMG');
  if (bits.length) $('#genCount').textContent += ' · ' + bits.join(' · ');
  bindCopy($('#btnGenerate'), 'title', () => ([live ? (c.opusFree ? t('gen.opusFree') : '') : t('gen.demo'), 'Ctrl + Enter'].filter(Boolean).join(' · ')));
  updateSlug();
}

function updateSlug() {
  const eff = effectiveModel();
  const steps = eff.fixed?.steps || P.steps;
  const sampler = (eff.fixed?.sampler || P.sampler).replace(/^k_/, '').toUpperCase();
  const parts = [
    ['MODEL', eff.short],
    ['SIZE', `${P.width}×${P.height}`],
    ['STEPS', steps],
    ['CFG', P.scale],
    ['SAMPLER', sampler],
    ['SEED', P.seed || 'RANDOM'],
  ];
  $('#slug').replaceChildren(...parts.flatMap(([k, v], i) => [
    ...(i ? [h('span', { class: 'sep' }, '/')] : []),
    h('span', {}, () => t('slug.' + k) + ' '), h('b', {}, k === 'SEED' && !P.seed ? (() => t('f.random')) : v),
  ]));
}

export { editors, applyI18n };
