// @ts-check
// Subscriber isolation: one listener throwing must not stop the others, the caller's state change or the
// queue loop that fired the event. The error is still logged (tests treat console.error as a failure)
// and announced as 'nf:callback-error' so the diagnostics log can keep it.
/**
 * @param {Function} fn
 * @param {string} label event or path, for the log
 * @param {...any} args
 * @returns {any} the listener's return value, or undefined when it threw
 */
export function invoke(fn, label, ...args) {
  try {
    const out = fn(...args);
    // async listeners: report a rejection the same way, never to the caller
    if (out && typeof out.then === 'function') out.then(undefined, (err) => report(err, label));
    return out;
  } catch (err) {
    report(err, label);
    return undefined;
  }
}

/** @param {unknown} err @param {string} label */
function report(err, label) {
  console.error(`listener for "${label}" failed:`, err);
  try {
    globalThis.dispatchEvent?.(new CustomEvent('nf:callback-error', { detail: { label, message: String(/** @type {any} */ (err)?.message || err) } }));
  } catch { /* reporting must never throw */ }
}
