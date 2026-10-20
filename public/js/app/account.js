// Connection identity and account display.
import { $ } from '../util.js';
import { state, emit } from '../store.js';
import { bindCopy, t, getLang } from '../i18n.js';
import * as nai from '../nai.js';
import { toast } from '../ui/modal.js';
import * as stats from '../stats.js';

function refreshLive() {
  state.session.connection = nai.connectionContext().identity;
  state.session.live = state.session.connection !== 'demo';
  const c = $('#conn');
  c.dataset.mode = state.session.live ? 'live' : 'demo';
  c.dataset.connection = state.session.connection;
  c.querySelector('b').textContent = state.session.live ? 'LIVE' : 'DEMO';
  bindCopy(c, 'title', () => (state.session.live ? 'NovelAI API · ' + state.session.connection : t('set.noToken')));
  emit('session.live');
}

async function refreshAccount() {
  const el = $('#anlas b');
  if (!state.session.live) {
    el.textContent = '—';
    state.session.tier = null;
    state.session.anlas = null;
    state.session.usage = null;
    renderQuota(null);
    return false;
  }
  try {
    const sub = await nai.subscription();
    Object.assign(state.session, { tier: sub.tier, active: sub.active, anlas: sub.anlas, usageNegative: sub.usageNegative, usage: sub.usage });
    stats.recordAccount({ anlas: sub.anlas, usage: sub.usage });
    el.textContent = sub.anlas.toLocaleString();
    renderQuota(sub.usage);
    emit('session.tier');
    return true;
  } catch (err) {
    el.textContent = '!';
    if (err.status === 401) toast(() => (t('err.auth')), 'err');
    return false;
  }
}

function renderQuota(u) {
  const q = $('#quota');
  q.hidden = !u;
  if (!u) return;
  const zh = getLang() === 'zh';
  q.dataset.state = u.empty ? 'empty' : u.low ? 'low' : 'ok';
  q.querySelector('.q-bar i').style.width = u.shown + '%';
  q.querySelector('b').textContent = (u.percent < 10 ? u.percent.toFixed(1) : Math.round(u.percent)) + '%';
  bindCopy(q.querySelector('small'), 'textContent', () => ('≈' + u.images + ((getLang() === 'zh') ? '张' : '')));
  const full = u.secPerPercent > 0 && u.percent < 100 ? ((100 - u.percent) * u.secPerPercent) / 3600 : 0;
  const fullTxt = full ? (full >= 48 ? (full / 24).toFixed(1) + ((getLang() === 'zh') ? ' 天' : ' d') : full.toFixed(1) + ((getLang() === 'zh') ? ' 小时' : ' h')) : '';
  const mins = Math.round(u.secPerPercent / 60);
  const lines = (getLang() === 'zh')
    ? [
        `Opus V5 免费生成额度：剩余 ${u.percent.toFixed(2)}%（约 ${u.images} 张）`,
        `回复速度：每天 +${u.perDay}%（约 ${u.imagesPerDay} 张），每 1% 约 ${mins} 分钟`,
        fullTxt ? `回满 100% 约需 ${fullTxt}` : '已满，超过 100% 时暂停回复',
        u.empty ? '额度已用尽：V5 生成将消耗 Anlas，V4.5 仍可免费' : '',
      ]
    : [
        `Opus V5 allowance: ${u.percent.toFixed(2)}% remaining (~${u.images} images)`,
        `Refills +${u.perDay}%/day (~${u.imagesPerDay} images), 1% every ~${mins} min`,
        fullTxt ? `Full in ~${fullTxt}` : 'Full — refill pauses above 100%',
        u.empty ? 'Used up: V5 costs Anlas until it refills; V4.5 is still free' : '',
      ];
  q.title = lines.filter(Boolean).join('\n');
}


export { refreshLive, refreshAccount, renderQuota };
