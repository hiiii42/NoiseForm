// Small DOM + data helpers shared across modules.
import { t, bindCopy } from './i18n.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (typeof v === 'function' && ['title', 'placeholder', 'aria-label', 'aria-description', 'alt', 'label'].includes(k)) bindCopy(el, k, v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv);
        else el.style[sk] = sv;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    if (typeof c === 'function') {
      const text = document.createTextNode('');
      bindCopy(text, 'textContent', c);
      el.append(text);
    } else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function icon(name, cls = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'ic ' + cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pad = (n, w = 4) => String(n).padStart(w, '0');

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function randomSeed() {
  return Math.floor(Math.random() * 4294967295);
}

// Mulberry32 — tiny deterministic PRNG for demo renders and FX.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------- binary / encoding ----------

export function bytesToBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function dataURLToBase64(dataURL) {
  return dataURL.slice(dataURL.indexOf(',') + 1);
}

export async function blobToBase64(blob) {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

export function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

export function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(t('copy.util.0')));
    img.src = src;
  });
}

export function canvasToBlob(canvas, type = 'image/png', q) {
  return new Promise((res) => canvas.toBlob(res, type, q));
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Re-encode any image source to a PNG blob at an exact size (cover-fit when aspect differs).
export async function imageToPNG(src, w, h, fit = 'cover') {
  const img = typeof src === 'string' ? await loadImage(src) : src;
  const W = w || img.naturalWidth || img.width;
  const H = h || img.naturalHeight || img.height;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const s = fit === 'contain' ? Math.min(W / iw, H / ih) : Math.max(W / iw, H / ih);
  if (fit === 'contain') {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s);
  return canvasToBlob(c);
}

export async function makeThumb(blob, max = 256) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const c = makeCanvas(Math.round(img.width * s), Math.round(img.height * s));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return await canvasToBlob(c, 'image/webp', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export function pickFile(accept = 'image/*', multiple = false) {
  return new Promise((res) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => res(multiple ? [...input.files] : input.files[0] || null);
    input.click();
  });
}

export function fmtNum(n) {
  return Number(n).toLocaleString('en-US');
}

export function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}`;
}

export function slugify(str, max = 48) {
  return (
    str
      .replace(/[{}\[\]():|#]/g, '')
      .replace(/[^\w一-龥]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, max) || 'image'
  );
}

// ---------- noise (for FX & demo) ----------

// Compact 3D simplex-ish value noise (gradient noise) — good enough for visuals.
export function makeNoise3(seed = 1) {
  const r = rng(seed);
  const p = new Uint8Array(512);
  const base = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [base[i], base[j]] = [base[j], base[i]];
  }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];
  const grad = (h, x, y, z) => {
    const g = h & 15;
    const u = g < 8 ? x : y;
    const v = g < 4 ? y : g === 12 || g === 14 ? x : z;
    return ((g & 1) === 0 ? u : -u) + ((g & 2) === 0 ? v : -v);
  };
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y, z) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = fade(x), v = fade(y), w = fade(z);
    const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z;
    const B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
    return lerp(
      lerp(lerp(grad(p[AA], x, y, z), grad(p[BA], x - 1, y, z), u),
        lerp(grad(p[AB], x, y - 1, z), grad(p[BB], x - 1, y - 1, z), u), v),
      lerp(lerp(grad(p[AA + 1], x, y, z - 1), grad(p[BA + 1], x - 1, y, z - 1), u),
        lerp(grad(p[AB + 1], x, y - 1, z - 1), grad(p[BB + 1], x - 1, y - 1, z - 1), u), v),
      w
    );
  };
}
