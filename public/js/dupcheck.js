import { modelById } from './data.js';
import { buildGenerateBody } from './nai.js';

// Manual-click duplicate guard. Call only for deliberate Generate clicks.
let remembered = null;
let warning = null;

function equal(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && a.length !== b.length) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

function comparable(params) {
  const { nSamples, ...rest } = params;
  return rest;
}

// Returns a detached { params, seed, at } for callers that keep their own lastJob.
export function rememberJob(params, seed) {
  remembered = { params: structuredClone(params), seed, at: Date.now() };
  warning = null;
  return structuredClone(remembered);
}

// Reset both the second-click window and the internally remembered job.
export function resetDuplicate() {
  warning = null;
  remembered = null;
}

// ctx.click is the click timestamp (ms); now supplies it when omitted.
// An explicit lastJob (including null) overrides the internal rememberJob fallback.
export function checkDuplicate(ctx, { now = Date.now() } = {}) {
  const { params, lastJob = remembered, click = now } = ctx;
  const fixed = params?.seed != null && String(params.seed).trim() !== '';
  const current = params && comparable(params);
  const duplicate = !!(fixed && lastJob?.params && lastJob.seed != null &&
    String(params.seed) === String(lastJob.seed) && equal(current, comparable(lastJob.params)));
  if (!duplicate) {
    warning = null;
    return { duplicate: false, armed: false };
  }
  const time = Number.isFinite(click) ? click : now;
  const armed = !!(warning && time >= warning.at && time - warning.at <= 3000 &&
    warning.jobAt === lastJob.at && String(warning.seed) === String(lastJob.seed) && equal(warning.params, current));
  // Consume a confirmation; a later independent click must warn again.
  warning = armed ? null : { at: time, params: structuredClone(current), seed: lastJob.seed, jobAt: lastJob.at };
  return { duplicate: true, armed };
}

// ---------------------------------------------------------------- queue duplicate detection
// Use the same normalized request builder as generation, with compact source identities
// instead of image payloads. Arrays preserve request order. Versioned keys prevent legacy
// reference IDs (which omitted strengths etc.) from being treated as full specifications.
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}
// Two independent 32-bit hashes plus length avoid storing multi-MB data URLs in archive keys.
function sourceIdentity(r) {
  if (!r || typeof r !== 'object' || typeof r.image !== 'string' || !r.image) return null;
  let a = 2166136261, b = 5381;
  for (let i = 0; i < r.image.length; i++) {
    const c = r.image.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b, 33) ^ c;
  }
  return `${r.image.length}:${a >>> 0}:${b >>> 0}`;
}

/** g carries the resolved model and effective reference objects, never bare IDs. */
export function generationKey(g) {
  if (!g.params || g.base) return null; // base strength/mask were not archived
  const model = typeof g.model === 'object' ? g.model : modelById(g.model || g.params.model);
  const refs = model.refs ? (g.refs || []).filter(r => r?.enabled !== false) : [];
  const vibes = model.vibes && !refs.length ? (g.vibes || []).filter(v => v?.enabled) : [];
  if (refs.some(r => !sourceIdentity(r) || typeof r.type !== 'string' || !Number.isFinite(r.strength) || !Number.isFinite(r.fidelity)) ||
      vibes.some(v => !sourceIdentity(v) || !Number.isFinite(v.strength) || !Number.isFinite(v.ie))) return null;
  const body = buildGenerateBody({
    params: g.params, model, seed: Number(g.seed ?? g.params.seed), nSamples: 1,
    refs: refs.map(r => ({ ...r, data: sourceIdentity(r) })),
    // V4 encodes IE into the cached embedding; preserve it in the content identity too.
    vibes: vibes.map(v => ({ ...v, data: [sourceIdentity(v), v.ie] })),
  });
  return 'v2:' + stable({ body, demo: !!g.demo, kind: g.kind || 'gen' });
}
/** The same key for an archive record (light records carry params / model / demo / generation). */
export function recordKey(r) {
  if (r.generation && Object.hasOwn(r.generation, 'key')) return typeof r.generation.key === 'string' && r.generation.key.startsWith('v2:') ? r.generation.key : null;
  if (!r.generation || !Array.isArray(r.generation.refs) || !Array.isArray(r.generation.vibes)) return null;
  // Bare legacy IDs cannot establish either effective settings or disabled state.
  if (r.generation.refs.some(ref => !sourceIdentity(ref) || !Number.isFinite(ref.strength) || !Number.isFinite(ref.fidelity) || typeof ref.type !== 'string') ||
      r.generation.vibes.some(v => !sourceIdentity(v) || typeof v.enabled !== 'boolean' || !Number.isFinite(v.strength) || !Number.isFinite(v.ie))) return null;
  try {
    return generationKey({
      params: r.params, seed: r.seed, model: r.model, demo: r.demo, kind: r.kind,
      base: r.sourceId || r.generation.baseId || (r.baseImage ? 'external' : null),
      vibes: r.generation.vibes, refs: r.generation.refs,
    });
  } catch {
    return null; // Incomplete legacy params cannot be interpreted as a complete request.
  }
}
