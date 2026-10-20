import { t } from './i18n.js';
// Geometry and image processing only; no UI or generation side effects.
import { makeCanvas, canvasToBlob, loadImage } from './util.js';

const UNIT = 64;
const up = (n) => Math.ceil(n / UNIT) * UNIT;

// Coalesce repeated calls in this page; persisted archive identity handles reloads.
const finalizing = new Map();
export async function finalizeTiledJob(job, deps) {
  if (!job.tiledId) throw new Error(t('copy.tiled.0'));
  if (finalizing.has(job.tiledId)) return finalizing.get(job.tiledId);
  const task = (async () => {
    const existing = await deps.findRecords((r) => r.kind === 'upscale' && r.tiled?.id === job.tiledId);
    if (existing.length) return existing[0];
    const m = job.meta;
    if (!m || m.version !== 1 || !m.sourceId || !Array.isArray(m.tiles) || !m.tiles.length ||
        !Array.isArray(job.recs) || job.recs.length !== m.tiles.length || new Set(job.recs).size !== job.recs.length ||
        !Number.isInteger(m.outW) || m.outW <= 0 || !Number.isInteger(m.outH) || m.outH <= 0 ||
        !Number.isFinite(m.feather) || m.feather < 0) throw new Error(t('copy.tiled.1'));
    const records = await Promise.all(job.recs.map((id) => deps.getRecord(id)));
    if (records.some((r, i) => !r || r.kind !== 'tile' || r.tiled?.id !== job.tiledId || r.tiled?.key !== String(i))) {
      throw new Error(t('copy.tiled.2'));
    }
    const blobs = await Promise.all(job.recs.map((id) => deps.getBlob(id)));
    if (blobs.some((b) => !(b instanceof Blob) || !b.size)) throw new Error(t('copy.tiled.3'));
    const blob = await (deps.composite || composite)(m.outW, m.outH, m.tiles, blobs, { feather: m.feather });
    return deps.onResult({ blob, width: m.outW, height: m.outH, sourceId: m.sourceId,
      tiled: { ...structuredClone(m), id: job.tiledId, recs: [...job.recs] } });
  })();
  finalizing.set(job.tiledId, task);
  try { return await task; } finally { finalizing.delete(job.tiledId); }
}

export function planTiles({ width, height, scale = 'auto', overlap = 128, maxPixels = 1048576 }) {
  const factor = scale === 'auto' ? 1.3 : Number(scale);
  if (![width, height, overlap, maxPixels].every(Number.isFinite) || width <= 0 || height <= 0 ||
      overlap < 0 || maxPixels < UNIT * UNIT || !Number.isFinite(factor) || factor < 1 || factor > 2) {
    throw new RangeError(t('copy.tiled.4'));
  }
  const outW = up(width * factor), outH = up(height * factor), ov = up(overlap);
  const count = (length, size) => length <= size ? 1 : size <= ov ? Infinity : Math.ceil((length - size) / (size - ov)) + 1;
  let best = null;
  // Exhaust every aligned width. The largest legal height cannot increase the tile count.
  for (let w = UNIT; w <= Math.min(outW, Math.floor(maxPixels / UNIT / UNIT) * UNIT); w += UNIT) {
    const h = Math.min(outH, Math.floor(maxPixels / w / UNIT) * UNIT);
    const cols = count(outW, w), rows = count(outH, h), n = cols * rows;
    if (!Number.isFinite(n)) continue;
    const area = w * h, aspect = Math.abs(Math.log(w / h));
    if (!best || n < best.n || (n === best.n && (area > best.area || (area === best.area && aspect < best.aspect)))) {
      best = { w, h, cols, rows, n, area, aspect };
    }
  }
  if (!best || best.n > 10000) throw new RangeError(t('copy.tiled.5'));
  const { w, h, cols, rows } = best;
  const position = (i, n, length, size) => n === 1 ? 0 : Math.floor(i * (length - size) / UNIT / (n - 1)) * UNIT;
  const tiles = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    tiles.push({ x: position(x, cols, outW, w), y: position(y, rows, outH, h), w, h });
  }
  return { outW, outH, tiles, cols, rows };
}

export function cutTile(srcCanvas, tile, outW, outH) {
  // Sampling the corresponding source rectangle avoids allocating a full enlarged image per tile.
  const c = makeCanvas(tile.w, tile.h), ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcCanvas, tile.x * srcCanvas.width / outW, tile.y * srcCanvas.height / outH,
    tile.w * srcCanvas.width / outW, tile.h * srcCanvas.height / outH, 0, 0, tile.w, tile.h);
  return c.toDataURL('image/png');
}

export async function composite(outW, outH, tiles, blobs, { feather = 128 } = {}) {
  if (!Number.isInteger(outW) || !Number.isInteger(outH) || outW <= 0 || outH <= 0 ||
      !tiles.length || tiles.length !== blobs.length || !Number.isFinite(feather) || feather < 0) {
    throw new RangeError(t('copy.tiled.6'));
  }
  const canvas = makeCanvas(outW, outH), ctx = canvas.getContext('2d');
  const result = ctx.createImageData(outW, outH), dst = result.data;
  const weights = new Float32Array(outW * outH);
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (![t.x, t.y, t.w, t.h].every(Number.isInteger) || t.x < 0 || t.y < 0 || t.w <= 0 || t.h <= 0 ||
        t.x + t.w > outW || t.y + t.h > outH || !(blobs[i] instanceof Blob)) throw new RangeError(t('copy.tiled.7'));
    const url = URL.createObjectURL(blobs[i]);
    let img;
    try { img = await loadImage(url); } finally { URL.revokeObjectURL(url); }
    if (img.naturalWidth !== t.w || img.naturalHeight !== t.h) throw new Error(t('copy.tiled.8'));
    const c = makeCanvas(t.w, t.h), cc = c.getContext('2d', { willReadFrequently: true });
    cc.drawImage(img, 0, 0);
    const src = cc.getImageData(0, 0, t.w, t.h).data;
    const delta = [0, 0, 0];
    let samples = 0;
    // Compare matching pixels only where previous tiles already cover this tile.
    for (let y = 0; y < t.h; y += 4) for (let x = 0; x < t.w; x += 4) {
      const p = (t.y + y) * outW + t.x + x, s = (y * t.w + x) * 4, d = p * 4;
      if (weights[p] && src[s + 3] > 240 && dst[d + 3] > 240) {
        for (let k = 0; k < 3; k++) delta[k] += dst[d + k] - src[s + k];
        samples++;
      }
    }
    // Bound compensation so changed content cannot cause a large global colour shift.
    for (let k = 0; k < 3; k++) delta[k] = samples ? Math.max(-32, Math.min(32, delta[k] / samples)) : 0;
    for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) {
      const p = (t.y + y) * outW + t.x + x, s = (y * t.w + x) * 4, d = p * 4;
      // Exterior image edges never fade. Half-pixel distances keep all covered pixels nonzero.
      const edge = Math.min(t.x ? x + 0.5 : Infinity, t.y ? y + 0.5 : Infinity,
        t.x + t.w < outW ? t.w - x - 0.5 : Infinity, t.y + t.h < outH ? t.h - y - 0.5 : Infinity);
      const weight = feather ? Math.min(1, edge / feather) : 1;
      const old = weights[p], sum = old + weight;
      const a = src[s + 3] / 255, b = dst[d + 3] / 255, alpha = old * b + weight * a;
      for (let k = 0; k < 3; k++) {
        const value = Math.max(0, Math.min(255, src[s + k] + delta[k]));
        dst[d + k] = alpha ? (dst[d + k] * old * b + value * weight * a) / alpha : 0;
      }
      dst[d + 3] = 255 * alpha / sum;
      weights[p] = sum;
    }
    c.width = c.height = 0;
    // Yield between tiles so progress / close controls can paint.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (weights.some((w) => !w)) throw new Error(t('copy.tiled.9'));
  ctx.putImageData(result, 0, 0);
  const blob = await canvasToBlob(canvas);
  if (!blob) throw new Error(t('copy.tiled.10'));
  return blob;
}

// Future seam-repair pass: aligned, <=1MP strips centred in the shared bands.
export function planSeams({ outW, outH, tiles }, overlap = 128, maxPixels = 1048576) {
  if (!Number.isFinite(overlap) || overlap < 0) throw new RangeError(t('copy.tiled.11'));
  if (!overlap) return [];
  const bands = [], seen = new Set();
  for (const a of tiles) for (const b of tiles) {
    let band;
    if (a.y === b.y && a.h === b.h && b.x > a.x && b.x < a.x + a.w) {
      const w = Math.min(up(overlap), a.x + a.w - b.x);
      band = { x: Math.floor((b.x + (a.x + a.w - b.x - w) / 2) / UNIT) * UNIT, y: a.y, w, h: a.h };
    } else if (a.x === b.x && a.w === b.w && b.y > a.y && b.y < a.y + a.h) {
      const h = Math.min(up(overlap), a.y + a.h - b.y);
      band = { x: a.x, y: Math.floor((b.y + (a.y + a.h - b.y - h) / 2) / UNIT) * UNIT, w: a.w, h };
    }
    if (!band) continue;
    const plan = planTiles({ width: band.w, height: band.h, scale: 1, overlap: 0, maxPixels });
    for (const t of plan.tiles) {
      const strip = { x: band.x + t.x, y: band.y + t.y, w: t.w, h: t.h };
      const key = JSON.stringify(strip);
      if (!seen.has(key) && strip.x + strip.w <= outW && strip.y + strip.h <= outH) { seen.add(key); bands.push(strip); }
    }
  }
  return bands;
}
