// Static model / preset tables mirroring the NovelAI image generator.

const V5_HEAVY = 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';

const V5_BASE = {
  v4: true, // uses the v4_prompt / char_captions structure
  v5: true,
  group: 'NEW',
  varietyBase: null,
  forceKarras: true,
  costMul: 1.5,
  vibes: false,
  refs: false,
  maxChars: 32,
  suggestType: 'animev5',
  qualityPresets: true,
  transparency: true,
};

/** @type {Model[]} */ // global typedef from types.js
export const MODELS = [
  {
    ...V5_BASE,
    id: 'nai-diffusion-5-curated',
    name: 'NAI Diffusion V5 Curated',
    short: 'V5 CURATED',
    desc: 'Default · curated dataset · Qwen text encoder',
    tag: 'NEW',
    inpaint: 'nai-diffusion-4-5-curated-inpainting',
    fallback: 'nai-diffusion-4-5-curated',
    tokenLimit: 703,
  },
  {
    ...V5_BASE,
    id: 'nai-diffusion-5-full',
    name: 'NAI Diffusion V5 Full',
    short: 'V5 FULL',
    desc: 'Full dataset · highest fidelity',
    tag: 'NEW',
    full: true,
    inpaint: 'nai-diffusion-5-full-inpainting',
    fallback: 'nai-diffusion-4-5-full',
    tokenLimit: 1471,
  },
  {
    ...V5_BASE,
    id: 'nai-diffusion-5-full-medium',
    name: 'NAI Diffusion V5 Full (Medium Effort)',
    short: 'V5 FULL · MEDIUM',
    desc: 'Medium effort · fixed 14 steps · faster',
    tag: 'FAST',
    full: true,
    inpaint: 'nai-diffusion-5-full-medium-inpainting',
    fallback: 'nai-diffusion-4-5-full',
    tokenLimit: 1471,
    costK: 1 / 1.06521739,
    fixed: { steps: 14, sampler: 'k_euler_ancestral' },
    forcedUC: true,
    noRescale: true,
  },
  {
    id: 'nai-diffusion-4-5-full',
    name: 'NAI Diffusion V4.5 Full',
    short: 'V4.5 FULL',
    desc: 'Vibe transfer · precise reference',
    tag: 'LEGACY',
    group: 'LEGACY',
    v4: true,
    v45: true,
    full: true,
    varietyBase: 58,
    vibes: true,
    refs: true,
    maxChars: 6,
    tokenLimit: 512,
    vibeIE: 0.7,
    inpaint: 'nai-diffusion-4-5-full-inpainting',
  },
  {
    id: 'nai-diffusion-4-5-curated',
    name: 'NAI Diffusion V4.5 Curated',
    short: 'V4.5 CURATED',
    desc: 'Curated dataset · precise reference',
    tag: 'LEGACY',
    group: 'LEGACY',
    v4: true,
    v45: true,
    varietyBase: 58,
    vibes: true,
    refs: true,
    maxChars: 6,
    tokenLimit: 512,
    inpaint: 'nai-diffusion-4-5-curated-inpainting',
  },
  {
    id: 'nai-diffusion-4-full',
    name: 'NAI Diffusion V4 Full',
    short: 'V4 FULL',
    desc: 'Natural-language aware · multi-character',
    tag: 'LEGACY',
    group: 'LEGACY',
    v4: true,
    full: true,
    varietyBase: 19,
    vibes: true,
    maxChars: 6,
    tokenLimit: 512,
    inpaint: 'nai-diffusion-4-full-inpainting',
  },
  {
    id: 'nai-diffusion-4-curated-preview',
    name: 'NAI Diffusion V4 Curated',
    short: 'V4 CURATED',
    desc: 'Curated dataset preview',
    tag: 'LEGACY',
    group: 'LEGACY',
    v4: true,
    varietyBase: 19,
    vibes: true,
    maxChars: 6,
    tokenLimit: 512,
    inpaint: 'nai-diffusion-4-curated-inpainting',
  },
  {
    id: 'nai-diffusion-3',
    name: 'NAI Diffusion Anime V3',
    short: 'ANIME V3',
    desc: 'SDXL anime · SMEA / DYN',
    tag: 'LEGACY',
    group: 'LEGACY',
    v3: true,
    full: true,
    varietyBase: 19,
    vibes: true,
    tokenLimit: 225,
    inpaint: 'nai-diffusion-3-inpainting',
  },
  {
    id: 'nai-diffusion-furry-3',
    name: 'NAI Diffusion Furry V3',
    short: 'FURRY V3',
    desc: 'Legacy furry model',
    tag: 'LEGACY',
    group: 'LEGACY',
    v3: true,
    full: true,
    varietyBase: 19,
    vibes: true,
    tokenLimit: 225,
    inpaint: 'nai-diffusion-furry-3-inpainting',
  },
];

export const modelById = (id) => MODELS.find((m) => m.id === id) || MODELS[0];

// Quality tags appended to the end of the prompt (", " + suffix) when "Quality tags" is on.
// V5 models use a preset list [Standard, Light].
export const QUALITY_TAGS = {
  'nai-diffusion-5-curated': ['very aesthetic, masterpiece, no text', 'very aesthetic, amazing quality, no text'],
  'nai-diffusion-5-full': ['very aesthetic, masterpiece, no text', 'very aesthetic, amazing quality, no text'],
  'nai-diffusion-5-full-medium': ['very aesthetic, masterpiece, no text', 'very aesthetic, amazing quality, no text'],
  'nai-diffusion-4-5-full': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-curated': 'very aesthetic, masterpiece, no text, -0.8::feet::, rating:general',
  'nai-diffusion-4-full': 'no text, best quality, very aesthetic, absurdres',
  'nai-diffusion-4-curated-preview': 'rating:general, best quality, very aesthetic, absurdres',
  'nai-diffusion-3': 'best quality, amazing quality, very aesthetic, absurdres',
  'nai-diffusion-furry-3': '{best quality}, {amazing quality}',
};

// Undesired-content presets: [label, text]. Index == ucPreset value sent to the API.
const V5_UC = [
  ['Heavy', V5_HEAVY],
  ['Light', 'lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::'],
  ['Furry Focus', '{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic'],
  ['Human Focus', V5_HEAVY + ', @_@, mismatched pupils, glowing eyes, bad anatomy'],
  ['None', ''],
];

export const UC_PRESETS = {
  'nai-diffusion-5-curated': V5_UC,
  'nai-diffusion-5-full': V5_UC,
  'nai-diffusion-5-full-medium': V5_UC,
  'nai-diffusion-4-5-full': [
    ['Heavy', 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page'],
    ['Light', 'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page'],
    ['Furry Focus', '{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic'],
    ['Human Focus', 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy'],
    ['None', ''],
  ],
  'nai-diffusion-4-5-curated': [
    ['Heavy', 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page'],
    ['Light', 'blurry, lowres, upscaled, artistic error, scan artifacts, jpeg artifacts, logo, too many watermarks, negative space, blank page'],
    ['Human Focus', 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, bad hands, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, @_@, mismatched pupils, glowing eyes, negative space, blank page'],
    ['None', ''],
  ],
  'nai-diffusion-4-full': [
    ['Heavy', 'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, white blank page, blank page'],
    ['Light', 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, white blank page, blank page'],
    ['None', ''],
  ],
  'nai-diffusion-4-curated-preview': [
    ['Heavy', 'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts, white blank page, blank page'],
    ['Light', 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, logo, dated, signature, white blank page, blank page'],
    ['None', ''],
  ],
  'nai-diffusion-3': [
    ['Heavy', 'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]'],
    ['Light', 'lowres, jpeg artifacts, worst quality, watermark, blurry, very displeasing'],
    ['Human Focus', 'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract], bad anatomy, bad hands, @_@, mismatched pupils, heart-shaped pupils, glowing eyes'],
    ['None', 'lowres'],
  ],
  'nai-diffusion-furry-3': [
    ['Heavy', '{{worst quality}}, [displeasing], {unusual pupils}, guide lines, {{unfinished}}, {bad}, url, artist name, {{tall image}}, mosaic, {sketch page}, comic panel, impact (font), [dated], {logo}, ych, {what}, {where is your god now}, {distorted text}, repeated text, {floating head}, {1994}, {widescreen}, absolutely everyone, sequence, {compression artifacts}, hard translated, {cropped}, {commissioner name}, unknown text, high contrast'],
    ['Light', '{worst quality}, guide lines, unfinished, bad, url, tall image, widescreen, compression artifacts, unknown text'],
    ['None', 'lowres'],
  ],
};

// Landscape → portrait; 64px grid, each at most 1,048,576 pixels.
// Includes all three official NORMAL sizes.
export const COMPOSITIONS = [
  { w: 1536, h: 640 },
  { w: 1472, h: 704 },
  { w: 1344, h: 768 },
  { w: 1216, h: 832 },
  { w: 1152, h: 896 },
  { w: 1088, h: 960 },
  { w: 1024, h: 1024 },
  { w: 960, h: 1088 },
  { w: 896, h: 1152 },
  { w: 832, h: 1216 },
  { w: 768, h: 1344 },
  { w: 704, h: 1472 },
  { w: 640, h: 1536 },
];

export const SIZE_PRESETS = [
  { id: 'normal-portrait', group: 'NORMAL', label: 'Portrait', w: 832, h: 1216 },
  { id: 'normal-landscape', group: 'NORMAL', label: 'Landscape', w: 1216, h: 832 },
  { id: 'normal-square', group: 'NORMAL', label: 'Square', w: 1024, h: 1024 },
  { id: 'large-portrait', group: 'LARGE', label: 'Portrait', w: 1024, h: 1536 },
  { id: 'large-landscape', group: 'LARGE', label: 'Landscape', w: 1536, h: 1024 },
  { id: 'large-square', group: 'LARGE', label: 'Square', w: 1472, h: 1472 },
  { id: 'wallpaper-portrait', group: 'WALLPAPER', label: 'Portrait', w: 1088, h: 1920 },
  { id: 'wallpaper-landscape', group: 'WALLPAPER', label: 'Landscape', w: 1920, h: 1088 },
  { id: 'small-portrait', group: 'SMALL', label: 'Portrait', w: 512, h: 768 },
  { id: 'small-landscape', group: 'SMALL', label: 'Landscape', w: 768, h: 512 },
  { id: 'small-square', group: 'SMALL', label: 'Square', w: 640, h: 640 },
  { id: 'custom', group: 'CUSTOM', label: 'Custom', w: 0, h: 0 },
];

export const SAMPLERS = [
  { id: 'k_euler_ancestral', label: 'Euler Ancestral' },
  { id: 'k_euler', label: 'Euler' },
  { id: 'k_dpmpp_2s_ancestral', label: 'DPM++ 2S Ancestral' },
  { id: 'k_dpmpp_2m_sde', label: 'DPM++ 2M SDE' },
  { id: 'k_dpmpp_2m', label: 'DPM++ 2M' },
  { id: 'k_dpmpp_sde', label: 'DPM++ SDE' },
  { id: 'ddim_v3', label: 'DDIM', v3only: true },
];

export const NOISE_SCHEDULES = [
  { id: 'karras', label: 'Karras' },
  { id: 'exponential', label: 'Exponential' },
  { id: 'polyexponential', label: 'Polyexponential' },
  { id: 'native', label: 'Native', v3only: true },
];

export const CHAR_COLORS = ['#b9a7ff', '#5b78ff', '#ff5a14', '#ff2e7e', '#c8ff2e', '#2ee6c8'];

export const DIRECTOR_TOOLS = [
  { id: 'bg-removal', key: 'dir.bg', icon: 'invert' },
  { id: 'lineart', key: 'dir.lineart', icon: 'edit' },
  { id: 'sketch', key: 'dir.sketch', icon: 'brush' },
  { id: 'colorize', key: 'dir.colorize', icon: 'theme', prompt: true, defry: true },
  { id: 'emotion', key: 'dir.emotion', icon: 'enhance', emotion: true, defry: true },
  { id: 'declutter', key: 'dir.declutter', icon: 'wand' },
];

export const EMOTIONS = [
  'neutral', 'happy', 'sad', 'angry', 'scared', 'surprised', 'tired', 'excited', 'nervous',
  'thinking', 'confused', 'shy', 'disgusted', 'smug', 'bored', 'laughing', 'irritated',
  'aroused', 'embarrassed', 'worried', 'love', 'determined', 'hurt', 'playful',
];

export const DEFRY_LABELS = ['Normal', 'Slightly Weak', 'Weak', 'Even Weaker', 'Very Weak', 'Weakest'];

// V4.x grid; V5 keeps hundredth precision within the conservative 10–90% range.
export const POS_COLS = ['A', 'B', 'C', 'D', 'E'];
export const POS_VALUES = [0.1, 0.3, 0.5, 0.7, 0.9];
export function posClamp(value) {
  const n = Number(value ?? 0.5);
  return Math.round(Math.min(0.9, Math.max(0.1, Number.isFinite(n) ? n : 0.5)) * 100) / 100;
}
export function posSnap(value) {
  const n = Number(value ?? 0.5);
  return POS_VALUES[Math.max(0, Math.min(4, Math.round(((Number.isFinite(n) ? n : 0.5) - 0.1) * 5 + Number.EPSILON * 8)))];
}
export function posLabel(x, y, free = false) {
  if (free) return `${Math.round(posClamp(x) * 100)}·${Math.round(posClamp(y) * 100)}`;
  return POS_COLS[POS_VALUES.indexOf(posSnap(x))] + (POS_VALUES.indexOf(posSnap(y)) + 1);
}
export function posTitle(x, y) {
  return `x ${Math.round(posClamp(x) * 100)}% · y ${Math.round(posClamp(y) * 100)}%`;
}
