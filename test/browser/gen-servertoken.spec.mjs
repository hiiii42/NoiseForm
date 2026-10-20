import { mockLiveSource } from '../fixtures/mocklive.mjs';
export const options = { env: { NAI_TOKEN: 'pst-TEST' }, init: [mockLiveSource(), `
const mode = localStorage.getItem('test.identity') || 'server';
const stored = JSON.parse(localStorage.getItem('nf.settings'));
const settings = stored.v >= 1 && stored.data ? stored.data : stored;
settings.token = mode === 'browser' ? 'pst-MOCK' : '';
settings.conn = 'direct'; // server token must force proxy even if the preference says direct
localStorage.setItem('nf.settings', JSON.stringify(stored));
window.__routes = [];
const mock = window.fetch;
window.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u === '/proxy/health' && mode !== 'server') return new Response(JSON.stringify({ok:true, serverToken:false}));
  if (u.includes('/ai/') || u.includes('user/subscription')) window.__routes.push({url:u, auth:opts.headers?.authorization});
  return mock(url, opts);
};`] };

export default async ({ page, assert }) => {
  for (const [mode, identity, route] of [['server', 'server-token', '/proxy/image/'], ['browser', 'browser-token', 'https://image.novelai.net/'], ['demo', 'demo', null]]) {
    if (mode !== 'server') {
      await page.run((m) => localStorage.setItem('test.identity', m), mode);
      await page.reload();
    }
    const initial = await page.run(async () => {
      const { state } = await import('/js/store.js');
      Object.assign(state.params, { prompt: 'identity check', width: 64, height: 64, steps: 1, seed: '' });
      return { live: state.session.live, connection: state.session.connection, badge: document.querySelector('#conn b').textContent };
    });
    assert.equal(initial.connection, identity);
    assert.equal(initial.live, mode !== 'demo');
    assert.equal(initial.badge, mode === 'demo' ? 'DEMO' : 'LIVE');
    await page.click('#btnGenerate');
    await page.waitFor("import('/js/store.js').then(m=>!m.state.session.generating)");
    const calls = await page.eval('window.__routes');
    if (route) {
      assert.equal(await page.eval('window.__gen'), 1);
      assert.ok(calls.length >= 2);
      assert.ok(calls.every((c) => c.url.startsWith(route)), `${mode}: all requests use expected route`);
      assert.ok(calls.every((c) => mode === 'server' ? !c.auth : c.auth === 'Bearer pst-MOCK'));
    } else {
      assert.equal(await page.eval('window.__gen'), 0);
      assert.equal(calls.length, 0);
    }
  }
};
