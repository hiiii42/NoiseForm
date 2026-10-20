// Background completion signals: unseen-count + progress in the tab title, and (opt-in) system
// notifications while the tab is hidden or the window is unfocused. Auto runs coalesce into one
// notification that updates instead of stacking.
import { blobToDataURL } from './util.js';
import { state, set, on } from './store.js';
import { getLang, t } from './i18n.js';
import { toast } from './ui/modal.js';

let unseen = 0;
let prog = null; // 0..1 while generating in the background
let onOpen = null;
const away = () => document.hidden || !document.hasFocus();
const zh = () => getLang() === 'zh';

function paint() {
  const parts = [];
  if (prog != null && away()) parts.push(`▶ ${Math.round(prog * 100)}%`);
  if (unseen) parts.push(`(${unseen})`);
  const title = (parts.length ? parts.join(' ') + ' ' : '') + t('page.title');
  if (document.title !== title) document.title = title;
}

export function initNotify(opts) {
  onOpen = opts.open;
  on('settings.lang', paint);
  const back = () => {
    if (document.hidden) return;
    unseen = 0;
    paint();
  };
  document.addEventListener('visibilitychange', back);
  addEventListener('focus', back);
  addEventListener('blur', paint);
}

export function progressTitle(p) {
  const v = p == null ? null : Math.round(p * 100) / 100;
  if (v === prog) return;
  prog = v;
  paint();
}

export const notifySupported = () => 'Notification' in window;

// Turn system notifications on (asks for permission). Returns the final state.
export async function setNotify(on) {
  if (!on) return set('settings.notify', false), false;
  if (!notifySupported()) {
    toast(() => (zh() ? '此浏览器不支持系统通知，仍会在标签页标题显示计数。' : 'Notifications are not supported here — the tab title still shows a count.'), 'warn', 5000);
    return false;
  }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    toast(() => (zh() ? '浏览器拒绝了通知权限：请在地址栏左侧的站点设置里允许「通知」。' : 'Notification permission denied — allow it in the site settings next to the address bar.'), 'warn', 7000);
    set('settings.notify', false);
    return false;
  }
  set('settings.notify', true);
  return true;
}

// A notification that reuses a tag replaces the old one silently unless renotify is set; Windows then
// shows no banner at all (1.6 bug: only the first finish ever popped). Pop again at most every 15 s
// so an auto run updates one entry instead of flooding the screen.
const lastPop = new Map();
function system(title, body, { tag = 'nf-done', icon, id, force = false } = {}) {
  if ((!state.settings.notify && !force) || !notifySupported() || Notification.permission !== 'granted') return null;
  try {
    const now = Date.now();
    const renotify = now - (lastPop.get(tag) || 0) > 15000;
    if (renotify) lastPop.set(tag, now);
    const n = new Notification(title, { body, tag, icon, renotify, silent: !renotify });
    n.onclick = () => {
      window.focus();
      if (id) onOpen?.(id);
      n.close();
    };
    return n;
  } catch {
    return null;
  }
}

// Settings → "Send a test": shows one right away (no need to switch windows) so the user can tell
// whether the browser / OS lets notifications through.
export async function testNotify() {
  if (!(await setNotify(true))) return false;
  return !!system(zh() ? 'NOISEFORM · 测试通知' : 'NOISEFORM · test notification', zh() ? '看到这条说明后台提醒可以正常弹出。' : 'If you can see this, background alerts work.', { tag: 'nf-test-' + Date.now(), force: true });
}

// New images finished. recs: [{ id, no, thumb }]; label: e.g. "AUTO 3/10".
export async function notifyDone(recs, { label = '' } = {}) {
  if (!away() || !recs.length) return;
  unseen += recs.length;
  paint();
  const icon = recs[0].thumb ? await blobToDataURL(recs[0].thumb).catch(() => undefined) : undefined;
  const Z = zh();
  const title = (getLang() === 'zh') ? `生成完成 · ${unseen} 张未查看` : `Done · ${unseen} unseen`;
  const body = (label ? label + ' · ' : '') + ((getLang() === 'zh') ? `最新 №${String(recs[0].no).padStart(4, '0')}，点击查看` : `Latest №${String(recs[0].no).padStart(4, '0')} — click to view`);
  system(title, body, { icon, id: recs[0].id });
}

// Something needs attention (auto / grid stopped, error) while the user is away.
export function notifyAlert(msg) {
  if (!away()) return;
  paint();
  system(zh() ? 'NOISEFORM · 已停止' : 'NOISEFORM · stopped', msg, { tag: 'nf-alert' });
}
