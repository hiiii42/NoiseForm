// Generation queue facade: preserve the public API while assembling separate boundaries.
import { uid, randomSeed, sleep } from './util.js';
import { state } from './store.js';
import { t, getLang } from './i18n.js';
import { kv } from './db.js';
import { tabs } from './tabs.js';
import { invoke } from './callbacks.js';
import { toast } from './app/events.js';
import { notifyAlert } from './notify.js';
import { effectiveModel as resolveModel, freeBlockers as blockers } from './domain/cost.js';
import { generationSpec } from './domain/generation.js';
const effectiveModel = (ctx) => resolveModel(generationSpec(ctx, state, getLang()));
const freeBlockers = (ctx) => blockers(generationSpec(ctx, state, getLang()), state.session);
import { createQueueRepository } from './queue/repository.js';
import { createQueueRunner } from './queue/runner.js';
import { createQueueView } from './queue/view.js';
export { promptDiff, paramDiff } from './queue/view.js';

let deps = null; // installed by main; queried live by commands and the view
let autoRunning = () => false;
export const setAutoRunningQuery = (query) => { autoRunning = query; };
const subs = new Map();
export const onQueue = (ev, fn) => (subs.has(ev) || subs.set(ev, new Set()), subs.get(ev).add(fn));
export const offQueue = (ev, fn) => subs.get(ev)?.delete(fn);
// A UI listener (X/Y grid, tiled dialog …) that throws must never break the run loop that fired the event.
const fire = (ev, data) => { for (const fn of [...(subs.get(ev) || [])]) invoke(fn, 'queue:' + ev, data); };
const T = (z, e) => getLang() === 'zh' ? z : e;
const getDeps = () => deps;
const paint = () => view.paint();
const repository = createQueueRepository({ kv, tabs, runtime: () => runner.runtime(), onChange: paint, T });
const runner = createQueueRunner({ repository, tabs, state, getDeps, autoRunning: () => autoRunning(),
  paint, toast, notifyAlert, fire, T, t, uid, randomSeed, sleep, effectiveModel, freeBlockers });
const view = createQueueView({ Q: repository.state, R: runner.state, getDeps, commands: runner });

export const queueJobs = () => repository.state.jobs;
export const headJob = () => repository.state.jobs[0] || null;
export const { loadQueue } = repository;
export const { queueRunning, enqueue, cutIn, enqueueXY, xyJobState, enqueueTiled,
  setTiledFinalizer, runQueue, pauseQueue, endJob, toggleLoop } = runner;
export const { seedLabel, paintAutoButton, toggleQueue, closeQueue } = view;
export function initQueue(d) {
  deps = d;
  view.init();
}
