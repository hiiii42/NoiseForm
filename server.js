// NOISEFORM — zero-dependency static server + NovelAI proxy.
// Usage: node server.js   (PORT=8787, optional NAI_TOKEN=pst-... as fallback token,
//        NF_UPSTREAM_PROXY=http://host:port | none — defaults to HTTPS_PROXY, else a direct connection;
//        the browser setting (Settings → Connection → upstream proxy) overrides it per request)
// NF_HOST changes the bind address (default 127.0.0.1), not the trust boundary: all /proxy/*
// calls still require a loopback peer, a local Host and, when supplied, a same-origin Origin.
// There is no LAN proxy sharing/authentication mode, even with NF_HOST=0.0.0.0.
// NODE_ENV=test only: NF_TEST_UPSTREAM may point image/api at a loopback HTTP test double.
// /proxy/llm/* forwards OpenAI-compatible calls (chat/completions, models) for the prompt assistant:
//        the browser sends x-llm-base (endpoint base URL) and x-llm-route (proxy | direct). Local-only.
'use strict';

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const net = require('net');
const { pipeline } = require('stream');
// Reported by /proxy/health so a page served by newer files can tell the process was started before an update.
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; } catch { return null; } })();

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.NF_HOST || '127.0.0.1';
const ROOT = path.join(__dirname, 'public');
const DOCS = path.join(__dirname, 'docs');
const UPSTREAMS = {
  image: 'https://image.novelai.net',
  api: 'https://api.novelai.net',
};
if (process.env.NODE_ENV === 'test' && process.env.NF_TEST_UPSTREAM) {
  const upstream = new URL(process.env.NF_TEST_UPSTREAM);
  if (upstream.protocol !== 'http:' || !isLoopback(upstream.hostname) || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new Error('NF_TEST_UPSTREAM must be a loopback HTTP origin');
  }
  UPSTREAMS.image = UPSTREAMS.api = upstream.origin;
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};
const GZIP = new Set(['.html', '.js', '.css', '.json', '.svg', '.tsv']);
const gzCache = new Map(); // file -> { mtime, buf }

// Upstream HTTP proxy (CONNECT tunnel). Order: the browser's setting, sent per request as
// x-nf-upstream (http://host:port | none) > NF_UPSTREAM_PROXY > HTTPS_PROXY > direct.
const UPSTREAM_PROXY = (() => {
  const v = process.env.NF_UPSTREAM_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!v || /^none$/i.test(v)) return null;
  try { return new URL(v); } catch { console.warn('  ignoring invalid upstream proxy setting'); return null; }
})();

function tunnelAgent(p) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });
  agent.createConnection = (opts, cb) => {
    let settled = false;
    const ready = (err, socket) => {
      if (settled) return;
      settled = true;
      // The origin request cannot send bytes until this agent supplies its TLS socket.
      if (err) err.notSent = true;
      cb(err, socket);
    };
    const target = `${opts.host}:${opts.port || 443}`;
    const headers = { host: target };
    if (p.username) headers['proxy-authorization'] = 'Basic ' + Buffer.from(decodeURIComponent(p.username) + ':' + decodeURIComponent(p.password)).toString('base64');
    const req = http.request({ host: p.hostname, port: p.port || 80, method: 'CONNECT', path: target, headers });
    req.setTimeout(15000, () => req.destroy(new Error('proxy CONNECT timeout')));
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return ready(new Error(`proxy CONNECT ${target} → ${res.statusCode}`));
      }
      const s = tls.connect({ socket, servername: opts.servername || opts.host, ALPNProtocols: ['http/1.1'] });
      s.once('secureConnect', () => ready(null, s));
      s.once('error', ready);
    });
    req.once('error', (err) => ready(new Error(`upstream proxy ${p.host} unreachable (${err.code || err.message})`)));
    req.end();
  };
  return agent;
}
const directAgent = new https.Agent({ keepAlive: true });
const tunnels = new Map(); // proxy origin → agent (a few at most: one per setting the user has tried)
function agentFor(proxyUrl) {
  if (!proxyUrl) return directAgent;
  const key = proxyUrl.href;
  if (!tunnels.has(key)) {
    if (tunnels.size >= 8) { const [oldKey, old] = tunnels.entries().next().value; old.destroy(); tunnels.delete(oldKey); }
    tunnels.set(key, tunnelAgent(proxyUrl));
  }
  return tunnels.get(key);
}
// The browser may only name a plain http://host:port proxy (no credentials, path or query); anything
// else is rejected. Absent header = the server's environment default.
function upstreamFor(req) {
  const v = req.headers['x-nf-upstream'];
  if (v === undefined) return UPSTREAM_PROXY;
  if (/^none$/i.test(v)) return null;
  const m = /^http:\/\/([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:]{2,39}\]):([0-9]{1,5})$/.exec(String(v));
  if (!m || +m[2] < 1 || +m[2] > 65535) throw Object.assign(new Error('Invalid upstream proxy (expected http://host:port)'), { status: 400 });
  return new URL(v);
}

function isLoopback(address) {
  if (address === '::1') return true;
  if (address?.toLowerCase().startsWith('::ffff:')) address = address.slice(7);
  return net.isIP(address || '') === 4 && address.startsWith('127.');
}

function reply(res, code, message) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) return res.destroy();
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(message);
}

function localOrigin(req) {
  const host = req.headers.host;
  // Check the literal authority before URL parsing can canonicalize an attacker-controlled Host.
  if (typeof host !== 'string' || !/^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i.test(host)) return null;
  const url = new URL('http://' + host);
  if (Number(url.port || '80') !== req.socket.localPort) return null;
  return url.origin;
}

// Bounded process-local diagnostics: no request/response headers or payloads.
const diagnosticRows = [];
function redactDiagnostic(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s<>"']+/gi, (s) => { try { const u = new URL(s); return u.origin + u.pathname; } catch { return '[url]'; } })
    .replace(/\bBearer\s+[^\s,"';]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:pst|sk)-[^\s,"';<>]+/gi, '[redacted]')
    .replace(/[A-Za-z0-9+/_-]{80,}={0,2}/g, '[base64]').slice(0, 300);
}
const responseDiagnostics = new WeakMap();
function startDiagnostic(req, res, target, rest) {
  const start = performance.now();
  const row = { time: new Date().toISOString(), target, method: req.method,
    path: redactDiagnostic(rest.split('?')[0]), status: null, ms: null, msHeaders: null, bytes: 0, outcome: null, error: '', disconnected: false };
  let ended = false;
  const finish = (outcome) => {
    if (ended) return;
    ended = true;
    row.ms = Math.round(performance.now() - start);
    row.outcome = outcome;
    diagnosticRows.push(row);
    if (diagnosticRows.length > 200) diagnosticRows.shift();
    if (process.env.NF_LOG !== '0') console.log(JSON.stringify(row));
  };
  const trace = {
    host(host) { row.host = redactDiagnostic(host); },
    fail(error, outcome) { if (!ended) { row.error = redactDiagnostic(error); row.outcome = outcome; } },
    headers(upRes) {
      row.status = upRes.statusCode;
      row.msHeaders = Math.round(performance.now() - start);
      upRes.on('data', (chunk) => { row.bytes += chunk.length; });
      const truncated = () => {
        if (ended || row.outcome === 'client-closed') return;
        row.outcome = 'truncated'; row.disconnected = true; row.error = 'Upstream response interrupted';
      };
      upRes.once('aborted', truncated);
      upRes.once('error', truncated);
    },
  };
  res.once('finish', () => finish(row.outcome || (res.statusCode < 400 ? 'ok' : 'http-error')));
  res.once('close', () => {
    if (!res.writableFinished) {
      row.disconnected = true;
      finish(row.outcome === 'truncated' ? 'truncated' : 'client-closed');
    }
  });
  responseDiagnostics.set(res, trace);
  return trace;
}

function forwardRequest(req, res, up, fail) {
  let connecting = false;
  up.once('socket', (socket) => {
    connecting = socket.connecting;
    if (connecting) socket.once('connect', () => { connecting = false; });
  });
  up.on('timeout', () => up.destroy(new Error('upstream timeout')));
  up.on('error', (err) => {
    // finish/writableFinished only describe local flushing, not upstream acceptance.
    // Even a partial write or a failure on a reused socket is uncertain. Only proven
    // connection-establishment failures are safe to retry; correlation IDs are not keys.
    const outcome = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined
      : connecting || err.notSent === true ? 'not-sent' : 'unknown';
    responseDiagnostics.get(res)?.fail(err.message, outcome || (connecting || err.notSent === true ? 'not-sent' : 'unknown'));
    fail(err, outcome);
  });
  const abort = () => up.destroy();
  req.once('aborted', abort);
  req.once('error', abort);
  res.once('close', () => { if (!res.writableFinished) abort(); });
  req.pipe(up);
}

function forwardResponse(upRes, res) {
  responseDiagnostics.get(res)?.headers(upRes);
  // pipeline preserves chunks/backpressure and destroys both ends on truncation,
  // stream error or client disconnect. Consume its error after that teardown.
  pipeline(upRes, res, () => {});
}

// OpenAI-compatible relay for the prompt assistant (avoids browser CORS). Only from this machine, only
// https endpoints (or http on localhost, e.g. Ollama), only the two paths the app uses.
function proxyLLM(req, res, rest) {
  const trace = startDiagnostic(req, res, 'llm', rest);
  const fail = (code, message, outcome) => {
    trace.fail(message, outcome || 'http-error');
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) return res.destroy();
    res.writeHead(code, { 'content-type': 'application/json', ...(outcome ? { 'x-nf-outcome': outcome } : {}) });
    res.end(JSON.stringify({ error: { message }, ...(outcome ? { outcome } : {}) }));
  };
  let base;
  try {
    base = new URL(req.headers['x-llm-base'] || '');
  } catch {
    return fail(400, 'Missing or invalid x-llm-base');
  }
  trace.host(base.host);
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(base.hostname);
  if (!(base.protocol === 'https:' || (base.protocol === 'http:' && local))) return fail(400, 'Only https endpoints (or http://localhost)');
  if (!/^\/(chat\/completions|models)$/.test(rest)) return fail(400, 'Only /chat/completions and /models');
  const url = new URL(base.pathname.replace(/\/+$/, '') + rest, base);
  const headers = { 'user-agent': 'NOISEFORM/1.0' };
  for (const h of ['content-type', 'accept', 'authorization', 'content-length']) if (req.headers[h]) headers[h] = req.headers[h];
  const plain = url.protocol === 'http:';
  let upstream;
  try { upstream = upstreamFor(req); } catch (err) { return fail(400, err.message); }
  const agent = plain ? undefined : local || req.headers['x-llm-route'] === 'direct' ? directAgent : agentFor(upstream);
  const up = (plain ? http : https).request(
    { hostname: url.hostname, port: url.port || (plain ? 80 : 443), path: url.pathname + url.search, method: req.method, headers, agent, timeout: 180000 },
    (upRes) => {
      const out = { 'cache-control': 'no-store' };
      if (upRes.headers['content-type']) out['content-type'] = upRes.headers['content-type'];
      res.writeHead(upRes.statusCode, out);
      forwardResponse(upRes, res);
    }
  );
  forwardRequest(req, res, up, (err, outcome) => fail(502, 'LLM proxy error: ' + err.message, outcome));
}

function proxy(req, res, target, rest) {
  startDiagnostic(req, res, target, rest);
  const url = new URL(UPSTREAMS[target] + rest);
  const headers = { 'user-agent': 'NOISEFORM/1.0' };
  for (const h of ['content-type', 'accept', 'authorization', 'content-length', 'x-correlation-id', 'x-initiated-at']) {
    if (req.headers[h]) headers[h] = req.headers[h];
  }
  if (!headers.authorization && process.env.NAI_TOKEN) {
    headers.authorization = 'Bearer ' + process.env.NAI_TOKEN;
  }
  const fail = (err, outcome) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) return res.destroy(err);
    res.writeHead(502, { 'content-type': 'application/json', ...(outcome ? { 'x-nf-outcome': outcome } : {}) });
    res.end(JSON.stringify({ message: 'Proxy error: ' + err.message, ...(outcome ? { outcome } : {}) }));
  };
  let upstream;
  try { upstream = upstreamFor(req); }
  catch (err) {
    // rejected before anything was sent: a plain, known error
    res.writeHead(400, { 'content-type': 'application/json', 'x-nf-outcome': 'not-sent' });
    return res.end(JSON.stringify({ message: err.message, outcome: 'not-sent' }));
  }
  const plain = url.protocol === 'http:';
  const up = (plain ? http : https).request(
    { hostname: url.hostname, port: url.port || (plain ? 80 : 443), path: url.pathname + url.search, method: req.method, headers, agent: plain ? undefined : agentFor(upstream), timeout: 300000 },
    (upRes) => {
      const out = { 'cache-control': 'no-store' };
      if (upRes.headers['content-type']) out['content-type'] = upRes.headers['content-type'];
      if (upRes.headers['content-length']) out['content-length'] = upRes.headers['content-length'];
      res.writeHead(upRes.statusCode, out);
      forwardResponse(upRes, res);
    }
  );
  forwardRequest(req, res, up, fail);
}

function within(base, file) {
  const relative = path.relative(base, file);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function serveStatic(req, res, pathname) {
  const docs = pathname.startsWith('/docs/');
  const base = docs ? DOCS : ROOT;
  const relative = docs ? pathname.slice('/docs/'.length) : pathname.slice(1);
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative)) return reply(res, 403, 'Forbidden path');
  let file = path.resolve(base, relative);
  if (!within(base, file)) return reply(res, 403, 'Forbidden path');
  let data, st;
  try {
    // Resolve both the root and final file so a symlink/junction (including index.html) cannot escape.
    const realBase = await fs.promises.realpath(base);
    file = await fs.promises.realpath(file);
    if (!within(realBase, file)) return reply(res, 403, 'Forbidden path');
    st = await fs.promises.stat(file);
    if (st.isDirectory()) {
      file = await fs.promises.realpath(path.join(file, 'index.html'));
      if (!within(realBase, file)) return reply(res, 403, 'Forbidden path');
      st = await fs.promises.stat(file);
    }
    if (!st.isFile()) return reply(res, 404, '404');
    data = await fs.promises.readFile(file);
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP'].includes(err.code)) return reply(res, 404, '404');
    if (['EACCES', 'EPERM'].includes(err.code)) return reply(res, 403, 'Forbidden path');
    throw err;
  }
  const ext = path.extname(file).toLowerCase();
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-cache',
  };
  if (GZIP.has(ext) && data.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    const mtime = st.mtimeMs;
    let c = gzCache.get(file);
    if (!c || c.mtime !== mtime) gzCache.set(file, (c = { mtime, buf: zlib.gzipSync(data, { level: 6 }) }));
    headers['content-encoding'] = 'gzip';
    headers.vary = 'accept-encoding';
    data = c.buf;
  }
  if (res.destroyed) return;
  res.writeHead(200, headers);
  res.end(data);
}

async function handleRequest(req, res) {
  try {
    let pathname, routePath, search, origin;
    try {
      origin = localOrigin(req);
      // Decode before WHATWG URL normalization: otherwise dot segments/backslashes can disappear.
      if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('#')) throw new URIError('Invalid request target');
      const query = req.url.indexOf('?');
      const rawPath = query < 0 ? req.url : req.url.slice(0, query);
      search = query < 0 ? '' : req.url.slice(query);
      decodeURIComponent(search);
      pathname = decodeURIComponent(rawPath).replace(/\\/g, '/');
      if (/[\x00-\x1f\x7f]/.test(pathname)) throw new URIError('Invalid path');
      routePath = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return reply(res, 400, 'Bad request URL or Host');
    }
    if (!origin) return reply(res, 403, 'Local Host required');
    if (pathname.split('/').includes('..')) return reply(res, 403, 'Forbidden path');
    if ([pathname, routePath].some((p) => p === '/proxy' || p.startsWith('/proxy/'))) {
      if (!isLoopback(req.socket.remoteAddress)) return reply(res, 403, 'Proxy is local-only');
      // Forwarded headers are deliberately ignored: only the TCP peer establishes locality.
      if (req.headers.origin !== undefined && req.headers.origin !== origin) return reply(res, 403, 'Same-origin requests required');
    }
    if (pathname === '/proxy/diag') {
      if (req.method !== 'GET') return reply(res, 405, 'GET required');
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(diagnosticRows));
    }
    if (pathname === '/proxy/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, version: VERSION, serverToken: !!process.env.NAI_TOKEN, upstreamProxy: UPSTREAM_PROXY ? UPSTREAM_PROXY.host : null }));
    }
    if (routePath.startsWith('/proxy/llm/')) return proxyLLM(req, res, routePath.slice('/proxy/llm'.length));
    const m = routePath.match(/^\/proxy\/(image|api)(\/.*)$/);
    if (m) return proxy(req, res, m[1], m[2] + search);
    await serveStatic(req, res, pathname);
  } catch {
    // Covers synchronous routing errors and asynchronous static I/O without terminating the server.
    reply(res, 500, 'Internal server error');
  }
}

module.exports = { handleRequest };
if (require.main === module) {
  http.createServer(handleRequest).listen(PORT, HOST, () => {
    console.log('\n  NOISEFORM  →  http://' + HOST + ':' + PORT);
    console.log('  upstream   →  ' + (UPSTREAM_PROXY ? 'via proxy ' + UPSTREAM_PROXY.host : 'direct') + '\n');
  });
}
