// OpenAI-compatible chat client for the prompt assistant. Goes through the local server
// (/proxy/llm, no CORS, optional upstream proxy) when it is running, otherwise straight from the browser.
import { begin } from './diag.js';
import { state } from './store.js';
import { getLang } from './i18n.js';
import { upstreamHeaders } from './nai.js';

const T = (z, e) => (getLang() === 'zh' ? z : e);
export const llmConfig = () => ({ base: '', key: '', model: '', route: 'proxy', ...(state.settings.llm || {}) });
export const llmReady = () => {
  const c = llmConfig();
  return !!(c.base && c.model);
};

async function call(path, init = {}, baseOverride) {
  const c = llmConfig();
  const base = (baseOverride || c.base).trim().replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json', ...(c.key ? { authorization: 'Bearer ' + c.key.trim() } : {}) };
  const method = init.method || 'GET';
  const trace = begin({ kind: 'llm', method, path, route: state.session.proxy ? 'llm-proxy' : 'llm-direct', mutating: !['GET', 'HEAD'].includes(method), stream: false });
  let res;
  try {
    res = state.session.proxy
      ? await fetch('/proxy/llm' + path, { ...init, headers: { ...headers, 'x-llm-base': base, 'x-llm-route': c.route || 'proxy', ...upstreamHeaders() } })
      : await fetch(base + path, { ...init, headers });
    trace.headers(res.status);
  } catch (err) {
    trace.end(err.name === 'AbortError' ? 'aborted' : method === 'POST' ? 'unknown' : 'network', err.message);
    throw new Error(state.session.proxy ? T('连不上本地服务：', 'Local server unreachable: ') + err.message : T('浏览器直连被拦截（多半是跨域）。请用 node server.js 启动后再试。', 'The browser request was blocked (likely CORS). Start node server.js and retry.'));
  }
  let text;
  try {
    const data = await res.arrayBuffer();
    trace.bytes(data.byteLength);
    text = new TextDecoder().decode(data);
    trace.end(res.ok ? 'ok' : res.headers.get('x-nf-outcome') === 'unknown' ? 'unknown' : 'http-error', res.ok ? '' : `HTTP ${res.status}`);
  } catch (err) { trace.end(method === 'POST' ? 'unknown' : 'network', err.message); throw err; }
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const msg = j?.error?.message || j?.message || text.slice(0, 200) || res.statusText;
    const e = new Error(`${res.status} · ${msg}`);
    e.status = res.status;
    throw e;
  }
  return j;
}

// Optional request fields some providers reject (400/422). Rejected ones are remembered per endpoint.
// thinking: DeepSeek / GLM style switch — tag conversion needs no long reasoning, and reasoning tokens
// otherwise eat max_tokens and truncate the JSON (the v1.4.1 "Expected ',' or ']'" error).
const rejected = new Map(); // base → Set(field)
const OPTIONAL = ['thinking', 'response_format'];

/** → { text, truncated }. json=true asks for a JSON object. */
export async function chatEx(messages, { json = true, temperature = 0.6, maxTokens = 4096 } = {}) {
  const c = llmConfig();
  if (!llmReady()) throw new Error(T('先在「设置 → AI 构思」里填接口地址和模型', 'Set the endpoint and model in Settings → AI assistant first'));
  const base = c.base.trim();
  const bad = rejected.get(base) || new Set();
  rejected.set(base, bad);
  const extra = {};
  if (json) extra.response_format = { type: 'json_object' };
  if (!c.think) extra.thinking = { type: 'disabled' };
  let j;
  for (;;) {
    const body = { model: c.model.trim(), messages, temperature, max_tokens: c.think ? Math.max(maxTokens, 8192) : maxTokens };
    for (const k of OPTIONAL) if (extra[k] && !bad.has(k)) body[k] = extra[k];
    try {
      j = await call('/chat/completions', { method: 'POST', body: JSON.stringify(body) });
      break;
    } catch (err) {
      const imageInput = messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
      if ([400, 422].includes(err.status) && imageInput && /image|image_url|variant|vision|multimodal|multi.modal|content.*(?:array|list)|(?:array|list).*content|only.{0,30}text|text.only|图片|图像|识图/i.test(err.message)) {
        throw new Error(T('当前模型不支持识图，换一个支持图片的模型（如 gpt-4o-mini / qwen-vl / gemini）或关掉「附带当前图片」', 'This model does not support images. Choose a vision model (gpt-4o-mini / qwen-vl / gemini) or turn off “Attach current image”.'));
      }
      const drop = OPTIONAL.find((k) => body[k] && err.message.includes(k)) || OPTIONAL.find((k) => body[k]);
      if (![400, 422].includes(err.status) || !drop) throw err;
      bad.add(drop); // retry without it
    }
  }
  const ch = j?.choices?.[0];
  const text = ch?.message?.content;
  const truncated = ch?.finish_reason === 'length';
  if (typeof text !== 'string' || !text.trim())
    throw new Error(truncated ? T('输出被截断：模型把额度用在了“思考”上。请在设置里关掉「深度思考」或换个模型。', 'Output cut off: the model spent its budget reasoning. Turn off “Deep thinking” in Settings or pick another model.') : T('模型没有返回内容', 'The model returned nothing'));
  return { text, truncated };
}
export const chat = async (messages, opts) => (await chatEx(messages, opts)).text;

// → { models, base }. A base without /v1 that 404s is retried with /v1 (base tells the caller which one worked).
export async function listModels() {
  const c = llmConfig();
  const ids = (j) => (j?.data || j?.models || []).map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean).sort();
  try {
    return { models: ids(await call('/models', { method: 'GET' })), base: c.base };
  } catch (err) {
    const b = c.base.trim().replace(/\/+$/, '');
    if (err.status !== 404 || /\/v\d+$/.test(b)) throw err;
    return { models: ids(await call('/models', { method: 'GET' }, b + '/v1')), base: b + '/v1' };
  }
}
// a sensible default from a model list: cheap chat models first
export function pickModel(list) {
  return list.find((m) => /deepseek-chat|flash|mini|turbo|haiku|lite/i.test(m) && !/embed|tts|whisper|image|audio|vision-preview/i.test(m)) || list.find((m) => !/embed|tts|whisper|dall|image|audio|moderation/i.test(m)) || list[0] || '';
}

// Lenient JSON: strips ``` fences / reasoning text around the first {...} block.
export function parseJSON(text) {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1];
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0) throw new Error(T('模型返回的不是 JSON', 'The model did not return JSON'));
  if (b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch {}
  }
  const fixed = repairJSON(t.slice(a));
  if (fixed) return fixed;
  throw new Error(T('模型返回的 JSON 不完整（可能被截断），请重试', 'The model returned broken JSON (probably cut off); try again'));
}

// Salvage a truncated JSON object: cut at the last top-level-safe comma and close the open brackets.
export function repairJSON(s) {
  const stack = [];
  const cuts = []; // [index, stackCopy] at each comma outside strings
  let str = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (str) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') (str = false), cuts.push([i + 1, stack.slice()]);
      continue;
    }
    if (ch === '"') str = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length) cuts.push([i + 1, stack.slice()]);
      else {
        try {
          return JSON.parse(s.slice(0, i + 1));
        } catch {
          break;
        }
      }
    } else if (ch === ',') cuts.push([i, stack.slice()]);
  }
  for (let k = cuts.length - 1; k >= 0 && k >= cuts.length - 80; k--) {
    const [i, st] = cuts[k];
    try {
      return JSON.parse(s.slice(0, i) + st.reverse().join(''));
    } catch {}
  }
  return null;
}
