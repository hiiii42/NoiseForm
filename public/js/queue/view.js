// Queue DOM, popover and editor diff strip. paint() isolates each rendering region.
import { $, h, icon, debounce } from '../util.js';
import { state, on, emit } from '../store.js';
import { bindCopy, getLang } from '../i18n.js';
import { toast, confirmDialog } from '../ui/modal.js';
import { setQuery } from '../ui/archive.js';
import { xyQueueCopy } from '../ui/xy-copy.js';
import { total } from './policy.js';

const zh = () => getLang() === 'zh';
const T = (z, e) => (zh() ? z : e);
const fmtN = (n) => (n === Infinity ? '∞' : n);

// ---------------------------------------------------------------- diff helpers
const tagList = (s) => (s || '').split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
export function promptDiff(a, b) {
  const A = new Set(tagList(a));
  const B = new Set(tagList(b));
  return { add: [...B].filter((t) => !A.has(t)), rem: [...A].filter((t) => !B.has(t)) };
}
const charSig = (p) => JSON.stringify((p.characters || []).map((c) => [c.prompt, c.uc, c.x, c.y, c.enabled]));
const SKIP = new Set(['prompt', 'uc', 'characters', 'seed', 'seedLocked', 'sizePreset', 'nSamples', 'width', 'height']);
// differences between two param sets, prompt as tags, the rest as short labels
export function paramDiff(a, b) {
  const d = promptDiff(a.prompt, b.prompt);
  const other = [];
  if ((a.uc || '') !== (b.uc || '')) other.push(T('负面提示词', 'UC'));
  if (charSig(a) !== charSig(b)) other.push(T('角色', 'characters'));
  if (a.width !== b.width || a.height !== b.height) other.push(`${a.width}×${a.height} → ${b.width}×${b.height}`);
  if (String(a.seed || '') !== String(b.seed || '')) other.push(T('种子', 'seed'));
  const named = { steps: T('步数', 'steps'), scale: 'CFG', sampler: T('采样器', 'sampler'), cfgRescale: T('重缩放', 'rescale'), model: T('模型', 'model') };
  let misc = false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (SKIP.has(k) || JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
    if (named[k]) other.push(`${named[k]} ${a[k]} → ${b[k]}`);
    else misc = true;
  }
  if (misc) other.push(T('其他参数', 'other settings'));
  return { ...d, other, n: d.add.length + d.rem.length + other.length };
}
export function createQueueView({ Q, R, getDeps, commands }) {
  const { enqueue, endJob, runQueue, pauseQueue, applyToRunning, move, removeEntry, clearHistory } = commands;

  function seedLabel(j) {
    if (j.kind === 'tiled') return T('分块种子', 'tile seeds');
    if (j.kind === 'xy') return T('网格种子', 'grid seeds');
    if (j.seedMode === 'fixed') return T('固定 ', 'fixed ') + j.snap.params.seed;
    if (j.seedMode === 'prev' || j.seedMode === 'job') {
      const src = j.srcNo ? '#' + j.srcNo : j.seedMode === 'prev' ? '' : '#' + (Q.history.find((x) => x.id === j.seedFrom)?.no ?? '?');
      return (src ? T(`沿用 ${src} 的种子`, `seeds of ${src}`) : T('沿用上一批的种子', 'previous batch’s seeds')) + (j.srcSeeds ? ` (${Math.min(j.srcSeeds.length, total(j))})` : '');
    }
    return T('随机', 'random');
  }

  function diffChips(d, max = 8) {
    const out = [...d.add.map((t) => h('span', { class: 'dtag add' }, '+' + t)), ...d.rem.map((t) => h('span', { class: 'dtag rem' }, '−' + t)), ...d.other.map((t) => h('span', { class: 'dtag oth' }, t))];
    return out.length > max ? [...out.slice(0, max), h('span', { class: 'dtag oth' }, '+' + (out.length - max))] : out;
  }

  // ---------------------------------------------------------------- lock strip (above the editors)
  let stripSig = '';
  const mainJob = () => Q.jobs.find((j) => j.kind !== 'oneoff') || null;
  function paintStrip() {
    const el = $('#lockStrip');
    if (!el) return;
    const job = mainJob();
    // shown while a batch runs, and while one waits (paused) — so edits made during a pause are not a surprise on resume
    const show = job && job.kind === 'batch' && (R.running || Q.jobs.length > 0);
    el.hidden = !show;
    if (!show) return (stripSig = '');
    const paused = !R.running;
    const d = paramDiff(job.snap.params, state.params);
    const sig = JSON.stringify([job.id, job.done, d, zh(), paused]);
    if (sig === stripSig) return;
    stripSig = sig;
    const head = [h('i', { class: 'ls-dot' + (paused ? ' paused' : '') }), h('b', {}, () => (`${T('批量', 'Batch')} #${job.no}`)), h('span', { class: 'mono ls-n' }, `${job.done}/${fmtN(total(job))}`)];
    if (!d.n) {
      el.className = 'lock-strip' + (paused ? ' paused' : '');
      el.replaceChildren(...head, h('span', { class: 'ls-t' }, () => (paused ? T('已暂停 · 参数已锁定，「继续队列」接着跑', 'Paused · settings locked, Resume continues it') : T('参数已锁定 · 编辑区的改动不影响它', 'Settings locked · edits don’t affect it'))));
      return;
    }
    el.className = 'lock-strip diff' + (paused ? ' paused' : '');
    el.replaceChildren(
      h('div', { class: 'ls-row' }, ...head, h('span', { class: 'ls-t' }, () => (T('编辑区不同：', 'Editor differs:'))), ...diffChips(d, 6)),
      h(
        'div',
        { class: 'ls-row' },
        h('button', { class: 'btn sm solid', onclick: applyToRunning, title: () => (T('当前这张之后，这个批量改用编辑区的参数', 'From the next image, this batch uses the editor settings')) }, () => (paused ? T('继续时应用', 'Apply on resume') : T('下一张起应用', 'Apply from next'))),
        h('button', { class: 'btn sm', onclick: () => (enqueue(getDeps().snapshot()), toast(() => (T('已加入队列', 'Queued')), 'ok', 2000)), title: () => (T('当前批量跑完后再跑编辑区的版本', 'Run the editor version after this batch')) }, () => (T('跑完再排队', 'Queue after'))),
        h('button', { class: 'btn sm ghost', onclick: () => getDeps().applySnapshot(job.snap), title: () => (T('把编辑区恢复成这个批量的参数', 'Load this batch’s settings back into the editor')) }, () => (T('还原', 'Revert')))
      )
    );
  }
  // ---------------------------------------------------------------- auto button / queue button
  function paintAutoButton() {
    const b = $('#btnAuto');
    if (!b || (state.settings.autoMode || 'loop') !== 'loop') return;
    const job = mainJob() || Q.jobs[0];
    b.classList.toggle('on', R.running);
    $('.gen-dock').classList.toggle('auto-on', R.running);
    let label;
    if (R.running && R.stopReq) label = T('正在暂停…', 'PAUSING…');
    else if (R.running && job) label = `■ ${T('暂停', 'PAUSE')} ${job.done}/${fmtN(total(job))}`;
    else if (Q.jobs.length) label = `▶ ${T('继续队列', 'RESUME')} · ${Q.jobs.length}`;
    else label = T('自动生成', 'AUTO');
    b.querySelector('b').textContent = label;
    bindCopy(b, 'title', () => (R.running ? T('当前这张完成后暂停（Ctrl+Shift+Enter）', 'Pause after the current image (Ctrl+Shift+Enter)') : Q.jobs.length ? T('继续跑队列里的批量', 'Resume the queued batches') : T('把编辑区的参数锁定成一个批量并开始（Ctrl+Shift+Enter）', 'Lock the editor settings into a batch and start (Ctrl+Shift+Enter)')));
  }
  function paintQueueBtn() {
    const b = $('#btnQueue');
    if (!b) return;
    b.querySelector('.q-n').textContent = Q.jobs.length ? String(Q.jobs.length) : '';
    b.classList.toggle('on', R.running);
    const seed = $('#btnSeedPrev');
    if (seed) {
      seed.classList.toggle('on', !!state.settings.queueSeedPrev);
      seed.setAttribute('aria-pressed', String(!!state.settings.queueSeedPrev));
    }
  }

  let pop = null;
  let tab = 'queue';
  // A rendering error must never reach the runner or enqueue (it used to leave R.running stuck = frozen queue).
  const safe = (fn) => {
    try {
      fn();
    } catch (err) {
      console.error('[queue] paint', err);
    }
  };
  function paint() {
    safe(paintAutoButton);
    safe(paintQueueBtn);
    safe(paintStrip);
    if (pop) safe(paintPop);
  }
  function jobCard(j, i, list, isHistory) {
    // diff against the batch that runs before it (cut-ins don't count)
    const before = isHistory ? list.slice(i + 1) : list.slice(0, i).reverse();
    const prev = j.kind === 'oneoff' ? null : before.find((x) => x.kind !== 'oneoff') || null;
    const d = prev && prev.snap && j.snap ? paramDiff(prev.snap.params, j.snap.params) : null;
    const kindL = j.kind === 'tiled' ? T('分块放大', 'TILED') : j.kind === 'xy' ? 'X/Y' : j.kind === 'oneoff' ? T('插队', 'CUT-IN') : T('批量', 'BATCH');
    const stL = { queued: j.done ? T('等待中', 'waiting') : T('排队', 'queued'), running: T('运行中', 'running'), paused: T('已暂停', 'paused'), done: T('完成', 'done'), stopped: T('已结束', 'ended'), failed: T('失败', 'failed') }[j.status] || j.status;
    const running = !isHistory && R.running && R.cur === j.id;
    const t = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const acts = [];
    if (j.snap?.params) acts.push(h('button', { class: 'btn sm ghost', title: () => (T('把这个批量的参数载入编辑区', 'Load its settings into the editor')), onclick: () => getDeps().applySnapshot(j.snap) }, () => (T('载入', 'Load'))));
    if (isHistory) {
      if (j.kind === 'batch' && j.seeds.length) acts.push(h('button', { class: 'btn sm ghost', title: () => (T('用编辑区的提示词、这一批的种子再排一批', 'Queue the editor prompt with this batch’s seeds')), onclick: () => (enqueue(getDeps().snapshot(), { seedFrom: j.id, count: j.seeds.length }), toast(() => (T(`已排队：沿用 #${j.no} 的 ${j.seeds.length} 个种子`, `Queued with #${j.no}’s ${j.seeds.length} seeds`)), 'ok', 2600)) }, icon('seed'), () => (T('同种子排队', 'Same seeds'))));
      if (j.recs.length) acts.push(h('button', { class: 'btn sm ghost', title: () => (T('在档案栏只显示这一批', 'Show only this batch in the archive')), onclick: () => (closeQueue(), setQuery('job:' + j.no)) }, icon('search'), () => (T('看图', 'Images'))));
      acts.push(h('button', { class: 'btn sm sq ghost', 'aria-label': () => (T('删除记录', 'Remove')), title: () => (T('删除这条记录（图片保留）', 'Remove the entry (images stay)')), onclick: () => removeEntry(j, true) }, icon('close')));
    } else {
      if (i > 0 && !running) acts.push(h('button', { class: 'btn sm sq ghost', 'aria-label': () => (T('上移', 'Up')), onclick: () => move(i, -1) }, icon('up')));
      if (i < list.length - 1 && !running) acts.push(h('button', { class: 'btn sm sq ghost', 'aria-label': () => (T('下移', 'Down')), onclick: () => move(i, 1) }, icon('down')));
      acts.push(
        h('button', {
          class: 'btn sm ghost danger',
          title: () => (running ? T('当前这张完成后结束，移到历史', 'End after the current image (moves to history)') : T('从队列移除', 'Remove from the queue')),
          onclick: async () => {
            if (j.kind === 'tiled' || j.done > 0 || running) endJob(j.id);
            else removeEntry(j, false);
          },
        }, () => (running || j.done > 0 ? T('结束', 'End') : T('移除', 'Remove')))
      );
    }
    const pct = total(j) === Infinity ? 0 : Math.round((j.done / total(j)) * 100);
    return h(
      'div',
      { class: 'qj' + (running ? ' run' : '') + (j.status === 'failed' ? ' failed' : '') },
      h('div', { class: 'qj-h' }, h('b', { class: 'mono' }, `#${j.no}`), h('span', { class: 'qj-k mono' }, kindL), h('span', { class: 'qj-s' + (running ? ' on' : '') }, stL), h('span', { class: 'sp' }), h('span', { class: 'mono qj-n' }, `${j.done}/${fmtN(total(j))}`)),
      total(j) !== Infinity && !isHistory ? h('div', { class: 'qj-bar' }, h('i', { style: { width: pct + '%' } })) : null,
      h('div', { class: 'qj-m mono' }, h('span', {}, icon('seed'), seedLabel(j)), isHistory ? h('span', {}, () => (t(j.createdAt) + (j.finishedAt ? '–' + t(j.finishedAt) : ''))) : null, j.reason ? h('span', { class: 'qj-err', title: j.reason }, j.reason) : null),
      d && d.n ? h('div', { class: 'qj-d' }, ...diffChips(d)) : null,
      j.kind === 'xy' ? h('div', { class: 'qj-p mono' }, xyQueueCopy(j.label)) : h('div', { class: 'qj-p mono', title: j.snap?.params?.prompt || '' }, () => (j.snap?.params?.prompt || T('（空）', '(empty)'))),
      h('div', { class: 'qj-a' }, ...acts)
    );
  }
  function paintPop() {
    const tabs = h(
      'div',
      { class: 'qp-tabs', role: 'tablist' },
      ...[['queue', T('队列', 'Queue') + (Q.jobs.length ? ` ${Q.jobs.length}` : '')], ['history', T('历史', 'History') + (Q.history.length ? ` ${Q.history.length}` : '')]].map(([k, l]) =>
        h('button', { role: 'tab', 'aria-selected': String(tab === k), class: tab === k ? 'on' : '', onclick: () => ((tab = k), paintPop()) }, l)
      )
    );
    const ctl = h(
      'div',
      { class: 'qp-ctl' },
      R.running
        ? h('button', { class: 'btn sm', onclick: pauseQueue }, () => (R.stopReq ? T('正在暂停…', 'Pausing…') : '■ ' + T('暂停', 'Pause')))
        : h('button', { class: 'btn sm solid', disabled: !Q.jobs.length, onclick: runQueue }, () => ('▶ ' + T('开始', 'Run'))),
      h('button', { class: 'btn sm', title: () => (T('把编辑区当前的参数加入队列末尾', 'Add the editor settings to the end')), onclick: () => enqueue(getDeps().snapshot()) }, icon('plus'), () => (T('加入编辑区', 'Add editor'))),
      h('span', { class: 'sp' }),
      tab === 'history' && Q.history.length
        ? h('button', { class: 'btn sm ghost', onclick: async () => (await confirmDialog(() => (T('清空队列历史？（图片不受影响）', 'Clear the queue history? (images stay)'))) && clearHistory()) }, () => (T('清空', 'Clear')))
        : null
    );
    const list = tab === 'queue' ? Q.jobs : Q.history;
    const body = list.length
      ? list.map((j, i) => {
          try {
            return jobCard(j, i, list, tab === 'history');
          } catch (err) {
            console.error('[queue] card', err, j);
            return h('div', { class: 'qj failed' }, h('div', { class: 'qj-h' }, h('b', { class: 'mono' }, '#' + (j?.no ?? '?')), h('span', { class: 'qj-s' }, () => (T('记录损坏', 'damaged entry'))), h('span', { class: 'sp' }), h('button', { class: 'btn sm ghost', onclick: () => removeEntry(j, tab === 'history') }, () => (T('删除', 'Remove')))));
          }
        })
      : [h('p', { class: 'hint qp-empty' }, () => (tab === 'queue' ? T('队列为空。按「自动生成」或「加入编辑区」，当前参数会被锁定成一个批量。', 'Empty. “Auto” or “Add editor” locks the current settings into a batch.') : T('还没有跑完的批量。', 'No finished batches yet.')))];
    const scroll = pop.querySelector('.qp-list');
    const top = scroll ? scroll.scrollTop : 0;
    // Move the existing bell before replacing the header, preserving initAuto's listeners.
    const head = h('header', {}, h('span', { class: 'st-t' }, () => (T('队列', 'QUEUE'))), tabs);
    const bell = $('#btnNotify');
    if (bell) head.appendChild(bell);
    pop.replaceChildren(head, ctl, h('div', { class: 'qp-list' }, ...body));
    pop.querySelector('.qp-list').scrollTop = top;
  }
  function toggleQueue(anchor) {
    if (pop) return closeQueue();
    pop = h('div', { class: 'queue-pop', role: 'dialog', 'aria-label': () => (T('生成队列', 'Generation queue')) });
    document.body.append(pop);
    paintPop();
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.left)) + 'px';
    pop.style.bottom = Math.max(8, innerHeight - r.top + 8) + 'px';
    setTimeout(() => document.addEventListener('pointerdown', outside, true));
    document.addEventListener('keydown', esc, true);
  }
  function outside(e) {
    if (pop && !pop.contains(e.target) && !e.target.closest('#btnQueue, .modal-bg, .toast')) closeQueue();
  }
  function esc(e) {
    if (e.key === 'Escape' && pop && !document.querySelector('.modal-bg')) (e.stopPropagation(), closeQueue());
  }
  function closeQueue() {
    const bell = pop?.querySelector('#btnNotify');
    if (bell) $('#notifyHome').appendChild(bell);
    pop?.remove();
    pop = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', esc, true);
  }

  // ---------------------------------------------------------------- init
  function init() {
    const qb = $('#btnQueue');
    if (qb) qb.onclick = (e) => toggleQueue(e.currentTarget);
    const sb = $('#btnSeedPrev');
    if (sb)
      sb.onclick = () => {
        state.settings.queueSeedPrev = !state.settings.queueSeedPrev;
        emit('settings.queueSeedPrev');
        toast(() => (state.settings.queueSeedPrev ? T('新批量沿用上一批的种子（第 N 张 = 上一批第 N 张）', 'New batches reuse the previous batch’s seeds (image N = its image N)') : T('新批量使用随机种子', 'New batches use random seeds')), 'ok', 2600);
        paint();
      };
    const repaintStrip = debounce(paintStrip, 120);
    on(['params', 'base', 'vibes', 'refs'], repaintStrip);
    on(['settings.lang', 'settings.autoFreeOnly', 'settings.autoMode', 'settings.queueSeedPrev'], () => ((stripSig = ''), paint()));
    paint();
  }
  return { init, paint, seedLabel, paintAutoButton, toggleQueue, closeQueue };
}
