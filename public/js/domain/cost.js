// @ts-check
// Pure generation rules. No browser globals, store, or transport dependencies.
// spec: { params, base?, vibes?, refs?, nSamples?, lang? }; account: explicit
// { tier, active, live, freeBlocked, usageNegative, anlas?, usage? }. Balance does
// not change the price. lang selects the existing blocker text (default English).
import { modelById } from '../data.js';

const vibeKey = (modelId, ie) => `${modelId}@${Number(ie).toFixed(2)}`;

export const effectiveModel = (spec) => {
  const m = modelById(spec.params.model);
  const wantsRefs = (spec.refs || []).length > 0;
  const wantsVibes = (spec.vibes || []).some((v) => v.enabled);
  if (m.v5 && (wantsRefs || wantsVibes)) return modelById(m.fallback);
  return m;
};

export function estimateCost(spec, account) {
  const p = spec.params;
  const eff = effectiveModel(spec);
  const base = spec.base;
  const refList = spec.refs || [];
  const vibeList = spec.vibes || [];
  const vibes = eff.vibes && !(base?.mask && eff.v4) && !refList.length ? vibeList.filter((v) => v.enabled) : [];
  const newEnc = eff.v3 ? 0 : vibes.filter((v) => !v.enc?.[vibeKey(eff.id, v.ie)]).length;
  const refs = eff.refs ? refList.length : 0;
  return generationCost({
    account,
    model: eff,
    width: p.width,
    height: p.height,
    steps: eff.fixed?.steps || p.steps,
    nSamples: spec.nSamples ?? p.nSamples,
    smea: p.smea,
    dyn: p.dyn,
    strength: base ? base.strength : 1,
    isInpaint: !!base?.mask,
    newVibeEncodes: newEnc,
    vibeCount: vibes.length,
    refCount: refs,
  });
}

export function freeBlockers(spec, account) {
  const s = account;
  const P = spec.params;
  const m = effectiveModel(spec);
  const c = estimateCost(spec, account);
  const nSamples = spec.nSamples ?? P.nSamples;
  const refList = spec.refs || [];
  const vibeList = spec.vibes || [];
  if (!s.live || c.total === 0) return [];
  const out = [];
  const Z = spec.lang === 'zh';
  if (s.freeBlocked) out.push(Z ? 'NovelAI 已暂停该账号的免费生成（异常活动限制）' : 'NovelAI has disabled free generations for this account');
  if (!(s.tier >= 3)) out.push(Z ? '需要 Opus 订阅才有免费生成' : 'Free generations need Opus');
  const steps = m.fixed?.steps || P.steps;
  if (P.width * P.height > 1048576) out.push(Z ? `分辨率 ${P.width}×${P.height} 超过 1MP（如 832×1216、1024×1024）` : `${P.width}×${P.height} exceeds 1MP`);
  if (steps > 28) out.push(Z ? `步数 ${steps} > 28` : `Steps ${steps} > 28`);
  if (nSamples > 1) out.push(Z ? `生成数量 ${nSamples}：每次仅 1 张免费` : `${nSamples} images: only 1 is free`);
  if (m.refs && refList.length) out.push(Z ? '精确参考每张 +5 Anlas' : 'Precise Reference costs +5 each');
  if (m.v5 && s.usageNegative) out.push(Z ? 'V5 免费额度已用尽（切换到 V4.5 仍可免费）' : 'V5 allowance used up (V4.5 is still free)');
  const enc = vibeList.filter((v) => v.enabled).length;
  if (m.vibes && enc && c.total <= 2 * enc + Math.max(0, enc - 4) * 2) out.push(Z ? '氛围参考需要编码 / 超过 4 张（2 Anlas 起）' : 'Vibe encoding / more than 4 vibes costs Anlas');
  if (!out.length) out.push(Z ? `本次将消耗 ◈ ${c.total}` : `This would cost ◈ ${c.total}`);
  return out;
}

// The single Anlas formula. nai.generationCost is a thin wrapper that defaults account to the live session.
export function generationCost({ model, width, height, steps, nSamples, smea, dyn, strength = 1, newVibeEncodes = 0, vibeCount = 0, refCount = 0, isInpaint = false, account }) {
  const pixels = width * height;
  const k = model.costK || 1;
  let base = Math.ceil(2.951823174884865e-6 * pixels + 5.753298233447344e-7 * pixels * steps * k);
  if (model.v3 && smea) base = base * (dyn ? 1.4 : 1.2);
  if (model.costMul) base *= model.costMul;
  const f = isInpaint ? 1 : strength;
  const per = Math.max(Math.ceil(base * f), 2);
  const sub = account;
  const isOpus = sub.tier >= 3 && sub.active !== false;
  const opusFree = isOpus && !sub.freeBlocked && pixels <= 1048576 && steps <= 28 && refCount === 0 && !(model.v5 && sub.usageNegative);
  const samples = nSamples - (opusFree ? 1 : 0);
  const total = per * samples + 2 * newVibeEncodes + Math.max(0, vibeCount - 4) * 2 + 5 * refCount * nSamples;
  return { per, total, opusFree, tooLarge: per > 140 };
}

