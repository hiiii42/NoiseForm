// Archive rendering, storage dialog and selection adapters. No application imports except events.
import { $, h, icon } from '../util.js';
import { bindCopy, getLang } from '../i18n.js';
import { on } from '../app/events.js';
import { showRecord, showEmpty, dropUrl, updateSaveTool, updateFlagTool, hideDeveloping, revealDeveloping } from './stage.js';
import { renderArchive, markCurrent, forgetThumb, flashThumb, visibleRecords, selectedIds, clearSelection, setStorageLabel } from './archive.js';
import { openCompare, closeCompare, compareOpen, compareIds, placeInActive, onNewImage } from './compare.js';
import { toast, confirmDialog, openModal } from './modal.js';
import { openStorage as openStorageDialog, estimate, shortBytes, fmtBytes, sizeOf, WARN_BYTES } from './storage.js';
import { enterPost, setPostRecord, postActive } from './workbench.js';
import { maybeStart } from './tour.js';

export const recordQueries = { compareOpen, compareIds, postActive, visibleRecords, selectedIds, confirmDialog, chooseZipScope };
export function initRecordView(hooks) {
  const handlers = {
    'records:added': renderArchive, 'records:updated': renderArchive,
    'records:dispose': dropUrl, 'records:forget': forgetThumb, 'records:flash': flashThumb,
    'records:selected': showRecord, 'records:current': markCurrent, 'records:empty': showEmpty,
    'records:saved': updateSaveTool, 'records:flagged': updateFlagTool,
    'records:selection:clear': clearSelection,
    'records:storage': refreshStorage, 'records:storage:open': openStorage,
    'compare:open': openCompare, 'compare:close': closeCompare, 'compare:place': placeInActive, 'compare:added': onNewImage,
    'developing:hide': hideDeveloping,
    'developing:focus': () => { if (revealDeveloping()) markCurrent(null); },
    'post:record': setPostRecord, 'post:open': enterPost, 'tour:start': maybeStart,
  };
  const off = Object.entries(handlers).map(([name, fn]) => on(name, fn));
  let storageWarned = false;
  async function refreshStorage() {
    const ours = sizeOf(hooks.history());
    const est = await estimate();
    const warn = ours > WARN_BYTES || (est.quota && est.usage / est.quota > 0.8);
    const zh = getLang() === 'zh';
    setStorageLabel(shortBytes(ours), warn);
    bindCopy($('#btnStorage'), 'title', () => (((getLang() === 'zh') ? `档案占用 ${fmtBytes(ours)}` : `Archive uses ${fmtBytes(ours)}`) + (est.quota ? ((getLang() === 'zh') ? `（本站共 ${fmtBytes(est.usage)} / 配额 ${fmtBytes(est.quota)}）· 点击管理` : ` (site ${fmtBytes(est.usage)} of ${fmtBytes(est.quota)}) · click to manage`) : '')));
    if (warn && !storageWarned) {
      storageWarned = true;
      toast(() => ((getLang() === 'zh') ? `档案已占用 ${fmtBytes(ours)}，可点击档案栏底部的存储按钮清理已保存的旧图。` : `The archive uses ${fmtBytes(ours)} — use the storage button to clean up saved images.`), 'warn', 7000, () => openStorage());
    }
  }

  function openStorage() {
    return openStorageDialog({ list: hooks.history, remove: hooks.remove });
  }


  return () => off.forEach((remove) => remove());
}

function chooseZipScope(unsaved, total, shown) {
  const zh = getLang() === 'zh';
  return new Promise((res) => {
    let v = null;
    const pick = (x) => () => ((v = x), m.close());
    const m = openModal({
      n: 'ZIP',
      title: () => ((getLang() === 'zh') ? '打包下载' : 'DOWNLOAD ZIP'),
      body: h(
        'div',
        { class: 'opt-grid' },
        h('button', { class: 'opt', disabled: !unsaved, onclick: pick('unsaved') }, icon('download'), h('b', {}, () => (((getLang() === 'zh') ? '仅未保存 ' : 'Unsaved only ') + unsaved)), h('small', {}, () => ((getLang() === 'zh') ? '跳过已下载 / 已在文件夹中的图像' : 'Skip images already saved'))),
        shown !== total ? h('button', { class: 'opt', disabled: !shown, onclick: pick('shown') }, icon('search'), h('b', {}, () => (((getLang() === 'zh') ? '当前筛选结果 ' : 'Current view ') + shown)), h('small', {}, () => ((getLang() === 'zh') ? '档案栏筛选 / 搜索后显示的图像' : 'What the archive shows now'))) : null,
        h('button', { class: 'opt', onclick: pick('all') }, icon('zip'), h('b', {}, () => (((getLang() === 'zh') ? '全部 ' : 'Everything ') + total)), h('small', {}, () => ((getLang() === 'zh') ? '包括已经保存过的' : 'Including saved ones')))
      ),
      onClose: () => res(v),
    });
    m.el.style.width = 'min(480px, 100%)';
  });
}

