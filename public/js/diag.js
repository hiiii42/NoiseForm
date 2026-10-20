// Local metadata only. Never pass request/response bodies or headers to this module.
// @ts-check
import { readLocalVersioned, writeLocalVersioned } from './persist.js';

export const LIMIT = 200;
const KEY = 'nf.diag';
/** Remove credentials before truncating, including URL userinfo/query and binary payloads. */
export function redact(value) {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s<>"']+/gi, (s) => { try { const u = new URL(s); return u.origin + u.pathname; } catch { return '[url]'; } })
    .replace(/\bBearer\s+[^\s,"';]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:pst|sk)-[^\s,"';<>]+/gi, '[redacted]')
    .replace(/(?:[A-Za-z0-9+/_-]{80,}={0,2})/g, '[base64]')
    .slice(0, 300);
}
export function pathOnly(value) {
  try { return redact(new URL(String(value), 'http://localhost').pathname); } catch { return '/'; }
}
const now = () => globalThis.performance?.now() ?? Date.now();
const finite = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
// Explicit allowlist also protects exports of older/tampered persisted entries.
function clean(r) {
  const out = {
    id: redact(r.id), kind: ['image', 'api', 'llm', 'event'].includes(r.kind) ? r.kind : 'event',
    method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(r.method) ? r.method : '',
    path: pathOnly(r.path || '/'), route: ['direct', 'proxy', 'llm-proxy', 'llm-direct'].includes(r.route) ? r.route : null,
    mutating: !!r.mutating, t0: redact(r.t0), tHeaders: finite(r.tHeaders), tEnd: finite(r.tEnd),
    status: finite(r.status), outcome: ['ok', 'http-error', 'unknown', 'timeout-headers', 'timeout-idle', 'aborted', 'network'].includes(r.outcome) ? r.outcome : null,
    bytes: finite(r.bytes), stream: !!r.stream, correlationId: redact(r.correlationId), error: redact(r.error),
  };
  if (r.probe) out['probe'] = true;
  if (r.event === 'nf:callback-error' || r.event === 'nf:persist-error') out['event'] = r.event;
  if (finite(r.tFirstFrame) !== null) out['tFirstFrame'] = r.tFirstFrame;
  return out;
}
let rows = [];
let loaded = false, timer, writing = false;
function hasStorage() { try { return !!globalThis.localStorage; } catch { return false; } }
function load() {
  if (loaded) return;
  loaded = true;
  if (!hasStorage()) return;
  rows = readLocalVersioned(KEY, { version: 1, validate: (d) => Array.isArray(d) && d.every((r) => r && typeof r === 'object'), fallback: [] }).slice(-LIMIT).map(clean);
  // A refresh while a request is in flight cannot establish the remote result.
  for (const r of rows) if (!r.outcome) { r.outcome = 'unknown'; r.error = 'Page ended before request completion'; }
}
export function flush() {
  clearTimeout(timer);
  load();
  if (!hasStorage() || writing) return;
  writing = true;
  try { writeLocalVersioned(KEY, rows.map(clean), { version: 1 }); }
  catch { /* persist.js announces the failure; avoid recursive logging writes */ }
  finally { writing = false; }
}
function changed() {
  if (writing) return;
  clearTimeout(timer);
  timer = setTimeout(flush, 100);
}
export function entries() { load(); return rows.map(clean); }
/** @param {any} meta */
export function begin(meta) {
  load();
  const start = now();
  const row = clean({ ...meta, id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`, t0: new Date().toISOString(), bytes: 0 });
  rows.push(row);
  if (rows.length > LIMIT) rows.splice(0, rows.length - LIMIT);
  changed();
  return {
    headers(status) { row.status = status; row.tHeaders = Math.round(now() - start); changed(); },
    bytes(n) { row.bytes += n; changed(); },
    firstFrame() { if (row['tFirstFrame'] == null) { row['tFirstFrame'] = Math.round(now() - start); changed(); } },
    end(outcome, error = '') { row.outcome = outcome; row.error = redact(error); row.tEnd = Math.round(now() - start); changed(); },
  };
}
const responses = new WeakMap();
export function attach(response, trace) { responses.set(response, trace); return response; }
export function firstFrame(response) { responses.get(response)?.firstFrame(); }
export function responseError(response, error = 'Invalid response format') { responses.get(response)?.end('unknown', error); }

function recordEvent(event) {
  const detail = event.detail || {};
  const trace = begin({ kind: 'event', event: event.type });
  trace.end('network', event.type === 'nf:persist-error'
    ? `${redact(detail.operation)} ${redact(detail.key)} ${redact(detail.error)}`
    : redact(detail.message));
}
globalThis.addEventListener?.('nf:callback-error', recordEvent);
globalThis.document?.addEventListener('nf:persist-error', recordEvent);
globalThis.addEventListener?.('pagehide', flush);
globalThis.document?.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

async function localJSON(path) {
  try { const r = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(1500) }); return r.ok ? await r.json() : null; }
  catch { return null; }
}
function hostOnly(value) {
  try { return redact(new URL(String(value).includes('://') ? String(value) : `http://${value}`).host); }
  catch { return null; }
}
function serverEntry(r) {
  return {
    time: redact(r.time), target: ['image', 'api', 'llm'].includes(r.target) ? r.target : null,
    method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(r.method) ? r.method : '',
    path: pathOnly(r.path || '/'), status: finite(r.status), ms: finite(r.ms), msHeaders: finite(r.msHeaders), bytes: finite(r.bytes),
    outcome: ['ok', 'http-error', 'not-sent', 'unknown', 'truncated', 'client-closed'].includes(r.outcome) ? r.outcome : null,
    error: redact(r.error), disconnected: !!r.disconnected, ...(r.host ? { host: hostOnly(r.host) } : {}),
  };
}
/** Call with explicit metadata, never a settings/connection object containing secrets. */
export async function exportReport({ pageVersion = '', serverStale = null, mode = 'auto', identity = 'demo' } = {}) {
  flush();
  const [health, server] = await Promise.all([localJSON('/proxy/health'), localJSON('/proxy/diag')]);
  return {
    pageVersion: redact(pageVersion),
    server: health ? { version: redact(health.version), upstreamProxy: health.upstreamProxy ? hostOnly(health.upstreamProxy) : null } : null,
    serverStale: serverStale ? redact(serverStale) : null,
    connection: { mode: ['auto', 'direct', 'proxy'].includes(mode) ? mode : 'auto', identity: ['demo', 'browser-token', 'server-token'].includes(identity) ? identity : 'demo' },
    userAgent: redact(globalThis.navigator?.userAgent), frontend: entries(), serverLogs: Array.isArray(server) ? server.slice(-LIMIT).filter((r) => r && typeof r === 'object').map(serverEntry) : null,
  };
}
