import { bindCopy, getLang } from '../i18n.js';
import { h, makeCanvas, canvasToBlob, loadImage, clamp, uid } from '../util.js';
import { state, on } from '../store.js';
import { toast } from './modal.js';
import { slider } from './slider.js';
import { defaultParams, BANDS, PRESET_OMIT, getPath, setPath, isDirty } from '../post/params.js';
import { labStats } from '../post/match.js';
import { parseCube } from '../post/lut.js';
import { readTextChunks, writeTextChunks, asciiJSON } from '../png.js';

const T = (zh, en) => state.settings.lang === 'en' ? en : zh;
const clone = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const button = (label, fn, attrs = {}) => h('button', { type: 'button', class: 'pw-btn', onclick: fn, ...attrs }, label);
const PAGES = [
  ['color', '调色', 'Color', ['light', 'color', 'curves', 'hsl', 'grading']],
  ['style', '风格', 'Style', ['style']],
  ['detail', '细节', 'Detail', ['detail']],
  ['retouch', '修饰', 'Retouch', ['retouch']],
];
let session = null;
export const postActive = () => !!session;

export async function enterPost(rec, deps = {}) {
  if (session) {
    session.deps = { ...session.deps, ...deps };
    return setPostRecord(rec);
  }
  const panel = document.getElementById('postPanel'), view = document.getElementById('postView');
  if (!panel || !view) throw new Error(T('缺少后处理面板或预览区域', 'Missing #postPanel / #postView'));
  if (typeof deps.onExport !== 'function') throw new Error(T('缺少导出回调', 'onExport callback required'));
  const editor = createWorkbench(panel, view, deps);
  session = editor;
  document.body.classList.add('post-mode');
  panel.hidden = view.hidden = false;
  try {
    editor.init();
    await editor.setRecord(rec);
  } catch (error) {
    if (session === editor) exitPost();
    throw error;
  }
}

export async function setPostRecord(rec) {
  if (session) return session.setRecord(rec);
}

export function exitPost() {
  if (!session) return;
  const editor = session;
  session = null;
  editor.destroy();
  document.body.classList.remove('post-mode');
  editor.deps.onExit?.();
}

// Keeps the old main.js import working until the main integration lands.
export const openWorkbench = (rec, deps) => enterPost(rec, { getBlob: r => Promise.resolve(r.blob), ...deps });

function readStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

// Whitelist schema keys; do not accept arbitrary paths from stored presets.
function mergeSchema(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const key of Object.keys(target)) {
    if (!(key in source)) continue;
    const a = target[key], b = source[key];
    if (Array.isArray(a)) {
      if (Array.isArray(b) && b.length >= 2 && b.length <= 64 && b.every(pt => Array.isArray(pt) && pt.length === 2 && pt.every(v => Number.isFinite(v) && v >= 0 && v <= 1))) {
        target[key] = clone(b).sort((x, y) => x[0] - y[0]);
      }
    } else if (a && typeof a === 'object') mergeSchema(a, b);
    else if (a === null) {
      if (b?.mean?.length === 3 && b?.std?.length === 3 && [...b.mean, ...b.std].every(Number.isFinite)) target[key] = clone(b);
    } else if (typeof a === typeof b && (typeof b !== 'number' || Number.isFinite(b))) target[key] = b;
  }
  return target;
}

function presetParams(params) {
  const result = clone(params);
  for (const path of PRESET_OMIT) {
    const parts = path.split('.');
    delete getPath(result, parts.slice(0, -1).join('.'))[parts.at(-1)];
  }
  result.style.lut = { name: params.style.lut.name, size: params.style.lut.size };
  return result;
}

function createWorkbench(panel, host, deps) {
  let initialization;
  const api = { deps, init: () => initialization ||= init(), setRecord, destroy };
  let params = defaultParams(), page = 'color', presetName = '';
  let renderer, source, sourceBlob, record, width = 1, height = 1;
  let disposed = false, loading = true, busy = false, loadVersion = 0, referenceVersion = 0;
  let frame = 0, compare = false, groupCompare = null, actual = false, pan = [0, 0];
  let mask = makeCanvas(1, 1), strokes = [], maskDirty = false, gesture = null;
  let history = [], historyIndex = -1, pendingRecord = null;
  let groups = [], curveDraw = null;
  const restoredFocus = document.activeElement;
  const lutCache = new Map();
  const storedUI = readStorage('nf.postUI', {});
  const ui = storedUI && typeof storedUI === 'object' && !Array.isArray(storedUI) ? storedUI : {};
  let presets = readStorage('nf.postPresets', []);
  if (!Array.isArray(presets)) presets = [];
  presets = presets.filter(p => p && typeof p.name === 'string' && p.params);
  const abort = new AbortController();
  const pill = h('span', { class: 'pw-pill', hidden: true });
  const tabs = h('nav', { class: 'pw-tabs post-tabs', role: 'tablist', 'aria-label': () => (T('后处理', 'Post processing')) });
  const content = h('div', { class: 'pw-content', role: 'tabpanel', id: 'postTabContent' });
  const saveRow = h('div', { class: 'pw-save-row', hidden: true });
  const save = button(() => (T('存为预设', 'Save preset')), showSave, { id: 'postSavePreset' });
  const exportBtn = button(() => (T('导出', 'Export')), exportImage, { class: 'pw-btn primary', id: 'postExport' });
  panel.replaceChildren(h('header', { class: 'pw-header' }, button(() => (T('← 结束处理', '← Finish')), exitPost), pill), tabs, content,
    h('footer', { class: 'pw-footer post-footer' }, saveRow, h('div', { class: 'pw-actions' }, save, exportBtn)));
  const canvas = makeCanvas(1, 1);
  canvas.id = 'postCanvas';
  bindCopy(canvas, 'aria-label', () => T('后处理预览', 'Post preview'));
  const overlay = makeCanvas(1, 1);
  overlay.className = 'pw-watermark';
  overlay.setAttribute('aria-hidden', 'true');
  const viewport = h('div', { class: 'pw-viewport' }, canvas, overlay);
  const status = h('span', { class: 'pw-dim', role: 'status' });
  const fallback = h('span', { class: 'pw-fallback', hidden: true }, () => (T('兼容预览 · 仅原图与水印', 'Fallback · source & watermark only')));
  const compareBtn = button(() => (T('按住看原图', 'Hold for original')), null, { id: 'postCompare' });
  const undoBtn = button('↶', undo, { title: () => (T('撤销 · Ctrl+Z', 'Undo · Ctrl+Z')), 'aria-label': () => (T('撤销', 'Undo')), id: 'postUndo' });
  const redoBtn = button('↷', redo, { title: () => (T('重做 · Ctrl+Shift+Z', 'Redo · Ctrl+Shift+Z')), 'aria-label': () => (T('重做', 'Redo')), id: 'postRedo' });
  const resetBtn = button(() => (T('全部复位', 'Reset all')), resetAll, { id: 'postReset' });
  const zoom = button(() => (T('适应', 'Fit')), () => { actual = !actual; pan = [0, 0]; update(); schedule(); }, { id: 'postZoom' });
  host.replaceChildren(h('div', { class: 'pw-toolbar post-toolbar' }, compareBtn, undoBtn, redoBtn, resetBtn), viewport,
    h('div', { class: 'pw-viewfoot' }, status, fallback, zoom));
  for (const [key, zh, en] of PAGES) tabs.append(button(() => (T(zh, en)), () => {
    page = key; content.scrollTop = 0; build();
  }, { role: 'tab', 'data-page': key, id: `postTab-${key}`, 'aria-controls': 'postTabContent' }));
  tabs.onkeydown = e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const index = PAGES.findIndex(p => p[0] === page);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? 3 : (index + (e.key === 'ArrowRight' ? 1 : 3)) % 4;
    tabs.children[next].click(); tabs.children[next].focus();
  };
  hold(compareBtn, value => { compare = value; schedule(); });
  const ro = new ResizeObserver(resize);
  ro.observe(viewport);
  const themeObserver = new MutationObserver(() => { curveDraw?.(); schedule(); });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
  window.addEventListener('resize', resize, { signal: abort.signal });
  window.addEventListener('blur', releaseCompare, { signal: abort.signal });
  document.addEventListener('keydown', keydown, { capture: true, signal: abort.signal });
  document.addEventListener('keyup', e => {
    if (e.code === 'Space' && compare) { e.preventDefault(); e.stopImmediatePropagation(); releaseCompare(); }
  }, { capture: true, signal: abort.signal });
  canvas.onpointerdown = startGesture;
  canvas.onpointermove = moveGesture;
  canvas.onpointerup = endGesture;
  canvas.onpointercancel = () => endGesture(null, true);
  canvas.onlostpointercapture = () => endGesture(null, true);
  build(); commit();
  const unsubscribeLang = on('settings.lang', update);

  async function init() {
    const mod = await import('../post/gl.js').catch(() => import('../post/gl.stub.js'));
    const selected = await mod.supported() ? mod : await import('../post/gl.stub.js');
    if (disposed) return;
    renderer = selected.createRenderer(canvas);
    fallback.hidden = !renderer.caps?.stub;
    resize();
  }

  async function setRecord(rec) {
    const version = ++loadVersion;
    await initialization;
    // onExport may itself select an archive record. Queue without awaiting the
    // callback, otherwise an onExport -> setPostRecord cycle would deadlock.
    if (busy) { pendingRecord = rec; return; }
    if (disposed || version !== loadVersion) return;
    loading = true; update();
    let url;
    try {
      const blob = await (api.deps.getBlob ? api.deps.getBlob(rec) : rec.blob);
      if (!(blob instanceof Blob)) throw new Error(T('档案图片不可用', 'Archive image unavailable'));
      url = URL.createObjectURL(blob);
      const img = await loadImage(url);
      if (disposed || version !== loadVersion) return;
      endGesture(null, true);
      renderer.setSource(img);
      source = img; sourceBlob = blob; record = rec;
      width = img.naturalWidth; height = img.naturalHeight;
      mask = makeCanvas(width, height); strokes = [];
      // Parameter history survives a source switch; masks never cross image boundaries.
      history.forEach(entry => { entry.strokes = []; });
      renderer.setMask(null); pan = [0, 0];
      status.textContent = `${width} × ${height}`;
      syncLUT(); schedule();
    } catch (error) {
      if (!disposed && version === loadVersion) toast(error.message, 'err');
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (!disposed && version === loadVersion) { loading = false; update(); }
    }
  }

  function dirty(path) {
    if ((path === 'retouch' || path === 'retouch.mosaic') && strokes.length) return true;
    // isDirty ignores text and names. A watermark still changes pixels.
    if ((!path || path === 'retouch' || path === 'retouch.watermark') && params.retouch.watermark.text) return true;
    return isDirty(params, path);
  }
  function update() {
    const changed = dirty() || strokes.length > 0;
    const unavailable = loading || busy || !source;
    exportBtn.disabled = unavailable || !changed;
    save.disabled = unavailable || !changed;
    content.inert = busy; saveRow.inert = busy;
    undoBtn.disabled = unavailable || historyIndex < 1;
    redoBtn.disabled = unavailable || historyIndex >= history.length - 1;
    resetBtn.disabled = unavailable || !changed;
    bindCopy(exportBtn, 'textContent', () => (busy ? T('导出中…', 'Exporting…') : T('导出', 'Export')));
    bindCopy(zoom, 'textContent', () => (actual ? '1:1' : T('适应', 'Fit')));
    zoom.setAttribute('aria-pressed', String(actual));
    pill.hidden = !presetName; pill.textContent = presetName;
    viewport.classList.toggle('painting', page === 'retouch' && params.retouch.mosaic.mode !== 'off');
    viewport.classList.toggle('actual', actual);
    for (const [i, entry] of PAGES.entries()) {
      const tab = tabs.children[i];
      tab.classList.toggle('on', entry[0] === page);
      tab.classList.toggle('dirty', entry[3].some(dirty));
      tab.setAttribute('aria-selected', String(entry[0] === page));
      tab.tabIndex = entry[0] === page ? 0 : -1;
    }
    content.setAttribute('aria-labelledby', `postTab-${page}`);
    for (const group of groups) group.actions.hidden = !group.paths.some(dirty);
  }
  function schedule() {
    if (!disposed && !frame) frame = requestAnimationFrame(render);
  }
  // Destination rectangle and scale in backing pixels; pan is stored in CSS pixels.
  function viewRect() {
    const dpr = devicePixelRatio || 1;
    const scale = actual ? dpr : Math.max(0.001, Math.min((canvas.width - 32 * dpr) / width, (canvas.height - 32 * dpr) / height));
    return { x: (canvas.width - width * scale) / 2 + pan[0] * dpr,
      y: (canvas.height - height * scale) / 2 + pan[1] * dpr,
      width: width * scale, height: height * scale, scale };
  }
  function render() {
    frame = 0;
    if (disposed || !renderer || !source) return;
    let visible = params;
    if (groupCompare) {
      visible = clone(params);
      for (const path of groupCompare) setPath(visible, path, clone(getPath(defaultParams(), path)));
    }
    if (maskDirty) { renderer.setMask(strokes.length || gesture?.stroke ? mask : null); maskDirty = false; }
    const hideMask = groupCompare?.includes('retouch.mosaic');
    if (hideMask) renderer.setMask(null);
    try {
      const destination = viewRect();
      // gl.js views are rectangles in source pixels, including the surrounding matte.
      renderer.render(visible, { compare, view: {
        x: -destination.x / destination.scale, y: -destination.y / destination.scale,
        w: canvas.width / destination.scale, h: canvas.height / destination.scale,
      } });
      const ctx = overlay.getContext('2d');
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      if (!compare) {
        const rect = viewRect();
        ctx.save(); ctx.translate(rect.x, rect.y); ctx.scale(rect.scale, rect.scale);
        drawWatermark(ctx, width, height, visible.retouch.watermark); ctx.restore();
      }
    } catch (error) { toast(error.message, 'err'); }
    finally { if (hideMask) renderer.setMask(strokes.length ? mask : null); }
  }
  function resize() {
    if (disposed) return;
    const rect = viewport.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = overlay.width = w; canvas.height = overlay.height = h;
    }
    schedule();
  }
  function commit() {
    if (disposed) return;
    const entry = { params: clone(params), strokes: strokes.slice(), presetName };
    if (historyIndex >= 0 && equal(entry, history[historyIndex])) { update(); return; }
    history.splice(historyIndex + 1); history.push(entry);
    if (history.length > 80) history.shift();
    historyIndex = history.length - 1; update();
  }
  function restore(entry) {
    params = clone(entry.params); strokes = entry.strokes.slice(); presetName = entry.presetName;
    rebuildMask(); syncLUT(); build(); schedule();
  }
  function undo() {
    if (!busy && !loading && historyIndex > 0) restore(history[--historyIndex]);
  }
  function redo() {
    if (!busy && !loading && historyIndex < history.length - 1) restore(history[++historyIndex]);
  }
  function resetAll() {
    if (busy || loading) return;
    params = defaultParams(); strokes = []; presetName = '';
    rebuildMask(); syncLUT(); commit(); build(); schedule();
  }
  function changed(commitNow = true) {
    update(); schedule();
    if (commitNow) commit();
  }
  function hold(node, set) {
    node.onpointerdown = e => {
      if (e.button !== 0) return;
      e.preventDefault(); node.setPointerCapture(e.pointerId); set(true);
    };
    node.onpointerup = node.onpointercancel = node.onlostpointercapture = () => set(false);
    node.onkeydown = e => {
      if (e.key === 'Enter' || e.code === 'Space') { e.preventDefault(); set(true); }
    };
    node.onkeyup = node.onblur = () => set(false);
  }
  function releaseCompare() { compare = false; groupCompare = null; schedule(); }
  function keydown(e) {
    if (e.target.closest('textarea, select, [contenteditable="true"], .modal-bg') ||
      (e.target.closest('input') && !e.target.matches('input[type="range"], input[type="checkbox"]'))) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!e.repeat) (e.shiftKey ? redo : undo)();
    } else if (e.code === 'Space') {
      e.preventDefault(); e.stopImmediatePropagation(); compare = true; schedule();
    }
  }

  function section(zh, en, paths = [], open = true) {
    const key = paths.join(',') || 'presets';
    const body = h('div', { class: 'pw-section-body' });
    const actions = h('span', { class: 'pw-group-actions', hidden: true });
    const compareGroup = button('◧', e => e.preventDefault(), { title: () => (T('按住对比本组', 'Hold to compare group')), 'aria-label': () => (T('按住对比本组', 'Hold to compare group')) });
    hold(compareGroup, value => { groupCompare = value ? paths : null; schedule(); });
    const reset = button('↺', e => {
      e.preventDefault();
      for (const path of paths) setPath(params, path, clone(getPath(defaultParams(), path)));
      if (paths.includes('retouch.mosaic')) { strokes = []; rebuildMask(); }
      syncLUT(); changed(); build();
    }, { title: () => (T('复位本组', 'Reset group')), 'aria-label': () => (T('复位本组', 'Reset group')) });
    actions.append(compareGroup, reset);
    const details = h('details', { class: 'pw-section', open: typeof ui[key] === 'boolean' ? ui[key] : open, 'data-group': key },
      h('summary', {}, h('span', {}, () => (T(zh, en))), actions), body);
    details.ontoggle = () => {
      if (!details.isConnected) return;
      ui[key] = details.open;
      try { localStorage.setItem('nf.postUI', JSON.stringify(ui)); } catch { /* Folding persistence is optional. */ }
    };
    content.append(details);
    if (paths.length) groups.push({ paths, actions });
    return body;
  }
  function addSlider(host, path, zh, en) {
    return slider(host, { label: () => T(zh, en), path, params, onChange: (_, event) => changed(event.commit) });
  }
  function sliders(host, prefix, entries) {
    for (const [key, zh, en] of entries) addSlider(host, `${prefix}.${key}`, zh, en);
  }
  function segments(host, path, entries) {
    const row = h('div', { class: 'pw-segments', role: 'group' });
    for (const [value, zh, en] of entries) row.append(button(() => (T(zh, en)), () => {
      setPath(params, path, value);
      for (const b of row.children) {
        const selected = b.dataset.value === String(value);
        b.classList.toggle('on', selected); b.setAttribute('aria-pressed', String(selected));
      }
      changed();
    }, { 'data-value': value, class: `pw-btn${getPath(params, path) === value ? ' on' : ''}`, 'aria-pressed': String(getPath(params, path) === value) }));
    host.append(row);
  }
  function check(host, path, zh, en) {
    host.append(h('label', { class: 'pw-check' }, h('input', { type: 'checkbox', checked: getPath(params, path),
      onchange: e => { setPath(params, path, e.target.checked); changed(); } }), () => (T(zh, en))));
  }
  function build() {
    const scroll = content.scrollTop;
    content.replaceChildren(); groups = []; curveDraw = null;
    buildPresets(section('预设', 'Presets'));
    if (page === 'color') buildColor();
    if (page === 'style') buildStyle();
    if (page === 'detail') buildDetail();
    if (page === 'retouch') buildRetouch();
    content.scrollTop = scroll; update();
  }
  function buildColor() {
    sliders(section('光线', 'Light', ['light']), 'light', [
      ['exposure', '曝光', 'Exposure'], ['brightness', '亮度', 'Brightness'], ['contrast', '对比度', 'Contrast'],
      ['highlights', '高光', 'Highlights'], ['shadows', '阴影', 'Shadows'], ['whites', '白色', 'Whites'], ['blacks', '黑色', 'Blacks'],
    ]);
    sliders(section('颜色', 'Color', ['color']), 'color', [
      ['temp', '色温', 'Temperature'], ['tint', '色调', 'Tint'], ['hue', '色相', 'Hue'],
      ['vibrance', '自然饱和度', 'Vibrance'], ['saturation', '饱和度', 'Saturation'],
    ]);
    buildCurves(section('曲线', 'Curves', ['curves'], false));
    const hs = section('HSL 混色', 'HSL mixer', ['hsl'], false);
    const hsTabs = h('div', { class: 'pw-segments' }), hsBody = h('div', { class: 'pw-stack' });
    let channel = 'h';
    const names = ['红', '橙', '黄', '绿', '青', '蓝', '紫', '品红'];
    function paintHSL() {
      hsBody.replaceChildren();
      [...hsTabs.children].forEach(b => b.classList.toggle('on', b.dataset.channel === channel));
      BANDS.forEach((band, i) => {
        const row = h('div', { class: `pw-band band-${band}` });
        addSlider(row, `hsl.${band}.${channel}`, names[i], band); hsBody.append(row);
      });
    }
    for (const [key, zh, en] of [['h', '色相', 'Hue'], ['s', '饱和', 'Saturation'], ['l', '明度', 'Lightness']]) {
      hsTabs.append(button(() => (T(zh, en)), () => { channel = key; paintHSL(); }, { 'data-channel': key }));
    }
    hs.append(hsTabs, hsBody); paintHSL();
    const grade = section('色调分级', 'Color grading', ['grading'], false);
    const select = h('select', { class: 'pw-input', 'aria-label': () => (T('色调范围', 'Tonal range')) });
    for (const [key, zh, en] of [['shadows', '阴影', 'Shadows'], ['midtones', '中间调', 'Midtones'], ['highlights', '高光', 'Highlights'], ['global', '全局', 'Global']]) {
      select.append(h('option', { value: key }, () => (T(zh, en))));
    }
    const gradeBody = h('div', { class: 'pw-stack' });
    const paintGrade = () => {
      gradeBody.replaceChildren();
      sliders(gradeBody, `grading.${select.value}`, [['hue', '色相', 'Hue'], ['sat', '饱和度', 'Saturation'], ['lum', '明度', 'Lightness']]);
    };
    select.onchange = paintGrade;
    grade.append(select, gradeBody); paintGrade();
    sliders(grade, 'grading', [['blend', '混合', 'Blend'], ['balance', '平衡', 'Balance']]);
  }
  function buildCurves(host) {
    let channel = 'rgb', selected = -1;
    const row = h('div', { class: 'pw-segments' });
    const graph = makeCanvas(200, 140);
    graph.className = 'pw-curve'; graph.tabIndex = 0;
    bindCopy(graph, 'aria-label', () => T('曲线：点击加点，拖动调整，双击删点', 'Curve: click to add, drag to move, double-click to delete'));
    const point = e => {
      const r = graph.getBoundingClientRect();
      return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp(1 - (e.clientY - r.top) / r.height, 0, 1)];
    };
    const nearest = p => params.curves[channel].findIndex(q => Math.hypot((p[0] - q[0]) * 200, (p[1] - q[1]) * 140) < 10);
    function draw() {
      const ctx = graph.getContext('2d'), css = getComputedStyle(panel);
      ctx.clearRect(0, 0, 200, 140);
      ctx.strokeStyle = css.getPropertyValue('--line-2'); ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        ctx.beginPath(); ctx.moveTo(i * 50, 0); ctx.lineTo(i * 50, 140); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i * 35); ctx.lineTo(200, i * 35); ctx.stroke();
      }
      ctx.strokeStyle = css.getPropertyValue('--acc'); ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 2;
      ctx.beginPath();
      params.curves[channel].forEach(([x, y], i) => i ? ctx.lineTo(x * 200, (1 - y) * 140) : ctx.moveTo(x * 200, (1 - y) * 140));
      ctx.stroke();
      for (const [x, y] of params.curves[channel]) { ctx.beginPath(); ctx.arc(x * 200, (1 - y) * 140, 4, 0, Math.PI * 2); ctx.fill(); }
      [...row.children].forEach(b => b.classList.toggle('on', b.dataset.channel === channel));
    }
    for (const key of ['rgb', 'r', 'g', 'b']) row.append(button(key.toUpperCase(), () => { channel = key; draw(); }, { 'data-channel': key }));
    graph.onpointerdown = e => {
      if (e.button !== 0) return;
      graph.setPointerCapture(e.pointerId);
      const p = point(e), points = params.curves[channel];
      selected = nearest(p);
      if (selected < 0 && points.length < 64) {
        p[0] = clamp(p[0], 0.001, 0.999);
        points.push(p); points.sort((a, b) => a[0] - b[0]); selected = points.indexOf(p);
      }
      draw(); changed(false);
    };
    graph.onpointermove = e => {
      if (selected < 0) return;
      const points = params.curves[channel], p = point(e);
      p[0] = selected === 0 ? 0 : selected === points.length - 1 ? 1 : clamp(p[0], points[selected - 1][0] + 0.001, points[selected + 1][0] - 0.001);
      points[selected] = p; draw(); changed(false);
    };
    graph.onpointerup = graph.onpointercancel = () => { selected = -1; commit(); };
    graph.ondblclick = e => {
      const at = nearest(point(e)), points = params.curves[channel];
      if (at > 0 && at < points.length - 1) { points.splice(at, 1); draw(); changed(); }
    };
    host.append(row, graph, h('small', { class: 'pw-note' }, () => (T('点击加点 · 双击删点', 'Click to add · double-click to delete'))));
    curveDraw = draw; draw();
  }
  function upload(host, label, accept, receive) {
    const input = h('input', { type: 'file', accept, hidden: true });
    const drop = button(label, () => input.click(), { class: 'pw-btn pw-drop' });
    async function take(file) {
      if (!file || disposed || busy) return;
      try { await receive(file); } catch (error) { if (!disposed) toast(error.message, 'err'); }
      finally { input.value = ''; }
    }
    input.onchange = () => take(input.files[0]);
    drop.ondragover = e => { e.preventDefault(); e.stopPropagation(); drop.classList.add('dragover'); };
    drop.ondragleave = () => drop.classList.remove('dragover');
    drop.ondrop = e => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('dragover'); take(e.dataTransfer.files[0]); };
    host.append(drop, input);
  }
  function captureStats(img) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const ratio = Math.min(1, 512 / Math.max(w, h));
    const c = makeCanvas(Math.max(1, Math.round(w * ratio)), Math.max(1, Math.round(h * ratio)));
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, c.width, c.height);
    return labStats(ctx.getImageData(0, 0, c.width, c.height));
  }
  function buildStyle() {
    const match = section('仿制色调', 'Match colors', ['style.match']);
    upload(match, () => params.style.match.name || T('拖入 / 选择参考图', 'Drop / choose reference'), 'image/*', async file => {
      const version = ++referenceVersion;
      const url = URL.createObjectURL(file);
      try {
        const img = await loadImage(url);
        if (disposed || version !== referenceVersion) return;
        params.style.match = { ...params.style.match, enabled: true, name: file.name, stats: captureStats(img) };
        changed(); build();
      } finally { URL.revokeObjectURL(url); }
    });
    match.append(button(() => (T('以当前图为参考', 'Use current image')), () => {
      if (!source || loading) return;
      referenceVersion++;
      params.style.match = { ...params.style.match, enabled: true, name: T('当前图', 'Current image'), stats: captureStats(source) };
      changed(); build();
    }));
    check(match, 'style.match.enabled', '启用', 'Enabled');
    addSlider(match, 'style.match.strength', '强度', 'Strength');
    const lut = section('LUT', 'LUT', ['style.lut']);
    upload(lut, () => params.style.lut.name || T('拖入 / 选择 .cube', 'Drop / choose .cube'), '.cube', async file => {
      if (file.size > 16000000) throw new Error(T('LUT 文件过大', 'LUT file too large'));
      const parsed = parseCube(await file.text());
      if (disposed) return;
      lutCache.set(`${file.name}:${parsed.size}`, rendererLUT(parsed));
      params.style.lut = { ...params.style.lut, enabled: true, name: file.name, size: parsed.size };
      syncLUT(); changed(); build();
    });
    if (params.style.lut.name && !lutCache.has(lutKey())) lut.append(h('small', { class: 'pw-note' }, () => (T('请重新选择此 LUT 文件。', 'Please select this LUT file again.'))));
    check(lut, 'style.lut.enabled', '启用', 'Enabled');
    addSlider(lut, 'style.lut.strength', '强度', 'Strength');
  }
  function lutKey() { return `${params.style.lut.name}:${params.style.lut.size}`; }
  function syncLUT() { renderer?.setLUT(lutCache.get(lutKey()) || null); }
  function buildDetail() {
    sliders(section('锐化', 'Sharpen', ['detail.sharpen']), 'detail.sharpen', [['amount', '数量', 'Amount'], ['radius', '半径', 'Radius'], ['threshold', '阈值', 'Threshold']]);
    sliders(section('质感', 'Texture', ['detail.clarity', 'detail.texture', 'detail.dehaze']), 'detail', [['clarity', '清晰度', 'Clarity'], ['texture', '纹理', 'Texture'], ['dehaze', '去朦胧', 'Dehaze']]);
    sliders(section('暗角', 'Vignette', ['detail.vignette'], false), 'detail.vignette', [['amount', '数量', 'Amount'], ['midpoint', '中点', 'Midpoint'], ['feather', '羽化', 'Feather'], ['roundness', '圆度', 'Roundness']]);
    const grain = section('杂色', 'Grain', ['detail.grain'], false);
    sliders(grain, 'detail.grain', [['amount', '数量', 'Amount'], ['size', '大小', 'Size']]);
    check(grain, 'detail.grain.mono', '单色', 'Monochrome'); check(grain, 'detail.grain.soft', '柔和', 'Soft');
    const aberration = section('色散', 'Aberration', ['detail.aberration'], false);
    segments(aberration, 'detail.aberration.mode', [['radial', '径向', 'Radial'], ['linear', '线性', 'Linear']]);
    sliders(aberration, 'detail.aberration', [['rc', '红 / 青', 'Red / cyan'], ['by', '蓝 / 黄', 'Blue / yellow'], ['edge', '边缘', 'Edge']]);
  }
  function buildRetouch() {
    const mosaic = section('马赛克', 'Mosaic', ['retouch.mosaic']);
    segments(mosaic, 'retouch.mosaic.mode', [['off', '关闭', 'Off'], ['paint', '涂抹', 'Paint'], ['erase', '擦除', 'Erase']]);
    sliders(mosaic, 'retouch.mosaic', [['size', '笔刷大小 %', 'Brush size %'], ['hardness', '硬度 %', 'Hardness %']]);
    segments(mosaic, 'retouch.mosaic.style', [['pixel', '像素块', 'Pixel'], ['blur', '模糊', 'Blur']]);
    addSlider(mosaic, 'retouch.mosaic.cell', '格子大小 %', 'Cell size %');
    mosaic.append(h('div', { class: 'pw-actions' }, button(() => (T('撤回一笔', 'Undo stroke')), () => {
      if (!strokes.length) return;
      strokes = strokes.slice(0, -1); rebuildMask(); changed();
    }), button(() => (T('清除', 'Clear')), () => { strokes = []; rebuildMask(); changed(); })));
    const watermark = section('水印', 'Watermark', ['retouch.watermark']);
    watermark.append(h('input', { class: 'pw-input', type: 'text', value: params.retouch.watermark.text, maxLength: 160,
      placeholder: () => (T('水印文字', 'Watermark text')), 'aria-label': () => (T('水印文字', 'Watermark text')),
      oninput: e => { params.retouch.watermark.text = e.target.value; changed(false); }, onchange: () => commit() }));
    const grid = h('div', { class: 'pw-grid', role: 'group', 'aria-label': () => (T('水印位置', 'Watermark position')) });
    for (let i = 0; i < 9; i++) grid.append(button(['↖', '↑', '↗', '←', '·', '→', '↙', '↓', '↘'][i], () => {
      params.retouch.watermark.position = i;
      [...grid.children].forEach((b, n) => { b.classList.toggle('on', i === n); b.setAttribute('aria-pressed', String(i === n)); });
      changed();
    }, { class: `pw-btn${params.retouch.watermark.position === i ? ' on' : ''}`, 'aria-label': () => (T('位置 ', 'Position ') + (i + 1)), 'aria-pressed': String(params.retouch.watermark.position === i) }));
    watermark.append(grid);
    sliders(watermark, 'retouch.watermark', [['size', '大小 %', 'Size %'], ['opacity', '不透明度', 'Opacity']]);
    watermark.append(h('label', { class: 'pw-color' }, () => (T('颜色', 'Color')), h('input', { type: 'color', value: params.retouch.watermark.color,
      oninput: e => { params.retouch.watermark.color = e.target.value; changed(false); }, onchange: () => commit() })));
    segments(section('元数据', 'Metadata', ['retouch.meta']), 'retouch.meta', [['all', '所有参数', 'All parameters'], ['post', '仅后处理', 'Post only'], ['none', '无', 'None']]);
  }
  function buildPresets(host) {
    host.classList.add('post-presets');
    if (!presets.length) host.append(h('small', { class: 'pw-note' }, () => (T('调好后，点下方「存为预设」。', 'Adjust, then save a preset below.'))));
    for (const preset of presets) {
      const row = h('div', { class: 'pw-preset' });
      const name = button(preset.name, () => loadPreset(preset), { class: 'pw-btn pw-preset-name' });
      row.append(name, button('✎', () => {
        const input = h('input', { class: 'pw-input', value: preset.name, maxLength: 60, 'aria-label': () => (T('预设名称', 'Preset name')) });
        const done = () => {
          const next = input.value.trim();
          if (!next) return input.focus();
          const previous = preset.name;
          preset.name = next;
          if (writePresets()) { if (presetName === previous) presetName = next; build(); }
          else preset.name = previous;
        };
        row.replaceChildren(input, button(() => (T('保存', 'Save')), done), button(() => (T('取消', 'Cancel')), build));
        input.onkeydown = e => { if (e.key === 'Enter') done(); if (e.key === 'Escape') build(); };
        input.focus(); input.select();
      }, { title: () => (T('重命名', 'Rename')), 'aria-label': () => (T('重命名', 'Rename')) }), button('×', () => {
        const previous = presets;
        presets = presets.filter(p => p !== preset);
        if (writePresets()) { if (presetName === preset.name) presetName = ''; build(); }
        else presets = previous;
      }, { title: () => (T('删除预设', 'Delete preset')), 'aria-label': () => (T('删除预设', 'Delete preset')) }));
      host.append(row);
    }
  }
  function writePresets() {
    try { localStorage.setItem('nf.postPresets', JSON.stringify(presets)); return true; }
    catch { toast(() => (T('预设保存失败：存储空间不足', 'Preset storage unavailable')), 'err'); return false; }
  }
  function showSave() {
    if (save.disabled) return;
    const input = h('input', { class: 'pw-input', value: T('预设 ', 'Preset ') + (presets.length + 1), maxLength: 60, 'aria-label': () => (T('预设名称', 'Preset name')) });
    const done = () => {
      const name = input.value.trim();
      if (!name) return input.focus();
      const item = { id: uid(), name, params: presetParams(params) };
      presets.push(item);
      if (!writePresets()) { presets.pop(); return; }
      presetName = name; saveRow.hidden = true; build();
      toast(() => (T(`已保存预设「${name}」`, `Saved preset “${name}”`)));
    };
    saveRow.replaceChildren(input, button(() => (T('保存', 'Save')), done), button(() => (T('取消', 'Cancel')), () => { saveRow.hidden = true; }));
    input.onkeydown = e => { if (e.key === 'Enter') done(); if (e.key === 'Escape') saveRow.hidden = true; };
    saveRow.hidden = false; input.focus(); input.select();
  }
  function loadPreset(preset) {
    const before = { params: clone(params), strokes: strokes.slice(), presetName };
    const next = mergeSchema(defaultParams(), preset.params);
    for (const path of PRESET_OMIT) setPath(next, path, getPath(params, path));
    next.style.lut.enabled = !!next.style.lut.name && lutCache.has(`${next.style.lut.name}:${next.style.lut.size}`);
    params = next; presetName = preset.name;
    syncLUT(); changed(); build();
    toast(() => (T('已载入预设 · 点击撤销', 'Preset loaded · click to undo')), 'ok', 4500, () => {
      if (disposed || busy) return;
      // A toast must never reintroduce strokes after switching images.
      before.strokes = strokes.slice(); restore(before); commit();
    });
  }
  function sourcePoint(e) {
    const bounds = canvas.getBoundingClientRect(), rect = viewRect();
    return [((e.clientX - bounds.left) * canvas.width / bounds.width - rect.x) / rect.scale,
      ((e.clientY - bounds.top) * canvas.height / bounds.height - rect.y) / rect.scale];
  }
  function stamp(stroke, point) {
    const ctx = mask.getContext('2d'), radius = stroke.size * Math.max(width, height) / 200;
    ctx.save();
    ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
    const gradient = ctx.createRadialGradient(point[0], point[1], 0, point[0], point[1], radius);
    // Mask alpha is data, independent of theme colors.
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(Math.min(0.999, stroke.hardness / 100), 'rgba(255,255,255,1)');
    gradient.addColorStop(1, stroke.hardness === 100 ? 'rgba(255,255,255,1)' : 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(point[0], point[1], radius, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function line(stroke, a, b) {
    const distance = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const step = Math.max(1, stroke.size * Math.max(width, height) / 100 * 0.12);
    const count = Math.max(1, Math.ceil(distance / step));
    for (let i = 1; i <= count; i++) stamp(stroke, [a[0] + (b[0] - a[0]) * i / count, a[1] + (b[1] - a[1]) * i / count]);
  }
  function rebuildMask() {
    mask.getContext('2d').clearRect(0, 0, mask.width, mask.height);
    for (const stroke of strokes) {
      stamp(stroke, stroke.points[0]);
      for (let i = 1; i < stroke.points.length; i++) line(stroke, stroke.points[i - 1], stroke.points[i]);
    }
    maskDirty = true; schedule();
  }
  function startGesture(e) {
    if (busy || loading || !source || e.button !== 0) return;
    const point = sourcePoint(e), tool = params.retouch.mosaic;
    const painting = page === 'retouch' && tool.mode !== 'off' && !e.altKey;
    if (painting && (point[0] < 0 || point[0] > width || point[1] < 0 || point[1] > height)) return;
    canvas.setPointerCapture(e.pointerId);
    if (painting) {
      const stroke = { size: tool.size, hardness: tool.hardness, erase: tool.mode === 'erase', points: [point] };
      gesture = { stroke }; stamp(stroke, point); maskDirty = true; schedule();
    } else if (actual) gesture = { x: e.clientX, y: e.clientY, pan: [...pan] };
  }
  function moveGesture(e) {
    if (!gesture) return;
    if (gesture.stroke) {
      const stroke = gesture.stroke, point = sourcePoint(e), last = stroke.points.at(-1);
      if (Math.hypot(last[0] - point[0], last[1] - point[1]) < 1) return;
      line(stroke, last, point); stroke.points.push(point); maskDirty = true;
    } else pan = [gesture.pan[0] + e.clientX - gesture.x, gesture.pan[1] + e.clientY - gesture.y];
    schedule();
  }
  function endGesture(e, cancel = false) {
    if (!gesture) return;
    const previous = gesture; gesture = null;
    if (previous.stroke) {
      if (cancel) rebuildMask();
      else { strokes = [...strokes, previous.stroke]; maskDirty = true; renderer.setMask(mask); changed(); }
    }
    if (e && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  }
  async function exportImage() {
    if (busy || loading || !source || exportBtn.disabled) return;
    busy = true; update();
    const snapshot = clone(params), blobSource = sourceBlob, sourceId = record.id;
    const exportWidth = width, exportHeight = height, callback = api.deps.onExport;
    try {
      renderer.setMask(strokes.length ? mask : null);
      const data = await renderer.exportImageData(snapshot);
      if (disposed) return;
      const output = makeCanvas(data.width, data.height), ctx = output.getContext('2d');
      ctx.putImageData(data, 0, 0);
      drawWatermark(ctx, data.width, data.height, snapshot.retouch.watermark);
      let blob = await canvasToBlob(output);
      if (!blob) throw new Error(T('PNG 编码失败', 'PNG encoding failed'));
      if (snapshot.retouch.meta !== 'none') {
        const entries = snapshot.retouch.meta === 'all' ? readTextChunks(new Uint8Array(await blobSource.arrayBuffer())) : {};
        entries['noiseform-post'] = asciiJSON(snapshot);
        blob = new Blob([writeTextChunks(new Uint8Array(await blob.arrayBuffer()), entries)], { type: 'image/png' });
      }
      if (disposed) return;
      const result = await callback({ blob, width: exportWidth, height: exportHeight, post: snapshot, sourceId });
      if (!disposed) toast(() => (T('已导出', 'Exported') + (result?.no != null ? ` №${String(result.no).padStart(4, '0')}` : '')));
    } catch (error) { if (!disposed) toast(error.message, 'err'); }
    finally {
      busy = false;
      if (!disposed) {
        update(); schedule();
        if (pendingRecord) {
          const next = pendingRecord; pendingRecord = null;
          void setRecord(next);
        }
      }
    }
  }
  function destroy() {
    unsubscribeLang();
    disposed = true; loadVersion++; referenceVersion++;
    abort.abort(); ro.disconnect(); themeObserver.disconnect(); cancelAnimationFrame(frame);
    renderer?.destroy(); lutCache.clear();
    history = []; strokes = []; source = sourceBlob = null; mask.width = mask.height = 1;
    panel.hidden = host.hidden = true;
    panel.replaceChildren(); host.replaceChildren(); restoredFocus?.focus?.();
  }
  return api;
}

function drawWatermark(ctx, width, height, watermark) {
  if (!watermark.text?.trim()) return;
  const size = Math.max(1, width * watermark.size / 100), pad = width * 0.025;
  const position = clamp(Math.round(watermark.position), 0, 8), col = position % 3, row = Math.floor(position / 3);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
  ctx.globalAlpha = clamp(watermark.opacity / 100, 0, 1);
  ctx.font = `${size}px sans-serif`;
  ctx.textAlign = ['left', 'center', 'right'][col]; ctx.textBaseline = ['top', 'middle', 'bottom'][row];
  ctx.fillStyle = watermark.color;
  ctx.fillText(watermark.text.replace(/\s+/g, ' '), [pad, width / 2, width - pad][col], [pad, height / 2, height - pad][row], width - pad * 2);
  ctx.restore();
}

// The GPU accepts 3D tables. Lift separable 1D CUBE data into a bounded 3D table.
function rendererLUT(lut) {
  if (lut.dimension !== 1) return lut;
  const size = Math.min(65, lut.size), data = new Float32Array(size ** 3 * 3);
  const sample = (value, channel) => {
    const x = value * (lut.size - 1), low = Math.floor(x), high = Math.min(lut.size - 1, low + 1);
    return lut.data[low * 3 + channel] * (1 - x + low) + lut.data[high * 3 + channel] * (x - low);
  };
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const offset = ((b * size + g) * size + r) * 3;
    data[offset] = sample(r / (size - 1), 0);
    data[offset + 1] = sample(g / (size - 1), 1);
    data[offset + 2] = sample(b / (size - 1), 2);
  }
  return { ...lut, dimension: 3, size, data };
}
