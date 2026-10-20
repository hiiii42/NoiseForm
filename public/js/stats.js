// Usage statistics (live API only): images generated per day, how many were free, Anlas spent
// (from balance changes, so tools and vibe encodes count too) and the V5 allowance drain rate.
import { h, pad } from './util.js';
import { getLang } from './i18n.js';
import { on } from './store.js';

const KEY = 'nf.stats';
const IMG_PER_PCT = 17.3; // V5 images per 1% of the Opus allowance (official frontend)
const H = 3600e3;
let S = null;

function load() {
  if (S) return S;
  try {
    S = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {}
  S = Object.assign({ days: {}, usage: [], events: [], lastAnlas: null }, S || {});
  return S;
}
function save() {
  const s = load();
  const keys = Object.keys(s.days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete s.days[k];
  const cut = Date.now() - 48 * H;
  s.usage = s.usage.filter((u) => u.at > cut);
  s.events = s.events.filter((e) => e.at > cut);
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
}
const dayOf = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
};
const day = (k = dayOf()) => (load().days[k] ||= { n: 0, free: 0, paid: 0, est: 0, anlas: 0, v5: 0 });

// After a successful generation. cost = generationCost() result for the job.
export function recordGen({ n, cost, live, v5 }) {
  if (!live) return;
  const d = day();
  const free = cost?.opusFree ? 1 : 0;
  d.n += n;
  d.free += free;
  d.paid += n - free;
  d.est += cost?.total || 0;
  if (v5 && free) d.v5 += 1;
  load().events.push({ at: Date.now(), n, v5: v5 && free ? 1 : 0 });
  save();
}

// After each account refresh: Anlas decreases count as spending; allowance samples for the drain rate.
export function recordAccount({ anlas, usage }) {
  const s = load();
  if (anlas != null) {
    if (s.lastAnlas != null && anlas < s.lastAnlas) day().anlas += s.lastAnlas - anlas;
    s.lastAnlas = anlas;
  }
  if (usage) {
    const last = s.usage.at(-1);
    if (!last || last.p !== usage.percent || Date.now() - last.at > 10 * 60e3) s.usage.push({ at: Date.now(), p: usage.percent });
  }
  save();
}

export const today = () => ({ ...day() });

// V5 allowance outlook: observed net drain from allowance samples (last 3 h), or estimated from
// free V5 images in the last hour minus the refill rate.
export function drain(usage) {
  if (!usage) return null;
  const s = load();
  const now = Date.now();
  let observed = null;
  const win = s.usage.filter((u) => now - u.at < 3 * H);
  if (win.length >= 2) {
    const a = win[0];
    const b = win.at(-1);
    const dt = (b.at - a.at) / H;
    if (dt >= 0.25) observed = (a.p - b.p) / dt; // %/h, refill included
  }
  const recent = s.events.filter((e) => now - e.at < H).reduce((x, e) => x + e.v5, 0);
  const refill = (usage.perDay || 0) / 24;
  const estimated = recent / IMG_PER_PCT - refill;
  const rate = observed != null && observed > 0 ? observed : estimated;
  return { observed, estimated, recent, refill, rate, hours: rate > 0 ? usage.percent / rate : null };
}

const fmtH = (h, zh) => (h >= 48 ? (h / 24).toFixed(1) + ((getLang() === 'zh') ? ' 天' : ' d') : h >= 1 ? h.toFixed(1) + ((getLang() === 'zh') ? ' 小时' : ' h') : Math.max(1, Math.round(h * 60)) + ((getLang() === 'zh') ? ' 分钟' : ' min'));

let pop = null;
let repaint = null;
on('settings.lang', () => queueMicrotask(() => { if (pop) repaint?.(); }));
export function toggleStats(anchor, { usage, live }) {
  if (pop) return closeStats();
  repaint = () => { closeStats(); toggleStats(anchor, { usage, live }); };
  const zh = getLang() === 'zh';
  const d = today();
  const dr = drain(usage);
  const big = (v, l, cls = '') => h('div', { class: 'st-big ' + cls }, h('b', {}, v), h('span', {}, l));
  const days = Object.entries(load().days).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 7);
  let outlook = null;
  if (usage) {
    const lines = [];
    lines.push((getLang() === 'zh') ? `今日用 V5 免费生成 ${d.v5} 张（约 ${(d.v5 / IMG_PER_PCT).toFixed(1)}% 额度）` : `${d.v5} free V5 images today (~${(d.v5 / IMG_PER_PCT).toFixed(1)}% of the allowance)`);
    lines.push((getLang() === 'zh') ? `回复速度 +${usage.perDay}%/天（约 ${(usage.perDay / 24).toFixed(2)}%/小时）` : `Refills +${usage.perDay}%/day (~${(usage.perDay / 24).toFixed(2)}%/h)`);
    if (dr.observed != null) lines.push((getLang() === 'zh') ? `近 3 小时实测：额度每小时 ${dr.observed >= 0 ? '减少' : '增加'} ${Math.abs(dr.observed).toFixed(2)}%` : `Measured over 3 h: ${dr.observed >= 0 ? '−' : '+'}${Math.abs(dr.observed).toFixed(2)}%/h`);
    lines.push((getLang() === 'zh') ? `最近 1 小时免费生成 V5 ${dr.recent} 张` : `${dr.recent} free V5 images in the last hour`);
    const verdict = usage.negative
      ? (getLang() === 'zh') ? '额度已用尽：V5 生成将消耗 Anlas，V4.5 仍可免费' : 'Used up: V5 now costs Anlas (V4.5 is still free)'
      : dr.hours != null
        ? (getLang() === 'zh') ? `按当前速度，约 ${fmtH(dr.hours, zh)} 后用完` : `At this pace it runs out in ~${fmtH(dr.hours, zh)}`
        : (getLang() === 'zh') ? '按当前速度不会用完（回复快于消耗）' : 'At this pace it won’t run out (refill ≥ use)';
    outlook = h('section', { class: 'st-sec' }, h('h4', { class: 'mono' }, 'V5 · ' + usage.percent.toFixed(2) + '%'), h('p', { class: 'st-verdict' + (dr.hours != null && dr.hours < 3 ? ' low' : '') }, verdict), ...lines.map((l) => h('p', { class: 'hint' }, l)));
  }
  pop = h(
    'div',
    { class: 'stats-pop' },
    h('header', {}, h('span', { class: 'st-t' }, () => ((getLang() === 'zh') ? '今日' : 'TODAY')), h('span', { class: 'mono' }, dayOf())),
    live ? null : h('p', { class: 'hint' }, () => ((getLang() === 'zh') ? '演示模式生成不计入统计；填入 API 令牌后开始记录。' : 'Demo renders are not counted — add an API token to start tracking.')),
    h('div', { class: 'st-row' }, big(d.n, () => ((getLang() === 'zh') ? '张' : 'images')), big(d.free, () => ((getLang() === 'zh') ? '免费' : 'free'), 'ok'), big(d.paid, () => ((getLang() === 'zh') ? '付费' : 'paid'), d.paid ? 'warn' : ''), big('◈ ' + d.anlas, () => ((getLang() === 'zh') ? 'Anlas 消耗' : 'Anlas spent'), d.anlas ? 'warn' : '')),
    h('p', { class: 'hint' }, () => ((getLang() === 'zh') ? `Anlas 按余额变化统计（含放大、导演工具、氛围编码）。按价格估算的生成花费：◈ ${d.est}` : `Anlas from balance changes (includes upscale, director, vibe encoding). Estimated generation cost: ◈ ${d.est}`)),
    outlook,
    days.length > 1
      ? h(
          'table',
          { class: 'st-days mono' },
          h('tr', {}, h('th', {}, () => ((getLang() === 'zh') ? '日期' : 'Day')), h('th', {}, () => ((getLang() === 'zh') ? '张' : 'Img')), h('th', {}, () => ((getLang() === 'zh') ? '免费' : 'Free')), h('th', {}, '◈')),
          ...days.map(([k, v]) => h('tr', {}, h('td', {}, k.slice(5)), h('td', {}, v.n), h('td', {}, v.free), h('td', {}, v.anlas)))
        )
      : null
  );
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = r.bottom + 8 + 'px';
  pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth)) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
}
function outside(e) {
  if (pop && !pop.contains(e.target) && !e.target.closest('#quota, #anlas')) closeStats();
}
export function closeStats() {
  pop?.remove();
  pop = null;
  document.removeEventListener('pointerdown', outside, true);
}
