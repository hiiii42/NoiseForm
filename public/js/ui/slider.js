import { h, clamp } from '../util.js';
import { defaultParams, RANGES, getPath, setPath } from '../post/params.js';
import { state } from '../store.js';

const T = (zh, en) => state.settings.lang === 'en' ? en : zh;

// Repeating channels share ranges; the parameter contract remains immutable.
function rangeFor(path) {
  if (RANGES[path]) return RANGES[path];
  if (/^hsl\.[^.]+\.[hsl]$/.test(path)) return [-100, 100, 1, true];
  if (/^grading\.[^.]+\.hue$/.test(path)) return [0, 360, 1, false];
  if (/^grading\.[^.]+\.sat$/.test(path)) return [0, 100, 1, false];
  if (/^grading\.[^.]+\.lum$/.test(path)) return [-100, 100, 1, true];
  throw new Error(T(`未知滑杆参数：${path}`, `Unknown slider path: ${path}`));
}

/** onChange(value, {path, commit}): input is live; commit ends a history transaction. */
export function slider(host, { label, path, params, onChange }) {
  const [min, max, step, bipolar] = rangeFor(path);
  const initial = getPath(defaultParams(), path);
  const digits = (String(step).split('.')[1] || '').length;
  const semantic = path.endsWith('exposure') ? 'exposure'
    : path.endsWith('.temp') ? 'temp' : path.endsWith('.tint') ? 'tint'
      : /\.hue$|^hsl\..*\.h$/.test(path) ? 'hue'
        : /saturation|vibrance|\.sat$|^hsl\..*\.s$/.test(path) ? 'saturation' : 'neutral';
  const name = h('label', { class: 'ps-label', title: () => (T('双击复位', 'Double-click to reset')) }, label);
  const value = h('button', { type: 'button', class: 'ps-value', 'aria-label': label });
  const input = h('input', { type: 'range', min, max, step, 'aria-label': label, 'data-path': path });
  const track = h('div', { class: 'ps-track' }, h('i', { class: 'ps-fill' }), input);
  const row = h('div', { class: `post-slider ps-${semantic}${bipolar ? ' bipolar' : ''}`, 'data-path': path },
    h('div', { class: 'ps-head' }, name, value), track);
  host.append(row);
  let editor = null;
  const normalize = n => Number(clamp(min + Math.round((n - min) / step) * step, min, max).toFixed(digits));
  function sync() {
    const n = getPath(params, path);
    input.value = n;
    const changed = n !== initial;
    row.classList.toggle('dirty', changed);
    value.textContent = `${changed && n > 0 ? '+' : ''}${Number(n).toFixed(digits)}`;
    const percent = (n - min) / (max - min) * 100;
    row.style.setProperty('--fill-start', `${bipolar ? Math.min(50, percent) : 0}%`);
    row.style.setProperty('--fill-size', `${bipolar ? Math.abs(percent - 50) : percent}%`);
  }
  function change(n, commit) {
    if (!Number.isFinite(n)) return;
    setPath(params, path, normalize(n));
    sync();
    onChange?.(getPath(params, path), { path, commit });
  }
  input.oninput = () => change(Number(input.value), false);
  input.onchange = () => change(Number(input.value), true);
  input.onpointerup = input.onpointercancel = () => change(Number(input.value), true);
  name.ondblclick = () => change(initial, true);
  value.onclick = () => {
    if (editor) return;
    editor = h('input', { class: 'ps-number', type: 'number', min, max, step, value: getPath(params, path), 'aria-label': label });
    value.hidden = true;
    value.after(editor);
    let finished = false;
    const finish = save => {
      if (finished) return;
      finished = true;
      const n = editor.value === '' ? NaN : Number(editor.value);
      editor.remove(); editor = null; value.hidden = false;
      if (save) change(n, true);
    };
    editor.onblur = () => finish(true);
    editor.onkeydown = e => {
      e.stopPropagation();
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault(); finish(e.key === 'Enter'); value.focus();
      }
    };
    editor.focus(); editor.select();
  };
  sync();
  return { el: row, sync };
}
