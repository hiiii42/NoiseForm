// Settings, import and enhance dialogs + NovelAI metadata → params mapping.
import { h, icon, blobToDataURL, loadImage } from '../util.js';
import { exportReport } from '../diag.js';
import { state, emit, set, commit } from '../store.js';
import { bindCopy, t, getLang } from '../i18n.js';
import { MODELS, modelById, QUALITY_TAGS, SIZE_PRESETS } from '../data.js';
import { readNaiMetadata } from '../png.js';
import { sanitizeMetadata, modelFromSource } from '../importschema.js';
import { ucPresetsFor, generationCost, upstreamSetting } from '../nai.js';
import { openModal, toast } from './modal.js';
import { setNotify, notifySupported, testNotify } from '../notify.js';
import { appearanceControls } from '../themes.js';
import { chat, listModels, pickModel } from '../llm.js';

export async function downloadDiagnostics() {
  const report = await exportReport({
    pageVersion: document.querySelector('.brand-v')?.textContent.trim().replace(/^v/, ''),
    serverStale: state.session.serverStale, mode: state.settings.conn,
    identity: state.settings.token?.trim() ? 'browser-token' : state.session.serverToken ? 'server-token' : 'demo',
  });
  const date = new Date(), pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = `noiseform-diag-${stamp}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return report;
}

// ------------------------------------------------------------ settings
// OpenAI-compatible endpoint for the prompt assistant (ui/ideate.js)
function llmField(zh) {
  const c = { base: '', key: '', model: '', route: 'proxy', think: false, models: [], ...(state.settings.llm || {}) };
  const save = () => set('settings.llm', { ...c });
  const inp = (key, attrs) => {
    const i = h('input', { class: 'inp mono grow', value: c[key] || '', autocomplete: 'off', spellcheck: false, ...attrs });
    i.oninput = () => ((c[key] = i.value.trim()), save());
    return i;
  };
  const base = inp('base', { placeholder: 'https://api.deepseek.com' });
  const key = inp('key', { type: 'password', placeholder: 'sk-…' });
  const eye = h('button', { class: 'btn sq', title: () => (t('copy.ui.dialogs.0')), onclick: () => (key.type = key.type === 'password' ? 'text' : 'password') }, icon('eye'));
  const st = h('div', { class: 'status-line' });
  // model: a picker filled from the endpoint's /models (no model needed to fetch it); free text as a fallback
  const modelBox = h('div', { class: 'row gap grow llm-model' });
  const paintModel = () => {
    if (c.models?.length) {
      const sel = h('select', { class: 'sel grow mono' }, ...(c.models.includes(c.model) || !c.model ? [] : [h('option', { value: c.model }, c.model)]), ...c.models.map((m) => h('option', { value: m }, m)));
      sel.value = c.model || '';
      sel.onchange = () => ((c.model = sel.value), save(), quick());
      const other = h('button', { class: 'btn sq ghost', title: () => ((getLang() === 'zh') ? '手动输入模型名' : 'Type a model name'), onclick: () => ((c.models = []), save(), paintModel(), modelBox.querySelector('input')?.focus()) }, icon('edit'));
      modelBox.replaceChildren(sel, other);
    } else modelBox.replaceChildren(inp('model', { placeholder: () => ((getLang() === 'zh') ? '先点「获取模型」，或手动填写' : 'Press “Fetch models”, or type one') }));
  };
  const busy = (b, msg) => ((fetchBtn.disabled = b), (st.className = 'status-line'), bindCopy(st, 'textContent', typeof msg === 'function' ? msg : () => msg || ''));
  const noModels = () => getLang() === 'zh' ? '连上了，但接口没有列出模型，请手动填写模型名' : 'Connected, but no models were listed — type a model name';
  const fail = (err) => {
    const emptyList = err.message === noModels();
    st.className = 'status-line err';
    bindCopy(st, 'textContent', () => typeof err === 'function' ? err() : emptyList ? noModels() : err.message || String(err));
    fetchBtn.disabled = false;
  };
  // a tiny real request with the chosen model
  async function quick() {
    if (!c.model) return;
    busy(true, () => (getLang() === 'zh') ? `测试 ${c.model}…` : `Testing ${c.model}…`);
    const t0 = performance.now();
    try {
      await chat([{ role: 'user', content: 'Reply with the JSON object {"ok": true}.' }], { maxTokens: 64 });
      fetchBtn.disabled = false;
      st.className = 'status-line ok';
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      bindCopy(st, 'textContent', () => (((getLang() === 'zh') ? '可以用 · ' : 'Ready · ') + c.model + ` · ${elapsed}s`));
    } catch (err) {
      fail(err);
    }
  }
  const fetchBtn = h('button', { class: 'btn solid' }, () => ((getLang() === 'zh') ? '获取模型' : 'Fetch models'));
  fetchBtn.onclick = async () => {
    if (!c.base) return fail(() => (getLang() === 'zh') ? '先填接口地址' : 'Enter the endpoint first');
    busy(true, () => (getLang() === 'zh') ? '连接中…' : 'Connecting…');
    try {
      const r = await listModels();
      if (r.base !== c.base) ((c.base = r.base), (base.value = r.base));
      if (!r.models.length) throw new Error(noModels());
      c.models = r.models;
      if (!c.model || !r.models.includes(c.model)) c.model = pickModel(r.models);
      save();
      paintModel();
      await quick();
      if (st.className.endsWith('ok')) {
        const elapsedStatus = st.textContent;
        const timing = elapsedStatus.match(/ · ([\d.]+s)$/)?.[1] || '';
        bindCopy(st, 'textContent', () => (getLang() === 'zh' ? '可以用 · ' : 'Ready · ') + c.model + ` · ${timing}` + (getLang() === 'zh' ? ` · 共 ${r.models.length} 个模型` : ` · ${r.models.length} models`));
      }
    } catch (err) {
      fail(err);
      paintModel();
    }
  };
  base.addEventListener('change', () => ((c.models = []), save(), paintModel()));
  paintModel();
  const lw = (s) => h('span', { class: 't-label llm-l' }, s);
  const route = h(
    'div',
    { class: 'seg' },
    ...[['proxy', () => getLang() === 'zh' ? '经上游代理' : 'Via proxy'], ['direct', () => getLang() === 'zh' ? '直连' : 'Direct']].map(([v, l]) => {
      const b = h('button', { class: c.route === v ? 'on' : '', onclick: () => ((c.route = v), save(), [...b.parentNode.children].forEach((x) => x.classList.toggle('on', x === b))) }, l);
      return b;
    })
  );
  const think = h('input', { type: 'checkbox', checked: !!c.think });
  think.onchange = () => ((c.think = think.checked), save());
  return h(
    'div',
    { class: 'field' },
    h('span', { class: 't-label' }, () => ((getLang() === 'zh') ? 'AI 构思 · OpenAI 兼容接口' : 'AI assistant · OpenAI-compatible')),
    h('div', { class: 'row gap' }, lw(() => ((getLang() === 'zh') ? '地址' : 'Base')), base),
    h('div', { class: 'row gap' }, lw(() => (t('copy.ui.dialogs.6'))), key, eye, fetchBtn),
    h('div', { class: 'row gap' }, lw(() => ((getLang() === 'zh') ? '模型' : 'Model')), modelBox),
    h(
      'div',
      { class: 'row gap' },
      lw(() => ((getLang() === 'zh') ? '线路' : 'Route')),
      route,
      h('label', { class: 'tgl', title: () => ((getLang() === 'zh') ? '推理模型的“思考”。转 tag 用不到，关掉快很多，也不会把输出截断' : 'Reasoning. Not needed for tags; off is much faster and avoids cut-off output') }, think, h('span', { class: 'sw' }), h('span', { class: 'cn' }, () => ((getLang() === 'zh') ? '深度思考' : 'Deep thinking')))
    ),
    st,
    h('p', { class: 'hint' }, () => ((getLang() === 'zh') ? '填地址和 key → 获取模型 → 选一个。例：https://api.deepseek.com · https://api.openai.com/v1 · http://localhost:11434/v1。key 只存在本机浏览器。' : 'Endpoint + key → Fetch models → pick one. e.g. https://api.deepseek.com · https://api.openai.com/v1 · http://localhost:11434/v1. The key stays in this browser.'))
  );
}

export function openSettings({ testToken, clearHistory, appearanceChanged, setLang, folder, replayTour }) {
  const s = state.settings;
  const tok = h('input', { class: 'inp mono', type: 'password', value: s.token, placeholder: 'pst-xxxxxxxxxxxxxxxx', autocomplete: 'off', spellcheck: false });
  const eye = h('button', { class: 'btn sq', title: () => (t('copy.ui.dialogs.0')) }, icon('eye'));
  eye.onclick = () => (tok.type = tok.type === 'password' ? 'text' : 'password');
  const status = h('div', { class: 'status-line' }, () => (s.token ? '' : t('set.noToken')));
  const test = h('button', { class: 'btn solid' }, () => (t('act.test')));
  const acct = h('dl', { class: 'kv' });
  const renderAcct = () => {
    const se = state.session;
    acct.replaceChildren(
      h('dt', {}, () => (t('set.tier'))),
      h('dd', {}, se.tier == null ? '—' : ['PAPER', 'TABLET', 'SCROLL', 'OPUS'][se.tier] || se.tier),
      h('dt', {}, () => (t('set.anlas'))),
      h('dd', {}, se.anlas == null ? '—' : '◈ ' + se.anlas.toLocaleString())
    );
  };
  renderAcct();
  test.onclick = async () => {
    s.token = tok.value.trim();
    emit('settings.token');
    status.className = 'status-line';
    bindCopy(status, 'textContent', () => (t('set.testing')));
    const ok = await testToken();
    status.className = 'status-line ' + (ok ? 'ok' : 'err');
    bindCopy(status, 'textContent', () => (ok ? t('set.ok') : s.token ? t('set.bad') : t('set.noToken')));
    renderAcct();
  };
  tok.addEventListener('change', () => {
    s.token = tok.value.trim();
    emit('settings.token');
  });

  const seg = (opts, cur, onPick) => {
    const el = h('div', { class: 'seg', style: { width: '100%' } });
    const paint = (v) =>
      el.replaceChildren(
        ...opts.map(([val, label, dis]) =>
          h('button', { class: val === v ? 'on' : '', style: { flex: 1 }, disabled: dis, onclick: () => (onPick(val), paint(val)) }, label)
        )
      );
    paint(cur);
    return el;
  };
  const check = (label, key) => {
    const i = h('input', { type: 'checkbox', checked: !!s[key] });
    i.onchange = () => set('settings.' + key, i.checked);
    return h('label', { class: 'tgl' }, i, h('span', { class: 'sw' }), h('span', { class: 'cn' }, label));
  };

  // Upstream proxy the local server uses (e.g. Clash's default 7890). Off = the server's own default.
  const T2 = (z, e) => (getLang() === 'zh' ? z : e);
  const up = () => ({ on: false, host: '127.0.0.1', port: 7890, ...(s.upstream || {}) });
  const upOn = h('input', { type: 'checkbox', checked: up().on, 'data-upstream': 'on' });
  const upHost = h('input', { class: 'inp mono', value: up().host, placeholder: '127.0.0.1', spellcheck: false, 'aria-label': () => T2('代理地址', 'Proxy host'), 'data-upstream': 'host', style: { flex: 1, minWidth: '0' } });
  const upPort = h('input', { class: 'inp mono', type: 'number', min: 1, max: 65535, value: up().port, placeholder: '7890', 'aria-label': () => T2('端口', 'Port'), 'data-upstream': 'port', style: { width: '90px' } });
  const upHint = h('p', { class: 'hint' });
  const paintUp = () => {
    const v = up();
    upHost.disabled = upPort.disabled = !v.on;
    const valid = !v.on || !!upstreamSetting(v);
    upHost.classList.toggle('bad', !valid);
    upPort.classList.toggle('bad', !valid);
    bindCopy(upHint, 'textContent', () => !valid
      ? T2('地址或端口无效：填主机名 / IP 和 1–65535 的端口', 'Invalid host or port: a host name / IP and a port from 1 to 65535')
      : v.on ? T2(`本地代理访问 NovelAI 和 AI 接口时经过 http://${v.host}:${v.port}`, `The local proxy reaches NovelAI and the AI endpoint through http://${v.host}:${v.port}`)
        : T2(`关闭时${state.session.upstreamProxy ? '按启动参数经 ' + state.session.upstreamProxy : '直连'}。只在「本地代理」线路下生效。`, `Off: ${state.session.upstreamProxy ? 'via ' + state.session.upstreamProxy + ' (server setting)' : 'direct'}. Only used on the local-proxy route.`));
  };
  const saveUp = () => {
    const port = Number(upPort.value);
    commit('settings', { upstream: { on: upOn.checked, host: upHost.value.trim() || '127.0.0.1', port: Number.isFinite(port) ? Math.round(port) : 7890 } });
    paintUp();
  };
  upOn.onchange = saveUp;
  upHost.onchange = saveUp;
  upPort.onchange = saveUp;
  paintUp();

  const zh = getLang() === 'zh';
  const body = [
    h(
      'div',
      { class: 'field' },
      h('span', { class: 't-label' }, () => (t('set.token'))),
      h('div', { class: 'token-row' }, tok, eye, test),
      status,
      h('p', { class: 'hint' }, () => (t('set.tokenHint')))
    ),
    h('div', { class: 'field' }, h('span', { class: 't-label' }, () => (t('set.account'))), acct),
    h(
      'div',
      { class: 'field' },
      h('span', { class: 't-label' }, () => (t('set.conn'))),
      seg(
        [
          ['auto', () => (t('set.connAuto'))],
          ['direct', () => (t('set.connDirect'))],
          ['proxy', () => (t('set.connProxy')), !state.session.proxy],
        ],
        s.conn,
        (v) => set('settings.conn', v)
      ),
      h('p', { class: 'hint' }, () => (t('set.connHint') + (state.session.proxy ? ((getLang() === 'zh') ? '（本地代理已连接）' : ' (local proxy on)') : (getLang() === 'zh') ? '（未检测到本地代理：请用 node server.js 启动）' : ' (proxy not detected — run node server.js)')))
    ),
    h('div', { class: 'field' },
      h('span', { class: 't-label' }, () => T2('上游代理', 'Upstream proxy')),
      h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
        h('label', { class: 'tgl' }, upOn, h('span', { class: 'sw' }), h('span', { class: 'cn' }, () => T2('使用', 'Use'))),
        upHost, h('span', { class: 'mono' }, ':'), upPort),
      upHint
    ),
    h('button', { class: 'btn sm', 'data-action': 'export-diag', onclick: async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try { await downloadDiagnostics(); }
      catch (err) { toast(err.message, 'err'); }
      finally { button.disabled = false; }
    } }, () => getLang() === 'zh' ? '导出诊断日志' : 'Export diagnostics'),
    h('div', { class: 'field' }, h('span', { class: 't-label' }, () => (t('set.theme'))), appearanceControls(appearanceChanged)),
    h(
      'div',
      { class: 'row', style: { gap: '16px', alignItems: 'flex-start' } },
      h(
        'div',
        { class: 'field grow' },
        h('span', { class: 't-label' }, () => (t('set.lang'))),
        seg(
          [
            ['zh', () => t('copy.ui.dialogs.5')],
            ['en', 'EN'],
          ],
          s.lang,
          setLang
        )
      )
    ),
    h(
      'div',
      { class: 'field' },
      h('span', { class: 't-label' }, () => (t('set.fx'))),
      h(
        'div',
        { class: 'row wrap gap' },
        check(() => (t('set.fxReveal')), 'fxReveal'),
        check(() => (t('set.fxBg')), 'fxBg'),
        check(() => ((getLang() === 'zh') ? '生成过程实时预览（实验性，V4+）' : 'Live step previews (experimental, V4+)'), 'stream')
      )
    ),
    h(
      'div',
      { class: 'field' },
      h('span', { class: 't-label' }, () => ((getLang() === 'zh') ? '提示词' : 'Prompt')),
      h('div', { class: 'row wrap gap' }, check(() => ((getLang() === 'zh') ? '自动规整：离开编辑框时下划线换空格、中文逗号换英文、段尾补逗号' : 'Auto-format on blur: underscores to spaces, full-width commas, trailing comma'), 'promptFormat'), check(() => ((getLang() === 'zh') ? '悬停 artist: 标签时显示 nax.moe 的社区样图（会向其 CDN 请求图片）' : 'Hover an artist: tag to show the community sample from nax.moe (loads from its CDN)'), 'artistPeek'))
    ),
    llmField(zh),
    notifyField(zh),
    h(
      'div',
      { class: 'field' },
      h('span', { class: 't-label' }, () => (t('set.shortcuts'))),
      h(
        'dl',
        { class: 'kv' },
        h('dt', {}, 'CTRL + ENTER'),
        h('dd', {}, () => ((getLang() === 'zh') ? '生成' : 'Generate')),
        h('dt', {}, 'CTRL + ↑ / ↓'),
        h('dd', {}, () => ((getLang() === 'zh') ? '光标处 tag 权重 ±0.1（1.1::tag::，可降到负数）' : 'Tag weight ±0.1 (1.1::tag::, down to negative)')),
        h('dt', {}, '← / → (↑ / ↓)'),
        h('dd', {}, () => ((getLang() === 'zh') ? '浏览档案（按当前筛选；网格模式下 ↑/↓ 跳一行）' : 'Browse the archive (filtered; ↑/↓ = row in grid mode)')),
        h('dt', {}, 'S'),
        h('dd', {}, () => ((getLang() === 'zh') ? '锁定当前图的种子；再按一次解锁（随机）' : 'Lock the stage image’s seed; press again to unlock (random)')),
        h('dt', {}, 'F / X / U'),
        h('dd', {}, () => ((getLang() === 'zh') ? '收藏 / 淘汰（并跳到下一张）/ 清除标记' : 'Star / reject (and advance) / clear')),
        h('dt', {}, () => (t('copy.ui.dialogs.1'))),
        h('dd', {}, () => ((getLang() === 'zh') ? '多选 / 连选档案图像，右键打开操作菜单；Alt + 左键锁定 / 解锁种子，Alt + 右键套用参数（保留种子）' : 'Select / range-select; right-click for actions; Alt+click locks / unlocks the seed, Alt+right-click parameters (keep seed)')),
        h('dt', {}, 'CTRL + A · ESC'),
        h('dd', {}, () => ((getLang() === 'zh') ? '全选当前筛选结果 · 取消选择' : 'Select all shown · clear selection')),
        h('dt', {}, 'CTRL + S'),
        h('dd', {}, () => ((getLang() === 'zh') ? '下载当前图像（有选中时打包选中）' : 'Save current image (or zip the selection)')),
        h('dt', {}, () => (t('copy.ui.dialogs.2'))),
        h('dd', {}, () => ((getLang() === 'zh') ? '在编辑框中插入片段' : 'Insert a snippet in an editor')),
        h('dt', {}, 'CTRL + V'),
        h('dd', {}, () => ((getLang() === 'zh') ? '粘贴图像以导入' : 'Paste an image to import')),
        h('dt', {}, 'DEL'),
        h('dd', {}, () => ((getLang() === 'zh') ? '删除当前图像（或选中的图像）' : 'Delete current image (or the selection)'))
      )
    ),
    saveField(folder, check, zh),
    h(
      'div',
      { class: 'field' },
      h('span', { class: 't-label' }, () => (t('set.data'))),
      h('div', {}, h('button', { class: 'btn danger', onclick: clearHistory }, icon('trash'), () => (t('act.clearHistory'))))
    ),
    replayTour &&
      h(
        'div',
        { class: 'field' },
        h('span', { class: 't-label' }, () => ((getLang() === 'zh') ? '引导' : 'Tours')),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn sm', onclick: () => (m.close(), replayTour('main')) }, () => ((getLang() === 'zh') ? '重看新手引导' : 'Replay the tour')),
          h('button', { class: 'btn sm ghost', onclick: () => (m.close(), replayTour('post')) }, () => ((getLang() === 'zh') ? '后处理引导' : 'Post-processing tour'))
        )
      ),
  ];
  const done = h('button', { class: 'btn solid' }, () => (t('act.close')));
  const m = openModal({ n: '⚙', title: () => (t('copy.ui.dialogs.3')), sub: () => (t('modal.settings')), body, foot: [done] });
  done.onclick = () => {
    s.token = tok.value.trim();
    emit('settings.token');
    m.close();
  };
}

function notifyField(zh) {
  const i = h('input', { type: 'checkbox', checked: !!state.settings.notify && notifySupported() && Notification.permission === 'granted' });
  i.onchange = async () => ((i.checked = await setNotify(i.checked)), paintPerm());
  const permLabel = () => {
    const p = notifySupported() ? Notification.permission : 'unsupported';
    const Z = getLang() === 'zh';
    return ({ granted: Z ? '浏览器权限：已允许' : 'Permission: allowed', denied: Z ? '浏览器权限：已拒绝（在地址栏左侧的站点设置里改）' : 'Permission: blocked (change it in the site settings)', default: Z ? '浏览器权限：尚未询问' : 'Permission: not asked yet', unsupported: Z ? '此浏览器不支持系统通知' : 'Not supported in this browser' })[p];
  };
  let permText = h('span', {}, permLabel);
  const paintPerm = () => { const next = h('span', {}, permLabel); permText.replaceWith(next); permText = next; };
  const testBtn = h('button', { class: 'btn sm', type: 'button' }, () => ((getLang() === 'zh') ? '发送测试通知' : 'Send a test'));
  testBtn.onclick = async () => {
    const ok = await testNotify();
    i.checked = !!state.settings.notify;
    paintPerm();
    if (ok) toast(() => (getLang() === 'zh' ? '已发送。如果屏幕角落没有弹出，请检查系统通知设置（见下方说明）。' : 'Sent. No popup in the screen corner? Check the OS notification settings (see below).'), 'ok', 6000);
  };
  return h(
    'div',
    { class: 'field' },
    h('span', { class: 't-label' }, () => ((getLang() === 'zh') ? '后台提醒' : 'Background alerts')),
    h('label', { class: 'tgl' }, i, h('span', { class: 'sw' }), h('span', { class: 'cn' }, () => ((getLang() === 'zh') ? '切到其他标签页 / 窗口时，生成完成或自动生成停止后弹出系统通知' : 'System notification when a generation finishes or auto stops while you are elsewhere'))),
    h('div', { class: 'row gap' }, testBtn, h('span', { class: 'hint' }, permText)),
    h('p', { class: 'hint' }, () => ((getLang() === 'zh') ? '无论是否开启，标签页标题都会显示进度和未查看的数量，例如「▶ 45% (3)」。点了测试却没有弹窗：在 Windows「设置 → 系统 → 通知」里打开 Chrome / Edge 的通知，并关闭「勿扰 / 专注助手」。' : 'Either way the tab title shows progress and the unseen count, e.g. “▶ 45% (3)”. Test shows nothing? Allow notifications for Chrome / Edge in your OS notification settings and turn off Do Not Disturb / Focus.'))
  );
}

function saveField(folder, check, zh) {
  const path = h('span', { class: 'path' }, '—');
  const clear = h('button', { class: 'btn sm sq', title: () => ((getLang() === 'zh') ? '取消文件夹' : 'Forget folder') }, icon('close'));
  const sync = async () => {
    const n = await folder.name();
    bindCopy(path, 'textContent', () => (n ? '📁 ' + n : (getLang() === 'zh') ? '未选择 — 使用浏览器下载' : 'None — using browser downloads'));
    clear.hidden = !n;
  };
  const pick = h('button', { class: 'btn sm' }, icon('upload'), () => ((getLang() === 'zh') ? '选择文件夹' : 'Choose folder'));
  pick.onclick = async () => {
    try {
      await folder.pick();
      sync();
    } catch (err) {
      if (err.name !== 'AbortError') toast(err.message, 'err');
    }
  };
  clear.onclick = async () => (await folder.clear(), sync());
  sync();
  return h(
    'div',
    { class: 'field' },
    h('span', { class: 't-label' }, () => ((getLang() === 'zh') ? '保存到本地' : 'Saving')),
    folder.supported
      ? h('div', { class: 'folder-row' }, path, pick, clear)
      : h('p', { class: 'hint' }, () => ((getLang() === 'zh') ? '当前浏览器不支持文件夹写入（需 Chrome / Edge），将使用普通下载。' : 'Folder saving needs Chrome / Edge; using regular downloads.')),
    h(
      'div',
      { class: 'row wrap gap' },
      folder.supported ? check(() => getLang() === 'zh' ? '新图像自动保存到文件夹' : 'Auto-save new images to folder', 'autoSave') : null,
      check(() => ((getLang() === 'zh') ? '重复保存前提醒' : 'Warn before saving twice'), 'warnDuplicate')
    ),
    h('p', { class: 'hint' }, () => ((getLang() === 'zh')
      ? '已保存的图像在历史栏显示 ✓。选择文件夹后会直接写入该文件夹，并能检测文件是否仍然存在（删除后可重新保存）。'
      : 'Saved images show ✓ in the archive. With a folder, files are written there directly and their existence is re-checked.'))
  );
}

// ------------------------------------------------------------ metadata → params
export { modelFromSource };

function reportDiscarded(n) {
  if (n) toast(() => (getLang() === 'zh' ? `已忽略 ${n} 个无效字段` : `Ignored ${n} invalid fields`));
}

function stripQuality(prompt, modelId) {
  let q = QUALITY_TAGS[modelId];
  const list = Array.isArray(q) ? q : q ? [q] : [];
  for (const s of list) {
    for (const suffix of [', transparent background, ' + s, ', ' + s]) {
      const i = prompt.indexOf(suffix);
      if (i >= 0) return { prompt: prompt.slice(0, i) + prompt.slice(i + suffix.length), on: true, preset: list.indexOf(s) };
    }
  }
  return { prompt, on: false, preset: 0 };
}

function stripUC(uc, modelId) {
  const presets = ucPresetsFor(modelId);
  let s = uc.replace(/^nsfw,\s*/, '');
  let best = -1;
  presets.forEach(([, text], i) => {
    if (text && s.startsWith(text) && (best < 0 || text.length > presets[best][1].length)) best = i;
  });
  if (best >= 0) return { uc: s.slice(presets[best][1].length).replace(/^,\s*/, ''), preset: best };
  const none = presets.findIndex(([l]) => l === 'None');
  return { uc, preset: none >= 0 ? none : 0 };
}

function applySettings(meta, P) {
  const c = meta.Comment || {};
  const modelId = c.model || meta.model || modelFromSource(meta.Source);
  if (modelId) P.model = modelById(modelId).id;
  if (c.width) P.width = c.width;
  if (c.height) P.height = c.height;
  if (c.steps) P.steps = c.steps;
  if (c.scale != null) P.scale = c.scale;
  if (c.cfg_rescale != null) P.cfgRescale = c.cfg_rescale;
  if (c.sampler) P.sampler = c.sampler;
  if (c.noise_schedule) P.noiseSchedule = c.noise_schedule;
  if (c.n_samples != null) P.nSamples = c.n_samples;
  if (c.sm != null) P.smea = c.sm;
  if (c.sm_dyn != null) P.dyn = c.sm_dyn;
  if (Object.hasOwn(c, 'skip_cfg_above_sigma')) P.variety = c.skip_cfg_above_sigma != null;
  if (c.dynamic_thresholding != null) P.decrisp = c.dynamic_thresholding;
  P.sizePreset = SIZE_PRESETS.find((p) => p.w === P.width && p.h === P.height)?.id || 'custom';
}

// Omitted flags keep the old full-import defaults; seed takes precedence over withSeed.
export function applyMetadata(meta, { prompt = true, uc = true, chars = true, settings = true, withSeed = true, seed = withSeed } = {}) {
  const validated = sanitizeMetadata(meta);
  meta = validated.meta;
  const c = meta.Comment || {};
  commit('params', (P) => {
    // Decode quality/UC using the source model even when model import is unchecked.
    const modelId = c.model || meta.model || modelFromSource(meta.Source) || P.model;
    if (settings) applySettings(meta, P);
    const promptText = c.v4_prompt?.caption?.base_caption ?? c.prompt ?? meta.Description;
    if (prompt && promptText != null) {
      const raw = promptText.replace(/^fur dataset,\s*/, '');
      const q = stripQuality(raw, modelId);
      P.prompt = q.prompt.trim();
      P.qualityToggle = q.on;
      P.qualityPreset = q.preset;
    }
    const ucText = c.v4_negative_prompt?.caption?.base_caption ?? c.uc ?? c.negative_prompt;
    if (uc && ucText != null) {
      const raw = ucText;
      const u = stripUC(raw, modelId);
      P.uc = u.uc;
      P.ucPreset = u.preset;
    }
    if (seed && c.seed != null) P.seed = String(c.seed);
    if (chars && c.v4_prompt?.caption?.char_captions) {
      const caps = c.v4_prompt.caption.char_captions;
      const negs = c.v4_negative_prompt?.caption?.char_captions || [];
      P.characters = caps.map((cc, i) => ({
        id: Math.random().toString(36).slice(2),
        prompt: cc.char_caption || '',
        uc: negs[i]?.char_caption || '',
        x: cc.centers?.[0]?.x ?? 0.5,
        y: cc.centers?.[0]?.y ?? 0.5,
        enabled: true,
      }));
      if (c.v4_prompt.use_coords != null) P.aiChoice = !c.v4_prompt.use_coords;
    }
  });
  reportDiscarded(validated.discarded);
  return validated;
}

// Compatibility for the stage/main.js seed and composition actions.
export function applySeed(meta, { composition = false } = {}) {
  return applyMetadata(meta, { prompt: false, uc: false, chars: false, settings: composition, seed: true });
}

// Fit inside the free area, keeping the aspect ratio to the nearest 64px grid.
function freeSettings(meta) {
  const c = meta.Comment || {};
  const width = Math.max(64, Number(c.width) || state.params.width);
  const height = Math.max(64, Number(c.height) || state.params.height);
  const factor = Math.min(1, Math.sqrt(1048576 / (width * height)), 16384 / Math.max(width, height));
  let w = Math.max(64, Math.floor(width * factor / 64) * 64);
  let hh = Math.max(64, Math.floor(height * factor / 64) * 64);
  // Minimum 64px on the short edge can push extreme aspect ratios over 1MP.
  if (w * hh > 1048576) {
    if (w >= hh) w = Math.floor(1048576 / hh / 64) * 64;
    else hh = Math.floor(1048576 / w / 64) * 64;
  }
  return { ...meta, Comment: { ...c, width: w, height: hh, steps: Math.min(28, c.steps || state.params.steps), n_samples: 1 } };
}

// ------------------------------------------------------------ import
export async function openImport(file, actions) {
  const url = await blobToDataURL(file);
  const meta = await readNaiMetadata(file).catch(() => null);
  const zh = getLang() === 'zh';
  const checks = Object.fromEntries(['prompt', 'uc', 'chars', 'settings', 'seed'].map((key) => [key,
    h('input', { type: 'checkbox', checked: true, 'data-import': key, style: { accentColor: 'var(--acc)' } }),
  ]));
  const free = h('input', { type: 'checkbox', 'data-import': 'free' });
  const withBase = h('input', { type: 'checkbox', 'data-import': 'withBase' });
  const selected = () => Object.fromEntries(Object.entries(checks).map(([key, input]) => [key, input.checked]));
  const importMeta = () => {
    const opts = selected();
    if (!Object.values(opts).some(Boolean)) return;
    // Validate before numeric transforms; the raw JSON stays available in the viewer.
    const validated = sanitizeMetadata(meta);
    actions.meta(free.checked && opts.settings ? freeSettings(validated.meta) : validated.meta, opts);
    reportDiscarded(validated.discarded);
  };
  const switchRow = (input, label, title) => h('label', { class: 'tgl', title, style: { justifyContent: 'flex-end', letterSpacing: '0', flexWrap: 'wrap' } },
    input, h('span', { class: 'sw', style: { flexShrink: 0 } }), h('span', { class: 'cn' }, label));
  const button = (key, ic, label, primary = false) => h('button', {
    class: primary ? 'btn solid grow' : 'btn sm ghost', 'data-import-action': key,
    style: primary ? { minHeight: '52px', flex: '1 1 0' } : null,
    onclick: async () => {
      m.close();
      try {
        if (key === 'base' || key === 'inpaint') {
          // Existing actions set the image size too. Restore the draft size before
          // importing selected fields, so unchecked settings really stay untouched.
          const P = state.params;
          const size = { width: P.width, height: P.height, sizePreset: P.sizePreset };
          try { await actions[key](url); }
          finally {
            commit('params', size);
          }
          if (meta && withBase.checked) importMeta();
        } else await actions[key](url);
      } catch (err) { toast(err.message || String(err), 'err'); }
    },
  }, icon(ic), label);
  const apply = h('button', { class: 'btn solid', 'data-import-action': 'meta', onclick: () => { importMeta(); m.close(); } },
    icon('reuse'), () => ((getLang() === 'zh') ? '导入元数据' : 'Import metadata'));
  const syncApply = () => (apply.disabled = !Object.values(checks).some((input) => input.checked));
  for (const input of Object.values(checks)) input.onchange = syncApply;
  const view = h('button', { class: 'btn sm', 'data-import-action': 'view', onclick: () => openModal({
    n: '{}', title: () => ((getLang() === 'zh') ? '查看元数据' : 'Metadata'),
    body: h('pre', { class: 'meta-pre', tabIndex: 0, style: { maxHeight: '60vh', userSelect: 'text' } }, JSON.stringify(meta, null, 2)),
  }) }, () => ((getLang() === 'zh') ? '查看元数据' : 'View metadata'));
  const metaBlock = meta ? h('div', { class: 'field', style: { gap: '12px' } },
    h('span', { class: 't-label' }, () => ((getLang() === 'zh') ? '导入元数据' : 'Import metadata')),
    h('div', { class: 'row wrap', style: { gap: '16px', alignItems: 'stretch' } },
      h('div', { class: 'field', style: { gap: '12px', flex: '1 1 80px' } },
        ...[['prompt', '提示词', 'Prompt'], ['uc', '负面', 'Negative'], ['chars', '角色', 'Characters'], ['settings', '设置', 'Settings'], ['seed', '种子', 'Seed']].map(([key, cn, en]) =>
          h('label', { class: 'row gap cn', title: () => (key === 'settings' ? ((getLang() === 'zh') ? '模型 / 尺寸 / 步数 / CFG / 采样器 / 调度 / 重缩放' : 'Model / size / steps / CFG / sampler / schedule / rescale') : null) }, checks[key], () => ((getLang() === 'zh') ? cn : en)))),
      h('div', { class: 'field', style: { gap: '14px', alignItems: 'flex-end', flex: '2 1 190px', minWidth: 0 } },
        view,
        switchRow(free, () => ((getLang() === 'zh') ? '参数免费化' : 'Free parameters'), () => ((getLang() === 'zh') ? '≤1MP · 64 倍数 · ≤28 步 · 1 张（勾选设置时）' : '≤1MP · 64px grid · ≤28 steps · 1 image (with settings selected)')),
        switchRow(withBase, () => ((getLang() === 'zh') ? '图生图 / 重绘时也应用参数' : 'Apply parameters with image'), ''),
        h('div', { style: { marginTop: 'auto', paddingTop: '6px' } }, apply))))
    : h('span', { class: 'hint' }, () => ((getLang() === 'zh') ? '无元数据' : 'No metadata'));
  const m = openModal({ n: 'IM', title: () => ((getLang() === 'zh') ? '想用这张图做什么？' : 'What would you like to do?'), body: [
    h('img', { src: url, alt: () => (file.name || ((getLang() === 'zh') ? '导入预览' : 'Import preview')), style: { width: '100%', height: '210px', objectFit: 'contain', background: 'var(--bg-1)' } }),
    h('div', { class: 'row gap' }, button('base', 'edit', () => ((getLang() === 'zh') ? '图生图' : 'Image to image'), true), button('inpaint', 'inpaint', () => ((getLang() === 'zh') ? '局部重绘' : 'Inpaint'), true)),
    metaBlock,
    h('div', { class: 'row wrap gap', style: { borderTop: '1px solid var(--line)', paddingTop: '10px' } },
      button('vibe', 'vibe', () => ((getLang() === 'zh') ? '氛围' : 'Vibe')), button('ref', 'target', () => ((getLang() === 'zh') ? '参考' : 'Reference')), button('director', 'wand', () => ((getLang() === 'zh') ? '导演工具' : 'Director'))),
  ] });
  m.el.style.width = 'min(620px, 100%)';
  m.el.querySelector('.modal-t').style.fontSize = 'calc(21px * var(--fz))';
}

// ------------------------------------------------------------ enhance
const ENH = [
  [0.2, 0],
  [0.4, 0],
  [0.5, 0],
  [0.6, 0],
  [0.7, 0.1],
];

export function openEnhance(rec, run) {
  let factor = 1.5;
  let mag = 1;
  const costEl = h('b', { class: 'mono' });
  const update = () => {
    const w = Math.round((rec.width * factor) / 64) * 64;
    const hh = Math.round((rec.height * factor) / 64) * 64;
    const [s] = ENH[mag - 1];
    const c = generationCost({ model: modelById(state.params.model), width: w, height: hh, steps: state.params.steps, nSamples: 1, strength: s });
    costEl.textContent = state.session.live ? `◈ ${c.total} · ${w}×${hh}` : `DEMO · ${w}×${hh}`;
  };
  const segF = h('div', { class: 'seg', style: { width: '100%' } });
  const segM = h('div', { class: 'seg', style: { width: '100%' } });
  const paint = () => {
    segF.replaceChildren(...[1, 1.5].map((f) => h('button', { class: f === factor ? 'on' : '', style: { flex: 1 }, onclick: () => ((factor = f), paint()) }, f + '×')));
    segM.replaceChildren(...[1, 2, 3, 4, 5].map((v) => h('button', { class: v === mag ? 'on' : '', style: { flex: 1 }, onclick: () => ((mag = v), paint()) }, String(v))));
    update();
  };
  paint();
  const go = h('button', { class: 'btn solid' }, icon('enhance'), () => (t('act.run')));
  const cancel = h('button', { class: 'btn' }, () => (t('act.cancel')));
  const m = openModal({
    n: 'EN',
    title: () => (t('copy.ui.dialogs.4')),
    sub: () => (t('modal.enhance')),
    accent: 'var(--lilac)',
    body: [
      h('div', { class: 'field' }, h('span', { class: 't-label' }, () => (t('enh.amount'))), segF),
      h('div', { class: 'field' }, h('span', { class: 't-label' }, () => (t('enh.mag'))), segM),
      h('p', { class: 'hint' }, () => (t('enh.hint'))),
      costEl,
    ],
    foot: [cancel, go],
  });
  cancel.onclick = () => m.close();
  go.onclick = () => {
    m.close();
    const [strength, noise] = ENH[mag - 1];
    run({ factor, strength, noise });
  };
}

export { MODELS, toast };
