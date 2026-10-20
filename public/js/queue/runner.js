// Queue commands and execution. All application/UI effects are injected.
import { persistError } from '../persist.js';
import { left, seedSource, seedChoice, shouldCheckFree, resultPolicy } from './policy.js';

export function createQueueRunner({ repository, tabs, state, getDeps, autoRunning, paint,
  toast, notifyAlert, fire, T, t, uid, randomSeed, sleep, effectiveModel, freeBlockers }) {
  const Q = repository.state;
  const R = { running: false, stopReq: false, cur: null, endReq: new Set() };
  const HISTORY_MAX = 60;
  let starting = false;
  let rerun = false; // requests during startup/final flush must not be dropped
  let lastStopped = false;
  let runnerToken = null; // retained through final flush even after lease loss
  const { persist, flushWrites } = repository;
  const mainJob = () => Q.jobs.find((j) => j.kind !== 'oneoff') || null;
  const queueRunning = () => R.running || starting;
  const runtime = () => ({ running: R.running, starting, token: runnerToken });
  function changed() { persist(); paint(); }
  function seedFor(job) {
    const choice = seedChoice(job);
    return choice.random ? randomSeed() : choice.seed;
  }

  // history keeps the prompt/settings (to reload or diff), not the reference images
  const lean = (j) => ({ ...j, snap: { params: j.snap.params }, cells: undefined });

  // ---------------------------------------------------------------- jobs
  function makeJob(kind, snap, extra) {
    return { id: uid(), no: ++Q.seq, kind, createdAt: Date.now(), status: 'queued', done: 0, seeds: [], recs: [], snap, freeOnly: state.settings.autoFreeOnly !== false, ...extra };
  }

  // seedMode: fixed (seed field set) · prev (same seeds as the previous batch) · job (same as a given history batch) · random
  function enqueue(snap, { count = Number(state.settings.autoCount || 0), seedFrom = null, start = false } = {}) {
    const seedMode = seedFrom ? 'job' : snap.params.seed ? 'fixed' : state.settings.queueSeedPrev ? 'prev' : 'random';
    const job = makeJob('batch', snap, { count, seedMode, seedFrom });
    if (seedMode === 'fixed' && count !== 1) toast(T(`种子已锁定（${snap.params.seed}）：这个批量的每张都会一样，队列会在第 2 张前暂停。要多样的结果请先解锁种子。`, `The seed is locked (${snap.params.seed}): every image of this batch would be the same, so the queue will pause before image 2. Unlock the seed for variety.`), 'warn', 6000);
    Q.jobs.push(job);
    changed();
    if (start) runQueue();
    return job;
  }

  // "Generate" while the queue runs: one image from the editor right after the current one
  function cutIn(snap) {
    const job = makeJob('oneoff', snap, { count: 1, seedMode: snap.params.seed ? 'fixed' : 'random', freeOnly: false });
    Q.jobs.unshift(job);
    changed();
    toast(() => (T('已插队：当前这张完成后用编辑区生成 1 张', 'Cut in: one image from the editor after the current one')), 'ok', 3200);
    return job;
  }

  function enqueueXY({ gridId, cells, snap, freeOnly, label }) {
    const job = makeJob('xy', snap, { count: cells.length, cells, gridId, freeOnly, label, seedMode: 'grid' });
    // an idle queue with paused batches: run the grid first, then pause again instead of resuming them
    if (!R.running && Q.jobs.length) {
      job.pauseAfter = true;
      Q.jobs.unshift(job);
    } else Q.jobs.push(job);
    changed();
    runQueue();
    return job;
  }

  function xyJobState(gridId) {
    const j = Q.jobs.find((x) => x.kind === 'xy' && x.gridId === gridId);
    if (!j) return null;
    return { live: true, running: R.running && R.cur === j.id, cur: R.running && R.cur === j.id ? j.cells[j.done]?.key : null, jobId: j.id, queued: Q.jobs.indexOf(j) };
  }

  // Finalizer for tiled jobs (registered by main → ui/tiled.finalizeTiledJob): composes and stores the final
  // image. Awaited before the job counts as done; if it throws the job stays queued (paused, stage 'compose')
  // and the next run retries only the composition. Must be idempotent.
  let tiledFinalizer = null;
  const setTiledFinalizer = (fn) => (tiledFinalizer = fn);

  // meta: persisted, opaque data the finalizer needs after a reload (plan geometry, sourceId, feather …)
  function enqueueTiled({ tiledId, cells, snap, label, freeOnly = true, meta = null }) {
    if (!cells?.length || cells.length > 35) throw new RangeError(t('copy.queue.0'));
    const frozen = structuredClone({ cells, snap });
    const job = makeJob('tiled', frozen.snap, {
      tiledId, cells: frozen.cells, count: cells.length, label, freeOnly, seedMode: 'grid', pauseAfter: !R.running && Q.jobs.length > 0, meta: meta ? structuredClone(meta) : null, stage: 'tiles',
    });
    Q.jobs.unshift(job);
    changed();
    runQueue();
    return job;
  }

  function itemFor(job) {
    const s = job.snap;
    if (job.kind === 'tiled') {
      const cell = job.cells[job.done];
      return { cell, seed: seedFor(job), ctx: { params: cell.params, base: cell.base, vibes: s.vibes || [], refs: s.refs || [], nSamples: 1 } };
    }
    if (job.kind === 'xy') {
      const cell = job.cells[job.done];
      return { cell, seed: seedFor(job), ctx: { params: cell.params, base: s.base || null, vibes: s.vibes || [], refs: s.refs || [], nSamples: 1 } };
    }
    return { seed: seedFor(job), ctx: { params: s.params, base: s.base || null, vibes: s.vibes || [], refs: s.refs || [], nSamples: 1 } };
  }

  // vibe encodings cached on a snapshot copy are written back to the editor's vibe with the same id
  function syncVibes(job) {
    for (const v of job.snap.vibes || []) {
      const live = state.vibes.find((x) => x.id === v.id);
      if (live && v.enc) live.enc = { ...v.enc, ...(live.enc || {}) };
    }
  }

  function finish(job, status, reason = '') {
    const i = Q.jobs.indexOf(job);
    if (i >= 0) Q.jobs.splice(i, 1);
    job.status = status;
    job.finishedAt = Date.now();
    job.reason = reason;
    if (job.kind !== 'oneoff' && (job.done > 0 || status === 'failed')) Q.history = [lean(job), ...Q.history].slice(0, HISTORY_MAX);
    R.endReq.delete(job.id);
    if (job.pauseAfter && R.running && Q.jobs.length) R.stopReq = true;
    fire('end', job);
    if (job.kind === 'tiled' && status === 'done') fire('tiledDone', { tiledId: job.tiledId, recs: job.recs.slice() });
    if (job.kind === 'batch' && status === 'done') toast(() => (T(`批量 #${job.no} 完成：${job.done} 张`, `Batch #${job.no} done: ${job.done} images`)), 'ok', 4000);
    changed();
  }

  // ---------------------------------------------------------------- runner
  async function runQueue() {
    if (R.running && R.stopReq) {
      R.stopReq = false;
      toast(() => (T('已取消暂停，队列继续', 'Pause cancelled, the queue continues')), 'ok', 2000);
      return paint();
    }
    // Called while a run is still starting up or flushing its final state (lock release, last write):
    // remember it and start again afterwards. Returning silently here made new jobs sit idle ("queue works
    // sometimes"): e.g. a grid queued right as the previous batch finished.
    if (starting && !R.running) {
      if (Q.jobs.length) rerun = true;
      return;
    }
    if (R.running || starting || !Q.jobs.length) return;
    if (autoRunning()) return toast(() => (T('请先停止「改动后」自动生成', 'Stop the on-change auto mode first')), 'warn');
    starting = true;
    paint();
    const release = await tabs.acquireRunLock();
    if (!release) {
      starting = false;
      toast(() => T('另一个标签页正在运行队列', 'Another tab is running the queue'), 'warn', 4000);
      return;
    }
    try {
      runnerToken = tabs.runToken();
      await repository.prepareRun(runnerToken);
      await loop();
    } catch (error) { persistError('queue', 'run', error); }
    finally {
      await flushWrites();
      // Flush the final state before allowing another tab to resume.
      try {
        await repository.clearRunner(runnerToken);
      } catch (error) { persistError('queue', 'write', error); }
      try { await release(); }
      catch (error) { persistError('queue', 'unlock', error); }
      runnerToken = null;
      starting = false;
      paint();
      // a run requested during the flush: honour it unless this run ended by a pause / stop
      const again = rerun && !lastStopped && Q.jobs.length > 0;
      rerun = false;
      if (again) setTimeout(runQueue);
    }
  }
  function pauseQueue() {
    if (!R.running) return;
    R.stopReq = true;
    toast(() => (T('当前这张完成后暂停队列', 'Pausing after the current image')), 'ok', 2400);
    paint();
  }
  function endJob(id) {
    const j = Q.jobs.find((x) => x.id === id);
    if (!j) return;
    if (R.running && R.cur === id) R.endReq.add(id);
    else finish(j, 'stopped');
    paint();
  }

  async function loop() {
    R.running = true;
    R.stopReq = false;
    let fails = 0;
    let skips = 0;
    let stopMsg = '';
    try {
      paint();
      while (!R.stopReq) {
        if (!await tabs.checkRunLock(runnerToken)) {
          stopMsg = T('队列运行权已转移，当前标签页已停止。', 'Queue ownership changed; this tab has stopped.');
          break;
        }
        const job = Q.jobs[0];
        if (!job) break;
        if (job.stage === 'unknown') {
          stopMsg = job.reason || T('结果未知，请核对后移除任务；如需重试，请重新入队。', 'Result unknown. Reconcile and remove this job; enqueue again if needed.');
          break;
        }
        if (R.endReq.has(job.id)) {
          finish(job, 'stopped');
          continue;
        }
        if (left(job) <= 0) {
          if (job.kind === 'tiled' && tiledFinalizer) {
            job.stage = 'compose';
            job.status = 'running';
            R.cur = job.id;
            changed();
            try {
              job.result = (await tiledFinalizer(job)) ?? job.result ?? null;
              if (!await tabs.checkRunLock(runnerToken)) break;
              job.stage = 'done';
            } catch (err) {
              job.status = 'paused';
              job.reason = T('拼图失败：', 'Composition failed: ') + (err?.message || err);
              stopMsg = job.reason + T('（分块已保留，继续队列会只重试拼图）', ' (tiles kept; resuming retries only the composition)');
              break;
            }
          }
          finish(job, 'done');
          continue;
        }
        while (state.session.generating && !R.stopReq) await sleep(150);
        if (R.stopReq) break;
        if (job.done === 0 && job.srcSeeds === undefined) {
          const src = seedSource(job, Q.history);
          job.srcSeeds = src ? src.seeds.slice() : null;
          job.srcNo = src ? src.no : null;
        }
        const item = itemFor(job);
        if (shouldCheckFree(job, state.settings, state.session)) {
          const why = freeBlockers(item.ctx);
          if (why.length) {
            stopMsg = T(`队列已暂停 — 批量 #${job.no} 的下一张不免费：\n· `, `Queue paused — the next image of #${job.no} is not free:\n· `) + why.join('\n· ') + (job.kind === 'batch' ? T('\n关闭「仅免费」后点「继续队列」可用 Anlas 继续', '\nTurn off “free only” and press Resume to continue with Anlas') : '');
            break;
          }
        }
        // Same params + seed as an image already in the archive (fixed seed with count > 1, "same seeds" with an
        // unchanged prompt …): stop instead of paying for a copy. Resuming acknowledges it for this exact key.
        if (job.kind === 'batch' && job.seedMode !== 'random' && !job.pendingSaveId && getDeps().generationKey && getDeps().findDuplicate) {
          let key = null;
          try {
            key = getDeps().generationKey({ params: { ...item.ctx.params, nSamples: 1 }, model: effectiveModel(item.ctx), seed: item.seed, nSamples: 1, base: item.ctx.base, vibes: item.ctx.vibes, refs: item.ctx.refs });
          } catch (err) {
            console.error('[queue] duplicate key', err);
          }
          const dup = key && job.dupAck !== key ? getDeps().findDuplicate(key) : null;
          if (dup) {
            job.dupAck = key;
            const no = '№' + String(dup.no || 0).padStart(4, '0');
            job.reason = T(`与 ${no} 参数和种子完全相同`, `identical to ${no} (same parameters and seed)`);
            stopMsg = T(`队列已暂停 — 批量 #${job.no} 的第 ${job.done + 1} 张会和 ${no} 一模一样（参数和种子完全相同）。\n改提示词或种子后点差异条的「继续时应用」；确实要重复就直接点「继续队列」。`, `Queue paused — image ${job.done + 1} of batch #${job.no} would be identical to ${no} (same parameters and seed).\nChange the prompt or seed and use “Apply on resume”, or press Resume to generate it anyway.`);
            break;
          }
        }
        for (const o of Q.jobs) if (o !== job && o.status === 'running') o.status = 'queued';
        job.status = 'running';
        job.startedAt ||= Date.now();
        R.cur = job.id;
        if (!await persist()) {
          stopMsg = T('队列已暂停：无法保存队列进度', 'Queue paused: could not save queue progress');
          break;
        }
        paint();
        fire('step', job);
        if (!await tabs.checkRunLock(runnerToken)) break;
        const res = job.pendingSaveId ? await getDeps().retrySave(job.pendingSaveId) : await getDeps().generate({
          params: { ...item.ctx.params, nSamples: 1 },
          model: effectiveModel(item.ctx),
          seed: item.seed,
          nSamples: 1,
          base: item.ctx.base,
          vibes: item.ctx.vibes,
          refs: item.ctx.refs,
          quiet: true,
          silent: job.kind === 'xy',
          follow: job.kind === 'xy' ? false : undefined,
          logPrompt: job.kind === 'batch',
          extra: { job: { id: job.id, no: job.no }, ...(item.cell ? { xy: { grid: job.gridId, x: item.cell.x, y: item.cell.y } } : {}) },
          label: job.kind === 'xy' ? `X/Y ${job.done + 1}/${job.cells.length}` : job.kind === 'oneoff' ? T('插队', 'Cut-in') : `${T('批量', 'Batch')} #${job.no}`,
          ...(job.kind === 'tiled' ? {
            silent: true, follow: false, kind: 'tile',
            extra: { job: { id: job.id, no: job.no }, tiled: { id: job.tiledId, key: item.cell.key }, kind: 'tile' },
            label: T(`分块放大 ${job.done + 1}/${job.cells.length}`, `Tiled upscale ${job.done + 1}/${job.cells.length}`),
          } : {}),
        });
        if (!await tabs.checkRunLock(runnerToken)) break;
        const next = resultPolicy(res, { fails, skips, kind: job.kind });
        fails = next.fails;
        skips = next.skips;
        if (next.action === 'continue') {
          if (job.pendingSaveId) getDeps().releaseSave(job.pendingSaveId);
          delete job.pendingSaveId;
          if (['persist', 'unknown'].includes(job.stage)) {
            if (job.kind === 'tiled') job.stage = 'tiles';
            else delete job.stage;
          }
          delete job.reason;
          const rec = res.recs[0];
          job.done++;
          job.seeds.push(rec.seed);
          job.recs.push(rec.id);
          syncVibes(job);
          if (job.kind === 'tiled') fire('tiledCell', { tiledId: job.tiledId, key: item.cell.key, id: rec.id, done: job.done, total: job.cells.length });
          else if (item.cell) fire('xycell', { gridId: job.gridId, key: item.cell.key, id: rec.id });
          changed();
          if (job.kind === 'batch' && left(job) > 0) await sleep(state.session.live ? 1000 : 250);
          continue;
        }
        if (res?.skipped) {
          // A manual generation slipped in, or the snapshot has no prompt.
          if (next.action === 'fail') finish(job, 'failed', T('无法开始生成（提示词为空？）', 'Could not start (empty prompt?)'));
          else await sleep(next.delay);
          continue;
        }
        const msg = res?.err?.message || 'error';
        if (next.action === 'pause' && next.stage) {
          job.stage = next.stage;
          if (res.pendingId) job.pendingSaveId = res.pendingId;
          job.status = 'paused';
          job.reason = msg;
          stopMsg = T('队列已暂停：', 'Queue paused: ') + msg + (job.stage === 'persist'
            ? T('（图像已生成；继续队列只重试保存，也可从「待保存」下载）', ' (image generated; Resume only retries saving, or download from Unsaved)') : '');
          break;
        }
        if (next.action === 'pause') {
          stopMsg = T('队列已暂停：', 'Queue paused: ') + msg;
          break;
        }
        if (next.busy) {
          toast(() => (T(`服务器繁忙（429），${3 * fails}s 后重试…`, `Busy (429), retrying in ${3 * fails}s…`)), 'warn', 3000 * fails);
          await sleep(next.delay);
          continue;
        }
        if (next.action === 'skip-cell') {
          fire('xyfail', { gridId: job.gridId, key: item.cell.key, msg });
          job.done++; // skip the cell
          if (next.failJob) finish(job, 'failed', msg);
          changed();
          continue;
        }
        if (next.action === 'fail') {
          finish(job, 'failed', msg);
          toast(() => (T(`批量 #${job.no} 已停止：`, `Batch #${job.no} stopped: `) + msg), 'err', 6000);
          continue;
        }
        await sleep(next.delay);
      }
    } finally {
      lastStopped = !!stopMsg || R.stopReq;
      R.running = false;
      R.cur = null;
      const head = Q.jobs[0];
      if (head && head.status === 'running') head.status = 'paused';
      if (head?.kind === 'tiled') fire('tiledPaused', { tiledId: head.tiledId, reason: stopMsg });
      // Flush scheduler progress with its original token. UI edits made during
      // this final flush are independent follower writes and may outlive release.
      persist(runnerToken);
      paint();
    }
    if (stopMsg) {
      toast(stopMsg, 'warn', 8000);
      notifyAlert(stopMsg);
    } else if (!Q.jobs.length) notifyAlert(T('队列全部完成', 'Queue finished'));
  }

  function applyToRunning() {
    const job = mainJob();
    if (!job || job.kind !== 'batch') return;
    const keepSeed = job.seedMode;
    job.snap = getDeps().snapshot();
    if (keepSeed !== 'fixed' && job.snap.params.seed) job.seedMode = 'fixed';
    if (keepSeed === 'fixed' && !job.snap.params.seed) job.seedMode = 'random';
    changed();
    toast(() => (T(`批量 #${job.no} 从下一张起使用新参数`, `Batch #${job.no} uses the new settings from the next image`)), 'ok', 3000);
  }

  function toggleLoop() {
    if (R.running) return R.stopReq ? runQueue() : pauseQueue();
    if (Q.jobs.length) return runQueue();
    enqueue(getDeps().snapshot(), { start: true });
  }

  function move(i, d) {
    const j = Q.jobs[i];
    Q.jobs.splice(i, 1);
    Q.jobs.splice(i + d, 0, j);
    changed();
  }

  function removeEntry(j, isHistory) {
    if (isHistory) Q.history = Q.history.filter((x) => x !== j);
    else Q.jobs = Q.jobs.filter((x) => x !== j);
    changed();
  }
  function clearHistory() { Q.history = []; changed(); }
  return { state: R, runtime, queueRunning, enqueue, cutIn, enqueueXY, xyJobState, enqueueTiled,
    setTiledFinalizer, runQueue, pauseQueue, endJob, toggleLoop, applyToRunning, move, removeEntry, clearHistory };
}
