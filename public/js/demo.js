// DEMO backend: procedural "poster" renders in the reference palettes, so the whole
// workflow works without an API token. Clearly not AI output.
import { rng, hashString, makeNoise3, makeCanvas, canvasToBlob, loadImage, sleep, clamp } from './util.js';
import { writeTextChunks, asciiJSON } from './png.js';

const PALETTES = [
  { name: 'foam', bg: '#0b0a0e', fg: '#ede8da', a: '#ff2e9a', b: '#c8ff2e', c: '#ffc2dc', mode: 'halftone' },
  { name: 'cloud', bg: '#0d4f96', fg: '#f4f4f4', a: '#c9d6ff', b: '#e6a3d6', c: '#6c9a2c', mode: 'flute' },
  { name: 'mind', bg: '#f2f1f7', fg: '#0d0d10', a: '#a996ff', b: '#cfc5ff', c: '#7a62ff', mode: 'type' },
  { name: 'reed', bg: '#a7b6c5', fg: '#1d2329', a: '#dcf24a', b: '#f6fbb8', c: '#99bb14', mode: 'flute' },
  { name: 'facet', bg: '#ece9e1', fg: '#1a1716', a: '#ff6a1a', b: '#2b2522', c: '#ffb27a', mode: 'halftone' },
  { name: 'ascii', bg: '#f3efe2', fg: '#e2175f', a: '#1d3fd6', b: '#1d3fd6', c: '#e2175f', mode: 'ascii' },
  { name: 'wave', bg: '#08243f', fg: '#ffffff', a: '#2aaae2', b: '#0d5b8b', c: '#c4ecff', mode: 'halftone' },
  { name: 'topo', bg: '#0b0b0d', fg: '#d9d6cf', a: '#ff5a14', b: '#57544e', c: '#ff8a4a', mode: 'contour' },
];

const KEYWORDS = [
  [/night|dark|black|shadow|moon/, ['topo', 'foam']],
  [/blue|sky|ocean|sea|water|underwater|rain/, ['wave', 'cloud']],
  [/pink|magenta|neon|cyber/, ['foam']],
  [/purple|violet|lavender|dream/, ['mind']],
  [/green|yellow|lime|forest|spring/, ['reed']],
  [/orange|sunset|autumn|fire/, ['facet']],
  [/ascii|pixel|retro|text|poster|monochrome/, ['ascii']],
];

function hex(c) {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function choosePalette(prompt, r) {
  const p = prompt.toLowerCase();
  for (const [re, names] of KEYWORDS) {
    if (re.test(p)) {
      const name = names[Math.floor(r() * names.length)]; // draw once, not per palette compared
      return PALETTES.find((x) => x.name === name);
    }
  }
  return PALETTES[Math.floor(r() * PALETTES.length)];
}

function headline(prompt) {
  const words = prompt
    .replace(/[{}[\]|#]|-?\d+(\.\d+)?::|::/g, ' ')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s && !/^(1girl|1boy|solo|masterpiece|best quality|very aesthetic|absurdres|no text)$/i.test(s));
  const w = (words[0] || 'noise form').toUpperCase().split(/\s+/).slice(0, 2);
  return w.length === 1 ? [w[0], w[0]] : w;
}

// Shaded metaballs → returns canvas at full size.
function blobLayer(W, H, pal, r, count) {
  const S = 2; // render at half-res
  const w = Math.ceil(W / S);
  const hgt = Math.ceil(H / S);
  const balls = [];
  const cx = w * (0.35 + r() * 0.3);
  const cy = hgt * (0.35 + r() * 0.3);
  for (let i = 0; i < count; i++) {
    const ang = r() * Math.PI * 2;
    const dist = Math.min(w, hgt) * (0.05 + r() * 0.32);
    balls.push({ x: cx + Math.cos(ang) * dist, y: cy + Math.sin(ang) * dist, r: Math.min(w, hgt) * (0.06 + r() * 0.12) });
  }
  const m = new Float32Array(w * hgt);
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (const b of balls) {
        const dx = x - b.x;
        const dy = y - b.y;
        s += (b.r * b.r) / (dx * dx + dy * dy + 1);
      }
      m[y * w + x] = s;
    }
  }
  const c = makeCanvas(w, hgt);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, hgt);
  const A = hex(pal.a);
  const B = hex(pal.b);
  const C = hex(pal.c);
  const L = [-0.45, -0.65, 0.62];
  const Hv = (() => {
    const v = [L[0], L[1], L[2] + 1];
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  })();
  const hAt = (i) => 1 - 1 / Math.max(m[i], 1e-3);
  for (let y = 1; y < hgt - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = m[i];
      if (v < 0.95) continue;
      const alpha = clamp((v - 0.95) / 0.08, 0, 1);
      let nx = (hAt(i - 1) - hAt(i + 1)) * 9;
      let ny = (hAt(i - w) - hAt(i + w)) * 9;
      let nz = 1;
      const nl = Math.hypot(nx, ny, nz);
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const diff = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
      const spec = Math.pow(Math.max(0, nx * Hv[0] + ny * Hv[1] + nz * Hv[2]), 38);
      const t = clamp(y / hgt + (x / w) * 0.4 - 0.15, 0, 1);
      let col = t < 0.5 ? mix(A, C, t * 2) : mix(C, B, (t - 0.5) * 2);
      const shade = 0.5 + 0.62 * diff;
      const o = i * 4;
      img.data[o] = clamp(col[0] * shade + spec * 255, 0, 255);
      img.data[o + 1] = clamp(col[1] * shade + spec * 255, 0, 255);
      img.data[o + 2] = clamp(col[2] * shade + spec * 255, 0, 255);
      img.data[o + 3] = alpha * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const out = makeCanvas(W, H);
  const octx = out.getContext('2d');
  // soft drop shadow
  octx.filter = `blur(${Math.round(W / 40)}px)`;
  octx.globalAlpha = 0.35;
  octx.drawImage(c, W * 0.02, H * 0.025, W, H);
  octx.filter = 'none';
  octx.globalAlpha = 1;
  octx.globalCompositeOperation = 'destination-in';
  octx.globalCompositeOperation = 'source-over';
  const shadow = makeCanvas(W, H);
  const sctx = shadow.getContext('2d');
  sctx.drawImage(out, 0, 0);
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = 'rgba(10,6,24,1)';
  sctx.fillRect(0, 0, W, H);
  octx.clearRect(0, 0, W, H);
  octx.globalAlpha = 0.4;
  octx.drawImage(shadow, 0, 0);
  octx.globalAlpha = 1;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(c, 0, 0, W, H);
  return out;
}

function postHalftone(ctx, W, H, pal, src) {
  const sctx = src.getContext('2d', { willReadFrequently: true });
  const d = sctx.getImageData(0, 0, W, H).data;
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, W, H);
  const step = Math.max(6, Math.round(W / 110));
  const rot = Math.PI / 4;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const diag = Math.hypot(W, H);
  for (let v = -diag; v < diag; v += step) {
    for (let u = -diag; u < diag; u += step) {
      const x = W / 2 + u * cos - v * sin;
      const y = H / 2 + u * sin + v * cos;
      if (x < -step || y < -step || x > W + step || y > H + step) continue;
      const xi = clamp(Math.round(x), 0, W - 1);
      const yi = clamp(Math.round(y), 0, H - 1);
      const o = (yi * W + xi) * 4;
      const R = d[o];
      const G = d[o + 1];
      const B = d[o + 2];
      const bgc = hex(pal.bg);
      const dist = Math.hypot(R - bgc[0], G - bgc[1], B - bgc[2]) / 441;
      const rad = step * 0.62 * Math.sqrt(clamp(dist * 1.6, 0, 1));
      if (rad < 0.4) continue;
      ctx.fillStyle = `rgb(${R},${G},${B})`;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function postAscii(ctx, W, H, pal, src, r) {
  const sctx = src.getContext('2d', { willReadFrequently: true });
  const d = sctx.getImageData(0, 0, W, H).data;
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, W, H);
  const cw = Math.max(8, Math.round(W / 80));
  const chH = Math.round(cw * 1.5);
  const ramp = ' .:/rcaZJdM@';
  ctx.font = `700 ${Math.round(cw * 1.25)}px "JetBrains Mono", monospace`;
  ctx.textBaseline = 'top';
  const bgc = hex(pal.bg);
  for (let y = 0; y < H; y += chH) {
    for (let x = 0; x < W; x += cw) {
      const o = (Math.min(H - 1, y + (chH >> 1)) * W + Math.min(W - 1, x + (cw >> 1))) * 4;
      const dist = Math.hypot(d[o] - bgc[0], d[o + 1] - bgc[1], d[o + 2] - bgc[2]) / 441;
      const k = Math.floor(clamp(dist * 1.5, 0, 0.999) * ramp.length);
      if (k <= 0) continue;
      ctx.fillStyle = r() < 0.08 ? pal.fg : pal.a;
      ctx.fillText(ramp[k], x, y);
    }
  }
}

function postFlute(ctx, W, H, src) {
  const n = Math.round(W / 34);
  const sw = W / n;
  for (let i = 0; i < n; i++) {
    const x = i * sw;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, 0, sw + 0.5, H);
    ctx.clip();
    // each reed magnifies + shifts what's behind it
    const k = 1.35;
    ctx.drawImage(src, x + sw / 2 - (sw / 2) * k - sw * 0.6, 0, W * k * 0.5 + 0, H, x - sw * 0.2, 0, W * 0.5 * k * (sw / (sw * k)) + sw * 0.2, H);
    ctx.restore();
    const g = ctx.createLinearGradient(x, 0, x + sw, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.28)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.04)');
    g.addColorStop(0.7, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.2)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, sw, H);
  }
}

function postFluteSimple(ctx, W, H, src) {
  const n = Math.round(W / 36);
  const sw = W / n;
  for (let i = 0; i < n; i++) {
    const x = i * sw;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, 0, sw + 0.6, H);
    ctx.clip();
    const k = 1.6;
    const cxs = x + sw / 2;
    ctx.translate(cxs, 0);
    ctx.scale(k, 1);
    ctx.translate(-cxs - sw * 0.3, 0);
    ctx.drawImage(src, 0, 0);
    ctx.restore();
    const g = ctx.createLinearGradient(x, 0, x + sw, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.32)');
    g.addColorStop(0.15, 'rgba(255,255,255,0.05)');
    g.addColorStop(0.75, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, sw, H);
  }
}

function overlayContours(ctx, W, H, pal, noise, z) {
  const cell = Math.max(6, Math.round(W / 140));
  const gw = Math.ceil(W / cell) + 1;
  const gh = Math.ceil(H / cell) + 1;
  const f = new Float32Array(gw * gh);
  const sc = 2.6 / W;
  for (let j = 0; j < gh; j++)
    for (let i = 0; i < gw; i++) {
      const x = i * cell * sc;
      const y = j * cell * sc;
      f[j * gw + i] = noise(x, y, z) + 0.5 * noise(x * 2.1, y * 2.1, z + 3);
    }
  ctx.lineWidth = Math.max(1, W / 700);
  for (let L = -0.9; L <= 0.9; L += 0.09) {
    const major = Math.abs((L * 100) % 45) < 5;
    ctx.strokeStyle = major ? pal.fg : pal.b;
    ctx.globalAlpha = major ? 0.75 : 0.5;
    ctx.beginPath();
    for (let j = 0; j < gh - 1; j++)
      for (let i = 0; i < gw - 1; i++) {
        const a = f[j * gw + i], b = f[j * gw + i + 1], c = f[(j + 1) * gw + i + 1], d = f[(j + 1) * gw + i];
        const idx = (a > L) | ((b > L) << 1) | ((c > L) << 2) | ((d > L) << 3);
        if (idx === 0 || idx === 15) continue;
        const x0 = i * cell, y0 = j * cell;
        const pt = (p, q, vp, vq) => {
          const t = (L - vp) / (vq - vp);
          return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        };
        const P = [[x0, y0], [x0 + cell, y0], [x0 + cell, y0 + cell], [x0, y0 + cell]];
        const e = [pt(P[0], P[1], a, b), pt(P[1], P[2], b, c), pt(P[3], P[2], d, c), pt(P[0], P[3], a, d)];
        const seg = SEGS[idx];
        for (let s = 0; s < seg.length; s += 2) {
          ctx.moveTo(...e[seg[s]]);
          ctx.lineTo(...e[seg[s + 1]]);
        }
      }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
// marching-squares edge pairs (edges: 0 top,1 right,2 bottom,3 left)
export const SEGS = [[], [3, 0], [0, 1], [3, 1], [1, 2], [3, 0, 1, 2], [0, 2], [3, 2], [3, 2], [0, 2], [0, 1, 2, 3], [1, 2], [3, 1], [0, 1], [3, 0], []];

export async function renderDemo({ prompt = '', width: W, height: H, seed, steps = 28, scale = 5, base, mask, strength = 0.7 }) {
  const r = rng((seed ^ hashString(prompt)) >>> 0);
  const pal = choosePalette(prompt, r);
  const noise = makeNoise3(seed);
  await document.fonts.load('800 100px Archivo').catch(() => {});

  const comp = makeCanvas(W, H);
  const c = comp.getContext('2d');
  c.fillStyle = pal.bg;
  c.fillRect(0, 0, W, H);

  let baseImg = null;
  if (base) {
    baseImg = await loadImage(base);
    c.drawImage(baseImg, 0, 0, W, H);
    c.globalAlpha = strength;
    c.fillStyle = pal.bg;
    c.fillRect(0, 0, W, H);
    c.globalAlpha = 1;
  }

  // giant stacked type (ref: MIND poster)
  const words = headline(prompt);
  c.fillStyle = pal.fg;
  c.textAlign = 'center';
  c.textBaseline = 'alphabetic';
  let fs = W * 0.36;
  const longest = words.reduce((a, b) => (a.length > b.length ? a : b));
  c.font = `800 ${fs}px Archivo, sans-serif`;
  const tw = c.measureText(longest).width;
  if (tw > W * 0.92) fs *= (W * 0.92) / tw;
  c.font = `800 ${fs}px Archivo, sans-serif`;
  const rows = 4;
  const lh = fs * 0.8;
  const top = H / 2 - (rows * lh) / 2 + lh * 0.85;
  for (let i = 0; i < rows; i++) {
    const word = words[i % words.length];
    if (i % 2 && pal.mode !== 'ascii') {
      c.strokeStyle = pal.fg;
      c.lineWidth = Math.max(1.5, fs / 70);
      c.strokeText(word, W / 2, top + i * lh);
    } else c.fillText(word, W / 2, top + i * lh);
  }

  // jelly blobs (ref: foam letters / MIND blobs / reeded glass)
  const blobs = blobLayer(W, H, pal, r, 5 + Math.floor(r() * 4));
  c.drawImage(blobs, 0, 0);

  const out = makeCanvas(W, H);
  const o = out.getContext('2d');
  if (pal.mode === 'halftone') postHalftone(o, W, H, pal, comp);
  else if (pal.mode === 'ascii') postAscii(o, W, H, pal, comp, r);
  else if (pal.mode === 'flute') postFluteSimple(o, W, H, comp);
  else {
    o.drawImage(comp, 0, 0);
    if (pal.mode === 'contour') overlayContours(o, W, H, pal, noise, r() * 10);
  }

  if (baseImg && mask) {
    // inpaint: keep original outside the mask
    const mimg = await loadImage(mask);
    const keep = makeCanvas(W, H);
    const k = keep.getContext('2d');
    k.drawImage(mimg, 0, 0, W, H);
    k.globalCompositeOperation = 'source-in';
    k.drawImage(out, 0, 0);
    o.globalCompositeOperation = 'source-over';
    o.drawImage(baseImg, 0, 0, W, H);
    o.drawImage(keep, 0, 0);
  }

  // print slug
  const sz = Math.max(10, Math.round(W / 70));
  o.font = `500 ${sz}px "JetBrains Mono", monospace`;
  o.textAlign = 'left';
  o.textBaseline = 'bottom';
  o.fillStyle = pal.mode === 'ascii' ? pal.fg : pal.fg;
  o.globalAlpha = 0.85;
  o.fillText(`NOISEFORM / DEMO RENDER — SEED ${seed} — ${steps} STEPS — CFG ${scale}`, sz * 1.6, H - sz * 1.4);
  o.textAlign = 'right';
  o.fillText(`${W}×${H}`, W - sz * 1.6, H - sz * 1.4);
  o.globalAlpha = 1;

  return canvasToBlob(out);
}

export async function demoGenerate(job, onProgress) {
  const { width, height, nSamples, steps } = job;
  const expected = 900 + (width * height * steps) / 1.6e4;
  const t0 = performance.now();
  const images = [];
  for (let i = 0; i < nSamples; i++) {
    const seed = (job.seed + i) >>> 0;
    const blob = await renderDemo({ ...job, seed });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const comment = { prompt: job.prompt, uc: job.uc, steps, scale: job.scale, seed, width, height, sampler: job.sampler, n_samples: nSamples, demo: true };
    const tagged = writeTextChunks(bytes, {
      Title: 'NOISEFORM demo render',
      Description: job.prompt,
      Software: 'NOISEFORM (demo)',
      Source: 'NOISEFORM demo',
      Comment: asciiJSON(comment),
    });
    images.push({ blob: new Blob([tagged], { type: 'image/png' }), seed });
  }
  // simulate the wait so the developing animation is visible
  while (performance.now() - t0 < expected) {
    onProgress?.((performance.now() - t0) / expected);
    await sleep(60);
  }
  return images;
}

// ---------------- demo director tools / upscale ----------------
function lum(d, i) {
  return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
}

export async function demoAugment(reqType, src, { emotion, defry = 0 } = {}) {
  const img = await loadImage(src);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const cnv = makeCanvas(W, H);
  const ctx = cnv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, W, H);
  const d = id.data;
  await sleep(700);
  if (reqType === 'lineart' || reqType === 'sketch') {
    const L = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) L[i] = lum(d, i * 4);
    const out = ctx.createImageData(W, H);
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const gx = -L[i - W - 1] - 2 * L[i - 1] - L[i + W - 1] + L[i - W + 1] + 2 * L[i + 1] + L[i + W + 1];
        const gy = -L[i - W - 1] - 2 * L[i - W] - L[i - W + 1] + L[i + W - 1] + 2 * L[i + W] + L[i + W + 1];
        const g = Math.hypot(gx, gy);
        let v = reqType === 'lineart' ? (g > 90 ? 0 : 255) : clamp(255 - g * 0.9, 40, 250);
        if (reqType === 'sketch') v = v * 0.92 + ((x * 7 + y * 13) % 17) * 0.6;
        out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
        out.data[i * 4 + 3] = 255;
      }
    ctx.putImageData(out, 0, 0);
  } else if (reqType === 'bg-removal') {
    const corners = [0, (W - 1) * 4, (H - 1) * W * 4, (H * W - 1) * 4];
    const bg = [0, 1, 2].map((k) => corners.reduce((s, c) => s + d[c + k], 0) / 4);
    for (let i = 0; i < d.length; i += 4) {
      const dist = Math.hypot(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]);
      d[i + 3] = clamp((dist - 30) * 4, 0, 255);
    }
    ctx.putImageData(id, 0, 0);
  } else if (reqType === 'colorize') {
    const stops = [hex('#1b1035'), hex('#ff2e7e'), hex('#ffb37a'), hex('#c8ff2e'), hex('#f6f3ea')];
    for (let i = 0; i < d.length; i += 4) {
      const t = lum(d, i) / 255;
      const p = t * (stops.length - 1);
      const k = Math.min(stops.length - 2, Math.floor(p));
      const c = mix(stops[k], stops[k + 1], p - k);
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
    }
    ctx.putImageData(id, 0, 0);
  } else if (reqType === 'declutter') {
    ctx.filter = 'blur(1.5px) contrast(1.1) saturate(1.1)';
    ctx.drawImage(img, 0, 0);
    ctx.filter = 'none';
  } else if (reqType === 'emotion') {
    ctx.filter = `saturate(${1.3 - defry * 0.05}) hue-rotate(${(hashString(emotion || '') % 60) - 30}deg)`;
    ctx.drawImage(img, 0, 0);
    ctx.filter = 'none';
    const sz = Math.round(W / 9);
    ctx.font = `800 ${sz}px Archivo, sans-serif`;
    ctx.fillStyle = '#ff2e7e';
    ctx.textAlign = 'center';
    ctx.fillText((emotion || 'neutral').toUpperCase(), W / 2, H - sz * 0.6);
  }
  return canvasToBlob(cnv);
}

export async function demoUpscale(src, factor = 4) {
  const img = await loadImage(src);
  const k = Math.min(factor, 4096 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = makeCanvas(Math.round(img.naturalWidth * k), Math.round(img.naturalHeight * k));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  await sleep(900);
  return canvasToBlob(c);
}
