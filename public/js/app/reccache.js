// Full-image LRU. IDs identify immutable image content; updates may replace metadata.
// No DOM dependency: the caller owns URL creation and supplies its release callback.
export function createRecordCache({ limit = 40, dispose = () => {}, isPinned = () => false } = {}) {
  const records = new Map();
  const owners = new Map();
  const pinned = (id) => isPinned(id) || [...owners.values()].some((ids) => ids.has(id));
  const checkLimit = (value) => {
    if (!Number.isInteger(value) || value < 1) throw new RangeError('Cache limit must be a positive integer');
    return value;
  };
  limit = checkLimit(limit);
  function remove(id) {
    if (!records.delete(id)) return false;
    dispose(id);
    return true;
  }
  function trim() {
    for (const id of records.keys()) {
      if (records.size <= limit) break;
      if (!pinned(id)) remove(id);
    }
  }
  const cache = {
    get size() { return records.size; },
    get limit() { return limit; },
    set limit(value) { limit = checkLimit(value); trim(); },
    has: (id) => records.has(id),
    keys: () => records.keys(),
    get(id) {
      const rec = records.get(id);
      if (rec) { records.delete(id); records.set(id, rec); }
      return rec;
    },
    set(id, rec) {
      records.delete(id);
      records.set(id, rec);
      trim();
      return cache;
    },
    // Explicit user deletion overrides pins; LRU eviction never does.
    delete: remove,
    clear() { for (const id of records.keys()) remove(id); },
    // Each consumer owns a group, so releasing one cannot unpin another consumer.
    pin(owner, ids) {
      const group = new Set(ids.filter(Boolean));
      if (group.size) owners.set(owner, group);
      else owners.delete(owner);
      trim();
    },
    retain(id) {
      const owner = Symbol('record operation');
      cache.pin(owner, [id]);
      return () => cache.pin(owner, []);
    },
    trim,
  };
  return cache;
}
