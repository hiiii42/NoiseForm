// @ts-check
// Tiny path-based reactive store with localStorage persistence.
// set(path, value): single-field edits; notify that path, its ancestors and '*'.
// patch(root, obj): legacy shallow merge; notify every supplied leaf (even unchanged),
// then the root. Callbacks/persistence can be scheduled more than once; kept for compatibility.
// commit(root, objectOrMutator, { replace }): atomic JSON-like object updates on a
// cloned draft. Objects merge by default; replace removes omitted fields. Mutators
// are synchronous and edit the draft. Only changed top-level leaves notify (no
// bubbling), then the root and '*'; callbacks are deduplicated across the whole
// commit, persistence is scheduled once, and equal values produce no events.
// Callbacks keep (value, path); commit adds { root, keys } as a third argument so
// shared UI subscribers can choose one redraw using the complete set of changes.
import { debounce } from './util.js';
import { kv } from './db.js';
import { readVersioned, writeVersioned, validateDefaults } from './persist.js';
import { tabs } from './tabs.js';
import { invoke } from './callbacks.js';

/** @type {Params} */
export const DEFAULT_PARAMS = {
  model: 'nai-diffusion-5-curated',
  prompt: '',
  uc: '',
  ucPreset: 0,
  qualityToggle: true,
  qualityPreset: 0,
  transparent: false,
  characters: [], // { id, prompt, uc, x, y, enabled }
  aiChoice: true,
  width: 832,
  height: 1216,
  sizePreset: 'normal-portrait',
  nSamples: 1,
  steps: 23,
  scale: 7,
  cfgRescale: 0,
  seed: '',
  seedLocked: false,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  variety: false,
  smea: false,
  dyn: false,
  decrisp: false,
  normalizeVibes: true,
};

/** @type {Settings} */
export const DEFAULT_SETTINGS = {
  token: '',
  conn: 'auto', // auto | direct | proxy
  // Upstream HTTP proxy the local server (node server.js) uses to reach NovelAI / the AI endpoint.
  // Off = the server's own default (NF_UPSTREAM_PROXY / HTTPS_PROXY, else direct).
  upstream: { on: false, host: '127.0.0.1', port: 7890 },
  theme: 'ink', // ink | novelai | dusk | moss | paper | mist | linen (see themes.js)
  fontScale: 's85', // themes.TEXT_SIZES id → --fz (default 85%)
  lang: 'zh',
  fxReveal: true,
  fxBg: true,
  stream: false,
  translate: true, // review column: Chinese for each tag
  spellcheck: true, // review column + editor underline: unknown / alias tags
  reviewOpen: true, // review column expanded (else a thin rail)
  archWide: false, // archive expanded into a grid
  archW: 560, // expanded archive width (px)
  archSize: 120, // expanded archive thumbnail size (px)
  autoSave: false,
  warnDuplicate: true,
  autoMode: 'loop',
  autoCount: 0,
  autoFreeOnly: true,
  queueSeedPrev: false, // new queue batches reuse the previous batch's seeds
  llm: { base: '', key: '', model: '', route: 'proxy' }, // OpenAI-compatible endpoint for the prompt assistant
  notify: false, // system notification when a generation finishes in the background
  artistPeek: true, // hover an artist: tag → sample image from nax.moe (public CDN)
  promptFormat: true, // normalise prompt text on blur (underscores, commas); pastes are literal since 1.7.2
  collapsed: { vibe: false, ref: true, base: false },
};

export const state = {
  params: { ...DEFAULT_PARAMS },
  settings: { ...DEFAULT_SETTINGS },
  // volatile / heavy (images kept as data URLs)
  base: null, // { image, width, height, strength, noise, mask, source }
  vibes: [], // { id, image, ie, strength, enabled, enc: { key: b64 } }
  refs: [], // precise references: { id, image, type, strength, fidelity }
  session: {
    live: false,
    connection: 'demo', // browser-token | server-token | demo
    serverToken: false,
    proxy: false,
    generating: false,
    progress: 0,
    anlas: null,
    tier: null,
    currentId: null,
    currentBatch: [],
  },
};

const subs = new Map();

export function get(path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), state);
}

export function set(path, value, { silent = false } = {}) {
  const keys = path.split('.');
  let o = state;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  if (o[keys.at(-1)] === value && typeof value !== 'object') return;
  o[keys.at(-1)] = value;
  if (!silent) emit(path);
}

export function patch(root, obj) {
  Object.assign(state[root], obj);
  for (const k of Object.keys(obj)) emit(`${root}.${k}`, false);
  emit(root, true);
}

// Parameters contain plain objects/arrays: compare values, independent of object key order.
function equalValue(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && a.length !== b.length) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equalValue(a[key], b[key]));
}

export function commit(root, next, { replace = false } = {}) {
  const current = state[root];
  const draft = replace ? {} : structuredClone(current);
  if (typeof next === 'function') {
    const result = next(draft);
    if (result?.then) throw new TypeError('commit mutators must be synchronous');
  } else Object.assign(draft, structuredClone(next));
  const keys = [...new Set([...Object.keys(current), ...Object.keys(draft)])].filter((key) =>
    Object.hasOwn(current, key) !== Object.hasOwn(draft, key) || !equalValue(current[key], draft[key]));
  if (!keys.length) return false;
  // Preserve root identity (UI modules retain state.params), and unchanged nested
  // references (existing editor callbacks may retain a character object).
  for (const key of keys) {
    if (Object.hasOwn(draft, key)) current[key] = draft[key];
    else delete current[key];
  }
  const hit = new Set();
  const change = Object.freeze({ root, keys: Object.freeze(keys) });
  try {
    for (const key of keys) notify(`${root}.${key}`, `${root}.${key}`, hit, change);
    notify(root, root, hit, change);
    notify('*', root, hit, change);
  } finally { schedulePersist(root); }
  return true;
}

function notify(subscription, path, hit, change = undefined) {
  const listeners = subs.get(subscription);
  if (listeners) for (const fn of listeners) if (!hit.has(fn)) {
    hit.add(fn);
    invoke(fn, subscription, get(path), path, change); // a throwing subscriber must not skip the rest or persistence
  }
}

export function emit(path, bubble = true) {
  const parts = path.split('.');
  const hit = new Set();
  const call = (k) => notify(k, path, hit);
  call(path);
  if (bubble) for (let i = parts.length - 1; i > 0; i--) call(parts.slice(0, i).join('.'));
  call('*');
  schedulePersist(parts[0]);
}

export function on(paths, fn) {
  for (const p of [].concat(paths)) {
    if (!subs.has(p)) subs.set(p, new Set());
    subs.get(p).add(fn);
  }
  return () => [].concat(paths).forEach((p) => subs.get(p)?.delete(fn));
}

// ---------- persistence ----------
const persistParams = debounce(() => {
  writeVersioned('nf.params', state.params).catch(() => {}); // reported by persist.js
}, 250);
const persistSettings = debounce(() => {
  writeVersioned('nf.settings', state.settings, { version: SETTINGS_VERSION }).then(() => tabs.notify('settings')).catch(() => {});
}, 100);
const persistRefs = debounce(() => {
  kv.set('refs', { vibes: state.vibes, refs: state.refs }).catch(() => {});
}, 400);

function schedulePersist(root) {
  if (refreshing) return;
  if (root === 'params') persistParams();
  else if (root === 'settings') persistSettings();
  else if (root === 'vibes' || root === 'refs') persistRefs();
}

export async function hydrate() {
  const p = await readVersioned('nf.params', { version: 1, validate: (d) => validateDefaults(d, DEFAULT_PARAMS), fallback: {} });
  Object.assign(state.params, structuredClone(DEFAULT_PARAMS), p);
  await refreshSettings();
  const r = await kv.get('refs');
  state.vibes = r.vibes || [];
  state.refs = r.refs || [];
}

let refreshing = false;
// v2 (1.6.2): the default text size became 85%; people still on the old default (100%) move with it once.
const SETTINGS_VERSION = 2;
function migrateSettings(d, from) {
  if (from < 2 && d && typeof d === 'object' && (d.fontScale == null || d.fontScale === 'md')) d = { ...d, fontScale: 's85' };
  return d;
}
async function refreshSettings() {
  const s = await readVersioned('nf.settings', { version: SETTINGS_VERSION, migrate: migrateSettings, validate: (d) => validateDefaults(d, DEFAULT_SETTINGS), fallback: {} });
  Object.assign(state.settings, structuredClone(DEFAULT_SETTINGS), s, {
    collapsed: { ...DEFAULT_SETTINGS.collapsed, ...(s.collapsed || {}) },
    llm: { ...DEFAULT_SETTINGS.llm, ...(s.llm || {}) },
    upstream: { ...DEFAULT_SETTINGS.upstream, ...(s.upstream || {}) },
  });
}
tabs.subscribe(async (topic) => {
  if (topic !== 'settings') return;
  await refreshSettings();
  refreshing = true;
  try {
    // Notify leaf subscribers as well as root subscribers without writing back.
    for (const key of Object.keys(state.settings)) emit('settings.' + key);
  } finally { refreshing = false; }
});
