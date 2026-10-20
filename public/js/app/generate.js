// Generation lifecycle and memory-only save recovery.
import { uid, randomSeed, downloadBlob } from '../util.js';
import { state, emit, commit } from '../store.js';
import { t, getLang } from '../i18n.js';
import * as nai from '../nai.js';
import { demoGenerate } from '../demo.js';
import { readTextChunks } from '../png.js';
import { zip } from '../zip.js';
import { autoRunning } from '../auto.js';
import { queueRunning, cutIn } from '../queue.js';
import * as stats from '../stats.js';
import { checkDuplicate, rememberJob, generationKey } from '../dupcheck.js';
import { stripForGeneration } from '../promptfmt.js';
import { history, addRecords, selectRecord } from './records.js';
import { editorSnapshot } from './editor.js';
import { refreshAccount } from './account.js';
import { emit as publish, toast } from './events.js';
import { effectiveModel } from '../domain/cost.js';
import { vibeKey } from '../domain/generation.js';
import { expandChunks } from '../domain/chunks.js';
let queries = { compareOpen: () => false, following: () => state.session.follow, chunks: () => [] };
export function initGeneration(ports) { queries = { ...queries, ...ports }; }
const P = state.params;
// @chunk references are expanded for the request and for the archived params (chunks may change later)
// … and `#` comment lines / `---` separators are dropped (after expansion, so chunks may carry comments too)
const cleanPrompt = (s) => stripForGeneration(expandChunks(s || '', queries.chunks()));
function expandParams(p) {
  const out = { ...p, prompt: cleanPrompt(p.prompt), uc: cleanPrompt(p.uc) };
  if (Array.isArray(p.characters)) out.characters = p.characters.map((c) => ({ ...c, prompt: cleanPrompt(c.prompt), uc: cleanPrompt(c.uc) }));
  return out;
}

function freezeTree(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

// GenerationSpec + ExecutionContext: built synchronously before the first await.
// UI drafts, chunk definitions and account/connection changes cannot alter an in-flight job.
function generationContext(overrides) {
  const spec = structuredClone({
    params: expandParams(overrides.params || P),
    base: overrides.base !== undefined ? overrides.base : state.base,
    vibes: overrides.vibes ?? state.vibes,
    refs: overrides.refs ?? state.refs ?? [],
  });
  spec.refs = spec.refs.filter((r) => r.enabled !== false);
  const model = structuredClone(overrides.model || effectiveModel(spec));
  const p = spec.params;
  Object.assign(p, {
    model: model.id, width: overrides.width ?? p.width, height: overrides.height ?? p.height,
    nSamples: overrides.nSamples ?? p.nSamples, steps: model.fixed?.steps || p.steps,
    sampler: model.fixed?.sampler || p.sampler,
    seed: overrides.seed ?? (p.seed !== '' && p.seed != null ? Number(p.seed) : randomSeed()),
  });
  if (p.sampler === 'ddim_v3' && !model.v3) p.sampler = 'k_euler_ancestral';
  if ((!model.v3 && p.noiseSchedule === 'native') || model.forceKarras) p.noiseSchedule = 'karras';
  spec.refs = model.refs ? spec.refs : [];
  spec.vibes = model.vibes && !spec.refs.length && !(spec.base?.mask && model.v4) ? spec.vibes.filter((v) => v.enabled) : [];
  const connection = nai.connectionContext();
  const account = { tier: state.session.tier, active: state.session.active, freeBlocked: state.session.freeBlocked, usageNegative: state.session.usageNegative };
  const cost = nai.generationCost({
    ...p, model, account, strength: spec.base?.strength ?? 1, isInpaint: !!spec.base?.mask,
    newVibeEncodes: model.v3 ? 0 : spec.vibes.filter((v) => !v.enc?.[vibeKey(model.id, v.ie)]).length,
    vibeCount: spec.vibes.length, refCount: spec.refs.length,
  });
  return freezeTree({ ...spec, model, cost, execution: { connection, account, live: connection.identity !== 'demo', stream: state.settings.stream } });
}

// Key of the image a queue item would produce (null when it has a base image: base strength / mask aren't
// recorded, so such images can't be compared reliably). Same overrides as generate().
export function generationKeyFor(overrides) {
  const c = generationContext(overrides);
  if (c.base || overrides.kind) return null;
  return generationKey({ params: c.params, seed: c.params.seed, model: c.model.id, demo: !c.execution.live, kind: 'gen', base: null, vibes: c.vibes, refs: c.refs });
}

function seedFromPNG(blob, fallback) {
  return blob
    .arrayBuffer()
    .then((buf) => {
      const meta = readTextChunks(new Uint8Array(buf));
      const c = meta.Comment ? JSON.parse(meta.Comment) : null;
      return c?.seed ?? fallback;
    })
    .catch(() => fallback);
}

// ------------------------------------------------------------ generation
let busy = false;

function setBusy(on, label) {
  busy = on;
  state.session.generating = on;
  publish('generation:busy', on, label);
}

// "Generate": cut in while the queue runs, otherwise a normal generation.
function generateNow() {
  if (queueRunning()) return cutIn(editorSnapshot());
  // same fixed seed + identical params as the last manual generation → warn; a second click within 3 s clears the seed
  const dup = checkDuplicate({ params: P });
  if (dup.duplicate && !dup.armed) {
    toast(() => (getLang() === 'zh' ? '上一张已用过相同的固定种子和完全一致的参数。3 秒内再点一次「生成」将清除种子并继续' : 'Same fixed seed and identical settings as the last image. Click Generate again within 3 s to clear the seed and continue'), 'warn', 3400);
    return;
  }
  if (dup.duplicate && dup.armed) {
    commit('params', { seed: '' });
  }
  return generate();
}

// GeneratedArtifact recovery is deliberately memory-only: quota exhaustion must not discard
// the Blob or submit another request. Stable record IDs make partial batch writes idempotent.
const pendingSaves = new Map();
// Includes persisted queue recoveries awaiting releaseSave (unlike the UI list).
export const pendingSaveCount = () => pendingSaves.size;

// Register received Blobs before decoding, thumbnails or persistence can fail.
// Every retry reuses these stable record IDs and never invokes a paid API.
export async function receiveOutputs(items, { options = {}, context = null, queued = false, select = true, prepare } = {}) {
  let no = Math.max(0, ...history.map((r) => r.no || 0), ...[...pendingSaves.values()].flatMap((p) => p.items.map((r) => r.no || 0)));
  const batchId = uid();
  const entry = {
    id: uid(), stage: 'received', options, context, queued, select, prepare,
    items: items.map((r) => ({ id: uid(), no: ++no, createdAt: Date.now(), batchId: items.length > 1 ? batchId : null, ...r })),
  };
  pendingSaves.set(entry.id, entry);
  return retrySave(entry.id);
}
export const getPendingSaves = () => [...pendingSaves.values()].filter((p) => p.stage !== 'persisted').map((p) => ({
  id: p.id, stage: p.stage, items: p.items.map((r) => ({ ...r })),
}));

function paintPendingSaves() { return publish('pending-saves', getPendingSaves()); }
const openPendingSaves = () => publish('pending-saves:open');

export async function downloadPendingSave(id) {
  const entry = pendingSaves.get(id);
  if (!entry) return;
  if (entry.items.length === 1) return downloadBlob(entry.items[0].blob, `noiseform-${entry.items[0].id}.png`);
  const files = await Promise.all(entry.items.map(async (r) => ({ name: `${r.id}.png`, data: new Uint8Array(await r.blob.arrayBuffer()) })));
  downloadBlob(new Blob([zip(files)], { type: 'application/zip' }), `noiseform-${id}.zip`);
}

// {ok:false, stage:'persist', pendingId, err} must never be retried through generate().
// Concurrent UI/queue retries share one promise; completed queue results remain until consumed.
export async function retrySave(id) {
  const entry = pendingSaves.get(id);
  if (!entry) return { ok: false, stage: 'persist', pendingId: id, err: new Error(t('err.pendingGone')) };
  if (entry.result) return entry.result;
  if (entry.saving) return entry.saving;
  entry.saving = (async () => {
    try {
      await entry.prepare?.(entry.items, entry);
      entry.prepare = null;
      await addRecords(entry.items, { select: !!entry.select, reveal: entry.options.reveal ?? true, silent: !!entry.options.silent, onPersisted: (recs) => {
        entry.stage = 'persisted';
        entry.result = { ok: true, stage: 'persisted', recs };
      } });
    } catch (err) {
      if (entry.stage !== 'persisted') {
        entry.stage = 'persist';
        entry.recoverable = true;
        paintPendingSaves();
        toast(() => (getLang() === 'zh' ? '图像已生成，但入库失败 · 点击重试保存 / 下载（刷新会丢失待保存图像）' : 'Image generated, archive save failed · click to retry save / download (reload loses unsaved images)'), 'warn', 12000, openPendingSaves);
        return { ok: false, stage: 'persist', pendingId: id, err };
      }
      // Rendering/notification errors after db.put must never turn success into regeneration.
      toast(String(err.message || err), 'warn');
    }
    const { recs } = entry.result;
    const o = entry.options;
    if (entry.context && (!o.params || o.logPrompt) && ['gen', 'img2img', 'inpaint'].includes(recs[0].kind)) publish('prompt:logged', entry.context.params, entry.context.model.id, recs.map((r) => r.id), history);
    try {
      publish('notification:done', recs, { label: o.label || (autoRunning() ? (getLang() === 'zh' ? '自动生成' : 'Auto') : '') });
      o.onRecords?.(recs);
    } catch (err) { toast(String(err.message || err), 'warn'); }
    // Only failed queue saves need a completed receipt for a later queue resume.
    if (!entry.queued || !entry.recoverable) pendingSaves.delete(id);
    paintPendingSaves();
    return entry.result;
  })();
  try { return await entry.saving; }
  finally { entry.saving = null; }
}

// job overrides let tools (variations / enhance) reuse the pipeline
async function generate(overrides = {}) {
  if (busy) {
    // a tool (variations / enhance) pressed while something generates: say so instead of silently doing nothing
    if (overrides.kind && !overrides.quiet) toast(() => (getLang() === 'zh' ? '正在生成中，等这张完成后再试' : 'Still generating — try again after this image'), 'warn', 2600);
    return { ok: false, skipped: true };
  }
  const context = generationContext(overrides);
  const { model, params, base, cost, execution } = context;
  const hasChars = (params.characters || []).some((c) => c.enabled && c.prompt.trim());
  if (!params.prompt.trim() && !hasChars) {
    toast(() => (t('gen.needPrompt')), 'warn');
    publish('prompt:focus');
    return { ok: false, skipped: true };
  }
  const { width: W, height: H, nSamples: n, steps, seed } = params;
  if (!overrides.params && !overrides.kind) rememberJob(P, P.seed ? seed : null);
  const action = base ? (base.mask ? 'infill' : 'img2img') : 'generate';
  const kind = overrides.kind || (action === 'infill' ? 'inpaint' : action === 'img2img' ? 'img2img' : 'gen');
  const extra = structuredClone(overrides.extra || {});

  setBusy(true);
  const label = `${model.short} · ${W}×${H} · ${steps} STEPS · SEED ${seed}` + (n > 1 ? ` · ×${n}` : '');
  // follow the new image only if the user is looking at the newest one (or nothing)
  const cur = state.session.currentId;
  const follow = !queries.compareOpen() && (overrides.follow ?? (!cur || cur === history[0]?.id || queries.following() === true));
  state.session.follow = follow;
  publish('generation:start', { width: W, height: H, label, prompt: params.prompt, seed }, { visible: follow });
  publish('generation:pending', { w: W, h: H, n, progress: 0, label: model.short, focused: follow });
  if (follow) publish('records:current', null);
  // One monotonic progress for the stage, the archive card, the Generate button and the tab title.
  let shownP = 0;
  const report = (p) => {
    if (!(p >= shownP)) return; // never backwards
    shownP = p;
    publish('generation:progress', p);
  };
  // Streamed jobs report real steps, so they get no time-based estimate (1.7.1: the estimate ran to
  // ~93% while queued, then the first real step "dropped" it to ~13%). Until the first step: "··".
  const streamed = execution.live && execution.stream && model.v4;
  let estimate = !streamed;
  let t0 = performance.now();
  const expected = (2.2 + 6.5 * ((W * H * steps) / (832 * 1216 * 28)) * n) * 1000;
  let streaming = false;
  if (streamed) publish('generation:waiting', true);
  // Once the estimate is spent the bar stops at its cap; say we are still waiting (with elapsed time) so a
  // slow server is distinguishable from a frozen page. The request watchdog in nai.js ends real stalls.
  let waitShown = '';
  const ticker = setInterval(() => {
    if (!estimate || streaming) return;
    const spent = performance.now() - t0;
    report(Math.min(0.94, spent / expected));
    if (spent > expected * 1.15) {
      const s = Math.floor(spent / 1000), text = `${label} · ${getLang() === 'zh' ? '等待服务器' : 'Waiting for server'} ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (text !== waitShown) publish('generation:label', (waitShown = text));
    }
  }, 120);

  try {
    let results; // [{ blob, seed }]
    if (!execution.live) {
      results = await demoGenerate(
        { prompt: params.prompt, uc: params.uc, width: W, height: H, nSamples: n, steps, scale: params.scale, sampler: params.sampler, seed, base: base?.image, mask: base?.mask, strength: base?.strength },
        (p) => report(p)
      );
      if (!state.session.demoNoted) {
        state.session.demoNoted = true;
        toast(() => (t('toast.demoNote')), 'warn', 5200);
      }
    } else {
      const job = { params: { ...params, nSamples: n }, model, seed, action, width: W, height: H, nSamples: n };
      if (base) {
        job.image = await nai.prepBase(base.image, W, H);
        job.strength = base.strength;
        job.noise = base.noise;
        if (base.mask) job.mask = await nai.prepMask(base.mask, W, H);
      }
      const refs = context.refs;
      if (refs.length) {
        publish('generation:label', label + ' · REF');
        job.refs = await Promise.all(refs.map(async (r) => ({ ...r, data: await nai.prepCharRef(r.image) })));
      }
      const vibes = context.vibes;
      if (vibes.length) {
        job.vibes = [];
        for (const v of vibes) {
          if (model.v3) {
            job.vibes.push({ data: await nai.prepVibe(v.image, model), ie: v.ie, strength: v.strength });
            continue;
          }
          const key = vibeKey(model.id, v.ie);
          let encoded = v.enc?.[key];
          if (!encoded) {
            publish('generation:label', label + ' · ENCODING VIBE');
            encoded = await nai.encodeVibe(await nai.prepVibe(v.image, model), v.ie, model.id, { connection: execution.connection });
            // Cache only on the same source image; do not mutate the frozen request context.
            for (const list of [state.vibes, overrides.vibes || []]) {
              const target = list.find((x) => x.id === v.id && x.image === v.image);
              if (target) target.enc = { ...target.enc, [key]: encoded };
            }
            emit('vibes');
          }
          job.vibes.push({ data: encoded, ie: v.ie, strength: v.strength });
        }
        publish('generation:label', label);
      }
      const body = nai.buildGenerateBody(job);
      let blobs;
      if (execution.stream && model.v4) {
        try {
          publish('generation:label', label + (getLang() === 'zh' ? ' · 等待首帧' : ' · WAITING'));
          blobs = await nai.generateStream(body, {
            connection: execution.connection,
            onPreview: ({ step, image }) => {
              if (!streaming) publish('generation:label', label);
              streaming = true;
              report(Math.min(0.97, (step + 1) / steps));
              publish('generation:preview', image);
            },
          });
        } catch (err) {
          // only fall back when nothing was produced (endpoint missing / rejected), never mid-stream
          if (streaming || ![400, 404, 405].includes(err.status)) throw err;
          // no stream on this endpoint: fall back to the plain request and the time estimate
          publish('generation:label', label);
          estimate = true;
          t0 = performance.now();
          blobs = await nai.generate(body, { connection: execution.connection });
        }
      } else blobs = await nai.generate(body, { connection: execution.connection });
      if (!blobs.length) throw new nai.UnknownResultError(new Error(t('copy.main.0')));
      results = await Promise.all(blobs.map(async (blob, i) => ({ blob, seed: await seedFromPNG(blob, (seed + i) >>> 0) })));
      refreshAccount();
    }
    // Received is a generation success even if local storage is full. Count exactly once.
    stats.recordGen({ n: results.length, cost, live: execution.live, v5: !!model.v5 });
    const items = results.map((r) => ({
      ...extra,
      blob: r.blob, seed: r.seed, width: W, height: H, model: model.id, kind, demo: !execution.live,
      params: { ...structuredClone(params), seed: r.seed },
      generation: { mode: execution.live ? 'live' : 'demo', connection: execution.connection.identity,
        baseId: base?.sourceId || base?.id || null, refs: context.refs.map((r) => r.id), vibes: context.vibes.map((v) => v.id),
        key: base || kind !== 'gen' ? null : generationKey({ params, seed: r.seed, model: model.id, demo: !execution.live, kind, refs: context.refs, vibes: context.vibes }) },
      ...(base ? (base.sourceId ? { sourceId: base.sourceId } : { baseImage: base.image }) : {}),
    }));
    try {
      const result = await receiveOutputs(items, { queued: !!extra.job, options: overrides, context,
        prepare: async (_items, entry) => {
          report(1);
          state.session.lastSeed = results[0]?.seed ?? seed;
          await publish('generation:land', results[0]?.blob);
          entry.select = queries.following() && !queries.compareOpen();
          if (!entry.select) publish('generation:stop');
          publish('generation:pending', null);
        },
      });
      if (result.ok) publish('generation:done', result);
      return result;
    } finally {
      publish('generation:handoff'); // showRecord normally took it over already
    }
  } catch (err) {
    publish('generation:failed', err);
    publish('generation:stop');
    publish('generation:pending', null);
    if (err.status === 403 && err.message === t('err.freeBlocked')) {
      // NovelAI disabled free generations for this account: stop advertising FREE
      state.session.freeBlocked = true;
      emit('session.tier');
    }
    if (!state.session.currentId) publish('records:empty');
    else selectRecord(state.session.currentId);
    if (!overrides.quiet) toast(() => (`${t('gen.failed')}: ${err.message || err}`), 'err');
    console.error(err);
    return { ok: false, stage: 'request', err };
  } finally {
    clearInterval(ticker);
    publish('generation:finished');
    setBusy(false);
  }
}


export const releaseSave = (id) => pendingSaves.delete(id);

export { generationContext, generate, generateNow, setBusy, paintPendingSaves };
