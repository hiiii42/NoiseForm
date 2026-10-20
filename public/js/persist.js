// @ts-check
// Business schema versions are independent of the IndexedDB physical version.
export const SCHEMA_VERSION = 1;
export const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** Error details deliberately exclude stored values (settings can contain credentials). */
export function persistError(key, operation, error, backupKey = null) {
  globalThis.document?.dispatchEvent(new CustomEvent('nf:persist-error', {
    detail: { key, operation, error: error?.name || 'Error', backupKey },
  }));
}

/** @type {{get: (key: string) => unknown, set: (key: string, value: any) => unknown}} */
export const localStore = {
  get: (key) => localStorage.getItem(key),
  set: (key, value) => localStorage.setItem(key, value),
};

/** @template T
 * @typedef {object} ReadOptions
 * @property {number} version
 * @property {(data: any, from: number) => T} [migrate]
 * @property {(data: any) => boolean} validate
 * @property {T} fallback
 * @property {{get: (key: string) => any, set: (key: string, value: any) => any}} [storage]
 * @property {boolean} [json]
 */

let backupSeq = 0;
/** Synchronous counterpart for existing synchronous UI loaders (chunks/layout).
 * @template T @param {string} key @param {ReadOptions<T>} options @returns {T}
 */
export function readLocalVersioned(key, { version, migrate = (d) => d, validate, fallback }) {
  let raw;
  try { raw = localStorage.getItem(key); }
  catch (error) { persistError(key, 'read', error); return structuredClone(fallback); }
  if (raw == null) return structuredClone(fallback);
  let data, from;
  try {
    const parsed = JSON.parse(raw);
    const wrapped = isObject(parsed) && Object.hasOwn(parsed, 'v');
    from = wrapped ? parsed.v : 0;
    if (!Number.isInteger(from) || from < 0 || from > version || (wrapped && !Object.hasOwn(parsed, 'data'))) throw new TypeError('Unsupported persistence schema');
    data = from === version ? parsed.data : migrate(wrapped ? parsed.data : parsed, from);
    if (!validate(data)) throw new TypeError('Invalid persisted data');
  } catch (error) {
    const backupKey = `${key}.bak-${Date.now()}-${++backupSeq}`;
    let backedUp = false;
    try { localStorage.setItem(backupKey, raw); backedUp = true; }
    catch (backupError) { persistError(key, 'backup', backupError); }
    persistError(key, 'validate', error, backedUp ? backupKey : null);
    if (backedUp && validate(fallback)) {
      try { writeLocalVersioned(key, structuredClone(fallback), { version }); }
      catch { /* write already reported */ }
    }
    return structuredClone(fallback);
  }
  if (from !== version) {
    try { writeLocalVersioned(key, data, { version }); }
    catch { /* a failed migration write still leaves readable legacy data */ }
  }
  return data;
}

/** @template T @param {string} key @param {T} data @param {{version?: number}} [options] */
export function writeLocalVersioned(key, data, { version = SCHEMA_VERSION } = {}) {
  try { localStorage.setItem(key, JSON.stringify({ v: version, data })); }
  catch (error) { persistError(key, 'write', error); throw error; }
}

/** @template T @param {string} key @param {ReadOptions<T>} options @returns {Promise<T>} */
export async function readVersioned(key, { version, migrate = (d) => d, validate, fallback, storage = localStore, json = storage === localStore }) {
  if (storage === localStore && json) return readLocalVersioned(key, { version, migrate, validate, fallback });
  let raw;
  try { raw = await storage.get(key); }
  catch (error) { persistError(key, 'read', error); return structuredClone(fallback); }
  if (raw == null) return structuredClone(fallback);
  let data, from;
  try {
    const parsed = json ? JSON.parse(raw) : raw;
    const wrapped = isObject(parsed) && Object.hasOwn(parsed, 'v');
    from = wrapped ? parsed.v : 0;
    if (!Number.isInteger(from) || from < 0 || from > version || (wrapped && !Object.hasOwn(parsed, 'data'))) throw new TypeError('Unsupported persistence schema');
    data = from === version ? parsed.data : migrate(wrapped ? parsed.data : parsed, from);
    if (!validate(data)) throw new TypeError('Invalid persisted data');
  } catch (error) {
    const backupKey = `${key}.bak-${Date.now()}-${++backupSeq}`;
    let backedUp = false;
    try { await storage.set(backupKey, raw); backedUp = true; }
    catch (backupError) { persistError(key, 'backup', backupError); }
    persistError(key, 'validate', error, backedUp ? backupKey : null);
    // Replace only after a durable backup; a quota failure keeps the source intact.
    if (backedUp && validate(fallback)) {
      try { await writeVersioned(key, structuredClone(fallback), { version, storage, json }); }
      catch { /* reported by writeVersioned */ }
    }
    return structuredClone(fallback);
  }
  if (from !== version) {
    try { await writeVersioned(key, data, { version, storage, json }); }
    catch { /* writeVersioned already reported the failure; keep the usable data. */ }
  }
  return data;
}

/** @template T
 * @param {string} key
 * @param {T} data
 * @param {{version?: number, storage?: typeof localStore, json?: boolean, meta?: object}} [options]
 */
export async function writeVersioned(key, data, { version = SCHEMA_VERSION, storage = localStore, json = storage === localStore, meta = {} } = {}) {
  try {
    const envelope = { ...meta, v: version, data };
    await storage.set(key, json ? JSON.stringify(envelope) : envelope);
    return envelope;
  } catch (error) { persistError(key, 'write', error); throw error; }
}

// Partial legacy settings/params are legal: hydration supplies missing defaults.
/** Validate partial legacy drafts.
 * Characters are REPAIRED in place rather than rejecting the whole payload: one odd character must
 * never reset the editor or wipe a queue (older versions and imports omit uc / enabled / x / y).
 * Repairable fields get defaults; entries without a string prompt are dropped and counted.
 * @param {any} data @param {object} defaults
 * @param {{discardedCharacters?: number, repairedCharacters?: number}} [report] Counts entries, not fields.
 * @returns {boolean}
 */
export function validateDefaults(data, defaults, report = {}) {
  if (!isObject(data)) return false;
  if (Object.hasOwn(defaults, 'characters') && Array.isArray(data.characters)) {
    const { list, dropped, repaired } = repairCharacters(data.characters);
    data.characters = list;
    report.discardedCharacters = dropped;
    report.repairedCharacters = repaired;
  }
  return Object.entries(defaults).every(([key, sample]) => {
    if (!Object.hasOwn(data, key)) return true;
    const value = data[key];
    if (Array.isArray(sample)) return Array.isArray(value) && value.every(isObject);
    if (isObject(sample)) return validateDefaults(value, sample, report);
    if (typeof sample === 'number') return typeof value === 'number' && Number.isFinite(value);
    // A frozen runtime snapshot uses a numeric seed; editor drafts use strings.
    if (key === 'seed') return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
    return typeof value === typeof sample;
  });
}

const coord = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);
/** Normalize a persisted / imported character list. @param {any[]} input
 * @returns {{list: object[], dropped: number, repaired: number}} */
export function repairCharacters(input) {
  let dropped = 0, repaired = 0;
  const seen = new Set();
  const list = [];
  input.forEach((c, i) => {
    if (!isObject(c) || typeof c.prompt !== 'string') { dropped++; return; }
    let id = typeof c.id === 'string' && c.id && !seen.has(c.id) ? c.id : `char-${i}-${Math.random().toString(36).slice(2, 8)}`;
    seen.add(id);
    const next = { ...c, id, uc: typeof c.uc === 'string' ? c.uc : '', x: coord(c.x), y: coord(c.y), enabled: typeof c.enabled === 'boolean' ? c.enabled : true };
    if (['id', 'uc', 'x', 'y', 'enabled'].some((k) => next[k] !== c[k])) repaired++;
    list.push(next);
  });
  return { list, dropped, repaired };
}

/** Known snapshot fields are checked when present; legacy partial snapshots remain legal.
 * @param {any} data @returns {boolean}
 */
export function validateQueue(data) {
  if (!isObject(data) || !Number.isInteger(data.seq) || data.seq < 0 || !Array.isArray(data.jobs) || !Array.isArray(data.history)) return false;
  const statuses = new Set(['queued', 'running', 'paused', 'done', 'stopped', 'failed']);
  const number = (v, min, max, integer = false) => typeof v === 'number' && Number.isFinite(v)
    && v >= min && v <= max && (!integer || Number.isInteger(v));
  const seed = (v) => number(v, 0, 4294967295, true)
    || (typeof v === 'string' && (v === '' || (/^\d{1,10}$/.test(v) && Number(v) <= 4294967295)));
  const params = (p) => {
    if (!isObject(p)) return false;
    const fields = {
      model: (v) => typeof v === 'string' && v.length > 0,
      prompt: (v) => typeof v === 'string', uc: (v) => typeof v === 'string',
      width: (v) => number(v, 1, 16384, true), height: (v) => number(v, 1, 16384, true),
      steps: (v) => number(v, 1, 50, true), nSamples: (v) => number(v, 1, 8, true),
      scale: (v) => number(v, 0, 10), cfgRescale: (v) => number(v, 0, 1), seed,
      sampler: (v) => typeof v === 'string' && v.length > 0,
      noiseSchedule: (v) => typeof v === 'string' && v.length > 0,
      ucPreset: (v) => number(v, 0, 100, true), qualityPreset: (v) => number(v, 0, 100, true),
      sizePreset: (v) => typeof v === 'string',
    };
    const booleans = ['qualityToggle', 'transparent', 'aiChoice', 'seedLocked', 'variety', 'smea', 'dyn', 'decrisp', 'normalizeVibes'];
    return Object.entries(fields).every(([k, validate]) => !Object.hasOwn(p, k) || validate(p[k]))
      && booleans.every((k) => !Object.hasOwn(p, k) || typeof p[k] === 'boolean')
      && validateDefaults(p, { characters: [] });
  };
  const valid = (j, history) => isObject(j) && typeof j.id === 'string' && Number.isFinite(j.no)
    && ['batch', 'oneoff', 'xy', 'tiled'].includes(j.kind) && statuses.has(j.status)
    && Number.isInteger(j.done) && j.done >= 0 && Array.isArray(j.seeds) && Array.isArray(j.recs)
    && j.seeds.every((s) => number(s, 0, 4294967295, true)) && j.recs.every((id) => typeof id === 'string')
    && isObject(j.snap) && params(j.snap.params) && Number.isFinite(j.count) && j.count >= 0
    && (history || !['xy', 'tiled'].includes(j.kind) || (Array.isArray(j.cells) && typeof j[j.kind === 'xy' ? 'gridId' : 'tiledId'] === 'string'));
  const all = [...data.jobs, ...data.history];
  return data.jobs.every((j) => valid(j, false)) && data.history.every((j) => valid(j, true))
    && new Set(all.map((j) => j.id)).size === all.length;
}

export const kvSchemas = {
  queue: { version: 1, validate: validateQueue, fallback: { seq: 0, jobs: [], history: [] } },
  refs: { version: 1, validate: (d) => isObject(d) && Array.isArray(d.vibes) && Array.isArray(d.refs) && [...d.vibes, ...d.refs].every((r) => isObject(r) && typeof r.id === 'string' && typeof r.image === 'string'), fallback: { vibes: [], refs: [] } },
  xyGrids: { version: 1, validate: (d) => Array.isArray(d) && d.every((g) => isObject(g) && typeof g.id === 'string' && isObject(g.cells)), fallback: [] },
  promptLog: { version: 1, validate: (d) => Array.isArray(d) && d.every((e) => isObject(e) && typeof e.id === 'string' && typeof e.prompt === 'string' && typeof e.uc === 'string' && Array.isArray(e.chars) && Array.isArray(e.recs)), fallback: null },
};

/** Three-way merge: conflicts keep the disk runner; unrelated additions survive.
 * @param {any} disk @param {any} local @param {any} base @param {boolean} owner @param {boolean} [protectedRunner]
 */
export function mergeQueue(disk, local, base, owner, protectedRunner = false) {
  const old = new Map([...base.jobs, ...base.history].map((j) => [j.id, j]));
  const diskAll = new Map([...disk.jobs, ...disk.history].map((j) => [j.id, j]));
  const localAll = new Map([...local.jobs, ...local.history].map((j) => [j.id, j]));
  const chosen = new Map(diskAll);
  for (const [id, previous] of old) {
    const next = localAll.get(id), current = diskAll.get(id);
    const same = !(protectedRunner && current?.status === 'running') && JSON.stringify(current) === JSON.stringify(previous);
    if (!next && (owner || same)) chosen.delete(id);
    else if (next && current && (owner || same)) chosen.set(id, next);
  }
  for (const [id, next] of localAll) if (!old.has(id) && (owner || !diskAll.has(id))) chosen.set(id, next);
  const historyIds = new Set([...disk.history, ...local.history].map((j) => j.id));
  const reordered = JSON.stringify(local.jobs.map((j) => j.id)) !== JSON.stringify(base.jobs.map((j) => j.id));
  const order = owner || reordered ? [...local.jobs, ...disk.jobs, ...local.history, ...disk.history] : [...disk.jobs, ...local.jobs, ...disk.history, ...local.history];
  const rows = [...new Set(order.map((j) => j.id))].filter((id) => chosen.has(id)).map((id) => chosen.get(id));
  return { seq: Math.max(disk.seq, local.seq), jobs: rows.filter((j) => !historyIds.has(j.id)), history: rows.filter((j) => historyIds.has(j.id)).slice(0, 60) };
}
