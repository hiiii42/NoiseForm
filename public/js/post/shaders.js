// Internal textures use top-to-bottom image coordinates; only presentation flips Y.
export const vertex = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const header = `#version 300 es
precision highp float;
precision highp sampler2DArray;
precision highp sampler3D;
in vec2 uv;
out vec4 frag;
uniform sampler2D inputTex;
uniform vec2 imageSize;
uniform vec4 workRect;
float lum(vec3 c) { return dot(c, vec3(.2126, .7152, .0722)); }
vec3 bounded(vec3 c) { return clamp(c, 0.0, 1.0); }
`;

const source = `
uniform sampler2DArray sourceTex;
uniform float pageSize;
uniform int pageColumns;
vec4 sourcePixel(ivec2 p) {
  p = clamp(p, ivec2(0), ivec2(imageSize) - 1);
  ivec2 page = p / int(pageSize);
  return texelFetch(sourceTex, ivec3(p % int(pageSize), page.y * pageColumns + page.x), 0);
}
vec4 sourceAt(vec2 p) {
  vec2 q = p - .5;
  ivec2 a = ivec2(floor(q));
  vec2 f = fract(q);
  return mix(mix(sourcePixel(a), sourcePixel(a + ivec2(1, 0)), f.x),
             mix(sourcePixel(a + ivec2(0, 1)), sourcePixel(a + ivec2(1)), f.x), f.y);
}
`;

const colorMath = `
vec3 rgbHsl(vec3 c) {
  float hi = max(c.r, max(c.g, c.b)), lo = min(c.r, min(c.g, c.b));
  float d = hi - lo, l = (hi + lo) * .5, h = 0.0;
  if (d > .000001) {
    if (hi == c.r) h = (c.g - c.b) / d;
    else if (hi == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
  }
  return vec3(fract(h / 6.0 + 1.0), d / max(.000001, 1.0 - abs(2.0*l - 1.0)), l);
}
vec3 hslRgb(vec3 h) {
  vec3 rgb = clamp(abs(mod(h.x * 6.0 + vec3(0,4,2), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return h.z + (rgb - .5) * (1.0 - abs(2.0*h.z - 1.0)) * h.y;
}
vec3 rgbLab(vec3 c) {
  c = mix(c / 12.92, pow((max(c, 0.0) + .055) / 1.055, vec3(2.4)), step(vec3(.04045), c));
  vec3 xyz = mat3(.4124564,.2126729,.0193339, .3575761,.7151522,.119192, .1804375,.072175,.9503041) * c;
  xyz /= vec3(.95047,1,1.08883);
  vec3 f = mix(7.787*xyz + 16.0/116.0, pow(max(xyz, 0.0), vec3(1.0/3.0)), step(vec3(.008856), xyz));
  return vec3(116.0*f.y-16.0, 500.0*(f.x-f.y), 200.0*(f.y-f.z));
}
vec3 labRgb(vec3 c) {
  float y = (c.x+16.0)/116.0;
  vec3 f = vec3(y+c.y/500.0,y,y-c.z/200.0);
  vec3 xyz = mix((f-16.0/116.0)/7.787, f*f*f, step(vec3(.008856), f*f*f)) * vec3(.95047,1,1.08883);
  vec3 rgb = mat3(3.2404542,-.969266,.0556434, -1.5371385,1.8760108,-.2040259, -.4985314,.041556,1.0572252) * xyz;
  return bounded(mix(12.92*rgb, 1.055*pow(max(rgb,0.0),vec3(1.0/2.4))-.055, step(vec3(.0031308),rgb)));
}
`;

export const color = header + source + colorMath + `
uniform vec3 sourceMean, matchMean, matchScale;
uniform float matchStrength, lutStrength, lutSize;
uniform vec3 lutMin, lutMax;
uniform sampler3D lutTex;
uniform sampler2D curveTex;
uniform bool useCurves, useHsl, useGrade;
uniform vec4 lightA, lightB;
uniform vec4 colorA;
uniform float saturation;
uniform vec3 bands[8];
uniform vec3 grades[4];
uniform vec2 gradeMix;
const float centers[8] = float[8](0.0,30.0,60.0,120.0,180.0,240.0,270.0,300.0);
vec4 curve(float x) { return texture(curveTex, vec2((clamp(x,0.0,1.0)*255.0+.5)/256.0, .5)); }
void main() {
  vec4 base = sourceAt(workRect.xy + gl_FragCoord.xy);
  vec3 c = base.rgb;
  if (matchStrength != 0.0) c = mix(c, labRgb((rgbLab(c)-sourceMean)*matchScale+matchMean), matchStrength);
  if (lutStrength != 0.0) {
    vec3 q = bounded((c-lutMin)/(lutMax-lutMin));
    c = mix(c, texture(lutTex, (q*(lutSize-1.0)+.5)/lutSize).rgb, lutStrength);
  }
  c *= exp2(lightA.x);
  c += lightA.y;
  c = (c-.5) * (1.0+lightA.z) + .5;
  float y = clamp(lum(c),0.0,1.0);
  c += (lightA.w*y*y + lightB.x*(1.0-y)*(1.0-y)) / 3.0;
  c = c * (1.0 + lightB.y*.5 - lightB.z*.5) + lightB.z*.5;
  if (colorA.x != 0.0 || colorA.y != 0.0) {
    vec3 lab = rgbLab(bounded(c));
    lab.yz += vec2(colorA.y, colorA.x)*.25;
    c = labRgb(lab);
  }
  if (colorA.z != 0.0 || colorA.w != 0.0 || saturation != 0.0) {
    vec3 h = rgbHsl(bounded(c));
    h.x = fract(h.x + colorA.z/360.0 + 1.0);
    h.y = clamp(h.y*(1.0+colorA.w*(1.0-h.y))*(1.0+saturation),0.0,1.0);
    c = hslRgb(h);
  }
  if (useCurves) {
    c = vec3(curve(c.r).r, curve(c.g).r, curve(c.b).r);
    c = vec3(curve(c.r).g, curve(c.g).b, curve(c.b).a);
  }
  if (useHsl) {
    vec3 h = rgbHsl(bounded(c)), delta = vec3(0);
    for (int i=0; i<8; i++) {
      float d = abs(h.x*360.0-centers[i]);
      float w = 1.0-smoothstep(0.0,45.0,min(d,360.0-d));
      delta += bands[i]*w;
    }
    h.x = fract(h.x+delta.x/1200.0+1.0);
    h.y = clamp(h.y*(1.0+delta.y/100.0),0.0,1.0);
    h.z = clamp(h.z+delta.z/200.0,0.0,1.0);
    c = hslRgb(h);
  }
  if (useGrade) {
    float y = clamp(lum(c)-gradeMix.y*.25,0.0,1.0);
    float width = mix(.08,.48,gradeMix.x);
    float sh = 1.0-smoothstep(.33-width,.33+width,y);
    float hi = smoothstep(.67-width,.67+width,y);
    vec4 weights = vec4(sh,max(0.0,1.0-sh-hi),hi,1);
    for (int i=0; i<4; i++) {
      vec3 g = grades[i];
      vec3 tint = hslRgb(vec3(g.x/360.0,1,.5));
      c += weights[i]*((tint-vec3(lum(tint)))*g.y*.5 + g.z*.25);
    }
  }
  frag = vec4(bounded(c),base.a);
}`;

export const blur = header + `
uniform vec2 direction;
uniform float sigma;
uniform int taps;
void main() {
  vec4 total = texture(inputTex,uv);
  float weights = 1.0;
  // Large kernels use 12 stratified samples per side; small kernels are exact.
  float stride = max(1.0,ceil(3.0*sigma)/12.0);
  for (int i=1; i<=12; i++) {
    if (i>taps) break;
    float d = float(i)*stride;
    float w = exp(-.5*d*d/(sigma*sigma));
    vec2 delta = direction*d/workRect.zw;
    total += (texture(inputTex,uv+delta)+texture(inputTex,uv-delta))*w;
    weights += 2.0*w;
  }
  frag = total/weights;
}`;

export const detail = header + `
uniform sampler2D softTex, fineTex;
uniform float amount, threshold;
uniform bool textureMode;
void main() {
  vec4 c = texture(inputTex,uv);
  vec3 delta = (textureMode ? texture(fineTex,uv).rgb : c.rgb) - texture(softTex,uv).rgb;
  if (max(abs(delta.r),max(abs(delta.g),abs(delta.b))) < threshold) delta = vec3(0);
  frag = vec4(bounded(c.rgb+amount*delta),c.a);
}`;

export const effects = header + `
uniform float dehaze;
uniform vec4 vignette;
uniform vec4 grain;
uint hash(uvec3 p) {
  uint h = p.x*374761393u ^ p.y*668265263u ^ (p.z+7u)*1274126177u;
  h = (h^(h>>13u))*1274126177u;
  return h^(h>>16u);
}
float noise(vec2 p, uint channel) { return float(hash(uvec3(ivec2(p),channel)))/4294967295.0-.5; }
void main() {
  vec4 base = texture(inputTex,uv);
  vec3 c = base.rgb;
  vec2 p = clamp(workRect.xy+gl_FragCoord.xy,vec2(.5),imageSize-.5);
  if (dehaze != 0.0) {
    float dark = min(c.r,min(c.g,c.b));
    c = (c-.5)*(1.0+dehaze*.6)+.5-dehaze*dark*.2;
  }
  if (vignette.x != 0.0) {
    vec2 d = (p/imageSize-.5)*2.0;
    float aspect = imageSize.x/imageSize.y;
    d *= mix(vec2(1),vec2(sqrt(aspect),1.0/sqrt(aspect)),max(vignette.w,0.0));
    float r = mix(length(d)/sqrt(2.0),max(abs(d.x),abs(d.y)),max(-vignette.w,0.0));
    float edge = smoothstep(vignette.y,vignette.y+max(.001,vignette.z),r);
    c *= 1.0-vignette.x*edge;
  }
  if (grain.x != 0.0) {
    vec2 q = floor(p/grain.y);
    vec3 n = vec3(noise(q,0u),noise(q,1u),noise(q,2u));
    if (grain.z>0.0) n = n.rrr;
    float weight = grain.w>0.0 ? .25+.75*(1.0-abs(2.0*clamp(lum(c),0.0,1.0)-1.0)) : 1.0;
    c += n*grain.x*.5*weight;
  }
  frag = vec4(bounded(c),base.a);
}`;

export const aberration = header + `
uniform vec4 aberration;
uniform vec2 center;
void main() {
  vec2 p = workRect.xy+uv*workRect.zw;
  vec2 d = (p/imageSize-center)*2.0;
  float distance = length(d)/sqrt(2.0);
  float weight = smoothstep(aberration.z,min(1.001,aberration.z+.35),distance);
  vec2 dir = aberration.w>0.0 ? vec2(1,0) : d/max(1.0,length(d));
  vec4 c = texture(inputTex,uv);
  c.r = texture(inputTex,uv+dir*weight*aberration.x/workRect.zw).r;
  c.b = texture(inputTex,uv+dir*weight*aberration.y/workRect.zw).b;
  frag = c;
}`;

export const mosaic = header + `
uniform sampler2DArray maskTex;
uniform sampler2D softTex;
uniform float pageSize, cell;
uniform int pageColumns;
uniform bool blurMode;
void main() {
  vec2 p = workRect.xy+uv*workRect.zw;
  ivec2 pos = clamp(ivec2(floor(p)),ivec2(0),ivec2(imageSize)-1);
  ivec2 page = pos/int(pageSize);
  float mask = texelFetch(maskTex,ivec3(pos%int(pageSize),page.y*pageColumns+page.x),0).a;
  vec2 block = clamp((floor(p/cell)+.5)*cell,vec2(.5),imageSize-.5);
  vec4 base = texture(inputTex,uv);
  vec3 hidden = blurMode ? texture(softTex,uv).rgb : texture(inputTex,(block-workRect.xy)/workRect.zw).rgb;
  frag = vec4(mix(base.rgb,hidden,mask),base.a);
}`;

const display = `
uniform vec4 viewRect, coreRect;
vec2 displayPoint() { return viewRect.xy + vec2(uv.x,1.0-uv.y)*viewRect.zw; }
bool outside(vec2 p, vec4 r) { return any(lessThan(p,r.xy)) || any(greaterThanEqual(p,r.xy+r.zw)); }
`;
export const present = header + display + `
void main() {
  vec2 p = displayPoint();
  if (outside(p,coreRect)) discard;
  frag = texture(inputTex,(p-workRect.xy)/workRect.zw);
}`;
export const original = header + source + display + `
void main() {
  vec2 p = displayPoint();
  frag = outside(p,vec4(0,0,imageSize)) ? vec4(0) : sourceAt(p);
}`;
