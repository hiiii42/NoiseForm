// Hover an `artist:name` tag in a prompt editor → a small card with the community sample image for that
// artist from nax.moe (NovelAI Tag Experiments, public CDN; V5 galleries). Pure link-out: nothing is uploaded,
// only the artist name is part of the image URL. Disabled with settings.artistPeek = false.
import { h } from '../util.js';
import { state } from '../store.js';
import { getLang } from '../i18n.js';

const T = (zh, en) => (getLang() === 'zh' ? zh : en);
const GALLERIES = ['danbooru-artist-tags-v5', 'danbooru-artist-tags-2-v5', 'danbooru-artist-tags-male-2-v5'];
const cdn = (gallery, name) => `https://cdn.zele.st/data/NAX/Images/${gallery}/${encodeURIComponent(encodeURIComponent(name))}.webp`;
export const siteUrl = (name) => 'https://nax.moe/?gallery=danbooru-artist-tags-v5&search=' + encodeURIComponent(artistName(name));
// 'artist:Foo_bar' / 'foo bar' → 'foo bar' (nax.moe and the CDN key artists by their spaced name)
export const artistName = (tag) => String(tag || '').trim().replace(/^artist:\s*/i, '').replace(/_/g, ' ').trim();
const found = new Map(); // name → url | null

let tip = null;
let timer = 0;
let shownFor = '';

function hide() {
  clearTimeout(timer);
  timer = 0;
  shownFor = '';
  if (tip) tip.hidden = true;
}

// artist name under the caret offset, or '' (tags are comma / newline separated; weights and braces stripped)
function artistAt(text, offset) {
  let s = offset, e = offset;
  while (s > 0 && !/[,\n]/.test(text[s - 1])) s--;
  while (e < text.length && !/[,\n]/.test(text[e])) e++;
  const raw = text.slice(s, e).trim().replace(/^[\d.]+::|::$/g, '').replace(/^[{[]+|[}\]]+$/g, '').trim();
  const m = raw.match(/^artist:\s*(.+)$/i);
  return m ? m[1].trim().replace(/_/g, ' ') : '';
}

function resolve(name) {
  if (found.has(name)) return Promise.resolve(found.get(name));
  return new Promise((done) => {
    let i = 0;
    const tryNext = () => {
      if (i >= GALLERIES.length) return (found.set(name, null), done(null));
      const url = cdn(GALLERIES[i++], name);
      const img = new Image();
      img.onload = () => (found.set(name, url), done(url));
      img.onerror = tryNext;
      img.src = url;
    };
    tryNext();
  });
}

function show(name, x, y) {
  if (!tip) {
    tip = h('div', { class: 'artist-peek', role: 'tooltip' });
    document.body.append(tip);
  }
  shownFor = name;
  tip.replaceChildren(h('b', {}, 'artist:' + name), h('div', { class: 'ap-img' }, h('span', { class: 'ap-wait' }, () => (T('加载中…', 'Loading…')))));
  tip.hidden = false;
  place(x, y);
  resolve(name).then((url) => {
    if (shownFor !== name || !tip || tip.hidden) return;
    const body = tip.querySelector('.ap-img');
    body.replaceChildren(url ? h('img', { src: url, alt: name }) : h('span', { class: 'ap-wait' }, () => (T('nax.moe 没有这位画师的样图', 'No sample on nax.moe'))));
    tip.append(h('a', { href: siteUrl(name), target: '_blank', rel: 'noopener' }, () => (T('在 nax.moe 查看 ↗', 'Open on nax.moe ↗'))));
    // nax.moe samples are CC BY 4.0 (u/Carlyone): keep the attribution with the image
    if (url) tip.append(h('small', { class: 'ap-credit' }, 'nax.moe · u/Carlyone · ', h('a', { href: 'https://creativecommons.org/licenses/by/4.0/', target: '_blank', rel: 'noopener' }, 'CC BY 4.0')));
    place(x, y);
  });
}
function place(x, y) {
  tip.style.left = Math.max(8, Math.min(x + 14, innerWidth - tip.offsetWidth - 8)) + 'px';
  tip.style.top = Math.max(8, Math.min(y + 18, innerHeight - tip.offsetHeight - 8)) + 'px';
}

export function attachArtistPeek(ta) {
  ta.addEventListener('pointermove', (e) => {
    if (state.settings.artistPeek === false || e.buttons || !document.caretPositionFromPoint) return hide();
    const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
    const name = pos && (pos.offsetNode === ta || ta.contains(pos.offsetNode)) ? artistAt(ta.value, pos.offset) : '';
    if (!name) return hide();
    if (name === shownFor) return place(e.clientX, e.clientY);
    clearTimeout(timer);
    timer = setTimeout(() => show(name, e.clientX, e.clientY), 550);
  });
  ta.addEventListener('pointerleave', hide);
  ta.addEventListener('keydown', hide);
  ta.addEventListener('blur', hide);
}
// Hover card for a single element that names one artist (AI 构思 chips).
export function attachPeekTo(el, tag) {
  const name = artistName(tag);
  if (!name) return;
  let at = [0, 0];
  el.addEventListener('pointerenter', (e) => {
    if (state.settings.artistPeek === false) return;
    at = [e.clientX, e.clientY];
    clearTimeout(timer);
    timer = setTimeout(() => show(name, ...at), 450);
  });
  el.addEventListener('pointermove', (e) => {
    at = [e.clientX, e.clientY];
    if (shownFor === name && tip && !tip.hidden) place(...at);
  });
  el.addEventListener('pointerleave', hide);
  el.addEventListener('pointerdown', hide);
}
document.addEventListener('scroll', hide, true);
