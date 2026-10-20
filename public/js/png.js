import { t } from './i18n.js';
// PNG text-chunk metadata (tEXt / iTXt) read + write, and NovelAI "stealth" alpha-LSB metadata reader.
import { crc32 } from './zip.js';
import { loadImage, makeCanvas } from './util.js';

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

export function isPNG(bytes) {
  return SIG.every((b, i) => bytes[i] === b);
}

export function readTextChunks(bytes) {
  const out = {};
  if (!isPNG(bytes)) return out;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const latin = new TextDecoder('latin1');
  const utf8 = new TextDecoder('utf-8');
  let p = 8;
  while (p + 8 <= bytes.length) {
    const len = dv.getUint32(p);
    const type = latin.decode(bytes.subarray(p + 4, p + 8));
    const data = bytes.subarray(p + 8, p + 8 + len);
    if (type === 'tEXt') {
      const z = data.indexOf(0);
      // NovelAI writes UTF-8 bytes into tEXt; decode leniently.
      out[latin.decode(data.subarray(0, z))] = utf8.decode(data.subarray(z + 1));
    } else if (type === 'iTXt') {
      const z = data.indexOf(0);
      const key = latin.decode(data.subarray(0, z));
      const compressed = data[z + 1];
      let q = z + 3;
      q = data.indexOf(0, q) + 1; // language tag
      q = data.indexOf(0, q) + 1; // translated keyword
      if (!compressed) out[key] = utf8.decode(data.subarray(q));
    } else if (type === 'IEND') break;
    p += 12 + len;
  }
  return out;
}

function chunk(type, data) {
  const enc = new TextEncoder();
  const t = enc.encode(type);
  const buf = new Uint8Array(12 + data.length);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, data.length);
  buf.set(t, 4);
  buf.set(data, 8);
  const crcIn = new Uint8Array(4 + data.length);
  crcIn.set(t, 0);
  crcIn.set(data, 4);
  dv.setUint32(8 + data.length, crc32(crcIn));
  return buf;
}

function textChunk(key, value) {
  const enc = new TextEncoder();
  // eslint-disable-next-line no-control-regex
  const ascii = /^[\x00-\x7f]*$/.test(value);
  if (ascii) {
    const k = enc.encode(key);
    const v = enc.encode(value);
    const d = new Uint8Array(k.length + 1 + v.length);
    d.set(k, 0);
    d.set(v, k.length + 1);
    return chunk('tEXt', d);
  }
  const k = enc.encode(key);
  const v = enc.encode(value);
  const d = new Uint8Array(k.length + 5 + v.length);
  d.set(k, 0);
  d.set(v, k.length + 5); // [key]\0 [flag=0][method=0] [lang]\0 [tkey]\0
  return chunk('iTXt', d);
}

// Insert text chunks right before IEND.
export function writeTextChunks(bytes, entries) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8;
  let iend = -1;
  while (p + 8 <= bytes.length) {
    const len = dv.getUint32(p);
    if (bytes[p + 4] === 73 && bytes[p + 5] === 69 && bytes[p + 6] === 78 && bytes[p + 7] === 68) {
      iend = p;
      break;
    }
    p += 12 + len;
  }
  if (iend < 0) return bytes;
  const extra = Object.entries(entries).map(([k, v]) => textChunk(k, String(v)));
  const size = extra.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(bytes.length + size);
  out.set(bytes.subarray(0, iend), 0);
  let q = iend;
  for (const c of extra) {
    out.set(c, q);
    q += c.length;
  }
  out.set(bytes.subarray(iend), q);
  return out;
}

// JSON.stringify with non-ASCII escaped (Python ensure_ascii style), so it fits in tEXt.
export function asciiJSON(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

// NovelAI hides a gzip'd JSON copy of its metadata in the alpha channel LSBs.
export async function readStealth(blobOrUrl) {
  const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
  try {
    const img = await loadImage(url);
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const c = makeCanvas(W, H);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, W, H).data;
    let bitIndex = 0;
    const nextBit = () => {
      const x = Math.floor(bitIndex / H);
      const y = bitIndex % H;
      bitIndex++;
      if (x >= W) throw new Error(t('copy.png.0'));
      return px[(y * W + x) * 4 + 3] & 1;
    };
    const readBytes = (n) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        let b = 0;
        for (let k = 0; k < 8; k++) b = (b << 1) | nextBit();
        out[i] = b;
      }
      return out;
    };
    const magic = new TextDecoder().decode(readBytes(15));
    if (magic !== 'stealth_pngcomp' && magic !== 'stealth_pnginfo') return null;
    let bits = 0;
    for (let k = 0; k < 32; k++) bits = (bits * 2) + nextBit();
    const data = readBytes(Math.ceil(bits / 8));
    let text;
    if (magic === 'stealth_pngcomp') {
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([data]).stream().pipeThrough(ds);
      text = await new Response(stream).text();
    } else {
      text = new TextDecoder().decode(data);
    }
    return JSON.parse(text);
  } catch {
    return null;
  } finally {
    if (typeof blobOrUrl !== 'string') URL.revokeObjectURL(url);
  }
}

// Unified: returns { Description, Comment(obj), Software, Source } or null.
export async function readNaiMetadata(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let meta = isPNG(bytes) ? readTextChunks(bytes) : {};
  if (!meta.Comment) {
    const stealth = await readStealth(blob);
    if (stealth) meta = { ...stealth, ...meta };
  }
  if (!meta.Comment && !meta.Description && !meta.parameters) return null;
  let comment = meta.Comment;
  if (typeof comment === 'string') {
    try {
      comment = JSON.parse(comment);
    } catch {
      comment = null;
    }
  }
  return { ...meta, Comment: comment };
}
