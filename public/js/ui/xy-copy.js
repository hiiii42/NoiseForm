// Presentation only: old grids/queue entries store generated axis captions.
// Translate their fixed UI fragments without changing stored tags or parameters.
import { getLang } from '../i18n.js';

const names = [
  ['有 / 无', 'with / without'], ['权重', 'weight'], ['替换', 'replace'],
  ['插入', 'insert'], ['步数', 'steps'], ['CFG', 'CFG'],
  ['引导重缩放', 'CFG rescale'], ['采样器', 'sampler'], ['种子', 'seed'],
];
export function xyAxisCopy(name = '') {
  const i = getLang() === 'zh' ? 0 : 1;
  for (const pair of names) {
    if (pair.includes(name)) return pair[i];
    for (const old of pair) {
      // A tag axis always has this delimiter; leave the tag itself untouched.
      if (name.endsWith(' · ' + old)) return name.slice(0, -old.length) + pair[i];
    }
  }
  const before = name.match(/^(?:插入（(.*) 前）|insert \(before (.*)\))$/);
  if (before) return i === 0 ? `插入（${before[1] ?? before[2]} 前）` : `insert (before ${before[1] ?? before[2]})`;
  if (name === '插入（开头）' || name === 'insert (at start)') return i === 0 ? '插入（开头）' : 'insert (at start)';
  return name;
}
export function xyValueCopy(kind, label) {
  const zh = getLang() === 'zh';
  if (kind === 'steps') return label.replace(/^(\d+) (?:步|steps)$/, (_, n) => n + (zh ? ' 步' : ' steps'));
  if (kind === 'cfgRescale') return label.replace(/^(?:重缩放|rescale) /, zh ? '重缩放 ' : 'rescale ');
  if (kind === 'toggle') return label.replace(/^(有 |无 |with |without )/, s => ['有 ', 'with '].includes(s) ? (zh ? '有 ' : 'with ') : (zh ? '无 ' : 'without '));
  if (kind === 'insert' && ['（不加）', '(none)'].includes(label)) return zh ? '（不加）' : '(none)';
  return label;
}
export function xyQueueCopy(label = '') {
  if (!label.startsWith('X/Y · ')) return label;
  return 'X/Y · ' + label.slice(6).split(' × ').map(xyAxisCopy).join(' × ');
}
