import { mockLiveSource } from '../fixtures/mocklive.mjs';

function fixtures() {
  const fetch = window.fetch;
  window.__diagHang = false;
  window.fetch = (url, options = {}) => {
    if (url === '/proxy/health') return Promise.resolve(new Response(JSON.stringify({ ok: true, serverToken: false, version: document.querySelector('.brand-v').textContent.replace(/^v/, ''), upstreamProxy: '127.0.0.1:7890' })));
    if (url === '/proxy/diag') return Promise.resolve(new Response('[]'));
    if (String(url).includes('generate-image') && window.__diagHang) return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    return fetch(url, options);
  };
}
export const options = { init: [mockLiveSource({ tier: 3, delay: 20 }), `(${fixtures.toString()})();`] };

export default async ({ page, assert, artifact, log }) => {
  const ids = await page.run(async () => {
    const nai = await import('/js/nai.js'), diag = await import('/js/diag.js');
    const body = { input: 'prompt SECRET', model: 'mock', parameters: {} };
    await nai.generate(body);
    const ok = diag.entries().at(-1).id;
    window.__diagHang = true; nai.TIMEOUTS.headers = 60;
    await nai.generate(body).catch(() => {});
    const timeout = diag.entries().at(-1).id;
    // Also exercise refreshing before the debounce expires or the request ends.
    nai.TIMEOUTS.headers = 90000;
    nai.generate(body).catch(() => {});
    return { ok, timeout, pending: diag.entries().at(-1).id };
  });
  await page.reload();
  await page.run(() => {
    const original = URL.createObjectURL;
    URL.createObjectURL = (blob) => { window.__diagBlob = blob; return original(blob); };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download.startsWith('noiseform-diag-')) window.__diagFilename = this.download;
      else click.call(this);
    };
  });
  await page.click('#btnSettings');
  await page.click('[data-action="export-diag"]');
  await page.waitFor('!!window.__diagFilename');
  const result = await page.run(async () => ({ name: window.__diagFilename, data: JSON.parse(await window.__diagBlob.text()) }));
  assert.match(result.name, /^noiseform-diag-\d{8}-\d{4}\.json$/);
  const find = (id) => result.data.frontend.find((r) => r.id === id);
  assert.equal(find(ids.ok)?.outcome, 'ok');
  assert.equal(find(ids.timeout)?.outcome, 'timeout-headers');
  assert.equal(find(ids.pending)?.outcome, 'unknown');
  assert.equal(result.data.connection.identity, 'browser-token');
  assert.equal(result.data.connection.mode, 'direct');
  assert.ok(result.data.pageVersion); assert.equal(result.data.server.version, result.data.pageVersion);
  assert.equal(result.data.server.upstreamProxy, '127.0.0.1:7890'); assert.deepEqual(result.data.serverLogs, []);
  assert.doesNotMatch(JSON.stringify(result), /pst-MOCK|prompt SECRET|authorization/i);
  await page.shot(artifact('diag/settings-export.png'));
  log('success + header timeout survive refresh; pending request becomes unknown; settings export contains metadata only');
};
