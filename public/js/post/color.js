// All processors return new ImageData and preserve input/alpha.
export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const copy = im => new ImageData(new Uint8ClampedArray(im.data), im.width, im.height);
export function rgbHsl(r, g, b) {
  const hi = Math.max(r,g,b), lo = Math.min(r,g,b), d = hi-lo, l = (hi+lo)/2;
  let h = 0;
  if (d) h = ((hi===r ? (g-b)/d : hi===g ? (b-r)/d+2 : (r-g)/d+4)*60+360)%360;
  return [h, d ? d/(1-Math.abs(2*l-1)) : 0, l];
}
function hslRgb(h,s,l) {
  const c=(1-Math.abs(2*l-1))*s, x=c*(1-Math.abs((h/60)%2-1)), m=l-c/2;
  return (h<60?[c,x,0]:h<120?[x,c,0]:h<180?[0,c,x]:h<240?[0,x,c]:h<300?[x,0,c]:[c,0,x]).map(v=>v+m);
}
export function curveValue(v, points = [0.25,0.5,0.75]) {
  const ys=[0,...points,1], x=clamp(v)*4, k=Math.min(3,Math.floor(x));
  return ys[k]+(ys[k+1]-ys[k])*(x-k);
}
export function applyColor(im,p={}) {
  const out=copy(im), d=out.data, centers=[0,30,60,120,180,240,270,300];
  if(['exposure','contrast','saturation','temperature','tint','highlights','shadows'].every(k=>!p[k]) && (!p.curve||p.curve.every((v,i)=>v===(i+1)/4)) && (!p.hsl||p.hsl.every(v=>!v.s&&!v.l))) return out;
  for(let i=0;i<d.length;i+=4) {
    let rgb=[d[i],d[i+1],d[i+2]].map(v=>v/255);
    const lum=rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
    rgb=rgb.map((v,c)=>{
      v*=2**(p.exposure||0);
      v=(v-.5)*(1+(p.contrast||0)/100)+.5;
      v+=((p.shadows||0)*(1-lum)**2+(p.highlights||0)*lum**2)/300;
      v+=(p.temperature||0)/500*(c===0?1:c===2?-1:0)+(p.tint||0)/600*(c===1?-1:.5);
      return curveValue(clamp(v),p.curve);
    });
    let [h,s,l]=rgbHsl(...rgb), ds=0, dl=0;
    for(let k=0;k<8;k++) {
      const distance=Math.abs(h-centers[k]), w=Math.max(0,1-Math.min(distance,360-distance)/45);
      ds+=w*(p.hsl?.[k]?.s||0); dl+=w*(p.hsl?.[k]?.l||0)*s;
    }
    rgb=hslRgb(h,clamp(s*(1+(p.saturation||0)/100)*(1+ds/100)),clamp(l+dl/200));
    for(let c=0;c<3;c++) d[i+c]=rgb[c]*255;
  }
  return out;
}
