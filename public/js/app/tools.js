// Image tool commands.
import { randomSeed, blobToDataURL, blobToBase64, loadImage, makeCanvas, canvasToBlob } from '../util.js';
import { state } from '../store.js';
import { t, getLang } from '../i18n.js';
import { modelById } from '../data.js';
import * as nai from '../nai.js';
import { demoAugment, demoUpscale } from '../demo.js';
import { history, recCache, currentRecord, getRecord, setFlag, saveRecord, selectRecord, openPost, deleteRecords } from './records.js';
import { generate, setBusy, receiveOutputs } from './generate.js';
import { editorSnapshot, useSeedOf, reuseParams } from './editor.js';
import { refreshAccount } from './account.js';
import { emit as publish, toast } from './events.js';
let ports = {};
export function initTools(deps) { ports = deps; }
const P = state.params;
async function recDataURL(rec) {
  return blobToDataURL(rec.blob);
}

async function asPNG(blob) {
  if (blob.type === 'image/png') return blob;
  const img = await imageFromBlob(blob);
  const c = makeCanvas(img.naturalWidth, img.naturalHeight);
  c.getContext('2d').drawImage(img, 0, 0);
  return canvasToBlob(c);
}

async function runTool(name) {
  const rec = await currentRecord();
  if (!rec) return;
  return withRecord(rec, () => toolForRecord(name, rec));
}

async function withRecord(rec, run) {
  const release = recCache.retain(rec.id);
  if (!recCache.has(rec.id)) recCache.set(rec.id, rec);
  try { return await run(); }
  finally { release(); }
}

// Temporary decoding URLs are not record URLs; release even if decoding fails.
async function imageFromBlob(blob) {
  const url = URL.createObjectURL(blob);
  try { return await loadImage(url); }
  finally { URL.revokeObjectURL(url); }
}

async function toolForRecord(name, rec) {
  switch (name) {
    case 'star':
      return setFlag([rec.id], rec.flag === 1 ? 0 : 1);
    case 'save':
      try {
        await saveRecord(rec);
      } catch (err) {
        toast(err.message || String(err), 'err');
      }
      break;
    case 'compare': {
      if (ports.compareOpen()) return publish('compare:close');
      const other = rec.id === history[0]?.id ? history[1]?.id : history[0]?.id;
      return publish('compare:open', other ? [rec.id, other] : [rec.id]);
    }
    case 'copy': {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': await asPNG(rec.blob) })]);
        toast(() => (t('toast.copied')));
      } catch (err) {
        toast(err.message, 'err');
      }
      break;
    }
    case 'upscale':
      return upscaleRec(rec);
    case 'variations': {
      if (!rec.params) return;
      const params = { ...structuredClone(rec.params), nSamples: P.nSamples };
      return generate({
        params,
        model: modelById(rec.model),
        width: rec.width,
        height: rec.height,
        base: { image: await recDataURL(rec), strength: 0.8, noise: 0.1, mask: null },
        seed: randomSeed(),
        kind: 'variation',
      });
    }
    case 'enhance':
      return ports.openEnhance(rec, (o) => withRecord(rec, () => enhanceRec(rec, o)));
    case 'post':
      return openPost(rec);
    case 'tiled':
      return ports.openTiled(rec, {
        snapshot: editorSnapshot,
        getBlob: async (r) => (r.blob ? r.blob : (await getRecord(r.id))?.blob),
        onResult: async ({ blob, width, height, sourceId, tiled }) => {
          const src = (await getRecord(sourceId)) || rec;
          const result = await receiveOutputs([{ blob, seed: src.seed, width, height, model: src.model, kind: 'upscale', demo: src.demo, params: src.params, tiled, sourceId: src.id }]);
          if (!result.ok) throw result.err;
          return result.recs[0];
        },
      });
    case 'director':
      return director(await recDataURL(rec));
    case 'base':
      await ports.setBaseImage(await recDataURL(rec));
      state.base.sourceId = rec.id;
      return toast(() => (t('toast.baseSet')));
    case 'inpaint':
      await ports.setBaseImage(await recDataURL(rec));
      state.base.sourceId = rec.id;
      return ports.openInpaint();
    case 'vibe':
      await ports.addVibe(await recDataURL(rec));
      return toast(() => (t('toast.vibeAdded')));
    case 'ref':
      await ports.addRef(await recDataURL(rec));
      return toast(() => (t('toast.refSet')));
    case 'seed':
      return useSeedOf(rec);
    case 'reuse':
      return reuseParams(rec);
    case 'delete': {
      if (!(await ports.confirmDialog(() => (t('confirm.delete')), { danger: true }))) return;
      await deleteRecords([rec.id]);
      return toast(() => (t('toast.deleted')));
    }
  }
}

async function upscaleRec(rec) {
  const live = state.session.live;
  if (live) {
    const cost = nai.upscaleCost(rec.width, rec.height);
    const zh = getLang() === 'zh';
    if (rec.width * rec.height > 1048576) return toast(() => ((getLang() === 'zh') ? '放大仅支持 ≤ 1MP 的图像。' : 'Upscale supports images up to 1MP.'), 'warn');
    if (!(await ports.confirmDialog(() => (((getLang() === 'zh') ? `放大 4 倍，消耗 ◈ ${cost} Anlas。` : `Upscale 4×, costs ◈ ${cost} Anlas.`) + ` ${rec.width}×${rec.height} → ${rec.width * 4}×${rec.height * 4}`)))) return;
  }
  setBusy(true, 'UPSCALING');
  publish('tool:start', { width: rec.width, height: rec.height, label: `UPSCALE ×4 · ${rec.width}×${rec.height}` });
  let p = 0;
  const tick = setInterval(() => publish('tool:progress', (p = Math.min(0.93, p + 0.02))), 120);
  try {
    let blob;
    if (live) blob = await nai.upscale(await blobToBase64(rec.blob), rec.width, rec.height);
    else blob = await demoUpscale(ports.urlFor(rec), 4);
    const result = await receiveOutputs([{ blob, seed: rec.seed, width: rec.width * 4, height: rec.height * 4, model: rec.model, kind: 'upscale', demo: !live, params: rec.params }], {
      prepare: async (items) => {
        const img = await imageFromBlob(blob);
        Object.assign(items[0], { width: img.naturalWidth, height: img.naturalHeight });
        publish('generation:stop');
      },
    });
    if (result.ok) toast(() => (t('toast.upscaled')));
    else { publish('generation:stop'); await selectRecord(rec.id); }
    if (live) refreshAccount();
  } catch (err) {
    publish('generation:stop');
    selectRecord(rec.id);
    toast(err.message || String(err), 'err');
  } finally {
    clearInterval(tick);
    setBusy(false);
  }
}

async function enhanceRec(rec, { factor, strength, noise }) {
  const W = Math.round((rec.width * factor) / 64) * 64;
  const H = Math.round((rec.height * factor) / 64) * 64;
  const img = await loadImage(ports.urlFor(rec));
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, W, H);
  const url = c.toDataURL('image/png');
  const params = { ...structuredClone(rec.params || P), nSamples: 1 };
  return generate({ params, model: modelById(rec.model || P.model), width: W, height: H, nSamples: 1, base: { image: url, strength, noise, mask: null }, seed: rec.seed ?? randomSeed(), kind: 'enhance' });
}

function director(src) {
  return ports.openDirector(src, {
    run: async (reqType, { prompt, defry, emotion }) => {
      if (!state.session.live) return demoAugment(reqType, src, { emotion, defry });
      const { b64, width, height } = await nai.prepDirector(src);
      const blob = await nai.augment(reqType, b64, width, height, { prompt, defry });
      refreshAccount();
      return blob;
    },
    save: async (blob, tool) => {
      const result = await receiveOutputs([{ blob, seed: null, kind: 'director', demo: !state.session.live, params: null, tool }], {
        options: { reveal: false },
        prepare: async (items) => {
          const img = await imageFromBlob(blob);
          const cur = await currentRecord();
          Object.assign(items[0], { width: img.naturalWidth, height: img.naturalHeight, model: cur?.model });
        },
      });
      if (!result.ok) throw result.err;
    },
  });
}

// ------------------------------------------------------------ import actions
const shortName = (n) => (n.length > 18 ? n.slice(0, 8) + '…' + n.slice(-7) : n);
const importActions = {
  meta: (meta, opts) => {
    ports.applyMetadata(meta, opts);
    publish('tools:refresh');
    publish('tools:chars');
    toast(() => (t('toast.importDone')));
  },
  seed: (meta, name) => {
    state.session.seedFrom = { seed: String(meta.Comment.seed), label: shortName(name) };
    ports.applySeed(meta);
    publish('tools:refresh');
    toast(() => ((getLang() === 'zh' ? '已导入种子 ' : 'Seed imported ') + meta.Comment.seed), 'ok');
  },
  comp: (meta, name) => {
    state.session.seedFrom = { seed: String(meta.Comment.seed), label: shortName(name) };
    ports.applySeed(meta, { composition: true });
    publish('tools:refresh');
    toast(() => (getLang() === 'zh' ? '已导入种子和构图参数（提示词保持不变）' : 'Seed and composition settings imported (prompt kept)'), 'ok');
  },
  base: async (url) => {
    await ports.setBaseImage(url);
    toast(() => (t('toast.baseSet')));
  },
  inpaint: async (url) => {
    await ports.setBaseImage(url);
    ports.openInpaint();
  },
  vibe: async (url) => {
    await ports.addVibe(url);
    toast(() => (t('toast.vibeAdded')));
  },
  ref: async (url) => {
    await ports.addRef(url);
    toast(() => (t('toast.refSet')));
  },
  director: (url) => director(url),
};


export { runTool, importActions };
