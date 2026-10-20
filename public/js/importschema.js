// Untrusted PNG metadata is copied through this allowlist before it reaches state.
// Limits bound both editor work and the number of character components we create.
import { MODELS, SAMPLERS, NOISE_SCHEDULES, UC_PRESETS } from './data.js';

export const IMPORT_LIMITS = Object.freeze({ text: 32768, json: 1048576, characters: Math.max(...MODELS.map((m) => m.maxChars || 0)), centers: 32 });
const HASHES = {
  'nai-diffusion-4-5-full': ['4BDE2A90', '1229B44F', 'B9F340FD', 'F3D95188'],
  'nai-diffusion-4-5-curated': ['C02D4F98', '5AB81C7C', 'B5A2A797'],
  'nai-diffusion-4-full': ['37442FCA', '4F49EC75', 'CA4B7203', '79F47848', 'F6302A9D'],
  'nai-diffusion-4-curated-preview': ['7ABFFA2A', 'C1CCBA86', '770A9E12'],
  'nai-diffusion-3': ['B0BDF6C1', 'C1E1DE52', '7BCCAA2C', '1120E6A9', '8BA2AF87'],
  'nai-diffusion-furry-3': ['4BE8C60C', 'C8704949', '37C2B166', 'F306816B', '9CC2F394'],
  'nai-diffusion-5-full': ['657484A5', '0ADF9AB7'],
  'nai-diffusion-5-curated': ['DB276663'],
  'nai-diffusion-5-full-medium': ['93F4BD30', '70AB5786'],
};

// Retain the Source hashes / version labels supported by the import dialog.
export function modelFromSource(source = '') {
  if (typeof source !== 'string' || source.length > 1024) return null;
  if (MODELS.some((m) => m.id === source)) return source;
  const hash = (source.match(/\b([0-9A-F]{8})\b/i) || [])[1]?.toUpperCase();
  for (const [id, list] of Object.entries(HASHES)) if (hash && list.includes(hash)) return id;
  if (/V5/i.test(source)) return 'nai-diffusion-5-curated';
  if (/V4\.5/i.test(source)) return 'nai-diffusion-4-5-full';
  if (/V4/i.test(source)) return 'nai-diffusion-4-full';
  if (/V3|Diffusion 3/i.test(source)) return 'nai-diffusion-3';
  return null;
}

const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const text = (/** @type {number} */ max = IMPORT_LIMITS.text) => (v) => typeof v === 'string' && v.length <= max;
const number = (min, max, integer = false) => (v) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v));
const bool = (v) => typeof v === 'boolean';
const enumeration = (values) => (v) => values.includes(v);
const model = enumeration(MODELS.map((m) => m.id));
const seed = (v) => number(0, 4294967295, true)(v) || (typeof v === 'string' && /^\d{1,10}$/.test(v) && Number(v) <= 4294967295);
const center = { x: number(0, 1), y: number(0, 1) };
const character = { char_caption: text(), centers: { items: center, max: IMPORT_LIMITS.centers, required: ['x', 'y'] } };
const v4 = (max) => ({
  caption: { base_caption: text(), char_captions: { items: character, max, required: ['char_caption'] } },
  use_coords: bool, use_order: bool, legacy_uc: bool,
});

function commentSchema(maxChars) {
  return {
    prompt: text(), uc: text(), negative_prompt: text(), seed, model,
    width: number(64, 16384, true), height: number(64, 16384, true),
    steps: number(1, 50, true), scale: number(0, 10), cfg_rescale: number(0, 1),
    n_samples: number(1, 8, true), sampler: enumeration(SAMPLERS.map((s) => s.id)),
    noise_schedule: enumeration(NOISE_SCHEDULES.map((s) => s.id)),
    sm: bool, sm_dyn: bool, dynamic_thresholding: bool,
    skip_cfg_above_sigma: (v) => v === null || number(0, 10000)(v),
    v4_prompt: v4(maxChars), v4_negative_prompt: v4(maxChars),
    // These fields occur in official / NOISEFORM exports, even though the dialog
    // derives the quality and UC presets from the actual prompt text.
    ucPreset: number(0, Math.max(...Object.values(UC_PRESETS).map((p) => p.length)) - 1, true),
    qualityToggle: bool, tag_hint_transparent_background: bool, use_coords: bool, demo: bool,
    params_version: number(1, 3, true), legacy: bool, legacy_v3_extend: bool,
    autoSmea: bool, add_original_image: bool, deliberate_euler_ancestral_bug: bool,
    prefer_brownian: bool, legacy_uc: bool, normalize_reference_strength_multiple: bool,
    strength: number(0, 1), noise: number(0, 1), extra_noise_seed: seed,
    inpaintImg2ImgStrength: number(0, 1), controlnet_strength: number(0, 2),
  };
}

/** Returns a fresh { meta, discarded }; each rejected field/container counts once.
 * Numeric strings are accepted only for seed (the UI stores it as a string).
 * Oversized arrays are rejected as a whole, never expanded or silently truncated.
 */
export function sanitizeMetadata(input) {
  let discarded = 0;
  const reject = () => { discarded++; return undefined; };
  const copy = (value, schema) => {
    if (typeof schema === 'function') return schema(value) ? value : reject();
    if (schema.items) {
      if (!Array.isArray(value) || value.length > schema.max) return reject();
      const out = [];
      for (const item of value) {
        const clean = copy(item, schema.items);
        // Reject the containing array rather than shift positive/negative
        // captions onto a different character when an entry is malformed.
        if (!clean || schema.required.some((key) => !Object.hasOwn(clean, key))) return clean ? reject() : undefined;
        out.push(clean);
      }
      return out;
    }
    if (!record(value)) return reject();
    const out = {};
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema, key)) { reject(); continue; }
      const clean = copy(value[key], schema[key]);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  };
  if (!record(input)) return { meta: {}, discarded: 1 };
  const meta = copy(input, { Title: text(256), Description: text(), Source: text(1024), Software: text(256), parameters: text(), model, Comment: () => true });
  let raw = meta.Comment;
  delete meta.Comment;
  if (typeof raw === 'string') {
    if (raw.length > IMPORT_LIMITS.json) { reject(); raw = undefined; }
    else {
      try { raw = JSON.parse(raw); }
      catch { reject(); raw = undefined; }
    }
  }
  if (raw !== undefined && raw !== null) {
    const id = record(raw) && model(raw.model) ? raw.model : meta.model || modelFromSource(meta.Source);
    const maxChars = MODELS.find((m) => m.id === id)?.maxChars ?? IMPORT_LIMITS.characters;
    const clean = copy(raw, commentSchema(maxChars));
    if (clean) meta.Comment = clean;
  } else if (raw === null) reject();
  return { meta, discarded };
}
