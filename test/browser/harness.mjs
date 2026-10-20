// Zero-dependency browser test harness: local server on a free port + headless Chrome over CDP.
// External network is blocked (only localhost, data: and blob: pass); /proxy/* is blocked unless allowProxy.
// Usage in a spec:  export default async ({ page, url, assert, log }) => { ... }
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ARTIFACTS = process.env.NF_TEST_ARTIFACTS
  ? resolve(process.env.NF_TEST_ARTIFACTS) : mkdtempSync(join(tmpdir(), 'nf-artifacts-'));
mkdirSync(ARTIFACTS, { recursive: true });
/** Shared run directory; create nested parents, reject paths outside the directory. */
export function artifact(name) {
  const path = resolve(ARTIFACTS, name);
  const rel = relative(ARTIFACTS, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Artifact path must stay inside the run directory');
  mkdirSync(dirname(path), { recursive: true });
  return path;
}
const CHROME_CANDIDATES = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
export const chromePath = () => CHROME_CANDIDATES.find((p) => existsSync(p)) || null;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const resources = new Set();
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  if (stopping) return;
  stopping = true;
  await Promise.allSettled([...resources].map((r) => r.close()));
  process.exit(signal === 'SIGINT' ? 130 : 143);
});
process.once('exit', () => {
  for (const r of resources) r.emergency();
});

function removeProfile(profile) {
  if (!profile) return;
  if (dirname(resolve(profile)) !== resolve(tmpdir()) || !profile.includes('nftest-')) throw new Error('Invalid test profile path');
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function track(proc, profile) {
  let exited = false;
  let spawnError;
  const done = new Promise((res) => {
    proc.once('exit', () => { exited = true; res(); });
    proc.once('error', (error) => { spawnError = error; exited = true; res(); });
  });
  const kill = () => {
    if (exited) return;
    if (process.platform === 'win32' && proc.pid) spawnSync('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    else if (profile && proc.pid) {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
    } else proc.kill('SIGKILL');
  };
  let closing;
  const resource = {
    error: () => spawnError,
    exited: () => exited,
    close: () => closing ||= (async () => {
      if (!exited) {
        if (profile) kill();
        else proc.kill();
      }
      await Promise.race([done, sleep(2000)]);
      if (!exited) {
        kill();
        await Promise.race([done, sleep(2000)]);
      }
      removeProfile(profile);
      resources.delete(resource);
    })(),
    emergency() {
      kill();
      try { removeProfile(profile); } catch {}
    },
  };
  resources.add(resource);
  return resource;
}

export function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

/** Starts server.js on a free port. env overrides are merged (NAI_TOKEN is removed unless given). */
export async function startServer(env = {}) {
  const port = await freePort();
  const childEnv = { ...process.env, PORT: String(port), ...env };
  if (!('NAI_TOKEN' in env)) delete childEnv.NAI_TOKEN;
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const resource = track(proc);
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  let ready = false;
  for (let i = 0; i < 50 && !resource.exited(); i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/proxy/health`, { signal: AbortSignal.timeout(1000) });
      if (r.status < 500) { ready = true; break; }
    } catch {}
    await sleep(100);
  }
  if (!ready) {
    await resource.close();
    throw new Error('Test server did not start: ' + (resource.error()?.message || out));
  }
  return { port, url: `http://127.0.0.1:${port}/`, proc, output: () => out, stop: resource.close };
}

/** Launches headless Chrome and returns a page API. opts: { width, height, allowProxy, init: [scriptSource] } */
export async function launch(opts = {}) {
  const chrome = chromePath();
  if (!chrome) throw new Error('Chrome not found (set CHROME=path)');
  const { width = 1600, height = 1000 } = opts;
  const port = await freePort();
  const prof = mkdtempSync(join(tmpdir(), 'nftest-'));
  let proc;
  try {
    proc = spawn(chrome, [`--remote-debugging-port=${port}`, '--headless=new', `--user-data-dir=${prof}`, `--window-size=${width},${height}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-gpu-sandbox', '--disable-extensions', ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []), 'about:blank'], { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
  } catch (error) {
    removeProfile(prof);
    throw error;
  }
  const resource = track(proc, prof);
  let ws;
  try {
    let targets;
    for (let i = 0; i < 80 && !resource.exited(); i++) {
      try {
        targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) })).json();
        if (targets.find((t) => t.type === 'page')) break;
      } catch {}
      await sleep(150);
    }
    const target = targets?.find((t) => t.type === 'page');
    if (!target) throw new Error('Chrome did not start: ' + (resource.error()?.message || chrome));
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('Chrome WebSocket startup timeout')), 10000);
      ws.onopen = () => { clearTimeout(timer); res(); };
      ws.onerror = () => { clearTimeout(timer); rej(new Error('Chrome WebSocket failed')); };
    });
    let id = 0;
    const pending = new Map();
    const logs = [];
    const errors = [];
    const listeners = new Set();
    const blocked = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id).resolve(msg);
        pending.delete(msg.id);
        return;
      }
      for (const fn of listeners) fn(msg);
      if (msg.method === 'Runtime.exceptionThrown') {
        const t = 'EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
        logs.push(t);
        errors.push(t);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const t = `console.${msg.params.type}: ` + msg.params.args.map((a) => a.value ?? a.description).join(' ');
        logs.push(t);
        if (msg.params.type === 'error') errors.push(t);
      } else if (msg.method === 'Fetch.requestPaused') {
        const u = msg.params.request.url;
        const local = /^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/|data:|blob:)/.test(u);
        const proxy = /^\/proxy\/(?!health(?:$|\/))/.test(new URL(u).pathname);
        if (local && (!proxy || opts.allowProxy)) send('Fetch.continueRequest', { requestId: msg.params.requestId }).catch(() => {});
        else {
          blocked.push(u);
          send('Fetch.failRequest', { requestId: msg.params.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
        }
      }
    };
    const send = (method, params = {}) => {
      if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Chrome WebSocket is not open'));
      return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => {
          pending.delete(i);
          rej(new Error('CDP timeout: ' + method));
        }, 60000);
        const reject = (error) => { clearTimeout(timer); rej(error); };
        pending.set(i, { resolve(msg) { clearTimeout(timer); res(msg); }, reject });
        try { ws.send(JSON.stringify({ id: i, method, params })); }
        catch (error) { pending.delete(i); reject(error); }
      });
    };
    ws.onclose = () => {
      for (const p of pending.values()) p.reject(new Error('Chrome WebSocket closed'));
      pending.clear();
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    // tours off by default so they don't cover the UI
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `try{ if(!localStorage.getItem('nf.tours')) localStorage.setItem('nf.tours', JSON.stringify({main:true,post:true,firstImage:true})) }catch{}` });
    for (const src of opts.init || []) await send('Page.addScriptToEvaluateOnNewDocument', { source: src });
    const page = {
      send,
      logs,
      errors,
      blocked,
      on: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
      wait: sleep,
      async goto(url, settle = 2500) {
        await send('Page.navigate', { url });
        await sleep(settle);
      },
      async reload(settle = 2500) {
        await send('Page.reload', {});
        await sleep(settle);
      },
      async eval(expr) {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.result?.exceptionDetails) throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
        return r.result?.result?.value;
      },
      /** run fn (serialised) in the page with JSON args: page.run((a,b)=>a+b, 1, 2) */
      async run(fn, ...args) {
        return page.eval(`(${fn.toString()})(...${JSON.stringify(args)})`);
      },
      async waitFor(expr, timeout = 10000, every = 100) {
        const t0 = Date.now();
        for (;;) {
          const v = await page.eval(expr).catch(() => undefined);
          if (v) return v;
          if (Date.now() - t0 > timeout) throw new Error('waitFor timeout: ' + expr.slice(0, 120));
          await sleep(every);
        }
      },
      async click(sel) {
        const r = await page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.click(); return true})()`);
        if (!r) throw new Error('click: not found ' + sel);
      },
      async key(key, modifiers = 0, code) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: code || key, modifiers, windowsVirtualKeyCode: key === 'Enter' ? 13 : 0 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: code || key, modifiers });
      },
      async type(text) {
        await send('Input.insertText', { text });
      },
      async mouse(type, x, y, extra = {}) {
        await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
      },
      async shot(path) {
        const r = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(path, Buffer.from(r.result.data, 'base64'));
      },
      async close() {
        // Ask Chrome to release its profile locks before terminating the process tree.
        try { await Promise.race([send('Browser.close'), sleep(1000)]); } catch {}
        try { ws.close(); } catch {}
        await resource.close();
      },
    };
    return page;
  } catch (error) {
    try { ws?.close(); } catch {}
    await resource.close();
    throw error;
  }
}
