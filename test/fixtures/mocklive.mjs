// Browser-side fake of the NovelAI API (subscription + generate-image). Install before the app loads:
//   export const options = { init: [mockLiveSource({ tier: 3 })] }
// Counters: window.__gen (generate calls), window.__anlas, window.__genBodies (parsed request bodies).
export function mockLive(cfg) {
  const real = window.fetch.bind(window);
  window.__anlas = cfg.anlas ?? 1488;
  window.__gen = 0;
  window.__genBodies = [];
  window.__mockCfg = cfg;
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const c = window.__mockCfg;
    if (u.includes('user/subscription'))
      return new Response(JSON.stringify({ tier: c.tier ?? 3, active: true, trainingStepsLeft: { fixedTrainingStepsLeft: window.__anlas, purchasedTrainingSteps: 0 }, usage: { percent: 40, isNegative: false, timeUntilNextPercent: 7888 } }), { headers: { 'content-type': 'application/json' } });
    if (u.endsWith('generate-image') || u.endsWith('generate-image-stream')) {
      window.__gen++;
      const body = JSON.parse(opts.body);
      window.__genBodies.push(body);
      if (c.failGenerate) return new Response(JSON.stringify({ message: 'mock failure' }), { status: c.failGenerate, headers: { 'content-type': 'application/json' } });
      const cv = document.createElement('canvas');
      cv.width = 64;
      cv.height = 96;
      const g = cv.getContext('2d');
      g.fillStyle = 'hsl(' + ((window.__gen * 47) % 360) + ',70%,55%)';
      g.fillRect(0, 0, 64, 96);
      const png = new Uint8Array(await (await new Promise((r) => cv.toBlob(r))).arrayBuffer());
      const { zip } = await import('/js/zip.js');
      await new Promise((r) => setTimeout(r, c.delay ?? 200));
      return new Response(zip([{ name: 'image_0.png', data: png }]), { headers: { 'content-type': 'application/zip' } });
    }
    return real(url, opts);
  };
}
/** Source string for options.init; also points the app at "direct" mode with a fake token. */
export const mockLiveSource = (cfg = {}) => `(${mockLive.toString()})(${JSON.stringify(cfg)});
try {
  const stored = JSON.parse(localStorage.getItem('nf.settings') || '{}');
  const s = stored.v >= 1 && stored.data ? stored.data : stored;
  if (!s.token) {
    s.token = 'pst-MOCK'; s.conn = 'direct';
    // First load deliberately remains v0 to exercise real-user migration.
    localStorage.setItem('nf.settings', JSON.stringify(stored));
  }
} catch {}`;
