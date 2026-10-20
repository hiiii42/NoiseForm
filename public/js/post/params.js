// Post-processing parameter schema — the single contract shared by the UI (ui/workbench.js) and the
// renderer (post/gl.js). Values are plain JSON (presets store a subset, see PRESET_OMIT). Ranges here
// are the UI ranges; the renderer must accept any value inside them.
export const BANDS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'magenta'];

export function defaultParams() {
  return {
    light: { exposure: 0, brightness: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 },
    color: { temp: 0, tint: 0, hue: 0, vibrance: 0, saturation: 0 },
    // each curve: sorted control points [[x, y], ...] in 0..1; identity = [[0,0],[1,1]]
    curves: { rgb: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] },
    // per band: hue shift -100..100 (≈ ±30°), saturation -100..100, luminance -100..100
    hsl: Object.fromEntries(BANDS.map((b) => [b, { h: 0, s: 0, l: 0 }])),
    grading: { shadows: { hue: 0, sat: 0, lum: 0 }, midtones: { hue: 0, sat: 0, lum: 0 }, highlights: { hue: 0, sat: 0, lum: 0 }, global: { hue: 0, sat: 0, lum: 0 }, blend: 50, balance: 0 },
    // style: reference colour match (Lab mean/std captured from a reference image; stats are kept in presets, images are not) and .cube LUT (preset keeps name + size only; the table lives in memory / IndexedDB)
    style: { match: { enabled: false, strength: 100, stats: null, name: '' }, lut: { enabled: false, strength: 100, name: '', size: 0 } },
    detail: {
      sharpen: { amount: 0, radius: 1, threshold: 0 },
      clarity: 0, texture: 0, dehaze: 0,
      vignette: { amount: 0, midpoint: 50, feather: 50, roundness: 0 },
      grain: { amount: 0, size: 1, mono: true, soft: true },
      aberration: { mode: 'radial', rc: 0, by: 0, edge: 30, cx: 0.5, cy: 0.5 },
    },
    // retouch: strokes (mosaic mask) belong to one image and never go into presets
    retouch: {
      mosaic: { mode: 'off', size: 8, hardness: 70, style: 'pixel', cell: 2 }, // size / cell in % of the long edge
      watermark: { text: '', position: 8, size: 3, opacity: 60, color: '#ffffff' }, // position 0..8 = 3×3 grid, size % of width
      meta: 'all', // all | post | none
    },
  };
}

// UI ranges: [min, max, step, bipolar]
export const RANGES = {
  'light.exposure': [-3, 3, 0.01, true], 'light.brightness': [-100, 100, 1, true], 'light.contrast': [-100, 100, 1, true],
  'light.highlights': [-100, 100, 1, true], 'light.shadows': [-100, 100, 1, true], 'light.whites': [-100, 100, 1, true], 'light.blacks': [-100, 100, 1, true],
  'color.temp': [-100, 100, 1, true], 'color.tint': [-100, 100, 1, true], 'color.hue': [-180, 180, 1, true], 'color.vibrance': [-100, 100, 1, true], 'color.saturation': [-100, 100, 1, true],
  'grading.blend': [0, 100, 1, false], 'grading.balance': [-100, 100, 1, true],
  'style.match.strength': [0, 100, 1, false], 'style.lut.strength': [0, 100, 1, false],
  'detail.sharpen.amount': [0, 200, 1, false], 'detail.sharpen.radius': [0.5, 5, 0.1, false], 'detail.sharpen.threshold': [0, 50, 1, false],
  'detail.clarity': [-100, 100, 1, true], 'detail.texture': [-100, 100, 1, true], 'detail.dehaze': [-100, 100, 1, true],
  'detail.vignette.amount': [-100, 100, 1, true], 'detail.vignette.midpoint': [0, 100, 1, false], 'detail.vignette.feather': [0, 100, 1, false], 'detail.vignette.roundness': [-100, 100, 1, true],
  'detail.grain.amount': [0, 100, 1, false], 'detail.grain.size': [0.5, 3, 0.1, false],
  'detail.aberration.rc': [-100, 100, 1, true], 'detail.aberration.by': [-100, 100, 1, true], 'detail.aberration.edge': [0, 100, 1, false],
  'retouch.mosaic.size': [1, 30, 0.5, false], 'retouch.mosaic.hardness': [0, 100, 1, false], 'retouch.mosaic.cell': [0.5, 10, 0.1, false],
  'retouch.watermark.size': [1, 15, 0.5, false], 'retouch.watermark.opacity': [0, 100, 1, false],
};

// paths that never go into presets (per-image data)
export const PRESET_OMIT = ['retouch.mosaic.mode', 'retouch.watermark.text'];

export const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
export const setPath = (o, p, v) => { const ks = p.split('.'); let x = o; for (let i = 0; i < ks.length - 1; i++) x = x[ks[i]]; x[ks.at(-1)] = v; };

// true when params differ from defaults in the given group ('light' | 'color' | … or a dotted path prefix)
export function isDirty(params, prefix = '') {
  const d = defaultParams();
  const a = prefix ? getPath(params, prefix) : params, b = prefix ? getPath(d, prefix) : d;
  return JSON.stringify(strip(a)) !== JSON.stringify(strip(b));
}
function strip(v) { if (v && typeof v === 'object' && !Array.isArray(v)) { const o = {}; for (const k of Object.keys(v)) if (!['stats', 'name', 'mode', 'text', 'size'].includes(k) || typeof v[k] !== 'string') o[k] = strip(v[k]); return o; } return v; }
