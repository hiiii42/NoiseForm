// Director tools modal: bg removal, line art, sketch, colorize, emotion, declutter.
import { h, icon, loadImage } from '../util.js';
import { state } from '../store.js';
import { t } from '../i18n.js';
import { DIRECTOR_TOOLS, EMOTIONS, DEFRY_LABELS, modelById } from '../data.js';
import { generationCost } from '../nai.js';
import { openModal, toast } from './modal.js';

function toolCost(id, w, h_) {
  const px = w * h_;
  let s = 1;
  if (px > 3143728) s = Math.sqrt(3143728 / px);
  else if (px < 1011712) s = Math.sqrt(1011712 / px);
  const W = Math.round(w * s);
  const H = Math.round(h_ * s);
  const c = generationCost({ model: modelById('nai-diffusion-3'), width: W, height: H, steps: 28, nSamples: 1 });
  if (id === 'bg-removal') return c.per * 3 + 5;
  return c.total;
}

export async function openDirector(src, { run, save }) {
  const img = await loadImage(src);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  let current = DIRECTOR_TOOLS[0];
  let emotion = 'happy';
  let defry = 0;
  let prompt = '';
  let result = null;
  let busy = false;

  const list = h('div', { class: 'dir-tools' });
  const opts = h('div', { class: 'field' });
  const runBtn = h('button', { class: 'btn solid', style: { height: '40px' } });
  const keep = h('button', { class: 'btn solid', disabled: true }, icon('check'), () => (t('dir.keep')));
  const view = h('div', { class: 'dir-view' });

  const renderList = () => {
    list.replaceChildren(
      ...DIRECTOR_TOOLS.map((tool, i) =>
        h(
          'button',
          {
            class: 'dir-tool' + (tool === current ? ' on' : ''),
            onclick: () => {
              current = tool;
              renderList();
              renderOpts();
            },
          },
          h('span', { class: 'n' }, String(i + 1).padStart(2, '0')),
          h('span', {}, h('b', {}, () => t(tool.key)), h('small', {}, () => (t(tool.key)))),
          h('span', { class: 'c' }, state.session.live ? toolCost(tool.id, W, H) + '◈' : 'DEMO')
        )
      )
    );
    runBtn.replaceChildren(icon('wand'), h('span', {}, () => `${t('act.run')} — ${t(current.key)}`));
  };

  const defrySeg = () =>
    h(
      'div',
      { class: 'field' },
      h('span', { class: 't-label' }, h('span', {}, () => (t('dir.defry'))), h('span', {}, () => t('defry.' + defry))),
      h(
        'div',
        { class: 'seg', style: { width: '100%' } },
        ...DEFRY_LABELS.map((_, i) =>
          h('button', { class: i === defry ? 'on' : '', style: { flex: 1 }, onclick: () => ((defry = i), renderOpts()) }, String(i))
        )
      )
    );

  const renderOpts = () => {
    const parts = [];
    if (current.emotion) {
      parts.push(
        h('span', { class: 't-label' }, () => (t('dir.emotionPick'))),
        h(
          'div',
          { class: 'emo-grid' },
          ...EMOTIONS.map((e) => h('button', { class: e === emotion ? 'on' : '', onclick: () => ((emotion = e), renderOpts()) }, () => t('emotion.' + e)))
        )
      );
    }
    if (current.prompt || current.emotion) {
      const inp = h('input', { class: 'inp', value: prompt, placeholder: () => (t('dir.prompt')) });
      inp.oninput = () => (prompt = inp.value);
      parts.push(h('span', { class: 't-label' }, () => (t('dir.prompt'))), inp);
    }
    if (current.defry) parts.push(defrySeg());
    if (!parts.length) parts.push(h('p', { class: 'hint' }, () => (t('dir.pick'))));
    opts.replaceChildren(...parts);
  };

  const renderView = () => {
    if (!result) {
      view.replaceChildren(h('div', { class: 'cmp' }, h('img', { src, alt: '' })));
      return;
    }
    const cmp = h(
      'div',
      { class: 'cmp' },
      h('img', { src, alt: '' }),
      h('img', { class: 'after', src: result.url, alt: '' }),
      h('span', { class: 'cmp-l', style: { left: '10px' } }, () => (t('dir.before'))),
      h('span', { class: 'cmp-l', style: { right: '10px' } }, () => (t('dir.after'))),
      h('div', { class: 'bar' })
    );
    const move = (e) => {
      const r = cmp.getBoundingClientRect();
      cmp.style.setProperty('--x', Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)) + '%');
    };
    cmp.addEventListener('pointerdown', (e) => {
      cmp.setPointerCapture(e.pointerId);
      move(e);
      cmp.onpointermove = move;
    });
    cmp.addEventListener('pointerup', () => (cmp.onpointermove = null));
    view.replaceChildren(cmp);
  };

  runBtn.onclick = async () => {
    if (busy) return;
    busy = true;
    runBtn.disabled = true;
    const overlay = h('div', { class: 'dir-busy' }, h('span', {}, current.id.toUpperCase() + ' …'));
    view.append(overlay);
    try {
      const p = current.emotion ? `${emotion};;${prompt}` : prompt;
      const blob = await run(current.id, { prompt: p, defry, emotion });
      if (result) URL.revokeObjectURL(result.url);
      result = { blob, url: URL.createObjectURL(blob), tool: current.id };
      keep.disabled = false;
      renderView();
    } catch (err) {
      toast(err.message || String(err), 'err');
      overlay.remove();
    } finally {
      busy = false;
      runBtn.disabled = false;
    }
  };
  keep.onclick = async () => {
    if (!result) return;
    await save(result.blob, result.tool);
    keep.disabled = true;
    toast(() => (t('toast.directorDone')));
  };

  const side = h('div', { class: 'dir-side' }, list, opts, runBtn);
  const close = h('button', { class: 'btn' }, () => (t('act.close')));
  const m = openModal({
    n: 'DT',
    title: () => (t('copy.ui.director.0')),
    sub: () => (t('modal.director')),
    size: 'full',
    accent: 'var(--warm)',
    body: h('div', { class: 'dir' }, side, view),
    foot: [close, keep],
    onClose: () => result && URL.revokeObjectURL(result.url),
  });
  m.body.style.padding = '0';
  close.onclick = () => m.close();
  renderList();
  renderOpts();
  renderView();
}
