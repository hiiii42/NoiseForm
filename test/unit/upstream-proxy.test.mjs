// 1.8.7: no built-in upstream proxy. The server connects directly unless the browser setting
// (x-nf-upstream) or NF_UPSTREAM_PROXY / HTTPS_PROXY names one. A fake CONNECT proxy refuses every
// tunnel, so nothing ever reaches the real NovelAI host.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = async (server) => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const close = (server) => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
function request(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', headers, agent: false }, (res) => {
      let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('stalled'))); req.end();
  });
}
async function startServer(t, env) {
  const reservation = http.createServer(); const port = await listen(reservation); await close(reservation);
  const proc = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), NF_LOG: '0', NAI_TOKEN: '', NF_UPSTREAM_PROXY: '', HTTPS_PROXY: '', https_proxy: '', ...env } });
  t.after(async () => { if (proc.exitCode === null) { const exited = once(proc, 'exit'); proc.kill(); await exited; } });
  for (let i = 0; i < 100; i++) { try { return { port, health: JSON.parse((await request(port, '/proxy/health')).body) }; } catch { await delay(30); } }
  throw new Error('server did not start');
}
async function fakeProxy(t) {
  const connects = [];
  const proxy = http.createServer((req, res) => res.end());
  proxy.on('connect', (req, socket) => { connects.push(req.url); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  const port = await listen(proxy);
  t.after(() => close(proxy));
  return { port, connects };
}

test('the default is a direct connection (the source-wide ban on the private port is in tools/check.mjs)', async (t) => {
  const { health } = await startServer(t, {});
  assert.equal(health.upstreamProxy, null, 'direct by default');
});

test('browser setting routes through the named proxy; malformed values are rejected before sending', async (t) => {
  const fake = await fakeProxy(t);
  const { port } = await startServer(t, {});
  const viaSetting = await request(port, '/proxy/image/user/subscription', { 'x-nf-upstream': `http://127.0.0.1:${fake.port}` });
  assert.equal(viaSetting.status, 502);
  assert.deepEqual(fake.connects, ['image.novelai.net:443'], 'tunnel requested from the configured proxy');
  for (const bad of ['http://user:pw@127.0.0.1:7890', 'socks5://127.0.0.1:7890', 'http://127.0.0.1:0', 'http://127.0.0.1:70000', 'http://127.0.0.1:7890/x', 'http://a b:1']) {
    const r = await request(port, '/proxy/image/user/subscription', { 'x-nf-upstream': bad });
    assert.equal(r.status, 400, bad);
    assert.equal(r.headers['x-nf-outcome'], 'not-sent', bad);
  }
  assert.equal(fake.connects.length, 1, 'rejected values never open a tunnel');
});

test('NF_UPSTREAM_PROXY still works when the browser sends no setting', async (t) => {
  const fake = await fakeProxy(t);
  const { port, health } = await startServer(t, { NF_UPSTREAM_PROXY: `http://127.0.0.1:${fake.port}` });
  assert.equal(health.upstreamProxy, `127.0.0.1:${fake.port}`);
  await request(port, '/proxy/image/user/subscription');
  assert.deepEqual(fake.connects, ['image.novelai.net:443']);
});
