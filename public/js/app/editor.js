// Editor snapshots and archive-to-editor commands.
import { uid, pad } from '../util.js';
import { state, emit, set, commit } from '../store.js';
import { t, getLang } from '../i18n.js';
import { randomPrompt } from '../tags.js';
import { toast } from '../ui/modal.js';

const P = state.params;
function applyEditors(e) {
  commit('params', {
    prompt: e.prompt,
    uc: e.uc,
    characters: e.chars.map((c) => ({ id: uid(), prompt: c.prompt, uc: c.uc, x: c.x ?? 0.5, y: c.y ?? 0.5, enabled: c.enabled !== false, tab: 'prompt' })),
  });
}

function reuseParams(rec, { keepSeed = false } = {}) {
  if (!rec?.params) return;
  const prevSeed = P.seed;
  commit('params', { ...rec.params, seed: keepSeed ? prevSeed : rec.seed != null ? String(rec.seed) : prevSeed });
  toast(() => (keepSeed ? (getLang() === 'zh' ? `已套用 №${pad(rec.no || 0, 4)} 的参数（种子不变）` : `Settings of №${pad(rec.no || 0, 4)} applied (seed kept)`) : t('toast.reused')));
}

// S / Alt+click / toolbar "Seed": lock this image's seed; doing it again on the same image unlocks (random).
function useSeedOf(rec) {
  if (!rec || rec.seed == null) return;
  if (P.seed === String(rec.seed)) {
    state.session.seedFrom = null;
    set('params.seed', '');
    return toast(() => (getLang() === 'zh' ? `种子已解锁 · 下次随机（原为 ${rec.seed}）` : `Seed unlocked · random next (was ${rec.seed})`), 'ok', 2400);
  }
  state.session.seedFrom = { seed: String(rec.seed), label: '№' + pad(rec.no || 0, 4) };
  if (P.seed === String(rec.seed)) emit('params.seed');
  else set('params.seed', String(rec.seed));
  const m = rec.params;
  const zh = getLang() === 'zh';
  const diff = m && (m.width !== P.width || m.height !== P.height || (rec.model && rec.model !== P.model));
  toast(() => (t('toast.seedSet') + ` · ${rec.seed}` + (diff ? ((getLang() === 'zh') ? '（注意：这张图的尺寸或模型和当前不同，构图会不一样）' : ' (its size or model differs, so the composition will too)') : '')), diff ? 'warn' : 'ok', diff ? 5000 : 2400);
}

// Editor state as a frozen snapshot (queue batches, X/Y grids) and back.
function editorSnapshot() {
  return {
    params: structuredClone(P),
    base: state.base ? { ...state.base } : null,
    vibes: state.vibes.map((v) => ({ ...v })),
    refs: (state.refs || []).map((r) => ({ ...r })),
  };
}
function applySnapshot(snap, { undo = true } = {}) {
  const before = editorSnapshot();
  const roots = [];
  if (snap.base !== undefined) {
    state.base = snap.base ? { ...snap.base } : null;
    roots.push('base');
  }
  if (snap.vibes) {
    state.vibes = snap.vibes.map((v) => ({ ...v }));
    roots.push('vibes');
  }
  if (snap.refs) {
    state.refs = snap.refs.map((r) => ({ ...r }));
    roots.push('refs');
  }
  // Subscribers see the complete snapshot, including image/reference state.
  commit('params', snap.params);
  for (const root of roots) emit(root);
  if (undo) toast(() => (getLang() === 'zh' ? '已载入到编辑区 · 点击撤销' : 'Loaded into the editor · click to undo'), 'ok', 5000, () => applySnapshot(before, { undo: false }));
}
function doRandomPrompt() {
  commit('params', { prompt: randomPrompt() });
}


export { applyEditors, reuseParams, useSeedOf, editorSnapshot, applySnapshot, doRandomPrompt };
