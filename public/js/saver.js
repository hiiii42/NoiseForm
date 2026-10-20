import { t } from './i18n.js';
// Save-to-disk via the File System Access API (Chromium). The chosen directory handle is
// persisted in IndexedDB so saved-file existence can be verified across sessions.
import { kv } from './db.js';
import { pad, slugify } from './util.js';

export const folderSupported = () => 'showDirectoryPicker' in window;

let dir = null;
let loaded = false;

export async function getDir() {
  if (!loaded) {
    loaded = true;
    dir = (await kv.get('saveDir').catch(() => null)) || null;
  }
  return dir;
}

export async function pickDir() {
  const d = await window.showDirectoryPicker({ id: 'noiseform', mode: 'readwrite', startIn: 'pictures' });
  dir = d;
  loaded = true;
  await kv.set('saveDir', d);
  return d;
}

export async function clearDir() {
  dir = null;
  await kv.delete('saveDir');
}

// interactive=true may show the browser permission prompt (needs a user gesture).
export async function ensurePermission(d, interactive) {
  if (!d) return false;
  const opts = { mode: 'readwrite' };
  if ((await d.queryPermission(opts)) === 'granted') return true;
  if (!interactive) return false;
  return (await d.requestPermission(opts)) === 'granted';
}

// Plain existence check. Reliability comes from the name: fileNameFor() embeds the record id, so the
// name main.saveRecord computes for an unsaved record can only exist if this record wrote it; a saved
// record checks the exact name it recorded itself (legacy names included, so cleanup keeps working).
export async function fileExists(d, name) {
  if (!name) return false;
  try {
    await d.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

export async function writeFile(d, name, blob) {
  const fh = await d.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}

export function fileNameFor(rec) {
  if (typeof rec.id !== 'string' || !rec.id) throw new Error(t('copy.saver.0'));
  // App ids (util.uid) are short lowercase base36 and are used as-is. Anything else is hex-encoded per
  // UTF-16 unit behind "h-" (never produced by a raw id): no truncation, case-folding collisions or unsafe characters.
  let id = '';
  if (/^[a-z0-9]{1,40}$/.test(rec.id)) id = rec.id;
  else {
    id = 'h-';
    for (let i = 0; i < rec.id.length; i++) id += rec.id.charCodeAt(i).toString(16).padStart(4, '0');
  }
  const ext = rec.blob?.type === 'image/webp' ? 'webp' : rec.blob?.type === 'image/jpeg' ? 'jpg' : 'png';
  const base = rec.kind === 'gen' || !rec.kind ? '' : slugify(String(rec.kind), 16) + '_';
  const name = `${slugify(pad(rec.no || 0, 4), 12)}_${base}${slugify(String(rec.params?.prompt || rec.kind || 'image'), 40)}_${slugify(String(rec.seed ?? 'x'), 16)}_${id}.${ext}`;
  if (name.length > 255) throw new Error(t('copy.saver.1'));
  return name;
}
