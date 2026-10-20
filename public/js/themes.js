// Themes + text size. The palettes live in css/base.css ([data-theme=…]); this is the list the
// pickers show, plus the bits of state that go on <html>: data-theme, data-tone and --fz.
import { h } from './util.js';
import { state, set } from './store.js';
import { getLang } from './i18n.js';

// sw = [background, surface, text, accent, second accent] for the swatch cards
export const THEMES = [
  { id: 'ink', name: 'INK', zh: '墨', tone: 'dark', note: ['霓虹暗房', 'Neon darkroom'], sw: ['#0b0a0e', '#1b1a21', '#ede8da', '#c8ff2e', '#ff2e7e'] },
  { id: 'novelai', name: 'NOVELAI', zh: '经典', tone: 'dark', note: ['NovelAI 经典深蓝', 'Classic NovelAI Dark'], sw: ['#191b31', '#22253f', '#ffffff', '#f5f3c2', '#ff7878'] },
  { id: 'dusk', name: 'DUSK', zh: '暮色', tone: 'dark', note: ['柔和暗紫 · 玫瑰', 'Soft plum · rose'], sw: ['#1c1a22', '#2d2a37', '#ede7ef', '#e8aab9', '#a3b5ec'] },
  { id: 'moss', name: 'MOSS', zh: '苔原', tone: 'dark', note: ['柔和墨绿 · 鼠尾草', 'Soft green · sage'], sw: ['#161b19', '#252d29', '#e5eae1', '#abd5a0', '#e4ba7f'] },
  { id: 'paper', name: 'PAPER', zh: '纸', tone: 'light', note: ['孔版印刷海报', 'Risograph poster'], sw: ['#efeadc', '#ded7c4', '#111016', '#1c3ff0', '#e5145d'] },
  { id: 'mist', name: 'MIST', zh: '雾蓝', tone: 'light', note: ['柔和浅灰蓝', 'Soft blue-grey'], sw: ['#e9edf1', '#d5dce3', '#1d2530', '#3b6893', '#b0652b'] },
  { id: 'linen', name: 'LINEN', zh: '亚麻', tone: 'light', note: ['暖米色 · 陶土', 'Warm oat · terracotta'], sw: ['#f2ede4', '#e1d9cb', '#2a2420', '#a4583a', '#3d6d84'] },
];
export const themeById = (id) => THEMES.find((t) => t.id === id) || THEMES[0];

// Default is 85% (1.6.2: the old 100% read too large). Settings v1 → v2 moves "md" users to it once.
export const DEFAULT_TEXT_SIZE = 's85';
export const TEXT_SIZES = [
  ['s70', 0.7, '70%', '70%'],
  ['s75', 0.75, '75%', '75%'],
  ['xs', 0.8, '80%', '80%'],
  ['s85', 0.85, '85%', '85%'],
  ['sm', 0.92, '紧凑', 'Compact'],
  ['md', 1, '标准', 'Default'],
  ['s107', 1.07, '107%', '107%'],
  ['lg', 1.1, '大', 'Large'],
  ['s115', 1.15, '115%', '115%'],
  ['xl', 1.2, '特大', 'X-Large'],
  ['s125', 1.25, '125%', '125%'],
  ['s135', 1.35, '135%', '135%'],
  ['xxl', 1.5, '150%', '150%'],
];
export const scaleOf = (id) => (TEXT_SIZES.find((s) => s[0] === id) || TEXT_SIZES.find((s) => s[0] === DEFAULT_TEXT_SIZE))[1];

// Put the current appearance on <html>. (index.html repeats this inline before first paint.)
export function applyAppearance() {
  const de = document.documentElement;
  const th = themeById(state.settings.theme);
  de.dataset.theme = th.id;
  de.dataset.tone = th.tone;
  de.style.setProperty('--fz', String(scaleOf(state.settings.fontScale)));
}

// Theme cards + an indexed slider: legacy IDs keep their exact original scale.
export function appearanceControls(onChange = () => {}) {
  const zh = getLang() === 'zh';
  const wrap = h('div', { class: 'appear' });
  const paint = () => {
    const cur = state.settings.theme;
    const fs = state.settings.fontScale || DEFAULT_TEXT_SIZE;
    const index = TEXT_SIZES.findIndex((s) => s[1] === scaleOf(fs));
    const percent = h('output', { class: 'text-size-value mono', 'aria-live': 'polite' }, Math.round(scaleOf(fs) * 100) + '%');
    const slider = h('input', {
      class: 'rng text-size-slider', type: 'range', min: '0', max: String(TEXT_SIZES.length - 1), step: '1', value: String(index),
      'aria-label': () => ((getLang() === 'zh') ? '字号' : 'Text size'), 'aria-valuetext': percent.textContent,
      style: { '--p': `${index / (TEXT_SIZES.length - 1) * 100}%` },
      oninput: (event) => {
        const i = Number(event.target.value);
        const [id, scale] = TEXT_SIZES[i];
        set('settings.fontScale', id);
        applyAppearance();
        percent.textContent = Math.round(scale * 100) + '%';
        slider.setAttribute('aria-valuetext', percent.textContent);
        slider.style.setProperty('--p', `${i / (TEXT_SIZES.length - 1) * 100}%`);
        onChange('size');
      },
    });
    wrap.replaceChildren(
      h('div', { class: 'theme-grid', role: 'radiogroup', 'aria-label': () => ((getLang() === 'zh') ? '配色' : 'Theme') },
        ...THEMES.map((t) =>
          h('button', {
            class: 'theme-card' + (t.id === cur ? ' on' : ''), role: 'radio', 'aria-checked': String(t.id === cur), title: () => (t.note[(getLang() === 'zh') ? 0 : 1]),
            style: { '--s0': t.sw[0], '--s1': t.sw[1], '--s2': t.sw[2], '--s3': t.sw[3], '--s4': t.sw[4] },
            onclick: () => { set('settings.theme', t.id); applyAppearance(); paint(); onChange('theme'); },
          },
            h('span', { class: 'tc-prev', 'aria-hidden': 'true' }, h('i', { class: 'tc-l1' }), h('i', { class: 'tc-l2' }), h('i', { class: 'tc-dot' })),
            h('span', { class: 'tc-n' }, h('b', {}, () => ((getLang() === 'zh') ? t.zh : t.name)), h('small', {}, () => ((getLang() === 'zh') ? t.name : t.note[1])))
          )
        )
      ),
      h('div', { class: 'appear-row text-size-row' },
        h('span', { class: 't-label' }, () => ((getLang() === 'zh') ? '字号' : 'Text size')),
        h('div', { class: 'text-size-track' }, slider,
          h('div', { class: 'text-size-ticks', 'aria-hidden': 'true' },
            ...TEXT_SIZES.map(([id, scale]) => h('i', { class: id === DEFAULT_TEXT_SIZE ? 'def' : '', title: () => Math.round(scale * 100) + '%' + (id === DEFAULT_TEXT_SIZE ? (getLang() === 'zh' ? '（默认）' : ' (default)') : '') }))
          )
        ), percent
      )
    );
  };
  paint();
  return wrap;
}

// Top-bar popover
let pop = null;
export function toggleAppearance(anchor, onChange) {
  if (pop) return closeAppearance();
  const zh = getLang() === 'zh';
  pop = h('div', { class: 'appear-pop' }, h('header', {}, h('span', { class: 'st-t' }, () => ((getLang() === 'zh') ? '外观' : 'LOOK')), h('span', { class: 'mono' }, () => ((getLang() === 'zh') ? '配色 · 字号' : 'theme · text size'))), appearanceControls(onChange));
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = r.bottom + 8 + 'px';
  pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth)) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  document.addEventListener('keydown', esc, true);
}
function outside(e) {
  if (pop && !pop.contains(e.target) && !e.target.closest('#btnTheme')) closeAppearance();
}
function esc(e) {
  if (e.key === 'Escape' && pop) (e.stopPropagation(), closeAppearance());
}
export function closeAppearance() {
  pop?.remove();
  pop = null;
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('keydown', esc, true);
}
