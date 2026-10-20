// 1.8.7: Settings → upstream proxy. Off by default (direct); when on, http://host:port goes to our local
// server as x-nf-upstream on proxy-route requests only — never to NovelAI directly.
import { mockLiveSource } from '../fixtures/mocklive.mjs';

function capture() {
  const real = window.fetch;
  window.__sent = [];
  window.fetch = (url, opts = {}) => {
    const u = String(url);
    if (u === '/proxy/health') return Promise.resolve(new Response(JSON.stringify({ ok: true, serverToken: false, upstreamProxy: null, version: document.querySelector('.brand-v').textContent.replace(/^v/, '') })));
    if (u.includes('user/subscription') || u.includes('generate-image')) window.__sent.push({ url: u, upstream: (opts.headers || {})['x-nf-upstream'] ?? null });
    if (u.startsWith('/proxy/image/')) return real(u.replace('/proxy/image', 'https://image.novelai.net'), opts);
    return real(url, opts);
  };
}
export const options = { init: [mockLiveSource({ tier: 3, delay: 20 }), '(' + capture.toString() + ')();'] };

export default async ({ page, assert, log }) => {
  await page.click('#btnSettings');
  const defaults = await page.eval("({ on: document.querySelector('[data-upstream=on]').checked, host: document.querySelector('[data-upstream=host]').value, port: document.querySelector('[data-upstream=port]').value, disabled: document.querySelector('[data-upstream=port]').disabled })");
  assert.deepEqual(defaults, { on: false, host: '127.0.0.1', port: '7890', disabled: true }, 'off by default, prefilled with 127.0.0.1:7890');

  // off + proxy route: no header (the server's own default, i.e. direct)
  const run = () => page.run(async () => {
    const nai = await import('/js/nai.js');
    window.__sent = [];
    await nai.probeProxy();
    await nai.generate({ input: 'x', model: 'mock', parameters: {} });
    return window.__sent;
  });
  await page.run(async () => (await import('/js/store.js')).set('settings.conn', 'proxy'));
  let sent = await run();
  assert.ok(sent.length && sent.every((s) => s.url.startsWith('/proxy/') && s.upstream === null), JSON.stringify(sent));

  // turn it on with a custom port through the UI
  await page.click('[data-upstream=on]');
  await page.run(() => { const p = document.querySelector('[data-upstream=port]'); p.value = '10809'; p.dispatchEvent(new Event('change')); });
  assert.deepEqual(await page.run(async () => (await import('/js/store.js')).state.settings.upstream), { on: true, host: '127.0.0.1', port: 10809 });
  sent = await run();
  assert.ok(sent.every((s) => s.upstream === 'http://127.0.0.1:10809'), JSON.stringify(sent));

  // invalid port: marked, and nothing malformed is sent
  await page.run(() => { const p = document.querySelector('[data-upstream=port]'); p.value = '70000'; p.dispatchEvent(new Event('change')); });
  assert.equal(await page.eval("document.querySelector('[data-upstream=port]').classList.contains('bad')"), true);
  sent = await run();
  assert.ok(sent.every((s) => s.upstream === null), 'invalid setting falls back to the server default');

  // direct route never carries it
  await page.run(async () => { const { set, state } = await import('/js/store.js'); set('settings.upstream', { on: true, host: '127.0.0.1', port: 7890 }); set('settings.conn', 'direct'); });
  sent = await run();
  assert.ok(sent.every((s) => !s.url.startsWith('/proxy/') && s.upstream === null), JSON.stringify(sent));
  log('default off (127.0.0.1:7890 prefilled); on → x-nf-upstream on proxy route only; invalid port marked and not sent');
};
