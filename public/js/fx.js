// Visual FX: topographic contour field (stage background), poster blobs, fluted-glass reveal.
import { makeNoise3, clamp, rng } from './util.js';
import { SEGS } from './demo.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function rgba(hex, a) {
  const m = hex.replace('#', '');
  const n = parseInt(m.length === 3 ? m.replace(/./g, '$&$&') : m, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ------------------------------------------------------------ contour background
// Raster cost dominates (a full-stage canvas redrawn every frame), so: 1× resolution, ~11 fps,
// two strokes per frame, and animation only while nothing covers the stage (`animate()`).
export function startContours(canvas, { enabled = () => true, animate = () => true } = {}) {
  const ctx = canvas.getContext('2d');
  const noise = makeNoise3(7);
  const r = rng(42);
  let W = 0;
  let H = 0;
  let dpr = 1;
  let t = r() * 100;
  let last = 0;
  let raf = 0;
  const mouse = { x: -1e4, y: -1e4, tx: -1e4, ty: -1e4 };
  const labels = [
    { u: 0.18, v: 0.24, s: 'Ridge of first light' },
    { u: 0.72, v: 0.66, s: 'σ = 14.6' },
    { u: 0.58, v: 0.18, s: 'Latent basin' },
  ];
  const route = Array.from({ length: 7 }, (_, i) => ({ u: 0.04 + i * 0.16 + r() * 0.05, v: 0.3 + r() * 0.5 }));

  const resize = () => {
    const b = canvas.getBoundingClientRect();
    dpr = 1; // faint hairlines — device resolution buys nothing but raster time
    W = Math.max(1, Math.round(b.width));
    H = Math.max(1, Math.round(b.height));
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    draw(true);
  };
  new ResizeObserver(resize).observe(canvas);
  canvas.parentElement.addEventListener('pointermove', (e) => {
    const b = canvas.getBoundingClientRect();
    mouse.tx = e.clientX - b.left;
    mouse.ty = e.clientY - b.top;
  });
  canvas.parentElement.addEventListener('pointerleave', () => {
    mouse.tx = -1e4;
    mouse.ty = -1e4;
  });

  function field(x, y) {
    const s = 0.0024;
    let f = noise(x * s, y * s, t) + 0.5 * noise(x * s * 2.3, y * s * 2.3, t * 1.3 + 9);
    const dx = x - mouse.x;
    const dy = y - mouse.y;
    f += 0.75 * Math.exp(-(dx * dx + dy * dy) / 26000);
    return f;
  }

  function drawLines(fg, warm) {
    const cell = 14;
    const gw = Math.ceil(W / cell) + 1;
    const gh = Math.ceil(H / cell) + 1;
    const f = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) f[j * gw + i] = field(i * cell, j * cell);
    ctx.lineWidth = 1;
    const paths = [new Path2D(), new Path2D()]; // minor, major
    let li = 0;
    for (let L = -1.0; L <= 1.3; L += 0.1, li++) {
      const path = paths[li % 5 === 0 ? 1 : 0];
      for (let j = 0; j < gh - 1; j++)
        for (let i = 0; i < gw - 1; i++) {
          const a = f[j * gw + i], b = f[j * gw + i + 1], c = f[(j + 1) * gw + i + 1], d = f[(j + 1) * gw + i];
          const idx = (a > L) | ((b > L) << 1) | ((c > L) << 2) | ((d > L) << 3);
          if (idx === 0 || idx === 15) continue;
          const x0 = i * cell, y0 = j * cell;
          const e = [
            [x0 + cell * ((L - a) / (b - a)), y0],
            [x0 + cell, y0 + cell * ((L - b) / (c - b))],
            [x0 + cell * ((L - d) / (c - d)), y0 + cell],
            [x0, y0 + cell * ((L - a) / (d - a))],
          ];
          const seg = SEGS[idx];
          for (let s = 0; s < seg.length; s += 2) {
            path.moveTo(e[seg[s]][0], e[seg[s]][1]);
            path.lineTo(e[seg[s + 1]][0], e[seg[s + 1]][1]);
          }
        }
    }
    ctx.strokeStyle = rgba(fg, 0.085);
    ctx.stroke(paths[0]);
    ctx.strokeStyle = rgba(fg, 0.2);
    ctx.stroke(paths[1]);
    // the orange route (ref: contour map)
    ctx.strokeStyle = rgba(warm, 0.85);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    const pts = route.map((p) => [p.u * W, p.v * H + Math.sin(t * 2 + p.u * 9) * 6]);
    ctx.moveTo(...pts[0]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    ctx.stroke();
    ctx.fillStyle = rgba(warm, 0.9);
    ctx.fillRect(pts[0][0] - 3, pts[0][1] - 3, 6, 6);
    ctx.font = 'italic 15px "Instrument Serif", serif';
    ctx.fillStyle = rgba(fg, 0.42);
    for (const l of labels) ctx.fillText(l.s, l.u * W, l.v * H);
  }

  function drawAscii(fg, info, neg) {
    const cw = 10;
    const ch = 16;
    ctx.font = '700 12px "JetBrains Mono", monospace';
    ctx.textBaseline = 'top';
    const ramp = '/rcaZJdM@';
    for (let y = 0; y < H; y += ch) {
      for (let x = 0; x < W; x += cw) {
        const v = field(x, y);
        const band = ((v + 2) * 6) % 1;
        if (band > 0.13) continue;
        const k = Math.floor(clamp((v + 1) / 2.2, 0, 0.999) * ramp.length);
        const hot = ((x * 31 + y * 17) % 97) === 0;
        ctx.fillStyle = hot ? rgba(neg, 0.5) : rgba(info, 0.22);
        ctx.fillText(ramp[k], x, y);
      }
    }
  }

  function draw(force) {
    if (!W) return;
    const theme = document.documentElement.dataset.theme;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    mouse.x += (mouse.tx - mouse.x) * (force ? 1 : 0.12);
    mouse.y += (mouse.ty - mouse.y) * (force ? 1 : 0.12);
    if (theme === 'paper') drawAscii(css('--fg'), css('--info'), css('--neg'));
    else drawLines(css('--fg'), css('--warm'));
  }

  let still = false; // drew the static frame for the current pause
  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (document.hidden || !enabled()) return;
    if (!animate() || !document.hasFocus()) {
      if (!still) (draw(true), (still = true));
      return;
    }
    still = false;
    if (now - last < 90) return;
    last = now;
    t += 0.008;
    draw(false);
  }
  raf = requestAnimationFrame(loop);
  return { redraw: () => draw(true), stop: () => cancelAnimationFrame(raf) };
}

// ------------------------------------------------------------ poster blobs
// The goo filter (3 blurs + lighting) re-rasterizes whenever a blob moves. The motion is slow
// (~6 px/s), so ~10 updates per second look identical to 60 and cost a sixth.
const BLOBS = [
  [13, 0, 80, 60], [11, -3, -40, 110], [15, -6, -120, 40], [12, -2, -70, -90],
  [16, -8, 110, -50], [10, -4, 50, -120], [17, -1, 140, 30],
]; // [duration s, delay s, dx, dy] — alternate, like the old CSS keyframes
const easeIO = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export function startBlobs(svg, { active = () => true } = {}) {
  const els = [...svg.querySelectorAll('.b')];
  let last = 0;
  const frame = (now) => {
    requestAnimationFrame(frame);
    if (document.hidden || now - last < 100 || !active()) return;
    last = now;
    const s = now / 1000;
    els.forEach((el, i) => {
      const [dur, delay, dx, dy] = BLOBS[i % BLOBS.length];
      let p = (((s - delay) / dur) % 2 + 2) % 2;
      if (p > 1) p = 2 - p;
      // keyframes: 0 → (dx/2, -0.6dy, 1.12) → (dx, dy, 0.92), eased per segment
      const a = p < 0.5 ? easeIO(p * 2) : easeIO(p * 2 - 1);
      const [x0, y0, k0, x1, y1, k1] = p < 0.5 ? [0, 0, 1, dx * 0.5, dy * -0.6, 1.12] : [dx * 0.5, dy * -0.6, 1.12, dx, dy, 0.92];
      el.style.transform = `translate(${(x0 + (x1 - x0) * a).toFixed(1)}px, ${(y0 + (y1 - y0) * a).toFixed(1)}px) scale(${(k0 + (k1 - k0) * a).toFixed(3)})`;
    });
  };
  requestAnimationFrame(frame);
}

// The generation progress view (data ocean) lives in develop.js.

// ------------------------------------------------------------ fluted-glass reveal
export function fluteReveal(frameEl, src, { strips = 26, duration = 1100 } = {}) {
  const b = frameEl.getBoundingClientRect();
  if (!b.width || !b.height) return;
  const wrap = document.createElement('div');
  wrap.className = 'flute';
  const sw = b.width / strips;
  for (let i = 0; i < strips; i++) {
    const s = document.createElement('div');
    s.className = 'flute-s';
    s.style.left = i * sw + 'px';
    s.style.width = Math.ceil(sw) + 1 + 'px';
    const inner = document.createElement('i');
    inner.style.backgroundImage = `url("${src}")`;
    inner.style.backgroundSize = `${b.width}px ${b.height * 1.12}px`;
    inner.style.width = b.width + 'px';
    inner.style.left = -i * sw + 'px';
    const k = 1.5 + ((i * 7) % 5) * 0.12;
    inner.style.transformOrigin = `${i * sw + sw / 2}px 50%`;
    inner.style.transform = `translateX(${(i % 2 ? 1 : -1) * sw * 0.8}px) scaleX(${k})`;
    inner.style.transitionDelay = (i / strips) * 260 + 'ms';
    s.append(inner);
    wrap.append(s);
  }
  frameEl.append(wrap);
  const img = frameEl.querySelector('img');
  if (img) img.style.opacity = '0';
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      wrap.classList.add('clear');
      setTimeout(() => {
        if (img) img.style.opacity = '';
        wrap.style.transition = 'opacity .25s';
        wrap.style.opacity = '0';
        setTimeout(() => wrap.remove(), 260);
      }, duration + 280);
    })
  );
}
