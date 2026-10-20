// Minimal MessagePack decoder + length-prefixed frame reader for /ai/generate-image-stream.

export function decode(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const td = new TextDecoder();
  let p = 0;
  const str = (n) => {
    const s = td.decode(bytes.subarray(p, p + n));
    p += n;
    return s;
  };
  const bin = (n) => {
    const b = bytes.slice(p, p + n);
    p += n;
    return b;
  };
  const arr = (n) => {
    const a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = read();
    return a;
  };
  const map = (n) => {
    const o = {};
    for (let i = 0; i < n; i++) {
      const k = read();
      o[k] = read();
    }
    return o;
  };
  function read() {
    const b = bytes[p++];
    if (b <= 0x7f) return b;
    if (b >= 0x80 && b <= 0x8f) return map(b & 0x0f);
    if (b >= 0x90 && b <= 0x9f) return arr(b & 0x0f);
    if (b >= 0xa0 && b <= 0xbf) return str(b & 0x1f);
    if (b >= 0xe0) return b - 256;
    let v;
    switch (b) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: v = bytes[p]; p += 1; return bin(v);
      case 0xc5: v = dv.getUint16(p); p += 2; return bin(v);
      case 0xc6: v = dv.getUint32(p); p += 4; return bin(v);
      case 0xc7: v = bytes[p]; p += 2; return bin(v);
      case 0xc8: v = dv.getUint16(p); p += 3; return bin(v);
      case 0xc9: v = dv.getUint32(p); p += 5; return bin(v);
      case 0xca: v = dv.getFloat32(p); p += 4; return v;
      case 0xcb: v = dv.getFloat64(p); p += 8; return v;
      case 0xcc: return bytes[p++];
      case 0xcd: v = dv.getUint16(p); p += 2; return v;
      case 0xce: v = dv.getUint32(p); p += 4; return v;
      case 0xcf: v = Number(dv.getBigUint64(p)); p += 8; return v;
      case 0xd0: v = dv.getInt8(p); p += 1; return v;
      case 0xd1: v = dv.getInt16(p); p += 2; return v;
      case 0xd2: v = dv.getInt32(p); p += 4; return v;
      case 0xd3: v = Number(dv.getBigInt64(p)); p += 8; return v;
      case 0xd4: p += 2; return null;
      case 0xd5: p += 3; return null;
      case 0xd6: p += 5; return null;
      case 0xd7: p += 9; return null;
      case 0xd8: p += 17; return null;
      case 0xd9: v = bytes[p]; p += 1; return str(v);
      case 0xda: v = dv.getUint16(p); p += 2; return str(v);
      case 0xdb: v = dv.getUint32(p); p += 4; return str(v);
      case 0xdc: v = dv.getUint16(p); p += 2; return arr(v);
      case 0xdd: v = dv.getUint32(p); p += 4; return arr(v);
      case 0xde: v = dv.getUint16(p); p += 2; return map(v);
      case 0xdf: v = dv.getUint32(p); p += 4; return map(v);
      default:
        throw new Error('msgpack: bad byte 0x' + b.toString(16));
    }
  }
  return read();
}

// Async iterator over frames: [uint32 BE length][msgpack payload]...
export async function* decodeStreamFrames(reader, initial = new Uint8Array(0)) {
  let buf = initial;
  const append = (chunk) => {
    const n = new Uint8Array(buf.length + chunk.length);
    n.set(buf);
    n.set(chunk, buf.length);
    buf = n;
  };
  for (let first = true; ; first = false) {
    const { value, done } = first && buf.length ? { value: null, done: false } : await reader.read();
    if (value) append(value);
    for (;;) {
      if (buf.length < 4) break;
      const len = new DataView(buf.buffer, buf.byteOffset).getUint32(0);
      if (buf.length < 4 + len) break;
      const frame = buf.subarray(4, 4 + len);
      yield decode(frame);
      buf = buf.slice(4 + len);
    }
    if (done) break;
  }
}
