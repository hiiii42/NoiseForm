import {copy,clamp} from './color.js';
export function rgbLab(r,g,b) {
  [r,g,b]=[r,g,b].map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});
  const f=v=>v>.008856?Math.cbrt(v):7.787*v+16/116;
  const x=f((.4124564*r+.3575761*g+.1804375*b)/.95047), y=f(.2126729*r+.7151522*g+.072175*b), z=f((.0193339*r+.119192*g+.9503041*b)/1.08883);
  return [116*y-16,500*(x-y),200*(y-z)];
}
function labRgb(l,a,b) {
  const y=(l+16)/116, inv=v=>v**3>.008856?v**3:(v-16/116)/7.787;
  const x=.95047*inv(y+a/500), yy=inv(y), z=1.08883*inv(y-b/200);
  return [3.2404542*x-1.5371385*yy-.4985314*z,-.969266*x+1.8760108*yy+.041556*z,.0556434*x-.2040259*yy+1.0572252*z].map(v=>255*clamp(v<=.0031308?12.92*v:1.055*v**(1/2.4)-.055));
}
export function labStats(im) {
  const mean=[0,0,0], m2=[0,0,0]; let n=0;
  for(let i=0;i<im.data.length;i+=4) {if(!im.data[i+3]) continue; n++; const lab=rgbLab(...im.data.subarray(i,i+3)); for(let c=0;c<3;c++){const d=lab[c]-mean[c];mean[c]+=d/n;m2[c]+=d*(lab[c]-mean[c]);}}
  return {mean,std:m2.map(v=>Math.sqrt(v/Math.max(1,n)))};
}
export function applyMatch(im,target,strength=1) {
  const out=copy(im); if(!target||!strength) return out;
  const src=labStats(im), t=clamp(strength);
  for(let i=0;i<im.data.length;i+=4) {
    const lab=rgbLab(...im.data.subarray(i,i+3));
    const rgb=labRgb(...lab.map((v,c)=>(v-src.mean[c])*(src.std[c]>.0001?target.std[c]/src.std[c]:1)+target.mean[c]));
    for(let c=0;c<3;c++) out.data[i+c]=im.data[i+c]*(1-t)+rgb[c]*t;
  } return out;
}
