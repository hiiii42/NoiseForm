// Archive search: `artist:wlop long hair model:v5 size:832x1216 seed:123 date:today is:star -smile`.
// Bare words match the prompt and character prompts; key:value terms match metadata; `-` negates.
// Unknown keys (artist:, rating:, …) are prompt text. Chinese words also match tags whose
// translation contains them (银发 → silver hair / grey hair …).
import { modelById } from './data.js';
import { tagDBReady, searchDB, lookup, aliasOf } from './tagdb.js';

const DAY = 86400000;
const startOfDay = (t = Date.now()) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const flat = (s) => (s || '').toLowerCase().replace(/[{}[\]]/g, ' ').replace(/-?\d+(?:\.\d+)?::|::/g, ' ').replace(/_/g, ' ').replace(/\s+/g, ' ');

const hay = new WeakMap();
function textOf(rec) {
  let t = hay.get(rec);
  if (!t) {
    const p = rec.params || {};
    const chars = (p.characters || []).map((c) => c.prompt).join(' , ');
    t = { prompt: ' ' + flat(p.prompt + ' , ' + chars) + ' ', uc: ' ' + flat(p.uc + ' , ' + (p.characters || []).map((c) => c.uc).join(' , ')) + ' ' };
    hay.set(rec, t);
  }
  return t;
}
// Chinese for every tag of the prompt (aliases resolve to their canonical tag's translation)
const zhHay = new WeakMap();
function zhOf(rec) {
  let z = zhHay.get(rec);
  if (z == null) {
    const p = rec.params || {};
    z = [p.prompt, ...(p.characters || []).map((c) => c.prompt)]
      .join(',')
      .split(/[,\n|]/)
      .map((x) => x.replace(/[{}[\]]|-?\d+(?:\.\d+)?::|::/g, '').replace(/^\s*artist:/i, '').trim())
      .filter(Boolean)
      .map((x) => (lookup(x) || aliasOf(x))?.zh || '')
      .join(' ');
    zhHay.set(rec, z);
  }
  return z;
}

function tokenize(q) {
  const out = [];
  const re = /(-?)(?:(\w+):)?(?:"([^"]*)"|(\S+))/g;
  let m;
  while ((m = re.exec(q))) {
    const neg = !!m[1];
    const key = (m[2] || '').toLowerCase();
    const val = (m[3] ?? m[4] ?? '').trim();
    if (!val && !key) continue;
    out.push({ neg, key, val, raw: (m[2] ? m[2] + ':' : '') + val });
  }
  return out;
}

function dateRange(v) {
  v = v.toLowerCase();
  const today = startOfDay();
  if (v === 'today' || v === '今天') return [today, today + DAY];
  if (v === 'yesterday' || v === '昨天') return [today - DAY, today];
  const rel = v.match(/^(\d+)d$/);
  if (rel) return [today - (+rel[1] - 1) * DAY, today + DAY];
  const m = v.match(/^(?:(\d{4})[-./])?(\d{1,2})[-./](\d{1,2})$/);
  if (m) {
    const y = m[1] ? +m[1] : new Date().getFullYear();
    const s = new Date(y, +m[2] - 1, +m[3]).getTime();
    return [s, s + DAY];
  }
  return null;
}

const num = (v) => Number(String(v).replace(/[^\d.]/g, ''));

// Returns (rec) => boolean, or null for an empty query.
export function compileQuery(q) {
  const terms = tokenize(q || '');
  if (!terms.length) return null;
  const tests = terms.map(({ neg, key, val, raw }) => {
    const v = val.toLowerCase();
    let f;
    switch (key) {
      case 'model':
      case 'm': {
        f = (r) => {
          const m = modelById(r.model || r.params?.model);
          return (m.id + ' ' + m.short + ' ' + (m.name || '')).toLowerCase().replace(/[\s-]+/g, '').includes(v.replace(/[\s-]+/g, ''));
        };
        break;
      }
      case 'seed':
        f = (r) => String(r.seed ?? '').startsWith(val);
        break;
      case 'no':
        f = (r) => r.no === num(val);
        break;
      case 'size': {
        const [w, h] = v.split(/[x×*]/).map(Number);
        f = (r) => (!w || r.width === w) && (!h || r.height === h);
        break;
      }
      case 'w':
      case 'width':
        f = (r) => r.width === num(val);
        break;
      case 'h':
      case 'height':
        f = (r) => r.height === num(val);
        break;
      case 'steps':
        f = (r) => r.params?.steps === num(val);
        break;
      case 'cfg':
      case 'scale':
        f = (r) => r.params?.scale === num(val);
        break;
      case 'sampler':
        f = (r) => (r.params?.sampler || '').toLowerCase().includes(v);
        break;
      case 'kind':
        f = (r) => (r.kind || '').toLowerCase().startsWith(v);
        break;
      case 'job':
      case 'batch':
      case '批量':
        f = (r) => !!r.job && String(r.job.no) === val.replace(/^#/, '');
        break;
      case 'date':
      case 'day': {
        const range = dateRange(val);
        f = range ? (r) => r.createdAt >= range[0] && r.createdAt < range[1] : () => false;
        break;
      }
      case 'is':
      case 'has':
        f = {
          star: (r) => r.flag === 1,
          starred: (r) => r.flag === 1,
          fav: (r) => r.flag === 1,
          收藏: (r) => r.flag === 1,
          reject: (r) => r.flag === -1,
          rejected: (r) => r.flag === -1,
          淘汰: (r) => r.flag === -1,
          saved: (r) => !!r.saved,
          已存: (r) => !!r.saved,
          unsaved: (r) => !r.saved,
          未存: (r) => !r.saved,
          demo: (r) => !!r.demo,
          xy: (r) => !!r.xy,
          tile: (r) => r.kind === 'tile',
          post: (r) => r.kind === 'post',
        }[v] || (() => false);
        break;
      case 'uc':
      case 'neg': {
        const needle = ' ' + flat(val).trim();
        f = (r) => textOf(r).uc.includes(needle);
        break;
      }
      default: {
        // prompt text (unknown keys such as artist: are part of the text)
        const needle = flat(raw).trim();
        const cjk = /[　-鿿]/.test(needle);
        const alts = [needle];
        if (cjk && tagDBReady()) for (const e of searchDB(needle, 24)) alts.push(flat(e.tag).trim());
        f = (r) => {
          const t = textOf(r).prompt;
          return alts.some((a) => t.includes(a)) || (cjk && tagDBReady() && zhOf(r).includes(needle));
        };
      }
    }
    return neg ? (r) => !f(r) : f;
  });
  return (r) => tests.every((f) => f(r));
}

export const SEARCH_HELP = [
  ['artist:wlop', '提示词包含（未知前缀按原文匹配）', 'prompt contains (unknown prefixes are text)'],
  ['"long hair"', '整段匹配', 'exact phrase'],
  ['银发', '中文匹配对应英文标签', 'Chinese → matching tags'],
  ['-smile', '排除', 'exclude'],
  ['uc:blurry', '负面提示词包含', 'undesired content contains'],
  ['model:v5', '模型', 'model'],
  ['size:832x1216', '尺寸', 'size'],
  ['seed:1234', '种子（前缀）', 'seed (prefix)'],
  ['steps:28  cfg:5', '步数 / 引导', 'steps / guidance'],
  ['date:today  date:7d  date:10-09', '日期', 'date'],
  ['is:star  is:reject  is:unsaved', '标记 / 保存状态', 'flag / saved state'],
  ['no:42', '编号', 'image number'],
  ['job:12', '队列里第 12 个批量出的图', 'images from queue batch #12'],
];
