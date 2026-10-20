// NOISEFORM — startup and dependency assembly.
import { $, pickFile } from './util.js';
import { state, hydrate, on, set } from './store.js';
import { bindCopy, setLang, applyI18n, getLang } from './i18n.js';
import * as nai from './nai.js';
import { startContours, startBlobs } from './fx.js';
import { applyAppearance, toggleAppearance } from './themes.js';
import { setRemoteSuggest } from './ui/editor.js';
import { initPanel, refreshAll, effectiveModel, currentCost } from './ui/panel.js';
import { initStage, showEmpty, renderTools, urlFor, updateSaveTool, updateFlagTool } from './ui/stage.js';
import { initArchive, renderArchive, markCompare, clearSelection } from './ui/archive.js';
import { compareOpen, initCompare, openCompare, addToCompare } from './ui/compare.js';
import { openInpaint } from './ui/inpaint.js';
import { openSettings, openImport } from './ui/dialogs.js';
import { toast } from './ui/modal.js';
import * as saver from './saver.js';
import { initAuto } from './auto.js';
import { queueRunning, initQueue, loadQueue, setTiledFinalizer } from './queue.js';
import { openIdeate } from './ui/ideate.js';
import * as stats from './stats.js';
import { initNotify } from './notify.js';
import { chunkNames, findChunk, toggleChunks } from './ui/chunks.js';
import './ui/tours.js';
import { maybeStart, startTour } from './ui/tour.js';
import { finalizeTiledJob } from './ui/tiled.js';
import { openTimeline, snapshotEditors } from './ui/timeline.js';
import { thumbUrlFor } from './ui/archive.js';
import { initXY } from './ui/xy.js';
import { initResizer } from './ui/resizer.js';
import { refreshLive, refreshAccount, renderQuota } from './app/account.js';
import { initRecords, deleteRecords, history, recCache, loadRecords, getRecord, userSelect, addRecords, selectRecord, batchAction, focusPending, refreshStorage, openStorage, saveRecord, zipAll, clearHistory, findDuplicateRecord, currentRecord } from './app/records.js';
import { initGeneration, getPendingSaves, downloadPendingSave, generate, generateNow, retrySave, releaseSave, paintPendingSaves, generationKeyFor } from './app/generate.js';
import { applyEditors, reuseParams, useSeedOf, editorSnapshot, applySnapshot, doRandomPrompt } from './app/editor.js';
import { initTools, runTool, importActions } from './app/tools.js';
import { wireKeys } from './app/keys.js';

import { initGenerationView } from './ui/genview.js';
import { initRecordView, recordQueries } from './ui/recordview.js';
import { initToolView, toolPorts } from './ui/toolview.js';

initGeneration({ compareOpen, following: () => state.session.follow,
  chunks: () => chunkNames().map(findChunk).filter(Boolean) });
initRecords(recordQueries);
initTools(toolPorts);
initGenerationView({ queueRunning, getPendingSaves, retrySave, downloadPendingSave });
initRecordView({ history: () => history, remove: deleteRecords });
initToolView();

// Stored data that failed to read / migrate / write is backed up by persist.js; say so instead of failing silently.
// Belt and braces for browsers without overflow: clip on the root: undo any programmatic page scroll.
addEventListener('scroll', () => (scrollX || scrollY) && scrollTo(0, 0), { passive: true });
document.addEventListener('nf:persist-error', (e) => {
  const { key, operation, backupKey } = e.detail || {};
  const zh = getLang() === 'zh';
  const what = operation === 'write' ? (zh ? '保存失败' : 'could not be saved') : zh ? '读取失败，已改用默认值' : 'could not be read; defaults are used';
  toast((zh ? `本地数据「${key}」${what}` : `Local data "${key}" ${what}`) + (backupKey ? (zh ? `（原数据已备份为 ${backupKey}）` : ` (original kept as ${backupKey})`) : ''), 'warn', 8000);
});
export { getPendingSaves, retrySave, downloadPendingSave } from './app/generate.js';
const P = state.params;
async function boot() {
  await hydrate();
  applyAppearance();
  setLang(state.settings.lang);
  // Set the dictionary before component subscribers repaint.
  on('settings.lang', setLang);
  syncLangBtn();
  await nai.probeProxy();
  refreshLive();
  if (state.session.serverStale) toast(() => (getLang() === 'zh' ? `本地服务还是旧版本（${state.session.serverStale}），页面已更新 · 请关掉 node server.js 再重新启动，否则代理的修复不生效` : `The local server is still an old version (${state.session.serverStale}) · restart node server.js so the proxy fixes take effect`), 'warn', 15000);

  initPanel({ randomPrompt: doRandomPrompt, openInpaint: () => openInpaint() });
  initStage({
    tool: runTool,
    select: (id) => userSelect(id),
    dropFile: (f) => openImport(f, importActions),
    // the image a derived record was made from: an archive record (sourceId) or the base image kept on the record
    original: async (rec) => {
      if (rec.sourceId) {
        const src = await getRecord(rec.sourceId);
        return src ? urlFor(src) : null;
      }
      return rec.baseImage || null;
    },
  });
  initArchive({
    select: userSelect,
    useSeed: (id) => getRecord(id).then(useSeedOf),
    useParams: (id) => getRecord(id).then((rec) => rec && reuseParams(rec, { keepSeed: true })),
    compare: (id) => addToCompare(id),
    download: (id) => getRecord(id).then((rec) => rec && saveRecord(rec, { ask: true })),
    batch: batchAction,
    zip: zipAll,
    clear: clearHistory,
    storage: () => openStorage(),
    refresh: () => renderArchive(history, state.session.currentId),
    focusPending,
  });
  initCompare({
    get: getRecord,
    urlFor,
    currentId: () => state.session.currentId,
    latestId: () => history[0]?.id,
    onChange: (ids) => {
      recCache.pin('compare', ids);
      markCompare(ids, history, state.session.currentId);
    },
  });
  saver.getDir();
  // animate only on the empty stage; behind an image the field is drawn once and held
  const posterUp = () => !$('#poster').classList.contains('gone');
  contours = startContours($('#contours'), { enabled: () => state.settings.fxBg, animate: posterUp });
  startBlobs($('.poster-blobs'), { active: posterUp });

  setRemoteSuggest(async (q) => {
    try {
      return await nai.suggestTags(effectiveModel().id, q);
    } catch {
      return [];
    }
  });

  await loadRecords();
  renderArchive(history, null);
  refreshStorage();
  if (history[0]) await selectRecord(history[0].id);
  else showEmpty();

  wireTop();
  wireKeys();
  initNotify({ open: (id) => (clearSelection(), userSelect(id)) });
  initAuto({ generate: (o) => generate(o) });
  await loadQueue();
  initQueue({ generate: (o) => generate(o), retrySave, releaseSave, snapshot: editorSnapshot, applySnapshot, generationKey: generationKeyFor, findDuplicate: findDuplicateRecord });
  // tiled upscale: composition runs from the persisted job, so it also completes after a page reload
  setTiledFinalizer((job) =>
    finalizeTiledJob(job, {
      getBlob: async (id) => (await getRecord(id))?.blob,
      getRecord: (id) => getRecord(id),
      findRecords: (pred) => history.filter(pred),
      onResult: async ({ blob, width, height, sourceId, tiled }) => {
        const src = (await getRecord(sourceId)) || {};
        const [out] = await addRecords([{ blob, seed: src.seed, width, height, model: src.model, kind: 'upscale', demo: src.demo, params: src.params, tiled, sourceId }], { select: false });
        return out;
      },
    })
  );
  initResizer();
  for (const sel of ['#stage', '#archive']) {
    $(sel)?.addEventListener('pointerdown', (e) => {
      const a = document.activeElement;
      if (a && a !== document.body && a.matches('textarea, input[type=text], input:not([type])') && !$(sel).contains(a) && !e.target.closest('input, textarea, select')) a.blur();
    });
  }
  initXY({
    snapshot: editorSnapshot,
    apply: (snap) => applySnapshot(snap),
    compare: (ids) => openCompare(ids),
    get: getRecord,
    urlFor,
    thumb: (id) => {
      const r = history.find((x) => x.id === id);
      return r ? thumbUrlFor(r) : '';
    },
    view: (id) => (clearSelection(), userSelect(id)),
    currentSeed: () => history.find((r) => r.id === state.session.currentId)?.seed ?? null,
  });
  on('settings.token', () => {
    refreshLive();
    refreshAccount();
  });
  refreshAccount();
  setInterval(() => state.session.live && !document.hidden && refreshAccount(), 60000);
  window.__nfPromptFormat = state.settings.promptFormat !== false;
  on('settings.promptFormat', (v) => (window.__nfPromptFormat = v !== false));
  maybeStart('main', 1500);
  on('settings.lang', refreshLanguage);
}

function wireTop() {
  $('#btnSettings').onclick = settings;
  $('#conn').onclick = settings;
  $('#btnTheme').onclick = (e) => toggleAppearance(e.currentTarget, appearanceChanged);
  $('#btnLang').onclick = () => changeLang(getLang() === 'zh' ? 'en' : 'zh');
  $('#btnImport').onclick = async () => {
    const f = await pickFile();
    if (f) openImport(f, importActions);
  };
  $('#btnGenerate').onclick = () => generateNow();
  $('#btnIdeate').onclick = (e) => {
    e.stopPropagation();
    openIdeate({ apply: (patch) => applySnapshot({ params: { ...structuredClone(P), ...patch } }), currentImage: async () => (await currentRecord())?.blob || null });
  };
  // today's stats
  for (const el of [$('#quota'), $('#anlas')]) {
    el.classList.add('clickable');
    el.addEventListener('click', () => stats.toggleStats($('#anlas'), { usage: state.session.usage, live: state.session.live }));
  }
  bindCopy($('#anlas'), 'title', () => (getLang() === 'zh' ? 'Anlas 余额 · 点击查看今日统计' : 'Anlas · click for today’s stats'));
  $('#btnSnippets').onclick = (e) => toggleChunks(e.currentTarget);
  $('#btnTimeline').onclick = () =>
    openTimeline({
      history: () => history,
      thumb: (r) => thumbUrlFor(r),
      current: () => P,
      view: (id) => (clearSelection(), userSelect(id)),
      restore: (entry) => {
        const before = snapshotEditors(P);
        applyEditors(entry);
        const zh = getLang() === 'zh';
        toast(() => ((getLang() === 'zh') ? '已恢复该版本的提示词 · 点击撤销' : 'Prompt restored · click to undo'), 'ok', 6000, () => applyEditors(before));
      },
    });
}

// Put a prompt version (prompt / UC / characters) into the editors.
function settings() {
  openSettings({
    testToken: async () => {
      refreshLive();
      return refreshAccount();
    },
    clearHistory,
    appearanceChanged,
    setLang: changeLang,
    replayTour: (id) => startTour(id, { force: true }),
    folder: {
      supported: saver.folderSupported(),
      name: async () => (await saver.getDir())?.name || '',
      pick: async () => (await saver.pickDir()).name,
      clear: () => saver.clearDir(),
    },
  });
}

// Theme or text size changed (top-bar popover or Settings): repaint the canvas background,
// which only redraws on its own while animating.
let contours = null;
function appearanceChanged() {
  requestAnimationFrame(() => contours?.redraw());
}

function changeLang(l) {
  set('settings.lang', l);
}

function refreshLanguage() {
  syncLangBtn();
  renderTools();
  const cur = recCache.get(state.session.currentId);
  if (cur) (updateSaveTool(cur), updateFlagTool(cur));
  refreshAll();
  renderArchive(history, state.session.currentId);
  renderQuota(state.session.usage);
  refreshLive();
  paintPendingSaves();
  refreshStorage();
  bindCopy($('#anlas'), 'title', () => (getLang() === 'zh' ? 'Anlas 余额 · 点击查看今日统计' : 'Anlas · click for today’s stats'));
}

function syncLangBtn() {
  bindCopy($('#btnLang'), 'textContent', () => (getLang() === 'zh' ? 'EN' : '中'));
}

boot().catch((err) => {
  console.error(err);
  toast('Boot error: ' + err.message, 'err');
});

export { applyI18n, currentCost };
