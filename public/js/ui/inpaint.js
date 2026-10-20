// Inpaint mask painter (modal). Output: white-on-black PNG data URL at image resolution.
import { h, icon, loadImage, makeCanvas, clamp } from '../util.js';
import { state, emit } from '../store.js';
import { t } from '../i18n.js';
import { openModal } from './modal.js';
import { makeSlider } from './panel.js';

const PAINT = 'rgba(255,46,126,1)';

export async function openInpaint() {
  const b = state.base;
  if (!b) return;
  const img = await loadImage(b.image);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const base = makeCanvas(W, H);
  base.getContext('2d').drawImage(img, 0, 0);
  const mask = makeCanvas(W, H);
  mask.className = 'mask-c';
  const mctx = mask.getContext('2d', { willReadFrequently: true });
  if (b.mask) {
    const mi = await loadImage(b.mask);
    const tmp = makeCanvas(W, H);
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    tctx.drawImage(mi, 0, 0, W, H);
    const d = tctx.getImageData(0, 0, W, H);
    for (let i = 0; i < d.data.length; i += 4) {
      const on = d.data[i] > 127;
      d.data[i] = 255;
      d.data[i + 1] = 46;
      d.data[i + 2] = 126;
      d.data[i + 3] = on ? 255 : 0;
    }
    mctx.putImageData(d, 0, 0);
  }

  let tool = 'brush';
  let size = Math.round(Math.max(W, H) / 18);
  const history = [];
  const cursor = h('div', { class: 'paint-cursor' });
  document.body.append(cursor);

  const wrap = h('div', { class: 'paint-wrap' }, base, mask);
  const stageEl = h('div', { class: 'paint-stage' }, wrap);

  const fit = () => {
    const r = stageEl.getBoundingClientRect();
    const s = Math.min((r.width - 40) / W, (r.height - 40) / H, 1.5);
    base.style.width = W * s + 'px';
    base.style.height = H * s + 'px';
  };
  const scale = () => W / base.getBoundingClientRect().width;

  let drawing = false;
  let last = null;
  let shiftErase = false;
  const pos = (e) => {
    const r = mask.getBoundingClientRect();
    return [(e.clientX - r.left) * scale(), (e.clientY - r.top) * scale()];
  };
  const stroke = (a, z) => {
    mctx.globalCompositeOperation = tool === 'eraser' || shiftErase ? 'destination-out' : 'source-over';
    mctx.strokeStyle = PAINT;
    mctx.fillStyle = PAINT;
    mctx.lineWidth = size;
    mctx.lineCap = 'round';
    mctx.lineJoin = 'round';
    mctx.beginPath();
    mctx.moveTo(a[0], a[1]);
    mctx.lineTo(z[0], z[1]);
    mctx.stroke();
  };
  mask.addEventListener('pointerdown', (e) => {
    mask.setPointerCapture(e.pointerId);
    history.push(mctx.getImageData(0, 0, W, H));
    if (history.length > 30) history.shift();
    drawing = true;
    shiftErase = e.shiftKey;
    last = pos(e);
    stroke(last, last);
  });
  mask.addEventListener('pointermove', (e) => {
    const s = size / scale();
    cursor.style.width = cursor.style.height = s + 'px';
    cursor.style.left = e.clientX + 'px';
    cursor.style.top = e.clientY + 'px';
    cursor.style.display = 'block';
    if (!drawing) return;
    const p = pos(e);
    stroke(last, p);
    last = p;
  });
  const end = () => (drawing = false);
  mask.addEventListener('pointerup', end);
  mask.addEventListener('pointercancel', end);
  mask.addEventListener('pointerleave', () => (cursor.style.display = 'none'));

  const segB = h('button', { class: 'on' }, icon('brush'), () => (t('paint.brush')));
  const segE = h('button', {}, icon('eraser'), () => (t('paint.eraser')));
  const setTool = (x) => {
    tool = x;
    segB.classList.toggle('on', x === 'brush');
    segE.classList.toggle('on', x === 'eraser');
  };
  segB.onclick = () => setTool('brush');
  segE.onclick = () => setTool('eraser');
  const sizeFld = h('div', { class: 'fld' });
  const sizeCtl = makeSlider(sizeFld, { label: () => (t('paint.size')), min: 4, max: Math.round(Math.max(W, H) / 4), step: 1, get: () => size, set: (v) => (size = v) });

  const undo = () => {
    const d = history.pop();
    if (d) mctx.putImageData(d, 0, 0);
  };
  const clear = () => {
    history.push(mctx.getImageData(0, 0, W, H));
    mctx.clearRect(0, 0, W, H);
  };
  const invert = () => {
    history.push(mctx.getImageData(0, 0, W, H));
    const d = mctx.getImageData(0, 0, W, H);
    for (let i = 0; i < d.data.length; i += 4) {
      d.data[i] = 255;
      d.data[i + 1] = 46;
      d.data[i + 2] = 126;
      d.data[i + 3] = d.data[i + 3] > 20 ? 0 : 255;
    }
    mctx.putImageData(d, 0, 0);
  };

  const side = h(
    'div',
    { class: 'paint-side' },
    h('div', { class: 'seg' }, segB, segE),
    sizeFld,
    h(
      'div',
      { class: 'row wrap', style: { gap: '6px' } },
      h('button', { class: 'btn sm', onclick: undo }, icon('undo'), () => (t('copy.ui.inpaint.0'))),
      h('button', { class: 'btn sm', onclick: invert }, icon('invert'), () => (t('paint.invert'))),
      h('button', { class: 'btn sm danger', onclick: clear }, icon('trash'), () => (t('paint.clear')))
    ),
    h('p', { class: 'hint' }, () => (t('paint.hint'))),
    h('p', { class: 'hint' }, () => t('paint.grid', { w: W, h: H }))
  );

  const onKey = (e) => {
    if (e.target.closest('input')) return;
    if (e.key === '[') {
      size = clamp(size - 6, 4, 2000);
      sizeCtl.sync();
    } else if (e.key === ']') {
      size = clamp(size + 6, 4, 2000);
      sizeCtl.sync();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
    } else if (e.key.toLowerCase() === 'b') setTool('brush');
    else if (e.key.toLowerCase() === 'e') setTool('eraser');
  };
  document.addEventListener('keydown', onKey);

  const cancel = h('button', { class: 'btn' }, () => (t('act.cancel')));
  const apply = h('button', { class: 'btn solid' }, icon('check'), () => (t('act.apply')));
  const m = openModal({
    n: 'IN',
    title: () => (t('copy.ui.inpaint.1')),
    sub: () => (t('modal.inpaint')),
    size: 'full',
    accent: 'var(--neg)',
    body: h('div', { class: 'paint' }, stageEl, side),
    foot: [cancel, apply],
    onClose: () => {
      document.removeEventListener('keydown', onKey);
      cursor.remove();
      ro.disconnect();
    },
  });
  m.body.style.padding = '0';
  const ro = new ResizeObserver(fit);
  ro.observe(stageEl);
  cancel.onclick = () => m.close();
  apply.onclick = () => {
    const d = mctx.getImageData(0, 0, W, H);
    let any = false;
    const out = makeCanvas(W, H);
    const octx = out.getContext('2d');
    const od = octx.createImageData(W, H);
    for (let i = 0; i < d.data.length; i += 4) {
      const on = d.data[i + 3] > 20;
      if (on) any = true;
      od.data[i] = od.data[i + 1] = od.data[i + 2] = on ? 255 : 0;
      od.data[i + 3] = 255;
    }
    octx.putImageData(od, 0, 0);
    if (any) {
      b.mask = out.toDataURL('image/png');
      b.maskPreview = mask.toDataURL('image/png');
    } else {
      b.mask = null;
      b.maskPreview = null;
    }
    emit('base');
    m.close();
  };
}
