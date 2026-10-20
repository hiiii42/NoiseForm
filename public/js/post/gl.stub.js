import { t } from '../i18n.js';
// Deliberately unprocessed fallback for UI development / browsers without WebGL2.
// Like gl.js, view is the visible rectangle {x,y,w,h} in source pixels.
export const supported = () => true;

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let source = null;
  return {
    caps: { stub: true, webgl2: false },
    setSource(img) { source = img; },
    setMask() {},
    setLUT() {},
    render(params, { view } = {}) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!source) return;
      const w = source.naturalWidth || source.width, h = source.naturalHeight || source.height;
      const scale = Math.min(canvas.width / w, canvas.height / h);
      const rect = view ? { x: -view.x * canvas.width / view.w, y: -view.y * canvas.height / view.h,
        width: w * canvas.width / view.w, height: h * canvas.height / view.h }
        : { x: (canvas.width - w * scale) / 2, y: (canvas.height - h * scale) / 2, width: w * scale, height: h * scale };
      ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height);
    },
    async exportImageData() {
      if (!source) throw new Error(t('copy.post.gl.stub.0'));
      const copy = document.createElement('canvas');
      copy.width = source.naturalWidth || source.width;
      copy.height = source.naturalHeight || source.height;
      const c = copy.getContext('2d'); c.drawImage(source, 0, 0);
      return c.getImageData(0, 0, copy.width, copy.height);
    },
    destroy() { source = null; ctx.clearRect(0, 0, canvas.width, canvas.height); },
  };
}
