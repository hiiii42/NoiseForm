// Storage: how much the archive occupies in IndexedDB, and cleanup of images that are already
// on disk (saved, not starred) or rejected.
import { h, icon } from '../util.js';
import { t, getLang } from '../i18n.js';
import { openModal, confirmDialog, toast } from './modal.js';
import * as saver from '../saver.js';

const DAY = 86400000;
export const fmtBytes = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + ' MB' : Math.max(0, Math.round(n / 1e3)) + ' KB');
export const shortBytes = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'G' : n >= 1e6 ? Math.round(n / 1e6) + 'M' : Math.round(n / 1e3) + 'K');
export const sizeOf = (recs) => recs.reduce((a, r) => a + (r.bytes || 0), 0);
export const WARN_BYTES = 1.5e9;

export async function estimate() {
  try {
    const e = await navigator.storage.estimate();
    return { usage: e.usage || 0, quota: e.quota || 0, persisted: (await navigator.storage.persisted?.()) || false };
  } catch {
    return { usage: 0, quota: 0, persisted: false };
  }
}

// deps: { list(): records, remove(ids): Promise }
export async function openStorage(deps) {
  const Z = getLang() === 'zh';
  const est = await estimate();
  const body = h('div', { class: 'store' });
  const m = openModal({ n: 'DB', title: () => (t('copy.ui.storage.0')), sub: () => ((getLang() === 'zh') ? '浏览器本地存储（IndexedDB）' : 'Browser storage (IndexedDB)'), body, onLang: () => paint() });
  m.el.style.width = 'min(620px, 100%)';
  const dir = await saver.getDir().catch(() => null);
  let days = 7;
  let verify = false;

  const paint = () => {
    const all = deps.list();
    const ours = sizeOf(all);
    const groups = [
      [(getLang() === 'zh') ? '全部' : 'All', all],
      [(getLang() === 'zh') ? '★ 已收藏' : '★ Starred', all.filter((r) => r.flag === 1)],
      [(getLang() === 'zh') ? '已保存、未收藏' : 'Saved, not starred', all.filter((r) => r.saved && r.flag !== 1)],
      [(getLang() === 'zh') ? '未保存' : 'Not saved', all.filter((r) => !r.saved)],
      [(getLang() === 'zh') ? '✕ 已淘汰' : '✕ Rejected', all.filter((r) => r.flag === -1)],
    ];
    const cut = Date.now() - days * DAY;
    const cands = all.filter((r) => r.saved && r.flag !== 1 && r.createdAt < cut && (!verify || r.saved.via === 'folder'));
    const rejects = all.filter((r) => r.flag === -1);
    const rejUnsaved = rejects.filter((r) => !r.saved).length;
    const pct = est.quota ? Math.min(100, (est.usage / est.quota) * 100) : 0;

    const daySel = h('select', { class: 'sel sm' }, ...[[0, (getLang() === 'zh') ? '全部' : 'any age'], [1, (getLang() === 'zh') ? '1 天前' : '> 1 day'], [7, (getLang() === 'zh') ? '7 天前' : '> 7 days'], [30, (getLang() === 'zh') ? '30 天前' : '> 30 days']].map(([v, l]) => h('option', { value: v, selected: v === days }, l)));
    daySel.onchange = () => ((days = +daySel.value), paint());
    const verifyCk = h('input', { type: 'checkbox', checked: verify, disabled: !dir });
    verifyCk.onchange = () => ((verify = verifyCk.checked), paint());

    const cleanBtn = h('button', { class: 'btn solid danger', disabled: !cands.length }, icon('trash'), () => ((getLang() === 'zh') ? `清理 ${cands.length} 张 · 释放 ${fmtBytes(sizeOf(cands))}` : `Remove ${cands.length} · free ${fmtBytes(sizeOf(cands))}`));
    cleanBtn.onclick = async () => {
      let ids = cands.map((r) => r.id);
      if (verify && dir) {
        if (!(await saver.ensurePermission(dir, true))) return toast(() => ((getLang() === 'zh') ? '没有文件夹权限' : 'No folder permission'), 'err');
        const ok = [];
        for (const r of cands) if (await saver.fileExists(dir, r.saved.name)) ok.push(r.id);
        if (ok.length < ids.length) toast(() => ((getLang() === 'zh') ? `${ids.length - ok.length} 张在文件夹中找不到，已跳过` : `${ids.length - ok.length} not found in the folder — skipped`), 'warn');
        ids = ok;
      }
      if (!ids.length) return;
      const msg = (getLang() === 'zh') ? `从浏览器中删除 ${ids.length} 张已保存且未收藏的图像？\n本地文件不受影响；此操作无法撤销。` : `Remove ${ids.length} saved, unstarred images from the browser?\nFiles on disk are untouched. This cannot be undone.`;
      if (!(await confirmDialog(msg, { danger: true }))) return;
      await deps.remove(ids);
      toast(() => ((getLang() === 'zh') ? `已清理 ${ids.length} 张` : `Removed ${ids.length}`));
      Object.assign(est, await estimate());
      paint();
    };
    const rejBtn = h('button', { class: 'btn danger', disabled: !rejects.length }, icon('reject'), () => ((getLang() === 'zh') ? `删除已淘汰 ${rejects.length} 张 · ${fmtBytes(sizeOf(rejects))}` : `Delete ${rejects.length} rejected · ${fmtBytes(sizeOf(rejects))}`));
    rejBtn.onclick = async () => {
      const msg = (getLang() === 'zh') ? `删除全部 ${rejects.length} 张已淘汰的图像？${rejUnsaved ? `\n其中 ${rejUnsaved} 张从未保存到本地。` : ''}\n此操作无法撤销。` : `Delete all ${rejects.length} rejected images?${rejUnsaved ? `\n${rejUnsaved} were never saved to disk.` : ''}\nThis cannot be undone.`;
      if (!(await confirmDialog(msg, { danger: true }))) return;
      await deps.remove(rejects.map((r) => r.id));
      toast(() => ((getLang() === 'zh') ? `已删除 ${rejects.length} 张` : `Deleted ${rejects.length}`));
      Object.assign(est, await estimate());
      paint();
    };
    const persistBtn = est.persisted
      ? h('span', { class: 'chip ok mono' }, () => ((getLang() === 'zh') ? '✓ 已启用持久存储（浏览器不会自动清除）' : '✓ Persistent — the browser won’t evict it'))
      : h(
          'button',
          {
            class: 'btn sm',
            onclick: async () => {
              const ok = await navigator.storage.persist?.().catch(() => false);
              est.persisted = !!ok;
              toast(() => (ok ? ((getLang() === 'zh') ? '已启用持久存储' : 'Storage is now persistent') : (getLang() === 'zh') ? '浏览器拒绝了（常用站点 / 已安装为应用时才会同意）' : 'The browser declined (granted for frequently used / installed sites)'), ok ? 'ok' : 'warn', 5000);
              paint();
            },
          },
          () => ((getLang() === 'zh') ? '申请持久存储' : 'Request persistent storage')
        );

    body.replaceChildren(
      h(
        'div',
        { class: 'store-top' },
        h('div', { class: 'store-big' }, h('b', {}, fmtBytes(ours)), h('span', {}, () => ((getLang() === 'zh') ? `档案 ${all.length} 张` : `${all.length} images`))),
        h(
          'div',
          { class: 'store-meter' },
          h('div', { class: 'q-bar' }, h('i', { style: { width: Math.max(pct, 0.5) + '%' } })),
          h('small', { class: 'mono' }, () => (est.quota ? ((getLang() === 'zh') ? `本站共用 ${fmtBytes(est.usage)} / 浏览器配额 ${fmtBytes(est.quota)}（${pct.toFixed(1)}%）` : `Site uses ${fmtBytes(est.usage)} of ${fmtBytes(est.quota)} (${pct.toFixed(1)}%)`) : '—'))
        ),
        persistBtn
      ),
      h('table', { class: 'store-t mono' }, ...groups.map(([l, rs]) => h('tr', {}, h('td', {}, l), h('td', {}, rs.length), h('td', {}, fmtBytes(sizeOf(rs)))))),
      h(
        'section',
        { class: 'store-sec' },
        h('h3', {}, () => ((getLang() === 'zh') ? '清理已保存且未收藏的旧图' : 'Clean up saved, unstarred images')),
        h('p', { class: 'hint' }, () => ((getLang() === 'zh') ? '「已保存」指曾经下载、写入文件夹或打包进 ZIP。浏览器无法确认下载的文件现在是否还在。收藏的图像永远不会被清理。' : '"Saved" = downloaded, written to the folder or zipped. The browser can’t verify downloads still exist. Starred images are never removed.')),
        h('div', { class: 'row wrap gap' }, h('span', { class: 't-label' }, () => ((getLang() === 'zh') ? '生成于' : 'Created')), daySel, h('label', { class: 'tgl', title: () => (dir ? '' : (getLang() === 'zh') ? '需要先在设置中选择保存文件夹' : 'Choose a save folder in Settings first') }, verifyCk, h('span', { class: 'sw' }), h('span', { class: 'cn' }, () => ((getLang() === 'zh') ? '只删除在保存文件夹里确认存在的' : 'Only if the file is confirmed in the save folder')))),
        h('div', {}, cleanBtn)
      ),
      h('section', { class: 'store-sec' }, h('h3', {}, () => ((getLang() === 'zh') ? '已淘汰的图像' : 'Rejected images')), h('p', { class: 'hint' }, () => ((getLang() === 'zh') ? '用 X 键标记淘汰的图像。' : 'Images marked with X.')), h('div', {}, rejBtn))
    );
  };
  paint();
  return m;
}
