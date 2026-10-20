// View subscriptions and interactive ports; installed by main before any application commands.
import { $, h } from '../util.js';
import { bindCopy, t, getLang } from '../i18n.js';
import { on } from '../app/events.js';
import { closeAC } from './editor.js';
import { startDeveloping, stopDeveloping, landDeveloping, releaseHandoff } from './stage.js';
import { setPending, updatePendingProgress } from './archive.js';
import { toast, openModal } from './modal.js';
import { notifyDone, progressTitle } from '../notify.js';
import { logPrompt } from './timeline.js';

export function initGenerationView({ queueRunning, getPendingSaves, retrySave, downloadPendingSave }) {
  let dev;
  const off = [];
  const listen = (name, fn) => off.push(on(name, fn));
  listen('toast', toast);
  listen('generation:busy', (on, label) => {
    const btn = $('#btnGenerate');
    btn.classList.toggle('busy', on);
    btn.disabled = on && !queueRunning();
    bindCopy($('.gen-t'), 'textContent', () => (on ? (queueRunning() ? (getLang() === 'zh' ? '插队 +1' : 'CUT IN +1') : label || t('gen.developing')) : t('act.generate')));
    if (!on) $('.gen-fill').style.width = '0';
  });
  listen('generation:start', (info, options) => { closeAC(); dev = startDeveloping(info, options); });
  // Each region is a separate listener so a broken stage cannot block the archive/title.
  listen('generation:progress', (p) => dev?.setProgress(p));
  listen('generation:progress', (p) => { $('.gen-fill').style.width = Math.round(p * 100) + '%'; });
  listen('generation:progress', updatePendingProgress);
  listen('generation:progress', progressTitle);
  listen('generation:waiting', (v) => dev?.setWaiting(v));
  listen('generation:label', (v) => dev?.setLabel(v));
  listen('generation:preview', (v) => dev?.setPreview(v));
  listen('generation:land', landDeveloping);
  listen('generation:handoff', releaseHandoff);
  listen('generation:stop', () => { stopDeveloping(); dev = null; });
  listen('generation:pending', setPending);
  listen('generation:finished', () => progressTitle(null));
  listen('prompt:focus', () => $('#promptEditor textarea')?.focus());
  listen('prompt:logged', logPrompt);
  listen('notification:done', notifyDone);
  listen('pending-saves', paintPendingSaves);
  listen('pending-saves:open', openPendingSaves);
  function paintPendingSaves() {
    let button = $('#btnPendingSaves');
    if (!button) {
      button = h('button', { id: 'btnPendingSaves', class: 'btn ghost', onclick: openPendingSaves });
      $('#btnQueue').insertAdjacentElement('afterend', button);
    }
    const n = getPendingSaves().length;
    button.hidden = !n;
    bindCopy(button, 'textContent', () => ((getLang() === 'zh' ? '待保存 ' : 'Unsaved ') + n));
  }

  function openPendingSaves() {
    const zh = getLang() === 'zh';
    const body = h('div', {}, h('p', {}, () => ((getLang() === 'zh') ? '图像已生成。待保存结果仅在本页内存中；关闭或刷新前请保存或下载。' : 'Images were generated. Unsaved results remain in this page only; save or download before closing/reloading.')));
    const dialog = openModal({ title: () => ((getLang() === 'zh') ? '待保存图像' : 'Unsaved images'), body });
    for (const entry of getPendingSaves()) {
      const retry = h('button', { class: 'btn', 'data-retry-save': entry.id }, () => ((getLang() === 'zh') ? '重试保存' : 'Retry save'));
      retry.onclick = async () => {
        retry.disabled = true;
        const res = await retrySave(entry.id);
        retry.disabled = false;
        if (res.ok) { dialog.close(); openPendingSaves(); }
      };
      const download = h('button', { class: 'btn', 'data-download-save': entry.id }, () => ((getLang() === 'zh') ? '下载' : 'Download'));
      download.onclick = () => downloadPendingSave(entry.id);
      body.append(h('div', {}, h('p', {}, `${entry.items.length} · ${(entry.items[0].params?.prompt || '').slice(0, 90)}`), retry, download));
    }
  }

  const beforeUnload = (e) => {
    if (!getPendingSaves().length) return;
    e.preventDefault();
    e.returnValue = '';
  };


  window.addEventListener('beforeunload', beforeUnload);
  return () => { off.forEach((remove) => remove()); window.removeEventListener('beforeunload', beforeUnload); };
}
