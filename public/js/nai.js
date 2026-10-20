// NovelAI HTTP client + request builders + Anlas cost model.
import { state } from './store.js';
import * as diag from './diag.js';
import { modelById, QUALITY_TAGS, UC_PRESETS, posClamp, posSnap } from './data.js';
import { unzip, isZip } from './zip.js';
import { isPNG } from './png.js';
import { bytesToBase64, blobToBase64, loadImage, makeCanvas, canvasToBlob, uid } from './util.js';
import { decodeStreamFrames } from './msgpack.js';
import { t, getLang } from './i18n.js';
import { generationCost as domainGenerationCost } from './domain/cost.js';

const DIRECT = { image: 'https://image.novelai.net', api: 'https://api.novelai.net' };
// Watchdog (1.8.5). A request must end even when the network goes quiet: a black-holed route, a dead
// pooled socket behind a proxy, or a response body that stops. Without these a generation sat at the
// capped estimate (≈93%) forever. Mutating requests that time out are UNKNOWN results (they may have run
// and been charged) and are never resent; tests shorten the values.
export const TIMEOUTS = { probe: 8000, headers: 240000, idle: 120000 };
const stalled = (ms) => new Error((getLang() === 'zh' ? `服务器 ${Math.round(ms / 1000)} 秒没有响应` : `No response from the server for ${Math.round(ms / 1000)}s`));
const timeoutSignal = (ms) => { const c = new AbortController(); const id = setTimeout(() => c.abort(new DOMException('timeout', 'TimeoutError')), ms); return { signal: c.signal, clear: () => clearTimeout(id) }; };
const anySignal = (...list) => AbortSignal.any(list.filter(Boolean));
const PROXY = { image: '/proxy/image', api: '/proxy/api' };

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let proxyAvailable = false;
let resolvedConn = null;

export class UnknownResultError extends ApiError {
  constructor(cause) {
    super(0, t('err.unknown'));
    this.unknown = true;
    this.cause = cause;
  }
}

// Capture credentials/route once per operation, including asynchronous image preparation.
export function connectionContext() {
  const token = (state.settings.token || '').trim();
  return Object.freeze({
    identity: token ? 'browser-token' : state.session.serverToken ? 'server-token' : 'demo',
    token, mode: state.settings.conn, proxy: proxyAvailable, resolved: resolvedConn,
  });
}

// Settings → upstream proxy. Only sent to our own local server, which uses it to reach NovelAI.
const UPSTREAM_HOST = /^([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:]{2,39}\])$/;
export function upstreamSetting(u = state.settings.upstream) {
  if (!u?.on) return null;
  const port = Number(u.port);
  const host = String(u.host || '').trim();
  return UPSTREAM_HOST.test(host) && Number.isInteger(port) && port >= 1 && port <= 65535 ? `http://${host}:${port}` : null;
}
export const upstreamHeaders = () => { const v = upstreamSetting(); return v ? { 'x-nf-upstream': v } : {}; };
const routeHeaders = (route, headers) => (route === PROXY ? { ...headers, ...upstreamHeaders() } : headers);

export async function probeProxy() {
  try {
    const r = await fetch('/proxy/health', { cache: 'no-store' });
    const j = r.ok ? await r.json() : null;
    proxyAvailable = j?.ok === true;
    state.session.serverToken = proxyAvailable && j?.serverToken === true;
    state.session.upstreamProxy = j?.upstreamProxy || null;
    // The static files are read fresh on every load, server.js only at start: an old process keeps old
    // proxy behaviour (before 1.8.3 a response cut off upstream never ended → generation stuck at ~93%).
    const page = globalThis.document?.querySelector('.brand-v')?.textContent.trim().replace(/^v/, '');
    state.session.serverStale = proxyAvailable && page && j.version !== page ? (j.version || '?') : null;
  } catch {
    proxyAvailable = false;
    state.session.serverToken = false;
    state.session.serverStale = null;
  }
  state.session.proxy = proxyAvailable;
  resolvedConn = null;
  return proxyAvailable;
}

function routes(connection) {
  const { mode, proxy, identity } = connection;
  if (identity === 'server-token') return [PROXY];
  if (mode === 'proxy' && proxy) return [PROXY];
  if (mode === 'direct') return [DIRECT];
  if (connection.resolved === 'proxy') return [PROXY];
  if (connection.resolved === 'direct') return [DIRECT];
  return proxy ? [DIRECT, PROXY] : [DIRECT];
}

function friendly(status, msg) {
  if (status === 401) return t('err.auth');
  if (status === 402) return t('err.anlas');
  if (status === 429) return t('err.busy');
  if (status === 403 && /free generations are unavailable/i.test(msg)) return t('err.freeBlocked');
  return msg || `HTTP ${status}`;
}

async function call(kind, path, { method = 'POST', body, auth = true, signal, connection = connectionContext() } = {}) {
  const headers = { 'x-correlation-id': uid().slice(0, 6), 'x-initiated-at': new Date().toISOString() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth && connection.token) headers.authorization = 'Bearer ' + connection.token;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const mutating = !['GET', 'HEAD'].includes(method);
  const meta = (route, probe = false) => ({ kind: probe ? 'image' : kind, path: probe ? '/user/subscription' : path,
    method: probe ? 'GET' : method, route: route === PROXY ? 'proxy' : 'direct', mutating: probe ? false : mutating,
    correlationId: headers['x-correlation-id'], stream: path.endsWith('-stream') && !probe, probe });
  let list = routes(connection);
  if (mutating && list.length > 1) {
    let selected = null;
    for (const route of list) {
      const trace = diag.begin(meta(route, true));
      const limit = timeoutSignal(TIMEOUTS.probe);
      try {
        signal?.throwIfAborted();
        const probe = await fetch(route.image + '/user/subscription', { method: 'GET', headers: routeHeaders(route, headers), signal: anySignal(signal, limit.signal) });
        trace.headers(probe.status);
        await probe.body?.cancel();
        trace.end(probe.ok ? 'ok' : 'http-error', probe.ok ? '' : `HTTP ${probe.status}`);
        selected = route;
        break;
      } catch (err) {
        trace.end(signal?.aborted ? 'aborted' : limit.signal.aborted ? 'timeout-headers' : 'network', err.message);
        if (signal?.aborted) throw err;
      } finally { limit.clear(); }
    }
    if (!selected) throw new ApiError(0, t('err.network'));
    if (connection.mode === 'auto' && connection.identity === 'browser-token') resolvedConn = selected === PROXY ? 'proxy' : 'direct';
    list = [selected];
  }
  let lastErr;
  for (let i = 0; i < list.length; i++) {
    const trace = diag.begin(meta(list[i]));
    let res;
    const wait = timeoutSignal(TIMEOUTS.headers);
    const own = new AbortController();
    wait.signal.addEventListener('abort', () => own.abort(wait.signal.reason));
    try {
      signal?.throwIfAborted();
      res = await fetch(list[i][kind] + path, { method, headers: routeHeaders(list[i], headers), body: payload, signal: anySignal(signal, own.signal) });
      trace.headers(res.status);
    } catch (err) {
      const timedOut = wait.signal.aborted;
      trace.end(signal?.aborted ? 'aborted' : timedOut ? 'timeout-headers' : mutating ? 'unknown' : 'network', err.message);
      if (signal?.aborted) throw err;
      if (mutating) {
        resolvedConn = null;
        throw new UnknownResultError(timedOut ? stalled(TIMEOUTS.headers) : err);
      }
      lastErr = timedOut ? stalled(TIMEOUTS.headers) : err;
      continue;
    } finally { wait.clear(); }
    if (list[i] === PROXY && connection.mode === 'auto' && connection.identity === 'browser-token') resolvedConn = 'proxy';
    const reader = res.body?.getReader();
    const status = res.status;
    const knownOutcome = mutating && res.headers.get('x-nf-outcome') === 'unknown' ? 'unknown' : res.ok ? 'ok' : 'http-error';
    // Monitor all response reads, including HTTP error bodies and read-only API calls.
    if (reader) {
      res = diag.attach(new Response(new ReadableStream({
        async pull(controller) {
          let idle, aborted, idleExpired = false;
          // The header watchdog is finished. Only caller cancellation races body reads;
          // an idle failure below aborts the transport through own directly.
          const cancelSignal = anySignal(signal);
          try {
            const quiet = new Promise((_, reject) => { idle = setTimeout(() => { idleExpired = true; reject(stalled(TIMEOUTS.idle)); }, TIMEOUTS.idle); });
            const cancelled = new Promise((_, reject) => {
              aborted = () => reject(cancelSignal.reason);
              cancelSignal.addEventListener('abort', aborted, { once: true });
              if (cancelSignal.aborted) aborted();
            });
            const { value, done } = await Promise.race([reader.read(), quiet, cancelled]);
            if (done) { trace.end(knownOutcome, knownOutcome === 'ok' ? '' : `HTTP ${status}`); controller.close(); }
            else { trace.bytes(value.byteLength); controller.enqueue(value); }
          } catch (err) {
            const userAbort = signal?.aborted;
            trace.end(userAbort ? 'aborted' : idleExpired ? 'timeout-idle' : mutating ? 'unknown' : 'network', err.message);
            if (mutating && !userAbort) resolvedConn = null;
            own.abort(err);
            reader.cancel(err).catch(() => {});
            controller.error(userAbort || !mutating ? err : new UnknownResultError(err));
          } finally { clearTimeout(idle); if (aborted) cancelSignal.removeEventListener('abort', aborted); }
        },
        cancel(reason) { trace.end('aborted', 'Response reader cancelled'); own.abort(reason); return reader.cancel(reason); },
      }), { status, statusText: res.statusText, headers: res.headers }), trace);
    } else { trace.end(knownOutcome, knownOutcome === 'ok' ? '' : `HTTP ${status}`); diag.attach(res, trace); }
    if (!res.ok) {
      let msg = '';
      let unknown = knownOutcome === 'unknown';
      let bodyFailed = false;
      try {
        const txt = await res.text();
        try {
          const error = JSON.parse(txt);
          unknown ||= mutating && error?.outcome === 'unknown';
          msg = error?.message || txt;
        } catch { msg = txt; }
      } catch (err) {
        if (signal?.aborted) throw err;
        bodyFailed = true; // HTTP rejection is already known even if its explanation is cut off.
      }
      if (unknown) {
        if (!bodyFailed) trace.end('unknown', `HTTP ${status}: upstream result unknown`);
        resolvedConn = null;
        throw new UnknownResultError(new ApiError(status, String(msg).slice(0, 300)));
      }
      throw new ApiError(status, friendly(status, String(msg).slice(0, 300)));
    }
    return res;
  }
  throw new ApiError(0, t('err.network') + (lastErr ? `\n(${lastErr.message})` : ''));
}

async function readImages(res) {
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (isZip(bytes)) {
    const files = await unzip(bytes);
    return files
      .filter((f) => /\.(png|webp|jpe?g)$/i.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
      .map((f) => new Blob([f.data], { type: /\.webp$/i.test(f.name) ? 'image/webp' : 'image/png' }));
  }
  if (isPNG(bytes)) return [new Blob([bytes], { type: 'image/png' })];
  throw new ApiError(0, t('copy.nai.0'));
}

// ---------------------------------------------------------------- prompt assembly

export function qualitySuffix(params, model) {
  let q = QUALITY_TAGS[model.id];
  if (Array.isArray(q)) q = q[params.qualityPreset || 0] || q[0];
  if (!params.qualityToggle) q = '';
  if (model.transparency && params.transparent) q = q ? 'transparent background, ' + q : 'transparent background';
  return q || '';
}

// V5: quoted strings become an explicit "teXt:" block unless the user wrote text: themselves.
function autoText(prompt) {
  if (/text:/i.test(prompt)) return '';
  const quotes = [...prompt.matchAll(/"([^"]+)"|“([^”]+)”|「([^」]+)」/g)].map((m) => m[1] || m[2] || m[3]).filter(Boolean);
  return quotes.length ? 'teXt: ' + quotes.join('\n\n') : '';
}

export function buildPrompt(params, model) {
  let out = withQuality(params.prompt, qualitySuffix(params, model));
  if (model.v5) {
    const txt = autoText(params.prompt);
    if (txt) out += ', ' + txt;
  }
  return out;
}

export function withQuality(prompt, q) {
  prompt = prompt.trim();
  if (!q) return prompt;
  const pipe = prompt.indexOf('|');
  let head = pipe >= 0 ? prompt.slice(0, pipe) : prompt;
  const tail = pipe >= 0 ? prompt.slice(pipe) : '';
  let text = '';
  const ti = head.search(/\bText:/);
  if (ti >= 0) {
    text = head.slice(ti);
    head = head.slice(0, ti);
  }
  head = head.replace(/[\s,]+$/, '');
  return (head ? head + ', ' + q : q) + (text ? ', ' + text : '') + (tail ? ' ' + tail : '');
}

export function ucPresetsFor(modelId) {
  return UC_PRESETS[modelId] || UC_PRESETS['nai-diffusion-4-5-full'];
}

export function assembleUC(params, model) {
  const presets = ucPresetsFor(model.id);
  const preset = presets[Math.min(params.ucPreset, presets.length - 1)] || presets[0];
  if (model.forcedUC) return presets[0][1];
  const user = (params.uc || '').trim();
  let uc = preset[1] ? (user ? preset[1] + ', ' + user : preset[1]) : user;
  if (model.full && preset[0] !== 'None' && !/nsfw/i.test(params.prompt)) uc = 'nsfw, ' + uc;
  return uc;
}

export function varietySigma(model, w, h) {
  if (!model.varietyBase) return null;
  return model.varietyBase * Math.sqrt((Math.floor(w / 8) * Math.floor(h / 8)) / (104 * 152));
}

export function normalizedStrengths(list, normalize) {
  const s = list.map((v) => v.strength);
  if (!normalize || s.length < 2) return s;
  const sum = s.reduce((a, b) => a + Math.abs(b), 0);
  return sum > 1 ? s.map((v) => v / sum) : s;
}

// job: { params, model, seed, action, image(b64), mask(b64), strength, noise, vibes:[{enc|raw, ie, strength}], refs:[...] }
export function buildGenerateBody(job) {
  const { params: p, model, seed } = job;
  const W = job.width ?? p.width;
  const H = job.height ?? p.height;
  const prompt = buildPrompt(p, model);
  const uc = assembleUC(p, model);
  let sampler = model.fixed?.sampler || p.sampler;
  const steps = model.fixed?.steps || p.steps;
  if (sampler === 'ddim_v3' && !model.v3) sampler = 'k_euler_ancestral';
  let schedule = p.noiseSchedule;
  if (!model.v3 && schedule === 'native') schedule = 'karras';
  if (model.forceKarras) schedule = 'karras';

  const P = {
    params_version: 3,
    width: W,
    height: H,
    scale: p.scale,
    sampler,
    steps,
    n_samples: job.nSamples ?? p.nSamples,
    seed,
    ucPreset: p.ucPreset,
    qualityToggle: p.qualityToggle,
    autoSmea: false,
    dynamic_thresholding: model.v3 ? !!p.decrisp : false,
    controlnet_strength: 1,
    legacy: false,
    add_original_image: true,
    cfg_rescale: p.cfgRescale,
    noise_schedule: schedule,
    legacy_v3_extend: false,
    skip_cfg_above_sigma: p.variety ? varietySigma(model, W, H) : null,
    negative_prompt: uc,
    deliberate_euler_ancestral_bug: false,
    prefer_brownian: true,
  };

  if (model.v5) {
    delete P.skip_cfg_above_sigma;
    if (p.transparent) P.tag_hint_transparent_background = true;
  }
  if (model.noRescale) delete P.cfg_rescale;
  if (model.v3) {
    P.sm = !!p.smea;
    P.sm_dyn = !!(p.smea && p.dyn);
  }

  if (model.v4) {
    // Match the UI's conservative V5 range; V4.x only sends its five grid centers.
    const coordinate = model.v5 ? posClamp : posSnap;
    const chars = (p.characters || [])
      .filter((c) => c.enabled && c.prompt.trim())
      .slice(0, model.maxChars || 6)
      .map((c) => ({ ...c, uc: model.forcedUC ? '' : c.uc, x: coordinate(c.x), y: coordinate(c.y) }));
    const useCoords = !p.aiChoice && chars.length > 0;
    P.use_coords = useCoords;
    P.legacy_uc = false;
    P.normalize_reference_strength_multiple = true;
    P.inpaintImg2ImgStrength = 1;
    P.characterPrompts = chars.map((c) => ({ prompt: c.prompt.trim(), uc: c.uc.trim(), center: { x: c.x, y: c.y }, enabled: true }));
    P.v4_prompt = {
      caption: {
        base_caption: prompt,
        char_captions: chars.map((c) => ({ char_caption: c.prompt.trim(), centers: [{ x: c.x, y: c.y }] })),
      },
      use_coords: useCoords,
      use_order: true,
    };
    P.v4_negative_prompt = {
      caption: {
        base_caption: uc,
        char_captions: chars.map((c) => ({ char_caption: c.uc.trim(), centers: [{ x: c.x, y: c.y }] })),
      },
      legacy_uc: false,
    };
  }

  const action = job.action || 'generate';
  if (action === 'img2img' || action === 'infill') {
    P.image = job.image;
    P.strength = job.strength;
    P.noise = job.noise;
    P.extra_noise_seed = seed > 0 ? seed - 1 : 0;
    if (action === 'img2img') P.color_correct = false;
    if (action === 'infill') {
      P.mask = job.mask;
      P.add_original_image = true;
    }
  }

  // vibe transfer (skipped for V4+ inpaint, per frontend behaviour)
  const vibes = job.vibes || [];
  if (vibes.length && !(action === 'infill' && model.v4)) {
    P.reference_image_multiple = vibes.map((v) => v.data);
    P.reference_strength_multiple = normalizedStrengths(vibes, p.normalizeVibes);
    if (model.v3) P.reference_information_extracted_multiple = vibes.map((v) => v.ie);
  }

  // precise reference (V4.5)
  const refs = job.refs || [];
  if (refs.length) {
    P.director_reference_images = refs.map((r) => r.data);
    P.director_reference_descriptions = refs.map((r) => ({ caption: { base_caption: r.type, char_captions: [] }, legacy_uc: false }));
    P.director_reference_information_extracted = refs.map(() => 1);
    P.director_reference_strength_values = refs.map((r) => r.strength);
    P.director_reference_secondary_strength_values = refs.map((r) => +(1 - r.fidelity).toFixed(3));
  }

  return {
    input: prompt,
    model: action === 'infill' ? model.inpaint : model.id,
    action,
    parameters: P,
  };
}

// ---------------------------------------------------------------- cost model

// formula lives in domain/cost.js (pure, unit-tested); this wrapper only supplies the live account
export const generationCost = (o) => domainGenerationCost({ ...o, account: o.account ?? state.session });

export function upscaleCost(w, h) {
  const px = w * h;
  if (px <= 1048576) return 1;
  if (px <= 1747627) return 2;
  if (px <= 2446678) return 3;
  return 4;
}

// ---------------------------------------------------------------- endpoints

export async function generate(body, { signal, connection } = {}) {
  const res = await call('image', '/ai/generate-image', { body, signal, connection });
  try { return await readImages(res); }
  catch (err) { if (!err.unknown && !signal?.aborted && err.name !== 'AbortError') diag.responseError(res); throw err.unknown || signal?.aborted || err.name === 'AbortError' ? err : new UnknownResultError(err); }
}

// Streaming variant (V4+): yields intermediate previews, resolves to final blobs.
export async function generateStream(body, { signal, onPreview, connection } = {}) {
  const b = structuredClone(body);
  b.parameters.stream = 'msgpack';
  const res = await call('image', '/ai/generate-image-stream', { body: b, signal, connection });
  try {
    const reader = res.body.getReader();
    // sniff the first bytes: a zip / png means the server answered without streaming
    let head = new Uint8Array(0);
    while (head.length < 8) {
      const { value, done } = await reader.read();
      if (value) {
        const n = new Uint8Array(head.length + value.length);
        n.set(head);
        n.set(value, head.length);
        head = n;
      }
      if (done) break;
    }
    if (isZip(head) || isPNG(head)) {
      const parts = [head];
      for (;;) {
        const { value, done } = await reader.read();
        if (value) parts.push(value);
        if (done) break;
      }
      return await readImages(new Response(new Blob(parts)));
    }
    const finals = [];
    for await (const ev of decodeStreamFrames(reader, head)) {
      diag.firstFrame(res);
      if (ev.event_type === 'intermediate' && ev.image) {
        onPreview?.({ index: ev.samp_ix || 0, step: ev.step_ix, image: new Blob([ev.image], { type: sniffType(ev.image) }) });
      } else if (ev.event_type === 'final' && ev.image) {
        finals[ev.samp_ix || 0] = new Blob([ev.image], { type: sniffType(ev.image) });
      } else if (ev.event_type === 'error') {
        throw new ApiError(500, ev.message || (getLang() === 'zh' ? '图像流错误' : 'Stream error'));
      }
    }
    if (!finals.filter(Boolean).length) throw new Error(t('copy.nai.1'));
    return finals.filter(Boolean);
  } catch (err) { if (!err.unknown && !signal?.aborted && err.name !== 'AbortError') diag.responseError(res); throw err.unknown || signal?.aborted || err.name === 'AbortError' ? err : new UnknownResultError(err); }
}

function sniffType(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'image/webp';
  return 'application/octet-stream';
}

export async function encodeVibe(imageB64, ie, modelId, { connection } = {}) {
  const res = await call('image', '/ai/encode-vibe', {
    body: { image: imageB64, information_extracted: ie, model: modelId, mask: null },
    connection,
  });
  return bytesToBase64(new Uint8Array(await res.arrayBuffer()));
}

export async function augment(reqType, imageB64, width, height, { prompt = '', defry = 0 } = {}) {
  const body = { req_type: reqType, width, height, image: imageB64 };
  if (reqType === 'colorize' || reqType === 'emotion') {
    body.prompt = prompt;
    body.defry = defry;
  }
  const res = await call('image', '/ai/augment-image', { body });
  return (await readImages(res))[0];
}

export async function upscale(imageB64, width, height) {
  try {
    const res = await call('image', '/ai/upscale', {
      body: { image: imageB64, model: 'nai-diffusion-5-curated', declared_blur_sigma: 0 },
    });
    return (await readImages(res))[0];
  } catch (err) {
    if (err.unknown || ![404, 405].includes(err.status)) throw err;
    const res = await call('api', '/ai/upscale', { body: { image: imageB64, width, height, scale: 4 } });
    return (await readImages(res))[0];
  }
}

// api.novelai.net/user/subscription now answers 400 "update to the image URL".
export async function subscription() {
  const res = await call('image', '/user/subscription', { method: 'GET' });
  const j = await res.json();
  const steps = j.trainingStepsLeft || {};
  return {
    tier: j.tier ?? 0,
    active: j.active !== false,
    anlas: (steps.fixedTrainingStepsLeft || 0) + (steps.purchasedTrainingSteps || 0),
    usageNegative: !!j.usage?.isNegative,
    usage: j.tier >= 3 && j.usage ? opusUsage(j.usage) : null,
    raw: j,
  };
}

// Opus V5 allowance, mirroring the official frontend: percent = remaining (may exceed 100,
// refill pauses there), timeUntilNextPercent = seconds per refilled percent, ~17.3 images per %.
export function opusUsage(u) {
  const remaining = u.isNegative ? 0 : Math.max(0, u.percent);
  const perDay = u.timeUntilNextPercent > 0 ? Math.round((86400 / u.timeUntilNextPercent) * 10) / 10 : 0;
  return {
    percent: remaining,
    shown: Math.min(100, remaining),
    images: Math.round(17.3 * remaining),
    perDay,
    imagesPerDay: Math.round(17.3 * perDay),
    secPerPercent: u.timeUntilNextPercent,
    negative: !!u.isNegative,
    low: !!u.isNegative || u.percent < 5,
    empty: !!u.isNegative,
  };
}

export async function suggestTags(modelId, q) {
  const model = modelById(modelId);
  const params = new URLSearchParams({ model: model.suggestModel || modelId, prompt: q });
  if (model.suggestType) params.set('type', model.suggestType);
  const res = await call('image', '/ai/generate-image/suggest-tags?' + params, { method: 'GET', auth: false });
  const j = await res.json();
  return (j.tags || []).map((x) => ({ tag: x.tag, count: x.count, cat: 0, confidence: x.confidence }));
}

// ---------------------------------------------------------------- image preparation

export async function prepBase(src, w, h) {
  const img = await loadImage(src);
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return blobToBase64(await canvasToBlob(c));
}

// Mask → quantised to 8px latent blocks, black bg / white = repaint.
export async function prepMask(src, w, h) {
  const img = await loadImage(src);
  const sw = Math.ceil(w / 8);
  const sh = Math.ceil(h / 8);
  const small = makeCanvas(sw, sh);
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(img, 0, 0, sw, sh);
  const d = sctx.getImageData(0, 0, sw, sh);
  for (let i = 0; i < d.data.length; i += 4) {
    const on = d.data[i] > 155 || d.data[i + 3] > 155 && d.data[i] > 100;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = on ? 255 : 0;
    d.data[i + 3] = 255;
  }
  sctx.putImageData(d, 0, 0);
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, w, h);
  return blobToBase64(await canvasToBlob(c));
}

export async function letterbox(src, W, H) {
  const img = await loadImage(src);
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
  const w = img.naturalWidth * s;
  const h = img.naturalHeight * s;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
  return blobToBase64(await canvasToBlob(c));
}

export async function prepCharRef(src) {
  const img = await loadImage(src);
  const ar = img.naturalWidth / img.naturalHeight;
  const opts = [
    [1024, 1536],
    [1536, 1024],
    [1472, 1472],
  ];
  const [W, H] = opts.reduce((best, o) => (Math.abs(o[0] / o[1] - ar) < Math.abs(best[0] / best[1] - ar) ? o : best));
  return letterbox(src, W, H);
}

export async function prepVibe(src, model) {
  if (model.v3) return letterbox(src, 448, 448);
  const img = await loadImage(src);
  const max = 1536;
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = makeCanvas(Math.round(img.naturalWidth * s), Math.round(img.naturalHeight * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return blobToBase64(await canvasToBlob(c));
}

// Director tools: ≤ ~3.1MP, upscaled to ~1MP if smaller.
export async function prepDirector(src) {
  const img = await loadImage(src);
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  const px = w * h;
  let s = 1;
  if (px > 3143728) s = Math.sqrt(3143728 / px);
  else if (px < 1011712) s = Math.sqrt(1011712 / px);
  w = Math.round(w * s);
  h = Math.round(h * s);
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return { b64: await blobToBase64(await canvasToBlob(c)), width: w, height: h };
}
