import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { PassThrough, Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const project = fileURLToPath(new URL('../../', import.meta.url));
const dummyToken = 'server-test-placeholder-not-a-real-token';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function request(port, target, headers = {}, hostname = '127.0.0.1', method = 'GET') {
  return new Promise((resolve, reject) => {
    // http.request preserves raw traversal/percent sequences; fetch normalizes dot segments.
    const req = http.request({ hostname, port, path: target, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, data, body: data.toString() });
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('Local test request timed out')));
    req.end();
  });
}

async function start(root, upstream, t, extraEnv = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      NF_HOST: '127.0.0.1',
      NODE_ENV: 'test',
      NF_TEST_UPSTREAM: upstream,
      NF_UPSTREAM_PROXY: 'none',
      NAI_TOKEN: dummyToken,
      ...extraEnv,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (data) => { output += data; });
  proc.stderr.on('data', (data) => { output += data; });
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      const exited = once(proc, 'exit');
      proc.kill();
      await exited;
    }
  });
  for (let i = 0; i < 100; i++) {
    try {
      const health = await request(port, '/proxy/health');
      assert.equal(health.status, 200);
      return { port, proc, output: () => output };
    } catch {}
    if (proc.exitCode !== null) throw new Error('Server exited: ' + output);
    await delay(30);
  }
  throw new Error('Server did not become ready: ' + output);
}

async function fakeRequest(handler, port, target, remoteAddress, headers = {}) {
  const req = Readable.from(['{}']);
  req.url = target;
  req.method = 'POST';
  req.headers = { host: '127.0.0.1:' + port, 'content-type': 'application/json', ...headers };
  req.socket = { remoteAddress, localPort: port };
  const res = new PassThrough();
  let status;
  let body = '';
  res.writeHead = (code) => { status = code; res.headersSent = true; };
  res.on('data', (data) => { body += data; });
  const finished = once(res, 'finish');
  await handler(req, res);
  await finished;
  return { status, body };
}

test('server trust, URL error recovery and static containment', { timeout: 30000 }, async (t) => {
  const cleanups = [];
  const cleanup = { after: (fn) => cleanups.push(fn) };
  t.after(async () => {
    for (const fn of cleanups.reverse()) await fn();
  });
  const root = await fs.mkdtemp(path.join(tmpdir(), 'noiseform-server-test-'));
  // Only this verified temporary directory is removed; the project never receives canary files.
  cleanup.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('noiseform-server-test-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  await fs.copyFile(path.join(project, 'server.js'), path.join(root, 'server.js'));
  for (const dir of ['public', 'docs', 'docs-private', 'public-private']) {
    await fs.mkdir(path.join(root, dir));
  }
  await fs.writeFile(path.join(root, 'public', 'index.html'), '<!doctype html><title>fixture</title>');
  const largeScript = '// static compression fixture\n'.repeat(100);
  await fs.writeFile(path.join(root, 'public', 'large.js'), largeScript);
  await fs.writeFile(path.join(root, 'docs', 'guide.md'), '# Local guide');
  await fs.writeFile(path.join(root, 'docs-private', 'canary.txt'), 'PRIVATE DOCS CANARY');
  await fs.writeFile(path.join(root, 'public-private', 'canary.txt'), 'PRIVATE PUBLIC CANARY');
  await fs.mkdir(path.join(root, 'public', 'sub'));

  const forwarded = [];
  const upstreamServer = http.createServer((req, res) => {
    forwarded.push({ path: req.url, token: req.headers.authorization });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"stub":true}');
  });
  upstreamServer.listen(0, '127.0.0.1');
  await once(upstreamServer, 'listening');
  cleanup.after(() => new Promise((resolve) => {
    upstreamServer.closeAllConnections();
    upstreamServer.close(resolve);
  }));
  const upstream = 'http://127.0.0.1:' + upstreamServer.address().port;
  const server = await start(root, upstream, cleanup, { NF_HOST: '' });
  const { port } = server;
  const origin = 'http://127.0.0.1:' + port;

  // Importing exposes the real entrypoint without opening another listener. Restore all env values.
  const env = { NODE_ENV: 'test', NF_TEST_UPSTREAM: upstream, NF_UPSTREAM_PROXY: 'none', NAI_TOKEN: dummyToken };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  cleanup.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const { handleRequest } = createRequire(import.meta.url)(path.join(root, 'server.js'));
  const proxyPaths = [
    '/proxy/health',
    '/proxy/image/ai/generate-image',
    '/proxy/api/user/subscription',
    '/proxy/llm/models',
    '/proxy/unknown',
    '/./proxy/image/ai/generate-image',
    '/%2e/proxy/api/user/subscription',
  ];

  await t.test('F02 default bind is 127.0.0.1 and health retains serverToken', async () => {
    const health = await request(port, '/proxy/health');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).serverToken, true);
    await assert.rejects(request(port, '/proxy/health', {}, '127.0.0.2'), { code: 'ECONNREFUSED' });
  });

  await t.test('F02 non-loopback peers cannot forward or inject NAI_TOKEN, even with spoofed forwarding headers', async () => {
    const before = forwarded.length;
    for (const address of ['192.0.2.10', '::ffff:192.0.2.10', '2001:db8::1', '::10', '127.evil']) {
      for (const target of proxyPaths) {
        const res = await fakeRequest(handleRequest, port, target, address, {
          origin,
          'x-forwarded-for': '127.0.0.1',
          forwarded: 'for=127.0.0.1',
          'x-llm-base': upstream,
        });
        assert.equal(res.status, 403, address + ' ' + target);
        assert.ok(!res.body.includes(dummyToken));
      }
    }
    assert.equal(forwarded.length, before, 'no denied request reached the upstream');
    for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
      const allowed = await fakeRequest(handleRequest, port, '/proxy/image/ai/generate-image', address);
      assert.equal(allowed.status, 200, address);
      assert.equal(forwarded.at(-1).token, 'Bearer ' + dummyToken, 'positive control proves injection path is active');
    }
  });

  await t.test('F02 cross-site Origins and hostile Hosts are denied on every proxy entry', async () => {
    const before = forwarded.length;
    for (const target of proxyPaths) {
      for (const badOrigin of ['https://evil.invalid', 'null', 'http://localhost:' + port, origin + '.evil.invalid', '']) {
        const res = await request(port, target, { origin: badOrigin, 'x-llm-base': upstream });
        assert.equal(res.status, 403, target + ' Origin=' + badOrigin);
      }
      for (const host of ['evil.invalid:' + port, '127.0.0.1.evil.invalid:' + port, '127.1:' + port, '2130706433:' + port, 'localhost:1', 'localhost@evil.invalid:' + port]) {
        assert.equal((await request(port, target, { host })).status, 403, target + ' Host=' + host);
      }
    }
    assert.equal(forwarded.length, before);
    assert.equal((await request(port, '/', { host: 'evil.invalid:' + port })).status, 403, 'static Host also prevents DNS rebinding');
    assert.equal((await request(port, '/', { origin: 'https://evil.invalid' })).status, 200, 'static resources do not require Origin');
    for (const host of ['127.0.0.1:' + port, 'localhost:' + port, '[::1]:' + port]) {
      assert.equal((await request(port, '/proxy/health', { host, origin: 'http://' + host })).status, 200);
    }
  });

  await t.test('F02 allowed local image/LLM requests still reach only the local double', async () => {
    for (const target of ['image/ai/generate-image', 'image/user/subscription']) {
      assert.equal((await request(port, '/proxy/' + target + '?fixture=1', { origin })).status, 200);
      assert.equal(forwarded.at(-1).token, 'Bearer ' + dummyToken);
      assert.ok(forwarded.at(-1).path.endsWith('?fixture=1'));
    }
    await request(port, '/proxy/image/user/subscription', { authorization: 'Bearer browser-placeholder' });
    assert.equal(forwarded.at(-1).token, 'Bearer browser-placeholder');
    assert.equal((await request(port, '/proxy/llm/models', { 'x-llm-base': upstream, origin })).status, 200);
    assert.equal(forwarded.at(-1).token, undefined, 'NAI_TOKEN is never injected into LLM calls');
  });

  await t.test('legacy /proxy/api route is retired: 410 not-sent, nothing forwarded', async () => {
    const before = forwarded.length;
    for (const target of ['/proxy/api/user/subscription', '/proxy/api/ai/upscale', '/proxy/api']) {
      const res = await request(port, target, { origin });
      assert.equal(res.status, 410, target);
      assert.equal(res.headers['x-nf-outcome'], 'not-sent');
      assert.equal(JSON.parse(res.body).outcome, 'not-sent');
    }
    assert.equal(forwarded.length, before);
  });

  await t.test('F05 malformed path/query encodings return 400 and health remains available', async () => {
    for (const target of ['/%', '/%2', '/%GG', '/%E0%A4%A', '/%C0%AF', '/%ED%A0%80', '/%FF', '/docs/%E0%A4', '/%00', '/%0a', '/proxy/health?bad=%', '/proxy/image/%F0%9F']) {
      assert.equal((await request(port, target)).status, 400, target);
      assert.equal((await request(port, '/proxy/health')).status, 200, 'health after ' + target);
      assert.equal(server.proc.exitCode, null);
    }
    assert.equal((await request(port, 'http://[invalid')).status, 400);
    assert.equal((await request(port, '//localhost/proxy/health')).status, 400);
    assert.equal((await request(port, '/proxy/health')).status, 200);
  });

  await t.test('F08 rejects docs/public traversal, encoded separators, sibling prefixes and absolute paths', async () => {
    const targets = [
      '/docs/../docs-private/canary.txt',
      '/docs/%2e%2e%5cdocs-private%5ccanary.txt',
      '/docs/%2E%2E%5CDOCS-PRIVATE%5Ccanary.txt',
      '/docs/%2e%2e%2fdocs-private%2fcanary.txt',
      '/../public-private/canary.txt',
      '/%2e%2e%5cpublic-private%5ccanary.txt',
      '/%2e%2e%2fpublic-private%2fcanary.txt',
      '/sub/../../public-private/canary.txt',
      '/docs//docs-private/canary.txt',
      '/docs/C:%5cWindows%5cwin.ini',
      '/C:%5cWindows%5cwin.ini',
      '/%5c%5clocalhost%5cshare%5ccanary.txt',
    ];
    for (const target of targets) {
      const res = await request(port, target);
      assert.equal(res.status, 403, target);
      assert.ok(!res.body.includes('CANARY'));
    }
    assert.equal((await request(port, '/')).status, 200);
    assert.equal((await request(port, '/docs/guide.md')).body, '# Local guide');
    assert.equal((await request(port, '/docs/missing/file.md')).status, 404);
    if (process.platform === 'win32') {
      assert.equal((await request(port, '/docs/GUIDE.MD')).body, '# Local guide', 'Windows paths remain case-insensitive');
    }
  });

  await t.test('F08 realpath containment rejects symlink/junction escapes in both roots', async () => {
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.symlink(path.join(root, 'docs-private'), path.join(root, 'docs', 'outside'), type);
    await fs.symlink(path.join(root, 'public-private'), path.join(root, 'public', 'outside'), type);
    for (const target of ['/docs/outside/canary.txt', '/outside/canary.txt']) {
      const res = await request(port, target);
      assert.equal(res.status, 403);
      assert.ok(!res.body.includes('CANARY'));
    }
  });

  await t.test('F05 normal I/O errors and gzip reads preserve service availability', async () => {
    for (const target of ['/missing.txt', '/docs/guide.md/not-a-file', '/sub/']) {
      assert.equal((await request(port, target, { 'accept-encoding': 'gzip' })).status, 404);
    }
    for (let i = 0; i < 2; i++) {
      const res = await request(port, '/large.js', { 'accept-encoding': 'gzip' });
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-encoding'], 'gzip');
      assert.equal(gunzipSync(res.data).toString(), largeScript);
    }
    await fs.unlink(path.join(root, 'public', 'large.js'));
    assert.equal((await request(port, '/large.js', { 'accept-encoding': 'gzip' })).status, 404);
    assert.equal((await request(port, '/proxy/health')).status, 200);
  });

  await t.test('F05 final exception boundary returns 500 for unexpected async I/O failures', async () => {
    const realStat = fs.stat;
    try {
      fs.stat = async () => { throw Object.assign(new Error('injected unexpected I/O failure'), { code: 'EIO' }); };
      assert.equal((await fakeRequest(handleRequest, port, '/', '127.0.0.1')).status, 500);
    } finally {
      fs.stat = realStat;
    }
    assert.equal((await fakeRequest(handleRequest, port, '/', '127.0.0.1')).status, 200);
    assert.equal((await request(port, '/proxy/health')).status, 200);
  });

  await t.test('F02 explicit wildcard binding retains the loopback-only proxy policy', async (st) => {
    const wildcard = await start(root, upstream, st, { NF_HOST: '0.0.0.0' });
    assert.equal((await request(wildcard.port, '/proxy/health', { host: '127.0.0.1:' + wildcard.port }, '127.0.0.2')).status, 200);
    assert.equal((await fakeRequest(handleRequest, wildcard.port, '/proxy/image/ai/generate-image', '192.0.2.10')).status, 403);
  });
});
