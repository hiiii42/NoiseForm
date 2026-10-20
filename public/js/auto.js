// Auto-generate: keep generating (continuous) or regenerate after each edit (on change),
// with a guard that stops before anything would cost Anlas.
import { $, sleep } from './util.js';
import { state, on, set } from './store.js';
import { bindCopy, getLang, t } from './i18n.js';
import { freeBlockers as panelFreeBlockers } from './ui/panel.js';
import { toast } from './ui/modal.js';
import { notifyAlert, setNotify, notifySupported } from './notify.js';
import { toggleLoop, paintAutoButton, queueRunning, setAutoRunningQuery } from './queue.js';

// toast + system notification when the user is away
const stopped = (msg, type = 'err', ms) => (toast(msg, type, ms), notifyAlert(msg));

let deps = null; // { generate(): Promise<{ok, err}> }
const run = { on: false, done: 0, target: Infinity, stopReq: false, lastSig: null, lastEdit: 0 };

setAutoRunningQuery(() => run.on);

const zh = () => getLang() === 'zh';

// Why the next generation would not be free (empty array = free). ctx = queued snapshot, default = editor.
export const freeBlockers = (ctx) => panelFreeBlockers(ctx);

function signature() {
  const { seed, seedLocked, ...p } = state.params;
  return JSON.stringify([p, seed || null, !!state.base, state.base?.strength, state.base?.mask?.length, state.vibes.map((v) => [v.enabled, v.ie, v.strength]), (state.refs || []).map((r) => [r.type, r.strength, r.fidelity])]);
}

export function initAuto(d) {
  deps = d;
  const s = state.settings;
  const mode = $('#autoMode');
  const paintMode = () => {
    for (const b of mode.querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.v === (s.autoMode || 'loop'));
      bindCopy(b, 'title', () => (b.dataset.v === 'change'
          ? zh() ? '改动后：编辑区就是批量，停手约 1 秒自动生成一张，适合边改边看' : 'On change: the editor is live; one image ~1s after each edit'
          : zh() ? '连续：把当前参数锁定成一个批量放进队列，编辑区可以随便改' : 'Continuous: locks the current settings into a queued batch; keep editing freely'));
    }
  };
  mode.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (run.on || queueRunning()) return toast(() => (zh() ? '先停止正在运行的自动生成 / 队列' : 'Stop the running auto / queue first'), 'warn');
    set('settings.autoMode', b.dataset.v);
    paintMode();
    paintBtn();
  };
  const count = $('#autoCount');
  count.value = String(s.autoCount ?? 0);
  count.onchange = () => set('settings.autoCount', Number(count.value));
  const free = $('#autoFree');
  free.checked = s.autoFreeOnly !== false;
  free.onchange = () => set('settings.autoFreeOnly', free.checked);
  $('#btnAuto').onclick = toggleAuto;
  const generate = $('#btnGenerate');
  bindCopy(generate, 'title', () => (t('gen.tip')));
  let holdTimer;
  let flashTimer;
  let clickTimer;
  let pointerId = null;
  let suppressClick = false;
  const endHold = (event) => {
    if (event?.pointerId != null && event.pointerId !== pointerId) return;
    clearTimeout(holdTimer);
    generate.classList.remove('holding');
    // Leaving cancels an unfinished hold; a completed hold still owns its release click.
    if (event?.type === 'pointerleave' || event?.type === 'pointermove') return;
    pointerId = null;
    // The native click follows pointerup in the same turn; do not eat a later key/click.
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { suppressClick = false; }, 0);
  };
  generate.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0 || generate.disabled || pointerId !== null) return;
    clearTimeout(clickTimer);
    clearTimeout(flashTimer);
    suppressClick = false;
    pointerId = event.pointerId;
    generate.classList.remove('hold-fired');
    generate.classList.add('holding');
    holdTimer = setTimeout(() => {
      generate.classList.remove('holding');
      if (generate.disabled) return;
      suppressClick = true;
      generate.classList.add('hold-fired');
      flashTimer = setTimeout(() => generate.classList.remove('hold-fired'), 240);
      toggleAuto();
    }, 600);
  });
  generate.addEventListener('pointerleave', endHold);
  generate.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    const r = generate.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) endHold(event);
  });
  window.addEventListener('pointerup', endHold, true);
  window.addEventListener('pointercancel', endHold, true);
  window.addEventListener('blur', () => endHold());
  document.addEventListener('visibilitychange', () => { if (document.hidden) endHold(); });
  generate.addEventListener('contextmenu', (event) => {
    if (pointerId !== null || suppressClick) event.preventDefault();
  });
  generate.addEventListener('click', (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  const bell = $('#btnNotify');
  const paintBell = () => {
    const on_ = !!s.notify && notifySupported() && Notification.permission === 'granted';
    bell.classList.toggle('on', on_);
    bindCopy(bell, 'title', () => (zh()
      ? (on_ ? '后台完成时弹系统通知：已开启' : '后台完成时弹系统通知：已关闭') + '（标签页标题总会显示未查看数量）'
      : (on_ ? 'System notification when done in the background: on' : 'System notification when done in the background: off') + ' (the tab title always shows a count)'));
  };
  bell.onclick = async () => {
    await setNotify(!bell.classList.contains('on'));
    paintBell();
  };
  paintBell();
  on(['params', 'base', 'vibes', 'refs'], () => (run.lastEdit = Date.now()));
  paintMode();
  paintBtn();
  on('settings.lang', () => { paintMode(); paintBell(); paintBtn(); });
}

export const autoRunning = () => run.on;

// The auto button: "continuous" runs the queue, "on change" runs the live loop below.
export function toggleAuto() {
  if ((state.settings.autoMode || 'loop') === 'loop') return toggleLoop();
  return run.on ? stopAuto() : startAuto();
}

function paintBtn() {
  if ((state.settings.autoMode || 'loop') === 'loop' && !run.on) return paintAutoButton();
  const b = $('#btnAuto');
  b.classList.toggle('on', run.on);
  $('.gen-dock').classList.toggle('auto-on', run.on);
  const tgt = run.target === Infinity ? (zh() ? '无限' : '∞') : run.target;
  bindCopy(b.querySelector('b'), 'textContent', () => (run.on ? `■ ${zh() ? '停止' : 'STOP'} ${run.done}/${tgt}` : zh() ? '自动生成' : 'AUTO'));
}

export async function startAuto() {
  if (run.on) return;
  if (queueRunning()) return toast(() => (zh() ? '队列正在运行，请先暂停' : 'The queue is running — pause it first'), 'warn');
  const n = Number(state.settings.autoCount || 0);
  Object.assign(run, { on: true, done: 0, target: n > 0 ? n : Infinity, stopReq: false, lastSig: null });
  paintBtn();
  const mode = 'change'; // "continuous" is the queue (queue.js)
  let fails = 0;
  try {
    while (!run.stopReq && run.done < run.target) {
      if (mode === 'change' && run.lastSig !== null) {
        // wait for an edit, then for ~1s of quiet
        while (!run.stopReq && (signature() === run.lastSig || Date.now() - run.lastEdit < 1000 || state.session.generating)) await sleep(150);
        if (run.stopReq) break;
      }
      while (state.session.generating && !run.stopReq) await sleep(150);
      if (run.stopReq) break;
      if (state.settings.autoFreeOnly !== false) {
        const why = freeBlockers();
        if (why.length) {
          stopped((zh() ? '自动生成已停止 — 本次不免费：\n· ' : 'Auto stopped — not free:\n· ') + why.join('\n· '), 'warn', 8000);
          break;
        }
      }
      run.lastSig = signature();
      const res = await deps.generate({ quiet: true });
      if (res?.ok) {
        run.done++;
        fails = 0;
        paintBtn();
        if (mode === 'loop') await sleep(1000);
        continue;
      }
      const st = res?.err?.status;
      if (res?.skipped) break;
      if (res?.stage === 'persist' || res?.err?.unknown) {
        stopped((zh() ? '自动生成已停止：' : 'Auto stopped: ') + res.err.message, 'warn', 8000);
        break;
      }
      if (st === 401 || st === 402 || st === 403) {
        stopped((zh() ? '自动生成已停止：' : 'Auto stopped: ') + res.err.message);
        break;
      }
      fails++;
      if (st === 429 && fails <= 6) {
        const wait = 3000 * fails;
        toast(() => (zh() ? `服务器繁忙（429），${wait / 1000}s 后重试…` : `Busy (429), retrying in ${wait / 1000}s…`), 'warn', wait);
        await sleep(wait);
        run.lastSig = null;
        continue;
      }
      if (fails >= 2 || st === 400) {
        stopped((zh() ? '自动生成已停止：' : 'Auto stopped: ') + (res?.err?.message || 'error'));
        break;
      }
      run.lastSig = null;
      await sleep(1500);
    }
    if (run.done >= run.target) stopped(zh() ? `自动生成完成：共 ${run.done} 张` : `Auto finished: ${run.done} images`, 'ok');
  } finally {
    run.on = false;
    paintBtn();
  }
}

export function stopAuto() {
  if (!run.on) return;
  run.stopReq = true;
  const b = $('#btnAuto');
  bindCopy(b.querySelector('b'), 'textContent', () => (zh() ? '正在停止…' : 'STOPPING…'));
}
