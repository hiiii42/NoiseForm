// 1.8.5: a generation must never sit at the capped estimate (≈93%) forever. A stalled request (no headers,
// a body that stops, or an auto-route probe into a black-holed route) ends as "result unknown" — never a
// silent resend — and while the server is merely slow the stage says it is still waiting, with elapsed time.
import { mockLiveSource } from '../fixtures/mocklive.mjs';

function stallModes() {
  const real = window.fetch;
  window.__stall = { mode: 'off', gen: 0, probes: [] };
  window.fetch = async (url, opts = {}) => {
    const u = String(url), s = window.__stall;
    const hang = () => new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(opts.signal.reason ?? new DOMException('aborted', 'AbortError'))));
    if (u.endsWith('/proxy/health')) return new Response(JSON.stringify({ ok: true, serverToken: false, upstreamProxy: null, version: s.serverVersion ?? document.querySelector('.brand-v').textContent.replace(/^v/, '') }));
    if (u.includes('user/subscription') && s.mode === 'probe') {
      s.probes.push(u);
      if (u.startsWith('https://image.novelai.net')) return hang(); // black-holed direct route
    }
    if (u.includes('generate-image') && s.mode !== 'off' && s.mode !== 'probe') {
      s.gen++;
      if (s.mode === 'headers') return hang();
      if (s.mode === 'body') {
        const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([0x50, 0x4b, 3, 4])); } }); // then nothing, never closes
        return new Response(stream, { headers: { 'content-type': 'application/zip' } });
      }
    }
    if (u.startsWith('/proxy/image/')) return real(u.replace('/proxy/image', 'https://image.novelai.net'), opts);
    return real(url, opts);
  };
}

export const options = { width: 1300, height: 860, init: [mockLiveSource({ tier: 3 }), '(' + stallModes.toString() + ')();'] };

export default async ({ page, assert, log }) => {
  await page.run(async () => {
    const { set } = await import('/js/store.js');
    set('settings.stream', false);
    set('params.model', 'nai-diffusion-4-5-full');
    set('params.prompt', '1girl, city');
    set('params.width', 512); set('params.height', 512); set('params.steps', 10);
    const nai = await import('/js/nai.js');
    Object.assign(nai.TIMEOUTS, { headers: 900, idle: 700, probe: 400 });
  });
  const run = async () => {
    const t0 = Date.now();
    const res = await page.run(async () => (await import('/js/app/generate.js')).generate());
    return { res, ms: Date.now() - t0 };
  };

  // 1. headers never arrive → unknown, one request, generator released
  await page.eval("window.__stall.mode = 'headers'; 1");
  let { res, ms } = await run();
  assert.equal(res.ok, false);
  assert.equal(res.err?.unknown, true, 'stalled request is an unknown result, not a plain failure');
  assert.equal(await page.eval('window.__stall.gen'), 1, 'never resent');
  assert.ok(ms < 5000, 'ended after the headers timeout, took ' + ms);
  assert.equal(await page.eval("document.body.classList.contains('busy') || !!document.querySelector('#btnGenerate[disabled]')"), false);

  // 2. body stops mid-transfer → unknown after the idle timeout
  await page.eval("window.__stall.mode = 'body'; window.__stall.gen = 0; 1");
  ({ res, ms } = await run());
  assert.equal(res.err?.unknown, true, 'stalled body is an unknown result');
  assert.equal(await page.eval('window.__stall.gen'), 1);
  assert.ok(ms < 5000, 'ended after the idle timeout, took ' + ms);

  // 3. auto route: the direct probe hangs → the probe times out and the proxy route is used
  await page.run(async () => {
    const { set } = await import('/js/store.js');
    set('settings.conn', 'auto');
    window.__stall.mode = 'probe';
    await (await import('/js/nai.js')).probeProxy();
  });
  ({ res, ms } = await run());
  assert.equal(res.ok, true, 'generated through the proxy after the direct probe timed out: ' + (res.err?.message || ''));
  assert.ok((await page.eval('window.__stall.probes')).some((u) => u.startsWith('/proxy/')), 'fell over to the proxy probe');

  // 4. merely slow: once the estimate is spent the stage says it is waiting, with elapsed seconds
  await page.run(async () => {
    const { set } = await import('/js/store.js');
    set('settings.conn', 'direct');
    window.__stall.mode = 'off';
    window.__mockCfg.delay = 5200;
  });
  const pending = page.run(async () => (await import('/js/app/generate.js')).generate());
  await page.waitFor("/等待服务器|Waiting for server/.test(document.querySelector('#developing')?.textContent || '')", 8000, 100);
  const label = await page.eval("document.querySelector('#developing').textContent");
  assert.ok(/\d+:\d\d/.test(label), 'elapsed time shown: ' + label);
  assert.equal((await pending).ok, true, 'slow but healthy request still completes');

  // 5. stale local server (started before an update) is reported once
  await page.run(async () => { window.__stall.serverVersion = '1.8.2'; await (await import('/js/nai.js')).probeProxy(); });
  assert.equal(await page.run(async () => (await import('/js/store.js')).state.session.serverStale), '1.8.2');
  await page.run(async () => { window.__stall.serverVersion = undefined; await (await import('/js/nai.js')).probeProxy(); });
  assert.equal(await page.run(async () => (await import('/js/store.js')).state.session.serverStale), null);
  // the two intentional unknown results are logged by generate(); nothing else may error
  assert.equal(page.errors.filter((s) => !s.includes('结果未知') && !s.includes('result is unknown')).length, 0, page.errors.join('\n'));
  page.errors.length = 0;
  log('stalled headers / body → unknown without resend; hung direct probe falls over to proxy; slow request shows elapsed wait; stale server detected');
};
