// Generation progress — "data ocean".
// A field of data marks (world-anchored, level-of-detail grid) fills the stage. A reticle seeks a spot,
// locks onto a frame with the image's aspect ratio, and the camera zooms in as the job progresses until
// that frame fills the stage, where the image develops: noise → order → stream previews → the final image.
// land(blob) finishes the zoom and draws the final image in the frame so the stage can hand over to the
// real <img> at the same place (stage.js: landDeveloping / showRecord).
import { makeNoise3, clamp, rng, loadImage } from './util.js';

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const easeIO = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const smooth = (x) => x * x * (3 - 2 * x);
const mix = (a, b, k) => a + (b - a) * k;
const MAG = 5; // magnification from "locked" to "fills the stage"
const SEEK = 1000; // ms the reticle travels
const LOCK = 380; // ms the reticle snaps to the frame
const G = 18; // ocean grid spacing (screen px) at each level of detail

// Where the image will sit in #view (padding, slug line, frame padding); a FLIP absorbs the difference.
export function finalRect(W, H, w, h) {
  const aw = Math.max(60, W - 92);
  const ah = Math.max(60, H - 210);
  const s = Math.min(aw / w, ah / h);
  const fw = w * s;
  const fh = h * s;
  return { x: W / 2 - fw / 2, y: (H - 40) / 2 - fh / 2, w: fw, h: fh };
}

function rgb(hex) {
  const m = String(hex || '#888').replace('#', '');
  const n = parseInt(m.length === 3 ? m.replace(/./g, '$&$&') : m, 16) || 0x888888;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// a small colour sample of an image, read through normalised coordinates (independent of the zoom)
function sampleImage(img, w, h) {
  const gw = 192;
  const gh = Math.max(8, Math.round((gw * h) / w));
  const c = document.createElement('canvas');
  c.width = gw;
  c.height = gh;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0, gw, gh);
  return { gw, gh, d: x.getImageData(0, 0, gw, gh).data };
}

function wordsOf(prompt) {
  const out = [];
  for (const raw of String(prompt || '').split(/[,\n]/)) {
    const w = raw.replace(/^\s*-?[\d.]+::|::\s*$/g, '').replace(/[{}[\]()]/g, '').trim();
    if (w && w.length <= 24 && !/^[#@]/.test(w)) out.push(w);
    if (out.length >= 18) break;
  }
  return out;
}

export function createDeveloper(host, { width, height, label = '', prompt = '', seed } = {}) {
  const owner = Symbol('developer'); // a fading developer must not clear its successor
  host.__developer = owner;
  host.replaceChildren();
  host.hidden = false;
  host.style.transition = '';
  host.style.opacity = '';
  host.classList.add('ocean');
  const el = (cls, tag = 'div') => {
    const e = document.createElement(tag);
    e.className = cls;
    host.append(e);
    return e;
  };
  const canvas = el('oc-canvas', 'canvas');
  const read = el('oc-read mono');
  const tick = el('oc-tick mono');
  const pct = el('oc-pct');
  pct.innerHTML = '00<sup>%</sup>';
  const lab = el('oc-l mono');
  lab.textContent = label;
  const ctx = canvas.getContext('2d');
  const noise = makeNoise3((Math.random() * 1e9) | 0);
  const r = rng((seed ?? Math.random() * 1e9) >>> 0 || 7);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dpr = Math.min(2, devicePixelRatio || 1);

  let W = 0;
  let H = 0;
  let progress = 0;
  let shown = 0;
  let zu = reduce ? 1 : 0; // zoom position 0…1
  let pc = reduce ? SEEK + LOCK : 0; // phase clock (ms); runs faster while landing
  let last = performance.now();
  const t0 = last;
  let raf = 0;
  let preview = null; // sampled stream preview
  let prevPreview = null; // the one before, for a short crossfade
  let previewAt = 0;
  let waiting = false; // no real progress yet (stream mode): show ·· instead of a number
  let final = null; // { img, data, t } once land() received the image
  let landing = null; // { resolve } while land() runs
  let landed = false; // after land(): hold the final frame (no zooming back out while the stage takes over)
  let fading = false;
  let colors = null;
  let colorsAt = -1e9;
  let box = { x: 0, y: 0, w: 0, h: 0 };
  // target (normalised stage position) and the reticle's start
  const tx = 0.32 + r() * 0.36;
  const ty = 0.3 + r() * 0.34;
  const ang = r() * Math.PI * 2;
  const sx = clamp(tx + Math.cos(ang) * 0.3, 0.08, 0.92);
  const sy = clamp(ty + Math.sin(ang) * 0.26, 0.1, 0.86);
  const words = wordsOf(prompt);
  for (let i = 0; i < 10; i++) words.push('0x' + ((r() * 0xffff) | 0).toString(16).toUpperCase().padStart(4, '0'));
  if (seed != null) words.push('seed ' + seed);
  words.push(`${width}×${height}`, 'σ ' + (r() * 20).toFixed(1), 'latent');
  // labels sit around the target, denser near it, so there is always some text in view while zooming
  // golden-angle spiral (no clumps), jittered
  const labels = words.map((s, i) => ({ s, a: i * 2.39996 + r() * 0.5, d: 0.1 + 0.9 * Math.pow((i + 0.5 + r() * 0.5) / words.length, 0.8), ph: r() * 6.28 }));

  const resize = () => {
    const b = host.getBoundingClientRect();
    W = Math.max(1, Math.round(b.width));
    H = Math.max(1, Math.round(b.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  const theme = () => {
    const root = document.documentElement;
    const paper = root.dataset.theme === 'paper';
    return {
      dot: rgb(paper ? cssVar('--info') : cssVar('--fg')),
      fg: rgb(cssVar('--fg')),
      acc: rgb(cssVar('--acc')),
      stage: cssVar('--stage') || '#000',
      line: cssVar('--line-2') || 'rgba(128,128,128,.4)',
      light: root.dataset.tone === 'light',
    };
  };

  // ocean value at a world position (0…1): slow noise + a swell; detail octave for deep zoom
  const field = (x, y, t, deep) => {
    let f = noise(x * 0.0045, y * 0.0045, t * 0.11) + 0.5 * noise(x * 0.016, y * 0.016, t * 0.19 + 7);
    if (deep > 0) f += 0.32 * deep * noise(x * 0.06, y * 0.06, t * 0.15 + 13);
    f += 0.2 * Math.sin(x * 0.011 + y * 0.005 - t * 0.45);
    return f * 0.62 + 0.5;
  };
  const hash = (i, j) => {
    let h = (i * 374761393 + j * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(64, now - last);
    last = now;
    pc += dt * (landing ? 3.2 : 1);
    // frame-rate independent easing (τ in ms)
    const k = (tau) => 1 - Math.exp(-dt / tau);
    shown += (progress - shown) * k(200);
    const lockT = clamp((pc - SEEK) / LOCK, 0, 1);
    if (!reduce) zu += ((landing || landed ? 1 : lockT >= 1 ? clamp(shown, 0, 1) : 0) - zu) * k(landing ? 90 : 380);
    if (final && final.t < 1) final.t = Math.min(1, final.t + dt / 460);
    if (landing && lockT >= 1 && zu > 0.995 && (!final || final.t >= 1)) {
      landing.resolve();
      landing = null;
    }
    if (document.hidden || host.hidden || document.body.classList.contains('post-mode') || !W) return;
    if (now - colorsAt > 500) (colors = theme()), (colorsAt = now);
    draw(now, lockT);
  }

  function draw(now, lockT) {
    const C = colors;
    const t = (now - t0) / 1000;
    const tm = reduce ? 0 : t;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const F = finalRect(W, H, width, height);
    const w0 = F.w / MAG;
    const h0 = F.h / MAG;
    const u = zu;
    const s = Math.pow(MAG, u);
    const e = easeIO(u);
    const T0x = tx * W;
    const T0y = ty * H;
    // the locked frame on screen
    const fcx = mix(T0x, F.x + F.w / 2, e);
    const fcy = mix(T0y, F.y + F.h / 2, e);
    // camera: world = screen at s = 1; keep T0 (world) under the frame centre
    const cx = T0x - (fcx - W / 2) / s;
    const cy = T0y - (fcy - H / 2) / s;
    const toX = (wx) => (wx - cx) * s + W / 2;
    const toY = (wy) => (wy - cy) * s + H / 2;
    // the reticle box: travels (seek), snaps to the frame (lock), then is the frame
    const seekT = easeIO(clamp(pc / SEEK, 0, 1));
    if (lockT <= 0) {
      const bx = mix(sx * W, T0x, seekT) + Math.sin(seekT * Math.PI) * 40;
      const by = mix(sy * H, T0y, seekT) - Math.sin(seekT * Math.PI) * 26;
      box = { x: bx - 17, y: by - 17, w: 34, h: 34 };
    } else {
      const k = easeOut(lockT);
      const bw = mix(34, w0 * s, k);
      const bh = mix(34, h0 * s, k);
      box = { x: fcx - bw / 2, y: fcy - bh / 2, w: bw, h: bh };
    }
    const inBox = (x, y, m) => x > box.x - m && x < box.x + box.w + m && y > box.y - m && y < box.y + box.h + m;
    const covered = lockT >= 1;

    // ---------------- ocean (level of detail: coarse grid + a finer grid fading in)
    const l2 = Math.log2(s);
    const lv = Math.floor(l2);
    const fr = smooth(l2 - lv);
    const gf = G / Math.pow(2, lv) / 2; // fine world spacing
    const wx0 = cx - W / 2 / s;
    const wy0 = cy - H / 2 / s;
    const i0 = Math.floor(wx0 / gf) - 1;
    const j0 = Math.floor(wy0 / gf) - 1;
    const i1 = Math.ceil((wx0 + W / s) / gf) + 1;
    const j1 = Math.ceil((wy0 + H / s) / gf) + 1;
    const step = fr < 0.03 ? 2 : 1;
    const deep = clamp(l2 / 1.5, 0, 1);
    const sp = gf * s; // fine spacing on screen (9…18)
    const B = 4;
    const paths = Array.from({ length: B }, () => new Path2D());
    const hot = new Path2D();
    const ii0 = step === 2 ? i0 - (((i0 % 2) + 2) % 2) : i0;
    const jj0 = step === 2 ? j0 - (((j0 % 2) + 2) % 2) : j0;
    for (let j = jj0; j <= j1; j += step) {
      const wy = j * gf;
      const y = toY(wy);
      const oddJ = j & 1;
      for (let i = ii0; i <= i1; i += step) {
        const coarse = !oddJ && !(i & 1);
        const a = coarse ? 1 : fr;
        if (a < 0.03) continue;
        const x = toX(i * gf);
        if (covered && inBox(x, y, 3)) continue;
        const v = field(i * gf, wy, tm, deep);
        if (v < 0.46) continue;
        const k = clamp((v - 0.46) / 0.46, 0, 1);
        const size = k * sp * 0.34 * a; // grows from 0 at the threshold: no popping
        if (size < 0.5) continue;
        const hsh = hash(i + lv * 7919, j - lv * 104729);
        (hsh < 0.012 ? hot : paths[Math.min(B - 1, (k * B) | 0)]).rect(x - size / 2, y - size / 2, size, size);
      }
    }
    for (let b = 0; b < B; b++) {
      ctx.fillStyle = rgba(C.dot, 0.1 + b * 0.13);
      ctx.fill(paths[b]);
    }
    ctx.fillStyle = rgba(C.acc, 0.85);
    ctx.fill(hot);

    // ---------------- drifting labels (prompt words, hex)
    const R = Math.max(W, H) * 0.62;
    ctx.font = '600 11px "JetBrains Mono", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    for (const l of labels) {
      const wx = T0x + Math.cos(l.a) * l.d * R + Math.sin(tm * 0.4 + l.ph) * 6;
      const wy = T0y + Math.sin(l.a) * l.d * R * 0.7 + Math.cos(tm * 0.33 + l.ph) * 4;
      const x = toX(wx);
      const y = toY(wy);
      if (x < -160 || x > W + 20 || y < -20 || y > H + 20 || (covered && inBox(x, y, 14)) || inBox(x + 40, y, 14)) continue;
      ctx.fillStyle = rgba(C.fg, 0.3 * (0.75 + 0.25 * Math.sin(tm * 0.5 + l.ph)));
      ctx.fillText(l.s, x, y);
    }

    // ---------------- reticle: crosshair from the edges to the box
    const ca = covered ? mix(0.5, 0.14, u) : 0.6;
    const mx = box.x + box.w / 2;
    const my = box.y + box.h / 2;
    ctx.strokeStyle = rgba(C.acc, ca);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, my + 0.5);
    ctx.lineTo(box.x - 8, my + 0.5);
    ctx.moveTo(box.x + box.w + 8, my + 0.5);
    ctx.lineTo(W, my + 0.5);
    ctx.moveTo(mx + 0.5, 0);
    ctx.lineTo(mx + 0.5, box.y - 8);
    ctx.moveTo(mx + 0.5, box.y + box.h + 8);
    ctx.lineTo(mx + 0.5, H);
    ctx.stroke();
    // ruler ticks along the crosshair
    ctx.beginPath();
    for (let x = mx % 40; x < W; x += 40) if (x < box.x - 12 || x > box.x + box.w + 12) (ctx.moveTo(x + 0.5, my - 3), ctx.lineTo(x + 0.5, my + 4));
    for (let y = my % 40; y < H; y += 40) if (y < box.y - 12 || y > box.y + box.h + 12) (ctx.moveTo(mx - 3, y + 0.5), ctx.lineTo(mx + 4, y + 0.5));
    ctx.stroke();

    // ---------------- the frame: stage colour, developing halftone, scan line
    if (lockT > 0) {
      ctx.save();
      ctx.globalAlpha = smooth(lockT);
      ctx.fillStyle = C.stage;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.w, box.h);
      ctx.clip();
      developInside(C, t, tm);
      ctx.restore();
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1;
      ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
    }
    // corner brackets
    const L = Math.min(18, box.w / 3, box.h / 3);
    const g = covered ? 7 : 0;
    ctx.strokeStyle = rgba(lockT < 1 ? C.acc : C.fg, 0.95);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (const [x, y, dx, dy] of [[box.x - g, box.y - g, 1, 1], [box.x + box.w + g, box.y - g, -1, 1], [box.x - g, box.y + box.h + g, 1, -1], [box.x + box.w + g, box.y + box.h + g, -1, -1]]) {
      ctx.moveTo(x + dx * L, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + dy * L);
    }
    ctx.stroke();

    // ---------------- HUD (DOM, positioned without layout reads)
    const p = clamp(shown, 0, 1);
    pct.lastChild.style.visibility = waiting && !final ? 'hidden' : '';
    pct.firstChild.nodeValue = waiting && !final ? '··' : String(Math.floor((final ? 1 : p) * 100)).padStart(2, '0');
    const ks = clamp(box.h / 520, 0.3, 1);
    pct.style.opacity = covered ? String(final ? 1 - final.t : 1) : '0';
    pct.style.transform = `translate(${box.x + 14}px, ${-(H - box.y - box.h + 12)}px) scale(${ks})`;
    read.textContent = `◎ ${clamp(mx / W, 0, 1).toFixed(3)} · ${clamp(my / H, 0, 1).toFixed(3)}   ×${s.toFixed(1)}`;
    read.style.transform = `translate(${box.x - g}px, ${-(H - box.y + g + 6)}px)`;
    tick.innerHTML = `T+${((now - t0) / 1000).toFixed(1)}s<br>${width}×${height}`;
    tick.style.opacity = covered ? '1' : '0';
    tick.style.transform = `translate(${-(W - box.x - box.w - g)}px, ${-(H - box.y + g + 6)}px)`;
    lab.style.opacity = covered ? '1' : '0';
    lab.style.transform = `translate(${box.x - g}px, ${box.y + box.h + g + 8}px)`;
  }

  // halftone inside the frame, in frame-normalised coordinates so it zooms with the frame
  function developInside(C, t, tm) {
    const step = 8;
    const order = smooth(clamp(shown * 1.15, 0, 1));
    const scanY = box.y + ((t / 4.5) % 1) * box.h;
    const src = final?.data || preview;
    // stream previews crossfade over 300 ms instead of jumping
    const pa = final || !prevPreview ? 1 : clamp((performance.now() - previewAt) / 300, 0, 1);
    const old = !final && pa < 1 ? prevPreview : null;
    const ft = final ? final.t : 0;
    const x0 = box.x + (((step / 2 - box.x) % step) + step) % step;
    const y0 = box.y + (((step / 2 - box.y) % step) + step) % step;
    const asp = box.h / Math.max(1, box.w);
    if (src) {
      const grow = 0.56 + 0.3 * smooth(clamp(ft / 0.6, 0, 1));
      for (let y = y0; y < box.y + box.h; y += step) {
        const vv = (y - box.y) / box.h;
        const gy = Math.min(src.gh - 1, (vv * src.gh) | 0);
        const ogy = old ? Math.min(old.gh - 1, (vv * old.gh) | 0) : 0;
        for (let x = x0; x < box.x + box.w; x += step) {
          const uu = (x - box.x) / box.w;
          const gx = Math.min(src.gw - 1, (uu * src.gw) | 0);
          const o = (gy * src.gw + gx) * 4;
          const d = src.d;
          let cr = d[o], cg = d[o + 1], cb = d[o + 2];
          if (old) {
            const q = (ogy * old.gw + Math.min(old.gw - 1, (uu * old.gw) | 0)) * 4;
            cr = mix(old.d[q], cr, pa);
            cg = mix(old.d[q + 1], cg, pa);
            cb = mix(old.d[q + 2], cb, pa);
          }
          const L = (0.299 * cr + 0.587 * cg + 0.114 * cb) / 255;
          const v = final ? 0.55 + 0.45 * smooth(clamp(ft / 0.6, 0, 1)) : C.light ? 1 - L : L;
          const rad = clamp(v, 0, 1) * step * grow;
          if (rad < 0.35) continue;
          ctx.fillStyle = `rgb(${cr | 0},${cg | 0},${cb | 0})`;
          ctx.beginPath();
          ctx.arc(x, y, rad, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else {
      const B = 5;
      const paths = Array.from({ length: B }, () => new Path2D());
      // 1.7.1: no per-frame randomness (it flickered). A static fine grain (scaled with the frame)
      // settles into a slowly drifting smooth field as the job progresses.
      for (let y = y0; y < box.y + box.h; y += step) {
        const vv = (y - box.y) / box.h;
        for (let x = x0; x < box.x + box.w; x += step) {
          const uu = (x - box.x) / box.w;
          const grain = 0.5 + 0.75 * noise(uu * 38, vv * 38 * asp, 3.7);
          const field = 0.5 + 0.55 * (noise(uu * 6, vv * 6 * asp, tm * 0.05) + 0.5 * noise(uu * 15, vv * 15 * asp, tm * 0.08 + 5));
          const v = clamp(mix(grain, field, order), 0, 1);
          const rad = v * step * 0.5;
          if (rad < 0.4) continue;
          const pth = paths[Math.min(B - 1, (v * B) | 0)];
          pth.moveTo(x + rad, y);
          pth.arc(x, y, rad, 0, Math.PI * 2);
        }
      }
      for (let b = 0; b < B; b++) {
        ctx.fillStyle = rgba(C.dot, 0.16 + b * 0.11);
        ctx.fill(paths[b]);
      }
    }
    if (!final) {
      // slow, faint scan line (activity cue without flashing)
      ctx.fillStyle = rgba(C.acc, 0.4);
      ctx.fillRect(box.x, scanY, box.w, 1);
    } else if (ft > 0.4) {
      ctx.globalAlpha *= smooth(clamp((ft - 0.4) / 0.6, 0, 1));
      ctx.drawImage(final.img, box.x, box.y, box.w, box.h);
    }
  }

  raf = requestAnimationFrame(frame);

  return {
    // monotonic: progress never moves backwards
    setProgress(v) {
      progress = Math.max(progress, clamp(v, 0, 1));
      if (progress > 0) waiting = false;
    },
    setWaiting(on) {
      waiting = !!on && progress <= 0;
    },
    setLabel(s) {
      lab.textContent = s;
    },
    async setPreview(blob) {
      const url = URL.createObjectURL(blob);
      try {
        const next = sampleImage(await loadImage(url), width, height);
        prevPreview = preview;
        preview = next;
        previewAt = performance.now();
      } catch {}
      URL.revokeObjectURL(url);
    },
    // finish the zoom; with an image, develop it in the frame. Resolves when the frame holds the image.
    async land(blob) {
      progress = 1;
      landed = true;
      if (blob) {
        const url = URL.createObjectURL(blob);
        try {
          const img = await loadImage(url);
          final = { img, data: sampleImage(img, width, height), t: 0, url };
        } catch {
          URL.revokeObjectURL(url);
        }
      }
      await Promise.race([new Promise((resolve) => (landing = { resolve })), new Promise((r2) => setTimeout(r2, 1600))]);
      landing = null;
      zu = 1;
      pc = Math.max(pc, SEEK + LOCK);
    },
    // the frame in client coordinates
    rect() {
      const b = host.getBoundingClientRect();
      return { left: b.left + box.x, top: b.top + box.y, width: box.w, height: box.h };
    },
    fadeOut(ms = 260) {
      if (fading) return;
      fading = true;
      host.style.transition = `opacity ${ms}ms ease`;
      host.style.opacity = '0';
      setTimeout(() => this.stop(), ms + 20);
    },
    stop() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      if (final?.url) URL.revokeObjectURL(final.url);
      landing?.resolve();
      landing = null;
      if (host.__developer !== owner) return;
      host.__developer = null;
      host.hidden = true;
      host.style.transition = '';
      host.style.opacity = '';
      host.classList.remove('ocean');
      host.replaceChildren();
    },
  };
}
