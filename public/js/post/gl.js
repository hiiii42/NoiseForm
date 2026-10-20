import { t } from '../i18n.js';
import { BANDS, defaultParams } from './params.js';
import { labStats } from './match.js';
import * as shaders from './shaders.js';

const contextOptions = { alpha: true, premultipliedAlpha: false, antialias: false, depth: false, stencil: false };
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

export function supported() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2', contextOptions);
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch { return false; }
}

// Shape-preserving cubic Hermite interpolation, including non-monotone curves.
function bakeCurve(points) {
  const p = points.filter(v => v?.length === 2 && v.every(Number.isFinite))
    .map(([x, y]) => [clamp(x), clamp(y)]).sort((a, b) => a[0] - b[0]);
  const knots = p.filter((v, i) => i === p.length - 1 || v[0] !== p[i + 1][0]);
  if (!knots.length) return Float32Array.from({ length: 256 }, (_, i) => i / 255);
  const n = knots.length, slopes = [], tangents = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) slopes.push((knots[i + 1][1] - knots[i][1]) / (knots[i + 1][0] - knots[i][0]));
  tangents[0] = slopes[0] || 0;
  tangents[n - 1] = slopes[n - 2] || 0;
  for (let i = 1; i < n - 1; i++) {
    if (slopes[i - 1] * slopes[i] <= 0) continue;
    const a = knots[i][0] - knots[i - 1][0], b = knots[i + 1][0] - knots[i][0];
    tangents[i] = 3 * (a + b) / ((2 * b + a) / slopes[i - 1] + (b + 2 * a) / slopes[i]);
  }
  return Float32Array.from({ length: 256 }, (_, i) => {
    const x = i / 255;
    if (x <= knots[0][0]) return knots[0][1];
    if (x >= knots[n - 1][0]) return knots[n - 1][1];
    let k = 0;
    while (knots[k + 1][0] < x) k++;
    const h = knots[k + 1][0] - knots[k][0], t = (x - knots[k][0]) / h;
    return clamp((2*t*t*t-3*t*t+1)*knots[k][1] + (t*t*t-2*t*t+t)*h*tangents[k]
      + (-2*t*t*t+3*t*t)*knots[k+1][1] + (t*t*t-t*t)*h*tangents[k+1],
    Math.min(knots[k][1], knots[k+1][1]), Math.max(knots[k][1], knots[k+1][1]));
  });
}

function withDefaults(p = {}) {
  const merge = (d, v) => Object.fromEntries(Object.entries(d).map(([k, x]) => [k,
    x && typeof x === 'object' && !Array.isArray(x) ? merge(x, v?.[k]) : v?.[k] ?? x]));
  return merge(defaultParams(), p);
}

/** Full-resolution WebGL2 processing. All coordinates and radii are source pixels. */
export function createRenderer(canvas) {
  let gl;
  try { gl = canvas.getContext('webgl2', contextOptions); } catch { /* CPU fallback. */ }
  let alive = !!gl;
  const maxTexture = gl?.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
  const caps = Object.freeze({ maxTexture, get ok() { return alive && !gl?.isContextLost(); } });
  const unavailable = () => { throw new Error(t('copy.post.gl.0')); };
  if (!gl) return Object.freeze({ caps, setSource: unavailable, setMask: unavailable, setLUT: unavailable,
    render: unavailable, exportImageData: async () => unavailable(), destroy() {} });

  const halfFloat = !!gl.getExtension('EXT_color_buffer_float');
  const programs = new Map(), textures = new Set(), targets = [];
  const vao = gl.createVertexArray();
  const readFbo = gl.createFramebuffer();
  let sourceTex, maskTex, lutTex, curveTex;
  let width = 0, height = 0, pageSize = 0, columns = 0, rows = 0, pageW = 0, pageH = 0;
  let stats = null, lut = null, curveKey = '', curvesActive = false, cachedKey = '', cachedResult = null;
  let destroyed = false;
  const onLost = event => { event.preventDefault(); alive = false; };
  canvas.addEventListener('webglcontextlost', onLost);
  gl.bindVertexArray(vao);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.disable(gl.DITHER);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);

  function assertReady(sourceRequired = true) {
    if (destroyed || !caps.ok) unavailable();
    if (sourceRequired && !sourceTex) throw new Error(t('copy.post.gl.1'));
  }
  function invalidate() { cachedKey = ''; cachedResult = null; }
  function removeTexture(t) { if (t) { gl.deleteTexture(t); textures.delete(t); } }
  function newTexture(target) {
    const t = gl.createTexture();
    textures.add(t);
    gl.bindTexture(target, t);
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (target !== gl.TEXTURE_2D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    return t;
  }
  function program(name) {
    if (programs.has(name)) return programs.get(name);
    const compiled = [];
    const p = gl.createProgram();
    try {
      for (const [type, text] of [[gl.VERTEX_SHADER, shaders.vertex], [gl.FRAGMENT_SHADER, shaders[name]]]) {
        const s = gl.createShader(type);
        compiled.push(s);
        gl.shaderSource(s, text);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${name}: ${gl.getShaderInfoLog(s)}`);
        gl.attachShader(p, s);
      }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name}: ${gl.getProgramInfoLog(p)}`);
      const uniforms = new Map();
      for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
        const info = gl.getActiveUniform(p, i);
        uniforms.set(info.name.replace(/\[0\]$/, ''), { type: info.type, location: gl.getUniformLocation(p, info.name) });
      }
      const result = { p, uniforms };
      programs.set(name, result);
      return result;
    } catch (e) { gl.deleteProgram(p); throw e; }
    finally { for (const s of compiled) gl.deleteShader(s); }
  }
  function uniform(info, value) {
    const l = info.location;
    switch (info.type) {
      case gl.FLOAT: gl.uniform1f(l, value); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(l, value); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(l, value); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(l, value); break;
      default: gl.uniform1i(l, Number(value));
    }
  }
  function bind(unit, target, tex) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, tex);
  }
  function target(index, w, h, byte = false) {
    let t = targets[index];
    if (t && (t.w !== w || t.h !== h || t.byte !== byte)) {
      removeTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
      t = null;
    }
    if (!t) {
      const tex = newTexture(gl.TEXTURE_2D);
      gl.texStorage2D(gl.TEXTURE_2D, 1, halfFloat && !byte ? gl.RGBA16F : gl.RGBA8, w, h);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        removeTexture(tex); gl.deleteFramebuffer(fbo);
        throw new Error(t('copy.post.gl.2'));
      }
      t = targets[index] = { tex, fbo, w, h, byte };
    }
    return t;
  }
  function draw(name, dst, rect, values = {}, input = null, soft = null, fine = null) {
    const p = program(name);
    gl.useProgram(p.p);
    gl.bindVertexArray(vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst?.fbo || null);
    gl.viewport(0, 0, dst?.w || canvas.width, dst?.h || canvas.height);
    bind(0, gl.TEXTURE_2D_ARRAY, sourceTex);
    bind(1, gl.TEXTURE_2D, input?.tex || curveTex);
    bind(2, gl.TEXTURE_3D, lutTex);
    bind(3, gl.TEXTURE_2D, curveTex);
    bind(4, gl.TEXTURE_2D_ARRAY, maskTex || sourceTex);
    bind(5, gl.TEXTURE_2D, soft?.tex || curveTex);
    bind(6, gl.TEXTURE_2D, fine?.tex || curveTex);
    const all = { sourceTex: 0, inputTex: 1, lutTex: 2, curveTex: 3, maskTex: 4, softTex: 5, fineTex: 6,
      imageSize: [width, height], workRect: rect, pageSize, pageColumns: columns, ...values };
    for (const [key, info] of p.uniforms) if (key in all) uniform(info, all[key]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function uploadPages(img) {
    const texture = newTexture(gl.TEXTURE_2D_ARRAY);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, pageW, pageH, columns * rows);
    const scratch = document.createElement('canvas');
    scratch.width = pageW; scratch.height = pageH;
    const ctx = scratch.getContext('2d', { willReadFrequently: false });
    ctx.imageSmoothingEnabled = false;
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
      const w = Math.min(pageW, width-x*pageSize), h = Math.min(pageH, height-y*pageSize);
      ctx.clearRect(0, 0, pageW, pageH);
      ctx.drawImage(img, x*pageSize, y*pageSize, w, h, 0, 0, w, h);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, y*columns+x, pageW, pageH, 1, gl.RGBA, gl.UNSIGNED_BYTE, scratch);
    }
    scratch.width = scratch.height = 1;
    return texture;
  }
  function setSource(img) {
    assertReady(false);
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new Error(t('copy.post.gl.3'));
    const page = Math.max(w,h) <= maxTexture ? Math.max(w,h) : Math.min(1024,maxTexture);
    const cols = Math.ceil(w/page), rs = Math.ceil(h/page);
    if (cols*rs > gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)) throw new Error(t('copy.post.gl.4'));
    width = w; height = h; pageSize = page; columns = cols; rows = rs;
    pageW = Math.min(page,w); pageH = Math.min(page,h);
    removeTexture(sourceTex); removeTexture(maskTex);
    maskTex = null; sourceTex = uploadPages(img); stats = null;
    invalidate();
    return { width, height };
  }
  function setMask(maskCanvas) {
    assertReady(!!maskCanvas);
    if (maskCanvas && (maskCanvas.width !== width || maskCanvas.height !== height)) throw new Error(t('copy.post.gl.5'));
    removeTexture(maskTex);
    maskTex = maskCanvas ? uploadPages(maskCanvas) : null;
    invalidate();
  }
  function setLUT(value) {
    assertReady(false);
    if (value && (!Number.isInteger(value.size) || value.size < 2 || value.size > gl.getParameter(gl.MAX_3D_TEXTURE_SIZE)
      || value.data?.length !== value.size**3*3 || (value.dimension && value.dimension !== 3))) throw new Error(t('copy.post.gl.6'));
    if (value && (!Array.from(value.data).every(Number.isFinite)
      || (value.min || [0,0,0]).some((v,i) => !Number.isFinite(v) || !Number.isFinite((value.max || [1,1,1])[i]) || v >= (value.max || [1,1,1])[i]))) throw new Error(t('copy.post.gl.7'));
    removeTexture(lutTex);
    lut = value;
    lutTex = newTexture(gl.TEXTURE_3D);
    const n = value?.size || 2;
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, n, n, n, 0, gl.RGB, gl.FLOAT,
      value ? new Float32Array(value.data) : new Float32Array(24));
    invalidate();
  }
  function sourceStats() {
    if (stats) return stats;
    const mean = [0,0,0], m2 = [0,0,0];
    let count = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, readFbo);
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
      const w = Math.min(pageW,width-x*pageSize), h = Math.min(pageH,height-y*pageSize);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, sourceTex, 0, y*columns+x);
      const bytes = new Uint8Array(w*h*4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      const s = labStats({ data: bytes, width: w, height: h });
      let n = 0;
      for (let i = 3; i < bytes.length; i += 4) if (bytes[i]) n++;
      if (!n) continue;
      for (let c = 0; c < 3; c++) {
        const delta = s.mean[c]-mean[c];
        m2[c] += s.std[c]**2*n + delta**2*count*n/(count+n);
        mean[c] += delta*n/(count+n);
      }
      count += n;
    }
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, null, 0, 0);
    stats = { mean, std: m2.map(v => Math.sqrt(v/Math.max(1,count))) };
    return stats;
  }

  function prepare(p) {
    const key = JSON.stringify(p.curves);
    if (curveKey !== key) {
      const data = new Float32Array(256*4);
      ['rgb','r','g','b'].forEach((channel,c) => bakeCurve(p.curves[channel]).forEach((v,i) => { data[i*4+c] = v; }));
      curvesActive = data.some((v,i) => Math.abs(v-Math.floor(i/4)/255) > .000001);
      gl.bindTexture(gl.TEXTURE_2D, curveTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 256, 1, 0, gl.RGBA, gl.FLOAT, data);
      curveKey = key;
    }
    const match = p.style.match, activeMatch = match.enabled && match.stats && match.strength !== 0;
    const src = activeMatch ? sourceStats() : { mean: [0,0,0], std: [1,1,1] };
    const ref = activeMatch ? match.stats : src;
    const l = p.light, c = p.color, g = p.grading;
    const curves = curvesActive;
    const hsl = BANDS.some(b => Object.values(p.hsl[b]).some(Boolean));
    const grade = ['shadows','midtones','highlights','global'].some(k => g[k].sat || g[k].lum);
    const activeLut = lut && p.style.lut.enabled && p.style.lut.strength !== 0;
    const colorActive = activeMatch || activeLut || Object.values(l).some(Boolean) || Object.values(c).some(Boolean) || curves || hsl || grade;
    const d = p.detail;
    const mosaicActive = !!maskTex; // Brush mode controls editing, not visibility of existing strokes.
    const detailActive = d.sharpen.amount || d.clarity || d.texture || d.dehaze || d.vignette.amount || d.grain.amount || d.aberration.rc || d.aberration.by;
    return { active: !!(colorActive || detailActive || mosaicActive), mosaicActive, uniforms: {
      sourceMean: src.mean, matchMean: ref.mean,
      matchScale: src.std.map((v,i) => v > .0001 ? ref.std[i]/v : 1), matchStrength: activeMatch ? match.strength/100 : 0,
      lutStrength: activeLut ? p.style.lut.strength/100 : 0, lutSize: lut?.size || 2, lutMin: lut?.min || [0,0,0], lutMax: lut?.max || [1,1,1],
      lightA: [l.exposure,l.brightness/100,l.contrast/100,l.highlights/100], lightB: [l.shadows/100,l.whites/100,l.blacks/100,0],
      colorA: [c.temp,c.tint,c.hue,c.vibrance/100], saturation: c.saturation/100,
      useCurves: curves, useHsl: hsl, useGrade: grade,
      bands: BANDS.flatMap(k => [p.hsl[k].h,p.hsl[k].s,p.hsl[k].l]),
      grades: ['shadows','midtones','highlights','global'].flatMap(k => [g[k].hue,g[k].sat/100,g[k].lum/100]),
      gradeMix: [g.blend/100,g.balance/100],
    } };
  }

  // Each sequential neighbourhood operation adds to the tile halo.
  function haloSize(p, plan) {
    const d = p.detail, long = Math.max(width,height), m = p.retouch.mosaic;
    let halo = 2;
    if (d.sharpen.amount) halo += Math.ceil(3*d.sharpen.radius);
    if (d.clarity) halo += Math.ceil(3*long*.02);
    if (d.texture) halo += 12;
    halo += Math.ceil(Math.max(Math.abs(d.aberration.rc),Math.abs(d.aberration.by)));
    if (plan.mosaicActive) halo += Math.ceil(long*m.cell/100*(m.style === 'blur' ? 1.5 : 1));
    return halo;
  }
  function* tiles(p, plan) {
    if (width <= maxTexture && height <= maxTexture) {
      yield { core: [0,0,width,height], work: [0,0,width,height] };
      return;
    }
    const halo = haloSize(p,plan), size = Math.min(1024,maxTexture-2*halo);
    if (size < 1) throw new Error(t('copy.post.gl.8'));
    for (let y = 0; y < height; y += size) for (let x = 0; x < width; x += size) {
      const w = Math.min(size,width-x), h = Math.min(size,height-y);
      const left = Math.max(0,x-halo), top = Math.max(0,y-halo);
      yield { core: [x,y,w,h], work: [left,top,Math.min(width,x+w+halo)-left,Math.min(height,y+h+halo)-top] };
    }
  }
  function process(p, plan, rect) {
    const w = rect[2], h = rect[3];
    let current = target(0,w,h), next = target(1,w,h);
    draw('color',current,rect,plan.uniforms);
    const swap = () => { [current,next] = [next,current]; };
    function blur(input,sigma,index = 3) {
      const tmp = target(2,w,h), out = target(index,w,h);
      const values = { sigma: Math.max(.1,sigma), taps: Math.min(12,Math.ceil(3*sigma)) };
      draw('blur',tmp,rect,{ ...values, direction: [1,0] },input);
      draw('blur',out,rect,{ ...values, direction: [0,1] },tmp);
      return out;
    }
    const d = p.detail;
    for (const [amount,radius,threshold] of [[d.sharpen.amount/100,d.sharpen.radius,d.sharpen.threshold/255], [d.clarity/100,Math.max(width,height)*.02,0]]) {
      if (!amount) continue;
      const soft = blur(current,radius);
      draw('detail',next,rect,{ amount, threshold, textureMode: false },current,soft);
      swap();
    }
    if (d.texture) {
      const soft = blur(current,4), fine = blur(current,1,4);
      draw('detail',next,rect,{ amount: d.texture/100, threshold: 0, textureMode: true },current,soft,fine);
      swap();
    }
    if (d.dehaze || d.vignette.amount || d.grain.amount) {
      const v = d.vignette, g = d.grain;
      draw('effects',next,rect,{ dehaze: d.dehaze/100, vignette: [v.amount/100,v.midpoint/100,v.feather/100,v.roundness/100],
        grain: [g.amount/100,g.size,Number(g.mono),Number(g.soft)] },current);
      swap();
    }
    const a = d.aberration;
    if (a.rc || a.by) {
      draw('aberration',next,rect,{ aberration: [a.rc,a.by,a.edge/100,Number(a.mode === 'linear')], center: [a.cx,a.cy] },current);
      swap();
    }
    if (plan.mosaicActive) {
      const m = p.retouch.mosaic, cell = Math.max(1,Math.max(width,height)*m.cell/100);
      const soft = m.style === 'blur' ? blur(current,cell/2) : null;
      draw('mosaic',next,rect,{ cell, blurMode: m.style === 'blur' },current,soft);
      swap();
    }
    return current;
  }
  function viewRect(view) {
    if (view) {
      if (![view.x,view.y,view.w,view.h].every(Number.isFinite) || view.w <= 0 || view.h <= 0) throw new Error(t('copy.post.gl.9'));
      return [view.x,view.y,view.w,view.h];
    }
    const scale = Math.min(canvas.width/width,canvas.height/height);
    const w = canvas.width/scale, h = canvas.height/scale;
    return [(width-w)/2,(height-h)/2,w,h];
  }
  function render(params, { compare = false, view } = {}) {
    assertReady();
    if (!canvas.width || !canvas.height) return;
    const visible = viewRect(view), rect = [0,0,width,height];
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.clearColor(0,0,0,0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (compare) { draw('original',null,rect,{ viewRect: visible }); return; }
    const p = withDefaults(params), plan = prepare(p);
    if (!plan.active) { draw('original',null,rect,{ viewRect: visible }); return; }
    const key = JSON.stringify(p), single = width <= maxTexture && height <= maxTexture;
    for (const tile of tiles(p,plan)) {
      const [x,y,w,h] = tile.core;
      if (x+w <= visible[0] || y+h <= visible[1] || x >= visible[0]+visible[2] || y >= visible[1]+visible[3]) continue;
      const result = single && cachedKey === key && cachedResult ? cachedResult : process(p,plan,tile.work);
      if (single) { cachedKey = key; cachedResult = result; }
      draw('present',null,tile.work,{ viewRect: visible, coreRect: tile.core },result);
    }
  }
  async function exportImageData(params) {
    assertReady();
    const p = withDefaults(params), plan = prepare(p);
    const output = new Uint8ClampedArray(width*height*4);
    // Export uses the same shaders and working precision as preview, then RGBA8 readback.
    invalidate();
    for (const tile of tiles(p,plan)) {
      const [x,y,w,h] = tile.core, dst = target(5,w,h,true);
      if (plan.active) {
        const result = process(p,plan,tile.work);
        draw('present',dst,tile.work,{ viewRect: tile.core, coreRect: tile.core },result);
      } else draw('original',dst,tile.work,{ viewRect: tile.core });
      const pixels = new Uint8Array(w*h*4);
      gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      for (let row = 0; row < h; row++) output.set(pixels.subarray((h-1-row)*w*4,(h-row)*w*4),((y+row)*width+x)*4);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    return new ImageData(output,width,height);
  }
  function destroy() {
    if (destroyed) return;
    destroyed = true; alive = false;
    canvas.removeEventListener('webglcontextlost',onLost);
    for (const { p } of programs.values()) gl.deleteProgram(p);
    for (const t of textures) gl.deleteTexture(t);
    for (const t of targets) if (t) gl.deleteFramebuffer(t.fbo);
    gl.deleteFramebuffer(readFbo); gl.deleteVertexArray(vao);
    programs.clear(); textures.clear(); targets.length = 0;
    stats = lut = cachedResult = null;
  }
  try {
    curveTex = newTexture(gl.TEXTURE_2D);
    setLUT(null);
    // Compile at construction, never during a slider interaction.
    for (const name of ['original','present','color','blur','detail','effects','aberration','mosaic']) program(name);
  } catch (e) { destroy(); throw e; }
  return Object.freeze({ setSource, setMask, setLUT, render, exportImageData, destroy, caps });
}
