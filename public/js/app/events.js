// @ts-check
// Application events (payloads are positional, in the order listed):
// generation:busy(on, label), start(info, {visible}), progress(fraction),
// waiting(boolean), label(text), preview(dataURL), land(blob), handoff(),
// stop(), pending(card|null), done(result), failed(error), finished().
// pending-saves(entries), pending-saves:open(); prompt:focus();
// prompt:logged(params, modelId, recordIds, history); notification:done(recs, options).
// records:added(history, currentId), updated(history, currentId), removed(ids),
// selected(rec, options), current(id), empty(), dispose(id), forget(id), flash(id),
// saved(rec), flagged(rec), storage(), storage:open(), selection:clear().
// compare:open(ids), close(), place(id), added(id), developing:hide(), focus().
// post:record(rec), post:open(rec, options), tour:start(id, delay).
// tools:refresh(), tools:chars(), tool:start(info), tool:progress(fraction),
// toast(message, kind?, ms?, onClick?).
// Subscribers run synchronously until their first await. emit resolves only after
// asynchronous view handoffs settle; errors never reject emit or affect a job.
import { invoke } from '../callbacks.js';

/** @type {Map<string, Set<Function>>} */
const subscribers = new Map();
/** @param {string} name @param {Function} fn */
export function on(name, fn) {
  if (!subscribers.has(name)) subscribers.set(name, new Set());
  subscribers.get(name).add(fn);
  return () => off(name, fn);
}
/** @param {string} name @param {Function} fn */
export function off(name, fn) {
  const listeners = subscribers.get(name);
  const removed = listeners?.delete(fn) || false;
  if (!listeners?.size) subscribers.delete(name);
  return removed;
}
/** @param {string} name @param {...any} args @returns {Promise<void>} */
export function emit(name, ...args) {
  const pending = [...(subscribers.get(name) || [])].map((fn) => invoke(fn, name, ...args));
  return Promise.allSettled(pending).then(() => {});
}
/** @param {...any} args */
export const toast = (...args) => { void emit('toast', ...args); };
