// Builds public/data/tags.tsv from community datasets (repository root licenses are MIT; see
// THIRD_PARTY.md for data provenance and the parts whose licensing is not confirmed):
//   Mekulu/ComfyUI-Danbooru-Autocomplete  data/danbooru_tags.json   (tags, category, count, nsfw, zh)
//   byzod/a1111-sd-webui-tagcomplete-CN   tags/Tags-zh-full-pack.csv (curated zh, fallback)
//   DominikDoom/a1111-sd-webui-tagcomplete tags/danbooru.csv        (aliases)
// Usage: node tools/build-tags.mjs <mekulu.json> <byzod.csv> <tagcomplete.csv>
// Output line: tag \t category \t count \t zh \t alias,alias
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [mekPath, byzodPath, tcPath] = process.argv.slice(2);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const parseCSVLine = (line) => {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') out.push(cur), (cur = '');
    else cur += c;
  }
  out.push(cur);
  return out;
};
const clean = (s) => (s || '').replace(/[\t\r\n]/g, ' ').trim();

const tags = new Map();
for (const [name, cat, count, , zh] of JSON.parse(readFileSync(mekPath, 'utf8'))) {
  tags.set(name, { cat, count, zh: clean(zh), aliases: [] });
}

let filled = 0;
for (const line of readFileSync(byzodPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
  if (!line) continue;
  const [name, zh] = parseCSVLine(line);
  const t = tags.get(name);
  // only fill gaps; entries missing from the Danbooru dump are aliases or obsolete tags
  if (t && !t.zh && zh) (t.zh = clean(zh)), filled++;
}

let aliasCount = 0;
for (const line of readFileSync(tcPath, 'utf8').split(/\r?\n/)) {
  if (!line) continue;
  const [name, cat, count, aliases] = parseCSVLine(line);
  let t = tags.get(name);
  if (!t) {
    if (Number(count) < 50) continue;
    t = { cat: Number(cat), count: Number(count), zh: '', aliases: [] };
    tags.set(name, t);
  }
  if (aliases && t.count >= 100) {
    t.aliases = aliases.split(',').filter((a) => a && a !== name && !/^\//.test(a)).slice(0, 6);
    aliasCount += t.aliases.length;
  }
}

// NovelAI-specific meta / quality tags that are not on Danbooru.
const NAI = [
  ['very aesthetic', '非常美观（NAI 质量）'], ['aesthetic', '美观（NAI 质量）'], ['displeasing', '不美观（NAI 质量）'],
  ['very displeasing', '非常不美观（NAI 质量）'], ['masterpiece', '杰作（质量）'], ['best quality', '最佳质量'],
  ['amazing quality', '惊艳质量'], ['great quality', '优秀质量'], ['good quality', '良好质量'], ['normal quality', '普通质量'],
  ['bad quality', '低质量'], ['low quality', '低质量（旧写法）'], ['high quality', '高质量（旧写法）'], ['worst quality', '最差质量'], ['no text', '无文字'], ['rating:general', '分级：全年龄'],
  ['rating:sensitive', '分级：敏感'], ['rating:questionable', '分级：存疑'], ['rating:explicit', '分级：成人'],
  ['artistic error', '画面错误'], ['scan artifacts', '扫描瑕疵'], ['fur dataset', '兽人数据集（NAI）'],
  ['transparent background', '透明背景'], ['location', '场景'], ['negative space', '留白'], ['blank page', '空白页'],
  ['film grain', '胶片颗粒'], ['jpeg artifacts', 'JPEG 压缩痕迹'], ['too many watermarks', '过多水印'],
  ['multiple views', '多视图'], ['upscaled', '放大过的'], ['ai-generated', 'AI 生成'], ['white haze', '白色雾化'],
  ['sepia', '棕褐色调'], ['dithering', '抖动噪点'], ['screentone', '网点纸'],
];
for (let y = 2005; y <= 2026; y++) NAI.push([`year ${y}`, `${y} 年`]);
for (const [name, zh] of NAI) {
  const k = name.replace(/ /g, '_');
  const t = tags.get(k);
  if (t) t.zh = t.zh || zh;
  else tags.set(k, { cat: 5, count: 0, zh, aliases: [], nai: 1 });
}

const rows = [...tags].sort((a, b) => b[1].count - a[1].count);
const out = rows.map(([n, t]) => [n, t.cat, t.count, t.zh, t.aliases.join(',')].join('\t')).join('\n');
mkdirSync(join(root, 'public', 'data'), { recursive: true });
writeFileSync(join(root, 'public', 'data', 'tags.tsv'), out);
const withZh = rows.filter(([, t]) => t.zh).length;
console.log(`tags ${rows.length}, with zh ${withZh}, byzod fill ${filled}, aliases ${aliasCount}, bytes ${Buffer.byteLength(out)}`);
