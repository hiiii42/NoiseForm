// 1.7.1: streamed generation shows real progress only — no time estimate while waiting for the first
// step (it used to run to ~93% and then drop to ~13%), and every progress display is monotonic.
import { mockLiveSource } from '../fixtures/mocklive.mjs';

// a streaming endpoint: waits (queue), then sends msgpack frames [u32 length][map] per step + a final image
function mockStream() {
  const real = window.fetch;
  const enc = new TextEncoder();
  const str = (s) => { const b = enc.encode(s); return [0xd9, b.length, ...b]; };
  const int = (n) => (n < 128 ? [n] : [0xcc, n]);
  const bin = (u8) => [0xc6, (u8.length >>> 24) & 255, (u8.length >>> 16) & 255, (u8.length >>> 8) & 255, u8.length & 255, ...u8];
  const frame = (obj) => {
    const parts = [0x80 | Object.keys(obj).length];
    for (const [k, v] of Object.entries(obj)) parts.push(...str(k), ...(typeof v === 'string' ? str(v) : typeof v === 'number' ? int(v) : bin(v)));
    const len = parts.length;
    return new Uint8Array([(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...parts]);
  };
  const png = async (hue) => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 96;
    const g = c.getContext('2d'); g.fillStyle = 'hsl(' + hue + ',70%,55%)'; g.fillRect(0, 0, 64, 96);
    return new Uint8Array(await (await new Promise((r) => c.toBlob(r))).arrayBuffer());
  };
  window.fetch = async (url, opts) => {
    if (!String(url).endsWith('generate-image-stream')) return real(url, opts);
    window.__streamCalls = (window.__streamCalls || 0) + 1;
    const steps = JSON.parse(opts.body).parameters.steps;
    const stream = new ReadableStream({
      async start(ctrl) {
        await new Promise((r) => setTimeout(r, 1800)); // "queued" on the server
        window.__firstFrameAt = performance.now();
        for (let i = 0; i < steps; i++) {
          ctrl.enqueue(frame({ event_type: 'intermediate', samp_ix: 0, step_ix: i, image: await png(i * 9) }));
          await new Promise((r) => setTimeout(r, 40));
        }
        ctrl.enqueue(frame({ event_type: 'final', samp_ix: 0, image: await png(200) }));
        ctrl.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'application/x-msgpack' } });
  };
}

export const options = { width: 1400, height: 900, init: [mockLiveSource({ tier: 3 }), `(${mockStream.toString()})();`] };

export default async ({ page, assert, log }) => {
  await page.run(async () => {
    const { set } = await import('/js/store.js');
    set('settings.stream', true);
    set('params.model', 'nai-diffusion-4-5-full');
    set('params.prompt', '1girl, city');
    set('params.steps', 20);
    set('params.width', 832); set('params.height', 1216);
    // sample every progress display while the job runs
    window.__samples = [];
    window.__sampler = setInterval(() => {
      const fill = parseFloat(document.querySelector('.gen-fill')?.style.width) || 0;
      const pct = document.querySelector('.oc-pct')?.firstChild?.nodeValue ?? null;
      const label = document.querySelector('.oc-l')?.textContent || '';
      window.__samples.push({ t: performance.now(), fill, pct, label, first: window.__firstFrameAt || 0 });
    }, 50);
  });
  await page.click('#btnGenerate');
  await page.waitFor('window.__streamCalls >= 1', 8000, 50);
  // while waiting the frame is locked and still: consecutive frames must barely differ (1.7.0 flickered:
  // every halftone dot got a new random size each frame)
  await page.wait(1500);
  const flicker = await page.eval(`new Promise((done) => {
    const c = document.querySelector('.oc-canvas'); const x = c.getContext('2d');
    const grab = () => x.getImageData(0, 0, c.width, c.height).data;
    requestAnimationFrame(() => { const a = grab(); requestAnimationFrame(() => requestAnimationFrame(() => {
      const b = grab(); let n = 0;
      for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 60) n++;
      done(n / (a.length / 4));
    })); });
  })`);
  assert.ok(flicker < 0.004, 'calm frame while waiting: ' + (flicker * 100).toFixed(2) + '% pixels changed');
  await page.waitFor("(async()=>{const {images}=await import('/js/db.js'); return (await images.list()).length>=1})()", 20000, 200);
  const s = await page.eval('(clearInterval(window.__sampler), window.__samples)');
  const before = s.filter((x) => !x.first || x.t < x.first);
  const after = s.filter((x) => x.first && x.t >= x.first);
  assert.ok(before.length >= 10, 'sampled the queued phase (' + before.length + ')');
  assert.ok(before.every((x) => x.fill === 0), 'no estimated progress before the first step: ' + JSON.stringify(before.map((x) => x.fill).filter(Boolean).slice(0, 5)));
  assert.ok(before.filter((x) => x.pct != null).every((x) => x.pct === '··'), 'stage shows ·· while waiting');
  assert.ok(before.some((x) => /等待首帧|WAITING/.test(x.label)), 'waiting label shown');
  let drops = 0;
  for (let i = 1; i < s.length; i++) if (s[i].fill < s[i - 1].fill && s[i].fill !== 0) drops++;
  assert.equal(drops, 0, 'the progress bar never moves backwards');
  assert.ok(after.some((x) => x.fill > 50), 'real steps move the bar');
  assert.ok(after.some((x) => x.pct && /^\d+$/.test(x.pct)) && after.every((x) => !/等待首帧|WAITING/.test(x.label) || x.t - x.first < 400), 'number and plain label once steps arrive');
  assert.equal(page.errors.length, 0, 'no page errors: ' + page.errors.join(' | '));
  log(`flicker ${(flicker * 100).toFixed(2)}% · queued phase ${before.length} samples at 0%; max ${Math.max(...s.map((x) => x.fill))}%`);
};
