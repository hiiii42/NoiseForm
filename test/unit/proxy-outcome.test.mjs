import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}
function request(port, path, { method = 'POST', headers = {}, body = '{}' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(800, () => req.destroy(new Error('downstream stalled')));
    req.end(method === 'GET' || method === 'HEAD' ? undefined : body);
  });
}

test('R01/R04 proxy outcomes and response lifecycle', { timeout: 30000 }, async (t) => {
  const received = [];
  let releaseStream;
  let cancelled;
  const upstream = http.createServer((req, res) => {
    if (req.url === '/early-reset') {
      req.once('data', () => req.socket.destroy());
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ path: req.url, method: req.method, body, headers: req.headers });
      if (req.url === '/reset') return req.socket.destroy();
      if (req.url === '/timeout') return;
      if (req.url === '/cancel-before-headers') {
        res.on('close', () => cancelled?.());
        return;
      }
      if (req.url === '/truncated') {
        res.writeHead(200, { 'content-type': 'application/x-msgpack', 'content-length': '100' });
        res.write('12345678');
        setTimeout(() => res.destroy(), 30);
        return;
      }
      if (req.url === '/stream' || req.url === '/cancel') {
        res.on('close', () => cancelled?.());
        res.writeHead(200, { 'content-type': 'application/x-msgpack' });
        res.write('first');
        releaseStream = () => res.end('second');
        return;
      }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"message":"invalid request"}');
    });
  });
  const upstreamPort = await listen(upstream);
  const reservation = http.createServer();
  const port = await listen(reservation);
  await close(reservation);
  // Accelerate only the /timeout fixture, without adding a production timeout override.
  const bootstrap = `const http = require('node:http'); const original = http.request;
    http.request = (options, ...args) => original({ ...options, timeout: options.path.includes('/timeout') ? 80 : options.timeout }, ...args);
    http.createServer(require('./server.js').handleRequest).listen(process.env.PORT, '127.0.0.1');`;
  const proc = spawn(process.execPath, ['-e', bootstrap], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', NF_TEST_UPSTREAM: `http://127.0.0.1:${upstreamPort}`, NF_UPSTREAM_PROXY: 'none', NAI_TOKEN: '' },
  });
  let output = '';
  proc.stdout.on('data', (chunk) => { output += chunk; });
  proc.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      const exited = once(proc, 'exit');
      proc.kill();
      await exited;
    }
    await close(upstream);
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await request(port, '/proxy/health', { method: 'GET', body: undefined }); ready = true; break; } catch {}
    await delay(30);
  }
  assert.ok(ready, output);
  for (const target of ['image', 'llm']) {
    const route = (scenario) => target === 'llm' ? '/proxy/llm/chat/completions' : `/proxy/${target}/${scenario}`;
    const headers = (scenario) => target === 'llm' ? { 'x-llm-base': `http://127.0.0.1:${upstreamPort}/${scenario}` } : {};
    // The LLM allowlist appends /chat/completions to the supplied base.
    // Normalize only inside this local double; the real relay still validates its paths.
    if (target === 'llm') upstream.prependListener('request', (req) => { req.url = req.url.replace('/chat/completions', ''); });
    await t.test(`${target}: accepted POST reset/timeout is unknown; GET stays ordinary 502`, async () => {
      for (const scenario of ['reset', 'timeout']) {
        const before = received.length;
        const res = await request(port, route(scenario), { headers: { ...headers(scenario), 'x-correlation-id': 'diagnostic-only' } });
        assert.equal(res.status, 502);
        assert.equal(res.headers['x-nf-outcome'], 'unknown');
        assert.equal(JSON.parse(res.body).outcome, 'unknown');
        assert.equal(received.length, before + 1);
        assert.equal(received.at(-1).body, '{}');
        assert.equal(received.at(-1).headers['idempotency-key'], undefined);
      }
      const res = await request(port, route('reset'), { method: 'GET', body: undefined, headers: headers('reset') });
      assert.equal(res.status, 502);
      assert.equal(res.headers['x-nf-outcome'], undefined);
      assert.equal(JSON.parse(res.body).outcome, undefined);
    });
    await t.test(`${target}: 8/100-byte response errors within one second`, async () => {
      const start = Date.now();
      await assert.rejects(request(port, route('truncated'), { headers: headers('truncated') }), (err) => err.code === 'ECONNRESET');
      assert.ok(Date.now() - start < 1000);
    });
    await t.test(`${target}: failure during a partial upload is conservatively unknown`, async () => {
      const result = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: route('early-reset'), method: 'POST', headers: { ...headers('early-reset'), 'content-length': '100' } }, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('error', reject);
          res.on('end', () => { resolve({ status: res.statusCode, headers: res.headers, body }); req.destroy(); });
        });
        req.on('error', reject);
        req.setTimeout(800, () => req.destroy(new Error('partial upload stalled')));
        req.write('12345678'); // deliberately do not end: lack of finish is NOT proof of not-sent
      });
      assert.equal(result.status, 502);
      assert.equal(result.headers['x-nf-outcome'], 'unknown');
      assert.equal(JSON.parse(result.body).outcome, 'unknown');
    });
    await t.test(`${target}: streaming first chunk arrives before upstream end`, async () => {
      const res = await fetch(`http://127.0.0.1:${port}${route('stream')}`, { method: 'POST', body: '{}', headers: headers('stream'), signal: AbortSignal.timeout(1000) });
      const reader = res.body.getReader();
      assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
      releaseStream();
      assert.equal(new TextDecoder().decode((await reader.read()).value), 'second');
      assert.equal((await reader.read()).done, true);
    });
    await t.test(`${target}: downstream disconnect destroys upstream, including before headers`, async () => {
      for (const scenario of ['cancel', 'cancel-before-headers']) {
        let timer;
        const closed = new Promise((resolve, reject) => {
          cancelled = resolve;
          timer = setTimeout(() => reject(new Error('upstream was not cancelled')), 800);
        });
        closed.catch(() => {});
        const before = received.length;
        const req = http.request({ hostname: '127.0.0.1', port, path: route(scenario), method: 'POST', headers: headers(scenario) });
        req.on('error', () => {});
        req.on('response', (res) => { res.on('error', () => {}); res.resume(); });
        req.end('{}');
        try {
          for (let i = 0; i < 50 && received.length === before; i++) await delay(10);
          assert.equal(received.length, before + 1);
          req.destroy();
          await closed;
        } finally { clearTimeout(timer); req.destroy(); cancelled = null; }
      }
    });
    await t.test(`${target}: ordinary 400 remains a known HTTP error`, async () => {
      const res = await request(port, route('bad'), { headers: headers('bad') });
      assert.equal(res.status, 400);
      assert.equal(res.headers['x-nf-outcome'], undefined);
      assert.equal(res.body, '{"message":"invalid request"}');
    });
  }
  await close(upstream);
  await t.test('connection refused before sending is not-sent', async () => {
    for (const target of ['image', 'llm']) {
      const res = await request(port, target === 'llm' ? '/proxy/llm/chat/completions' : `/proxy/${target}/reset`, {
        headers: target === 'llm' ? { 'x-llm-base': `http://127.0.0.1:${upstreamPort}` } : {},
      });
      assert.equal(res.status, 502);
      assert.equal(res.headers['x-nf-outcome'], 'not-sent');
      assert.equal(JSON.parse(res.body).outcome, 'not-sent');
    }
  });
  assert.equal((await request(port, '/proxy/health', { method: 'GET', body: undefined })).status, 200, output);
});
