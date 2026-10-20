import { t } from '../i18n.js';
import {copy,clamp} from './color.js';
export function parseCube(text) {
  let size=0, dimension=0, min=[0,0,0], max=[1,1,1]; const data=[];
  for(const raw of text.replace(/^\uFEFF/,'').split(/\r?\n/)) {
    const line=raw.split('#')[0].trim(); if(!line) continue;
    const [key,...args]=line.split(/\s+/);
    if(key==='TITLE') continue;
    if(key==='LUT_1D_SIZE'||key==='LUT_3D_SIZE') {
      if(size) throw Error(t('copy.post.lut.0'));
      dimension=key==='LUT_1D_SIZE'?1:3; size=Number(args[0]);
      if(!Number.isInteger(size)||size<2||size>(dimension===3?65:65536)) throw Error(t('copy.post.lut.1'));
    } else if(key==='DOMAIN_MIN') min=args.map(Number);
    else if(key==='DOMAIN_MAX') max=args.map(Number);
    else {
      const row=[key,...args].map(Number);
      if(row.length!==3||!row.every(Number.isFinite)) throw Error(t('copy.post.lut.2'));
      data.push(...row);
    }
  }
  if(!size||data.length!==3*size**dimension||min.length!==3||max.length!==3||!min.every((v,i)=>Number.isFinite(v)&&Number.isFinite(max[i])&&max[i]>v)) throw Error(t('copy.post.lut.3'));
  return {size,dimension,min,max,data};
}
export function applyLut(im,lut,strength=1) {
  const out=copy(im); if(!lut||!strength) return out;
  const {size:n,dimension,min,max,data}=lut, t=clamp(strength);
  for(let i=0;i<im.data.length;i+=4) {
    const v=[0,1,2].map(c=>clamp((im.data[i+c]/255-min[c])/(max[c]-min[c]))*(n-1));
    const lo=v.map(Math.floor), hi=lo.map(x=>Math.min(n-1,x+1)), f=v.map((x,c)=>x-lo[c]);
    for(let c=0;c<3;c++) {
      let value=0;
      if(dimension===1) value=data[lo[c]*3+c]*(1-f[c])+data[hi[c]*3+c]*f[c];
      else for(let b=0;b<2;b++) for(let g=0;g<2;g++) for(let r=0;r<2;r++) {
        const idx=((b?hi[2]:lo[2])*n*n+(g?hi[1]:lo[1])*n+(r?hi[0]:lo[0]))*3+c;
        value+=data[idx]*(r?f[0]:1-f[0])*(g?f[1]:1-f[1])*(b?f[2]:1-f[2]);
      }
      out.data[i+c]=im.data[i+c]*(1-t)+255*value*t;
    }
  }
  return out;
}
