// @ts-check
// One-pass expansion, including legacy names with spaces. Definitions are explicit
// snapshots; callers decide how to load or persist their chunk library.
/** @param {string} text @param {{name:string, text:string}[]} rows */
export function chunkReferences(text, rows) {
  const legacy = rows.map((r) => r.name).filter((n) => /\s/u.test(n)).sort((a, b) => b.length - a.length);
  const refs = [];
  const re = /@([^\s,，]+)/gu;
  let m;
  while ((m = re.exec(text))) {
    const old = legacy.find((n) => text.startsWith(n, m.index + 1) && (!text[m.index + 1 + n.length] || /[,，\r\n]/.test(text[m.index + 1 + n.length])));
    const name = old || m[1];
    const end = m.index + 1 + name.length;
    refs.push({ start: m.index, end, name });
    re.lastIndex = end;
  }
  return refs;
}
/** @param {string} text @param {{name:string, text:string}[]} rows */
export function expandChunks(text, rows) {
  let out = '', end = 0;
  for (const ref of chunkReferences(text, rows)) {
    out += text.slice(end, ref.start) + (rows.find((r) => r.name === ref.name)?.text ?? text.slice(ref.start, ref.end));
    end = ref.end;
  }
  return out + text.slice(end);
}
