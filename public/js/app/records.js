// Archive records, selection, persistence and export.
import { uid, makeThumb, downloadBlob, pad } from '../util.js';
import { state } from '../store.js';
import { t, getLang } from '../i18n.js';
import { images as db } from '../db.js';
import { zip } from '../zip.js';
import * as saver from '../saver.js';
import { fmtTime } from '../util.js';
import { createRecordCache } from './reccache.js';
import { recordKey } from '../dupcheck.js';
import { persistError } from '../persist.js';
import { emit as publish, toast } from './events.js';
let queries = { compareOpen: () => false, compareIds: () => [], postActive: () => false,
  visibleRecords: () => history, selectedIds: () => [], confirmDialog: async () => false, chooseZipScope: async () => null };
export function initRecords(ports) { queries = { ...queries, ...ports }; }
export const recCache = createRecordCache({ dispose: (id) => publish('records:dispose', id), isPinned: (id) => queries.compareIds().includes(id) });
export let history = []; // lightweight records, newest first
export async function loadRecords() {
  try { history = await db.list(); }
  catch (error) {
    // Keep the last readable archive on reload; main's event listener shows the error.
    persistError('images', 'read', error);
  }
}
async function getRecord(id, { reload = false } = {}) {
  if (!reload && recCache.has(id)) return recCache.get(id);
  const rec = await db.get(id);
  if (rec) recCache.set(id, rec);
  return rec;
}

async function userSelect(id) {
  if (queries.compareOpen()) return publish('compare:place', id);
  state.session.follow = false;
  if (state.session.generating) publish('developing:hide');
  return selectRecord(id);
}

function focusPending() {
  if (queries.compareOpen()) publish('compare:close');
  state.session.follow = true;
  publish('developing:focus');
}

async function addRecords(items, { reveal = true, select = true, silent = false, onPersisted } = {}) {
  let no = history.reduce((m, r) => Math.max(m, r.no || 0), 0);
  const batchId = uid();
  const recs = [];
  for (const it of items) {
    const rec = {
      id: uid(),
      no: ++no,
      createdAt: Date.now(),
      batchId: items.length > 1 ? batchId : null,
      thumb: it.thumb || await makeThumb(it.blob),
      ...it,
    };
    await db.put(rec);
    recCache.set(rec.id, rec);
    recs.push(rec);
  }
  onPersisted?.(recs);
  const light = recs.map(({ blob, ...r }) => ({ ...r, bytes: (blob?.size || 0) + (r.thumb?.size || 0) }));
  const ids = new Set(recs.map((r) => r.id));
  history = [...light.reverse(), ...history.filter((r) => !ids.has(r.id))];
  publish('records:added', history, select ? recs[0].id : state.session.currentId);
  if (select) await selectRecord(recs[0].id, { reveal });
  else if (!silent) {
    const zh = getLang() === 'zh';
    for (const r of recs) publish('records:flash', r.id);
    toast((() => ((getLang() === 'zh') ? `新图像 №${pad(recs[0].no, 4)} 已完成 · 点击查看` : `№${pad(recs[0].no, 4)} is ready · click to view`)), 'ok', 3600, () => selectRecord(recs[0].id, { reveal: true }));
  }
  for (const r of recs) publish('compare:added', r.id);
  if (select && recs.some((r) => r.kind === 'gen')) publish('tour:start', 'firstImage', 800);
  if (state.settings.autoSave) for (const r of recs) saveRecord(r, { auto: true }).catch(() => {});
  refreshStorage();
  return recs;
}

async function selectRecord(id, { reveal = false } = {}) {
  // Hold both the old view and the incoming batch until the UI has finished loading.
  const owner = Symbol('selection');
  recCache.pin(owner, [id]);
  try {
    const rec = await getRecord(id);
    if (!rec) return;
    const ids = rec.batchId ? history.filter((r) => r.batchId === rec.batchId).map((r) => r.id).reverse() : [];
    const pins = [id, rec.sourceId, ...ids];
    recCache.pin(owner, pins);
    const batch = (await Promise.all(ids.map((batchId) => getRecord(batchId)))).filter(Boolean);
    state.session.currentId = id;
    if (queries.postActive()) {
      await publish('post:record', rec);
      recCache.pin('post', [id]);
    } else {
      publish('records:selected', rec, { reveal, batch });
      recCache.pin('stage', pins);
    }
    publish('records:current', id);
  } finally {
    recCache.pin(owner, []);
  }
}

// In-place post-processing mode: the panel column and the stage are taken over by ui/workbench.js;
// archive clicks switch the image being edited, exports become `post` records next to the source.
async function openPost(rec) {
  recCache.pin('post', [rec.id]);
  await publish('post:open', rec, {
    getBlob: async (r) => (r.blob ? r.blob : (await getRecord(r.id))?.blob),
    onExport: async ({ blob, width, height, post, sourceId }) => {
      const src = (await getRecord(sourceId)) || rec;
      const [out] = await addRecords([{ blob, seed: src.seed, width, height, model: src.model, kind: 'post', demo: src.demo, params: src.params, post, sourceId: src.id }], { select: false, silent: true });
      return out;
    },
    onExit: () => {
      recCache.pin('post', []);
      if (state.session.currentId) selectRecord(state.session.currentId);
      else publish('records:empty');
    },
  });
  publish('tour:start', 'post', 600);
}

async function updateRecord(id, patch) {
  const previous = await getRecord(id, { reload: true });
  if (!previous) return null;
  const rec = { ...previous, ...patch };
  await db.put(rec);
  recCache.set(id, rec);
  const light = history.find((r) => r.id === id);
  if (light) Object.assign(light, patch);
  publish('records:updated', history, state.session.currentId);
  return rec;
}

// ------------------------------------------------------------ flags / batch
async function setFlag(ids, flag, { advance = false } = {}) {
  const zh = getLang() === 'zh';
  const v = flag || 0;
  await db.patch(ids, { flag: v });
  for (const id of ids) {
    const light = history.find((r) => r.id === id);
    if (light) light.flag = v;
    const full = recCache.get(id);
    if (full) full.flag = v;
  }
  const curId = state.session.currentId;
  // the current image may drop out of a filtered view: remember where it was
  const at = queries.visibleRecords().findIndex((r) => r.id === curId);
  publish('records:updated', history, curId);
  const cur = recCache.get(curId);
  if (cur) publish('records:flagged', cur);
  if (ids.length > 1) toast(() => ((getLang() === 'zh') ? `${ids.length} 张：${v === 1 ? '已收藏' : v === -1 ? '已淘汰' : '已清除标记'}` : `${ids.length} images ${v === 1 ? 'starred' : v === -1 ? 'rejected' : 'unflagged'}`));
  if (advance && at >= 0) {
    const now = queries.visibleRecords();
    const i = now.findIndex((r) => r.id === curId);
    const next = i >= 0 ? now[i + 1] : now[at] || now[at - 1];
    if (next && next.id !== curId) userSelect(next.id);
  }
}

// Remove records everywhere (DB, caches, compare, current view).
async function deleteRecords(ids) {
  if (!ids.length) return;
  const gone = new Set(ids);
  const curId = state.session.currentId;
  const at = queries.visibleRecords().findIndex((r) => r.id === curId);
  await db.deleteMany(ids);
  for (const id of ids) {
    recCache.delete(id);
    publish('records:forget', id);
  }
  history = history.filter((r) => !gone.has(r.id));
  publish('records:removed', ids);
  if (queries.compareOpen() && queries.compareIds().some((id) => gone.has(id))) {
    const left = queries.compareIds().filter((id) => !gone.has(id));
    left.length ? publish('compare:open', left) : publish('compare:close');
  }
  if (gone.has(curId)) {
    state.session.currentId = null;
    publish('records:updated', history, null);
    const list = queries.visibleRecords();
    const next = list[Math.min(Math.max(at, 0), list.length - 1)] || history[0];
    if (next) await selectRecord(next.id);
    else { publish('records:empty'); recCache.pin('stage', []); }
  } else publish('records:updated', history, curId);
  refreshStorage();
}

const manualSaved = () => ({ at: Date.now(), name: getLang() === 'zh' ? '（手动标记）' : '(marked manually)', via: 'manual' });

async function batchAction(act, ids) {
  if (!ids.length) return;
  const zh = getLang() === 'zh';
  switch (act) {
    case 'star':
      return setFlag(ids, 1);
    case 'reject':
      return setFlag(ids, -1);
    case 'unflag':
      return setFlag(ids, 0);
    case 'zip':
      return zipRecords(ids);
    case 'saved':
    case 'unsaved': {
      const val = (id) => (act === 'saved' ? history.find((r) => r.id === id)?.saved || manualSaved() : null);
      const vals = new Map(ids.map((id) => [id, val(id)]));
      await db.patch(ids, (id) => ({ saved: vals.get(id) }));
      for (const id of ids) {
        const light = history.find((r) => r.id === id);
        if (light) light.saved = vals.get(id);
        if (recCache.has(id)) recCache.get(id).saved = vals.get(id);
      }
      publish('records:updated', history, state.session.currentId);
      const cur = recCache.get(state.session.currentId);
      if (cur) publish('records:saved', cur);
      return toast(() => ((getLang() === 'zh') ? `${ids.length} 张已${act === 'saved' ? '标记为已保存' : '清除保存标记'}` : `${ids.length} images ${act === 'saved' ? 'marked saved' : 'unmarked'}`));
    }
    case 'compare':
      if (ids.length > 4) toast(() => ((getLang() === 'zh') ? '对比最多 4 张，已取前 4 张' : 'Compare shows up to 4 — using the first 4'), 'warn');
      publish('records:selection:clear');
      return publish('compare:open', ids.slice(0, 4));
    case 'delete': {
      const unsaved = ids.filter((id) => !history.find((r) => r.id === id)?.saved).length;
      const starred = ids.filter((id) => history.find((r) => r.id === id)?.flag === 1).length;
      const warn = [unsaved ? ((getLang() === 'zh') ? `其中 ${unsaved} 张尚未保存到本地` : `${unsaved} not saved to disk`) : '', starred ? ((getLang() === 'zh') ? `${starred} 张已收藏` : `${starred} starred`) : ''].filter(Boolean).join((getLang() === 'zh') ? '，' : ', ');
      const msg = (getLang() === 'zh') ? `删除选中的 ${ids.length} 张图像？${warn ? '\n' + warn + '。' : ''}\n此操作无法撤销。` : `Delete ${ids.length} images?${warn ? '\n' + warn + '.' : ''}\nThis cannot be undone.`;
      if (!(await queries.confirmDialog(msg, { danger: true }))) return;
      publish('records:selection:clear');
      await deleteRecords(ids);
      return toast(() => ((getLang() === 'zh') ? `已删除 ${ids.length} 张` : `Deleted ${ids.length}`));
    }
  }
}

// ------------------------------------------------------------ storage
function refreshStorage() { return publish('records:storage'); }
function openStorage() { return publish('records:storage:open'); }

// ------------------------------------------------------------ saving to disk
const fmtSaved = (s) => {
  const d = new Date(s.at);
  return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(s.at)}`;
};

// Returns true when the image ended up on disk (or the user declined a duplicate save).
async function saveRecord(rec, { auto = false, ask = true } = {}) {
  const zh = getLang() === 'zh';
  const name = saver.fileNameFor(rec);
  const dir = await saver.getDir();
  if (dir) {
    const ok = await saver.ensurePermission(dir, !auto);
    if (!ok) {
      if (auto && !state.session.autoSaveWarned) {
        state.session.autoSaveWarned = true;
        toast(() => ((getLang() === 'zh') ? '自动保存需要重新授权文件夹：点一次「下载」按钮即可授权。' : 'Auto-save needs folder permission again — click Save once to grant it.'), 'warn', 6000);
      }
      if (auto) return false;
    } else {
      const existsName = rec.saved?.via === 'folder' ? rec.saved.name : name;
      if (await saver.fileExists(dir, existsName)) {
        if (!auto) toast(() => (((getLang() === 'zh') ? '已在文件夹中，无需重复保存：' : 'Already in folder: ') + dir.name + '/' + existsName));
        if (!rec.saved) await markSaved(rec, { at: Date.now(), name: existsName, via: 'folder', dir: dir.name });
        return true;
      }
      await saver.writeFile(dir, name, rec.blob);
      await markSaved(rec, { at: Date.now(), name, via: 'folder', dir: dir.name });
      if (!auto) toast(() => (((getLang() === 'zh') ? '已保存到 ' : 'Saved to ') + dir.name + '/' + name));
      return true;
    }
  }
  if (auto) return false;
  if (rec.saved && ask && state.settings.warnDuplicate !== false) {
    const where = rec.saved.via === 'zip' ? ((getLang() === 'zh') ? '（打包在 ZIP 中）' : ' (inside a ZIP)') : '';
    const msg = (getLang() === 'zh')
      ? `这张图像已于 ${fmtSaved(rec.saved)} 保存过${where}：\n${rec.saved.name}\n\n确定要再次下载吗？`
      : `This image was already saved on ${fmtSaved(rec.saved)}${where}:\n${rec.saved.name}\n\nDownload it again?`;
    if (!(await queries.confirmDialog(msg, { okText: (getLang() === 'zh') ? '再次下载' : 'Download again' }))) return true;
  }
  downloadBlob(rec.blob, name);
  await markSaved(rec, { at: Date.now(), name, via: 'download' });
  return true;
}

async function markSaved(rec, saved) {
  rec.saved = saved;
  await updateRecord(rec.id, { saved });
  publish('records:updated', history, state.session.currentId);
  if (rec.id === state.session.currentId) publish('records:saved', rec);
}

async function currentRecord() {
  return state.session.currentId ? getRecord(state.session.currentId) : null;
}

async function zipAll() {
  if (!history.length) return;
  const sel = queries.selectedIds();
  if (sel.length) return zipRecords(sel);
  const unsaved = history.filter((r) => !r.saved).length;
  const shown = queries.visibleRecords().length;
  const scope = await queries.chooseZipScope(unsaved, history.length, shown);
  if (!scope) return;
  const ids = (scope === 'shown' ? queries.visibleRecords() : history).filter((r) => scope !== 'unsaved' || !r.saved).map((r) => r.id);
  return zipRecords(ids);
}

async function zipRecords(ids) {
  toast(() => (t('toast.zipping')));
  const files = [];
  const recs = [];
  for (const id of ids) {
    const rec = await getRecord(id, { reload: true });
    if (!rec?.blob) continue;
    files.push({ name: saver.fileNameFor(rec), data: new Uint8Array(await rec.blob.arrayBuffer()) });
    recs.push(rec);
  }
  if (!files.length) return;
  const d = new Date();
  const zname = `noiseform_${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}_${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}.zip`;
  downloadBlob(zip(files), zname);
  const at = Date.now();
  const fresh = new Map(recs.filter((r) => !r.saved).map((r) => [r.id, { at, name: zname + ' › ' + saver.fileNameFor(r), via: 'zip' }]));
  await db.patch([...fresh.keys()], (id) => ({ saved: fresh.get(id) }));
  for (const [id, saved] of fresh) {
    const light = history.find((r) => r.id === id);
    if (light) light.saved = saved;
    if (recCache.has(id)) recCache.get(id).saved = saved;
  }
  publish('records:updated', history, state.session.currentId);
  const cur = await currentRecord();
  if (cur) publish('records:saved', cur);
}

async function clearHistory() {
  if (!history.length) return;
  if (!(await queries.confirmDialog(() => (t('confirm.clearHistory')), { danger: true }))) return;
  await db.clear();
  for (const r of history) {
    publish('records:forget', r.id);
  }
  const removed = history.map((r) => r.id);
  history = [];
  publish('records:removed', removed);
  recCache.clear();
  state.session.currentId = null;
  publish('records:updated', history, null);
  publish('records:empty');
  recCache.pin('stage', []);
  toast(() => (t('toast.historyCleared')));
}


// Newest archive record that would come out identical to the given generation key (see dupcheck.generationKey).
// Keys are memoised per record id; tiles and post-processing results never count.
const keyMemo = new Map();
export function findDuplicateRecord(key) {
  for (const r of history) {
    if (!r.params || r.kind !== 'gen') continue;
    let k = keyMemo.get(r.id);
    if (k === undefined) keyMemo.set(r.id, (k = recordKey(r)));
    if (k === key) return r;
  }
  return null;
}

export { getRecord, userSelect, focusPending, addRecords, selectRecord, openPost, updateRecord, setFlag, deleteRecords, batchAction, refreshStorage, openStorage, saveRecord, markSaved, currentRecord, zipAll, zipRecords, clearHistory };
