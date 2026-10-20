// Local Danbooru tag database (public/data/tags.tsv): lookup, aliases, Chinese, typo suggestions,
// plus a cached online fallback (MyMemory) for natural-language fragments.

let db = null; // { list, byKey, alias, rows, index, indexReady }
let loading = null;

export const norm = (s) => s.trim().toLowerCase().replace(/[\s_]+/g, '_');
export const pretty = (s) => s.replace(/_/g, ' ');

export function loadTagDB() {
  if (db) return Promise.resolve(db);
  if (loading) return loading;
  loading = fetch('data/tags.tsv')
    .then((r) => {
      if (!r.ok) throw new Error('tags.tsv ' + r.status);
      return r.text();
    })
    .then(loadTagDBFromText)
    .catch((err) => {
      loading = null;
      throw err;
    });
  return loading;
}

// Local/test loader. Parsing is synchronous, as before; indexing never blocks loadTagDB().
// Await the returned database's indexReady promise when measuring indexed searches.
export function loadTagDBFromText(text) {
  const list = [], rows = [], byKey = new Map(), alias = new Map();
  for (const line of text.replace(/^\uFEFF/, '').split('\n')) {
    const [tag, cat, count, zh, al] = line.replace(/\r$/, '').split('\t');
    if (!tag) continue;
    const e = { tag, cat: +cat, count: +count, zh: zh || '' };
    const key = norm(tag);
    const aliases = al ? al.split(',').filter(Boolean).map(norm) : [];
    list.push(e);
    rows.push({ e, key, zh: norm(e.zh), aliases });
    byKey.set(key, e);
    for (const a of aliases) if (!alias.has(a)) alias.set(a, key);
  }
  // The shipped TSV is already sorted; support small, unordered test/import datasets too.
  if (list.some((e, i) => i && e.count > list[i - 1].count)) {
    list.sort((a, b) => b.count - a.count);
    rows.sort((a, b) => b.e.count - a.e.count);
  }
  db = { list, byKey, alias, rows, index: null };
  db.indexReady = buildIndex(db);
  return db;
}

const COPYRIGHT = 3, CHARACTER = 4;
const VIA = ['prefix', 'word', 'zh', 'alias', 'fuzzy'];
const SCORE = { prefix: 5, word: 4, zh: 3, alias: 2, fuzzy: 1 };
const EMPTY = [];
const takeLimit = (limit) => Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : limit === Infinity ? Infinity : 10;

function wordStarts(key) {
  const out = [];
  for (let i = key.indexOf('_'); i >= 0; i = key.indexOf('_', i + 1)) {
    if (i + 1 < key.length) out.push(key.slice(i + 1));
  }
  return out;
}

function post(map, key, id) {
  const ids = map.get(key);
  if (!ids) map.set(key, [id]);
  else if (ids[ids.length - 1] !== id) ids.push(id);
}

function prefixes(map, key, id) {
  // Short prefix buckets bound memory; longer queries verify just the matching bucket.
  for (let n = 1; n <= Math.min(3, key.length); n++) post(map, key.slice(0, n), id);
}

function grams(map, key, id, singles = false) {
  for (let i = 0; i < key.length; i++) {
    if (singles) post(map, key[i], id);
    if (i + 1 < key.length) post(map, key.slice(i, i + 2), id);
  }
}

function qualifiers(row) {
  const out = new Set();
  for (const name of [row.key, ...row.aliases]) {
    for (const m of name.matchAll(/\(([^()]*)\)/g)) out.add(norm(m[1]));
  }
  return out;
}

function buildIndex(owner) {
  const index = {
    prefix: new Map(), word: new Map(), zh: new Map(), alias: new Map(),
    fuzzy: new Map(), characters: new Map(),
  };
  let cursor = 0;
  return new Promise((resolve) => {
    const schedule = (fn) => typeof globalThis.requestIdleCallback === 'function'
      ? globalThis.requestIdleCallback(fn, { timeout: 200 })
      : setTimeout(() => fn(null), 0);
    const slice = (deadline) => {
      // A reload invalidates the previous build; do not publish stale partial indexes.
      if (owner !== db) return resolve();
      const start = performance.now();
      let processed = 0;
      while (cursor < owner.rows.length) {
        const id = cursor++, row = owner.rows[id];
        prefixes(index.prefix, row.key, id);
        for (const word of wordStarts(row.key)) prefixes(index.word, word, id);
        for (const a of row.aliases) {
          prefixes(index.alias, a, id);
          for (const word of wordStarts(a)) prefixes(index.alias, word, id);
        }
        grams(index.zh, row.zh, id, true);
        grams(index.fuzzy, row.key, id, true);
        for (const a of row.aliases) grams(index.fuzzy, a, id, true);
        if (row.e.cat === CHARACTER) for (const q of qualifiers(row)) post(index.characters, q, id);
        // Always make progress on timeout, but leave rendering/input a chance every ~4ms.
        if (++processed >= 2048 || performance.now() - start >= 4 || (deadline && deadline.timeRemaining() < 1)) break;
      }
      if (cursor < owner.rows.length) schedule(slice);
      else {
        owner.index = index; // atomic publication: fallback and indexed ranking agree
        resolve();
      }
    };
    schedule(slice);
  });
}

export const tagDBReady = () => !!db;

export function lookup(raw) {
  if (!db) return null;
  const k = norm(raw);
  return db.byKey.get(k) || null;
}

export function aliasOf(raw) {
  if (!db) return null;
  const t = db.alias.get(norm(raw));
  return t ? db.byKey.get(t) : null;
}

// Damerau-ish Levenshtein with early exit.
function dist(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  let prev2 = null;
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev.slice();
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

// Closest known tags for a misspelling (popular tags first among equal distance).
export function suggest(raw, limit = 3) {
  if (!db) return [];
  const k = norm(raw);
  const max = k.length <= 4 ? 1 : k.length <= 9 ? 2 : 3;
  const out = [];
  for (const e of db.list) {
    if (e.count < 30 && out.length) break; // list is sorted by count
    const d = dist(k, e.tag, max);
    if (d <= max) out.push({ e, d });
  }
  // word-order matches ("hair_long" → "long_hair")
  if (k.includes('_')) {
    const parts = k.split('_').sort().join('_');
    for (const e of db.list.slice(0, 40000)) if (e.tag !== k && e.tag.includes('_') && e.tag.split('_').sort().join('_') === parts) out.push({ e, d: 0.5 });
  }
  // aliases count as valid spellings too ("sliver hair" → "silver hair", itself an alias of grey hair)
  for (const [a, target] of db.alias) {
    const d = dist(k, a, max);
    if (d <= max) {
      const t = db.byKey.get(target);
      if (t) out.push({ e: { tag: a, cat: t.cat, count: t.count, zh: t.zh }, d: d + 0.1 });
    }
  }
  // tags NovelAI confirmed earlier
  for (const [term, count] of Object.entries(nvCache())) {
    if (!count) continue;
    const d = dist(k, norm(term), max);
    if (d <= max) out.push({ e: { tag: norm(term), cat: 0, count, zh: '' }, d: d + 0.05 });
  }
  out.sort((a, b) => a.d - b.d || b.e.count - a.e.count);
  const seen = new Set();
  return out.filter(({ e }) => !seen.has(e.tag) && seen.add(e.tag)).slice(0, limit).map(({ e }) => e);
}

function result(row, via, series = false) {
  const e = row.e;
  // Keep space-form tags: editor inserts these directly and archive search flattens them.
  return { tag: pretty(e.tag), cat: e.cat, count: e.count, zh: e.zh, score: SCORE[via], via,
    ...(series ? { kind: 'series' } : {}) };
}

function matches(row, k, via) {
  switch (via) {
    case 'prefix': return row.key.startsWith(k);
    case 'word': return row.key.includes('_' + k);
    case 'zh': return row.zh.includes(k);
    case 'alias': return row.aliases.some((a) => a.startsWith(k) || a.includes('_' + k));
    // Preserve the old substring fallback. Typo/edit-distance suggestions remain in suggest().
    case 'fuzzy': return row.key.includes(k) || row.aliases.some((a) => a.includes(k));
  }
  return false;
}

function rarest(map, k) {
  if (k.length === 1) return map.get(k) || EMPTY;
  let best = null;
  for (let i = 0; i + 1 < k.length; i++) {
    const ids = map.get(k.slice(i, i + 2));
    if (!ids) return EMPTY;
    if (!best || ids.length < best.length) best = ids;
  }
  return best || EMPTY;
}

function search(k, limit, series) {
  if (!db || !k || !limit) return [];
  if (!db.index) {
    const buckets = VIA.map(() => []);
    for (const row of db.rows) {
      if (series && row.e.cat !== COPYRIGHT) continue;
      const tier = VIA.findIndex((via) => matches(row, k, via));
      if (tier >= 0 && buckets[tier].length < limit) buckets[tier].push(result(row, VIA[tier], series));
      if (buckets[0].length >= limit) break;
    }
    return buckets.flat().slice(0, limit);
  }
  const out = [], seen = new Set(), index = db.index;
  for (const via of VIA) {
    const ids = via === 'zh' || via === 'fuzzy'
      ? rarest(index[via], k)
      : index[via].get(k.slice(0, 3)) || EMPTY;
    for (const id of ids) {
      if (seen.has(id)) continue;
      const row = db.rows[id];
      if (series && row.e.cat !== COPYRIGHT) continue;
      if (matches(row, k, via)) {
        seen.add(id);
        out.push(result(row, via, series));
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

// Rank is deliberately discrete: match class first, then count descending within that class.
export function searchDB(q, limit = 10) {
  q = q.trim();
  return q.startsWith('=') ? searchSeries(q.slice(1), limit) : search(norm(q), takeLimit(limit), false);
}

export function searchSeries(q, limit = 10) {
  return search(norm(q.trim().replace(/^=/, '')), takeLimit(limit), true);
}

// Category-filter before limiting: filtering searchDB's top general tags hides rare artists.
// Reuse the same index buckets and ranking without changing searchDB's public contract.
export function searchArtists(q, limit = 12) {
  const k = norm(q.replace(/^artist:/i, ''));
  limit = takeLimit(limit);
  if (!db || !k || !limit) return [];
  if (!db.index) {
    const buckets = VIA.map(() => []);
    for (const row of db.rows) {
      if (row.e.cat !== 1) continue;
      const tier = VIA.findIndex((via) => matches(row, k, via));
      if (tier >= 0 && buckets[tier].length < limit) buckets[tier].push(result(row, VIA[tier]));
      if (buckets[0].length >= limit) break;
    }
    return buckets.flat().slice(0, limit);
  }
  const out = [], seen = new Set(), index = db.index;
  for (const via of VIA) {
    const ids = via === 'zh' || via === 'fuzzy'
      ? rarest(index[via], k) : index[via].get(k.slice(0, 3)) || EMPTY;
    for (const id of ids) {
      const row = db.rows[id];
      if (row.e.cat !== 1 || seen.has(id) || !matches(row, k, via)) continue;
      seen.add(id);
      out.push(result(row, via));
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// No explicit relationships exist in the TSV. Only exact parenthesized qualifiers in a
// character's tag/aliases count; unqualified characters and franchise hierarchies are unknown.
export function charactersOf(seriesTag, limit = 10) {
  if (!db || !(limit = takeLimit(limit))) return [];
  const series = lookup(seriesTag) || aliasOf(seriesTag);
  if (!series || series.cat !== COPYRIGHT) return [];
  const key = norm(series.tag);
  const source = db.rows.find((r) => r.e === series);
  const names = new Set([key, ...source.aliases]);
  let rows;
  if (db.index) {
    const ids = new Set();
    for (const name of names) for (const id of db.index.characters.get(name) || EMPTY) ids.add(id);
    rows = [...ids].sort((a, b) => a - b).map((id) => db.rows[id]);
  } else {
    rows = db.rows.filter((row) => row.e.cat === CHARACTER && [...qualifiers(row)].some((q) => names.has(q)));
  }
  return rows.slice(0, limit).map((row) => {
    const direct = [...qualifiers({ key: row.key, aliases: EMPTY })].some((q) => names.has(q));
    return result(row, direct ? 'word' : 'alias');
  });
}

// Dictionary tags that literally occur in a sentence (Chinese names inside Chinese text, English tag
// names inside English text). Used to hand an LLM real Danbooru spellings. Longest / most used first.
export function termsIn(text, limit = 60) {
  if (!db || !text) return [];
  const t = text.toLowerCase();
  const padded = ' ' + t.replace(/[^a-z0-9:()'\-]+/g, ' ') + ' ';
  const cjk = /[　-鿿]/.test(t);
  const hits = [];
  for (const e of db.list) {
    if (e.count < 50) break; // list is sorted by count
    let m = 0;
    if (cjk && e.zh) {
      for (const z of e.zh.split(/[,，、/|;；]/)) if (z.length >= 2 && t.includes(z)) m = Math.max(m, z.length);
    }
    const p = pretty(e.tag);
    if (p.length >= 3 && padded.includes(' ' + p + ' ')) m = Math.max(m, p.length / 3);
    if (m) hits.push({ e, m });
  }
  hits.sort((a, b) => b.m - a.m || b.e.count - a.e.count);
  return hits.slice(0, limit).map(({ e }) => ({ tag: pretty(e.tag), cat: e.cat, count: e.count, zh: e.zh }));
}

// ---------------------------------------------------------------- NovelAI vocabulary check
// Danbooru drops/renames tags that NovelAI still knows (e.g. "silver hair"); ask NovelAI's
// free suggest endpoint for an exact match. Results cached: term -> count (0 = not known).
const NV_KEY = 'nf.naivocab';
let nv = null;
const nvInflight = new Map();
const nvFailed = new Map(); // term → time of the last failed lookup
function nvCache() {
  if (!nv) {
    try {
      nv = JSON.parse(localStorage.getItem(NV_KEY) || '{}');
    } catch {
      nv = {};
    }
  }
  return nv;
}
export const naiKnown = (raw) => nvCache()[pretty(norm(raw))];
export const canVerify = (raw) => Date.now() - (nvFailed.get(pretty(norm(raw))) || 0) >= 60000;

export function verifyNAI(raw, model = 'nai-diffusion-4-5-full') {
  const k = pretty(norm(raw));
  const c = nvCache();
  if (c[k] != null) return Promise.resolve(c[k]);
  if (nvInflight.has(k)) return nvInflight.get(k);
  if (Date.now() - (nvFailed.get(k) || 0) < 60000) return Promise.resolve(null); // unreachable: don't retry on every render
  const p = fetch('https://image.novelai.net/ai/generate-image/suggest-tags?' + new URLSearchParams({ model, prompt: k }))
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (!j) return (nvFailed.set(k, Date.now()), null);
      const hit = (j.tags || []).find((x) => x.tag.toLowerCase() === k);
      c[k] = hit ? hit.count || 1 : 0;
      try {
        localStorage.setItem(NV_KEY, JSON.stringify(c));
      } catch {}
      return c[k];
    })
    .catch(() => (nvFailed.set(k, Date.now()), null))
    .finally(() => nvInflight.delete(k));
  nvInflight.set(k, p);
  return p;
}

// ---------------------------------------------------------------- online fallback (sentences)
const TR_KEY = 'nf.tr';
let trCache = null;
const inflight = new Map();
const trFailed = new Map(); // text → time of the last failed / empty translation

function cache() {
  if (!trCache) {
    try {
      trCache = JSON.parse(localStorage.getItem(TR_KEY) || '{}');
    } catch {
      trCache = {};
    }
  }
  return trCache;
}
function saveCache() {
  const c = cache();
  const keys = Object.keys(c);
  if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete c[k];
  try {
    localStorage.setItem(TR_KEY, JSON.stringify(c));
  } catch {}
}

export const cachedTranslation = (text) => cache()[text.trim().toLowerCase()];
export const translating = (text) => inflight.has(text.trim().toLowerCase());
// false while a recent attempt failed — callers must not re-queue (it would loop re-rendering)
export const canTranslate = (text) => Date.now() - (trFailed.get(text.trim().toLowerCase()) || 0) >= 60000;

export function translateOnline(text) {
  const key = text.trim().toLowerCase();
  if (!key) return Promise.resolve('');
  const c = cache();
  if (c[key] != null) return Promise.resolve(c[key]);
  if (inflight.has(key)) return inflight.get(key);
  if (Date.now() - (trFailed.get(key) || 0) < 60000) return Promise.resolve('');
  const p = fetch('https://api.mymemory.translated.net/get?langpair=en|zh-CN&q=' + encodeURIComponent(key.slice(0, 480)))
    .then((r) => r.json())
    .then((j) => {
      const out = j?.responseStatus === 200 ? String(j.responseData?.translatedText || '') : '';
      if (out && !/MYMEMORY WARNING|QUOTA/i.test(out)) {
        c[key] = out;
        saveCache();
      } else trFailed.set(key, Date.now());
      return out;
    })
    .catch(() => (trFailed.set(key, Date.now()), ''))
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
