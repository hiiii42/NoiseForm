import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function listen(s) { s.listen(0, '127.0.0.1'); await once(s, 'listening'); return s.address().port; }
async function close(s) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); }
function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.setTimeout(1500, () => req.destroy(new Error('fixture stalled'))); req.end(body);
  });
}

test('proxy JSON lines and GET /proxy/diag cover outcomes, privacy, bounds and access restrictions', { timeout: 30000 }, async (t) => {
  let accepted;
  const upstream = http.createServer((req, res) => {
    const scenario = req.url.split('/')[1].split('?')[0];
    req.resume();
    req.on('end', () => {
      if (scenario === 'unknown') return req.socket.destroy();
      if (scenario === 'truncated') {
        res.writeHead(200, { 'content-length': 100 }); res.write('hello');
        setTimeout(() => res.destroy(), 15); return;
      }
      if (scenario === 'client-closed') { accepted?.(); res.writeHead(200); res.write('hello'); return; }
      res.writeHead(scenario === 'http-error' ? 400 : 200);
      res.end('response SECRET');
    });
  });
  const upstreamPort = await listen(upstream);
  const reservation = http.createServer(), port = await listen(reservation); await close(reservation);
  const bootstrap = "require('node:http').createServer(require('./server.js').handleRequest).listen(process.env.PORT, '127.0.0.1');";
  const env = { ...process.env, PORT: String(port), NODE_ENV: 'test', NAI_TOKEN: '', NF_UPSTREAM_PROXY: 'none', NF_TEST_UPSTREAM: `http://127.0.0.1:${upstreamPort}`, NF_LOG: '1' };
  const proc = spawn(process.execPath, ['-e', bootstrap], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  proc.stdout.on('data', (c) => { output += c; }); proc.stderr.on('data', (c) => { errors += c; });
  t.after(async () => { if (proc.exitCode === null && proc.signalCode === null) { const done = once(proc, 'exit'); proc.kill(); await done; } await close(upstream); });
  for (let i = 0; ; i++) {
    try { await request(port, '/proxy/health'); break; } catch { if (i > 100) throw new Error(errors); await delay(20); }
  }
  const read = async () => JSON.parse((await request(port, '/proxy/diag')).body);
  async function latest(expected) {
    for (let i = 0; i < 100; i++) {
      const row = (await read()).at(-1);
      if (row?.outcome === expected) return row;
      await delay(10);
    }
    assert.fail(`missing ${expected}`);
  }
  for (const target of ['image', 'llm']) {
    for (const outcome of ['ok', 'http-error', 'unknown', 'truncated', 'client-closed']) {
      const path = target === 'llm' ? '/proxy/llm/chat/completions' : `/proxy/${target}/${outcome}?token=pst-SECRET`;
      const headers = { authorization: 'Bearer pst-SECRET', 'x-llm-base': `http://alice:password@127.0.0.1:${upstreamPort}/${outcome}?key=sk-SECRET` };
      if (outcome === 'client-closed') {
        const done = new Promise((r) => { accepted = r; });
        const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers });
        req.on('error', () => {}); req.on('response', (res) => { res.on('error', () => {}); res.resume(); });
        req.end('prompt SECRET'); await done; req.destroy(); accepted = null;
      } else if (outcome === 'truncated') await assert.rejects(request(port, path, { method: 'POST', headers, body: 'prompt SECRET' }));
      else await request(port, path, { method: 'POST', headers, body: 'prompt SECRET' });
      const row = await latest(outcome);
      assert.equal(row.target, target); assert.equal(row.method, 'POST');
      assert.ok(row.ms >= 0); assert.ok(!row.path.includes('?'));
      if (outcome === 'ok' || outcome === 'http-error') {
        assert.ok(row.msHeaders >= 0); assert.equal(row.bytes, 'response SECRET'.length);
        assert.equal(row.status, outcome === 'ok' ? 200 : 400);
      }
      if (target === 'llm') assert.equal(row.host, `127.0.0.1:${upstreamPort}`);
    }
  }
  assert.equal((await request(port, '/proxy/diag', { headers: { origin: 'http://evil.invalid' } })).status, 403);
  assert.equal((await request(port, '/proxy/diag', { method: 'POST' })).status, 405);
  // Force ring rollover without sending any external traffic.
  for (let i = 0; i < 205; i++) await request(port, '/proxy/image/ok');
  assert.equal((await read()).length, 200);
  await close(upstream);
  await request(port, '/proxy/image/not-sent', { method: 'POST', body: 'prompt SECRET' });
  assert.equal((await latest('not-sent')).status, null, 'no upstream response headers exist for a connection refusal');
  await delay(50); // stdout delivery is asynchronous to the child response
  const lines = output.trim().split('\n').map((s) => JSON.parse(s));
  for (const outcome of ['ok', 'http-error', 'unknown', 'truncated', 'client-closed', 'not-sent']) assert.ok(lines.some((r) => r.outcome === outcome), outcome);
  assert.doesNotMatch(output + JSON.stringify(await read()), /authorization|prompt SECRET|response SECRET|pst-SECRET|sk-SECRET|alice|password/i);
  assert.equal(errors, '');
});

test('NF_LOG=0 suppresses stdout without disabling the diagnostic buffer', async (t) => {
  const prior = process.env.NF_LOG;
  process.env.NF_LOG = '0';
  const { handleRequest } = await import('../../server.js');
  const server = http.createServer(handleRequest), port = await listen(server);
  t.after(async () => { await close(server); if (prior == null) delete process.env.NF_LOG; else process.env.NF_LOG = prior; });
  const original = console.log, lines = [];
  console.log = (s) => lines.push(s);
  try {
    await request(port, '/proxy/llm/models'); // local validation failure; never reaches a network upstream
    assert.equal(JSON.parse((await request(port, '/proxy/diag')).body).at(-1).outcome, 'http-error');
    assert.deepEqual(lines, []);
  } finally { console.log = original; }
});
