import { artifact } from './harness.mjs';
import { join } from 'node:path';

export const options = { width: 1280, height: 800 };

export default async ({ page, assert, log }) => {
  const install = async () => {
    await page.run(async () => {
      if (!document.querySelector('link[href="css/resize.css"]')) {
        const css = document.createElement('link');
        css.rel = 'stylesheet'; css.href = 'css/resize.css';
        await new Promise((resolve, reject) => { css.onload = resolve; css.onerror = reject; document.head.append(css); });
      }
      const { initResizer } = await import('/js/ui/resizer.js');
      initResizer(); initResizer();
      await document.fonts.ready;
    });
    await page.wait(100);
  };
  const width = () => page.eval("document.querySelector('#panel').getBoundingClientRect().width");
  const scale = async (id) => {
    await page.run(async (id) => {
      const { set } = await import('/js/store.js');
      const { applyAppearance } = await import('/js/themes.js');
      set('settings.fontScale', id); applyAppearance();
    }, id);
    await page.wait(80);
  };
  const review = async (open) => {
    await page.run(async (open) => { const { set } = await import('/js/store.js'); set('settings.reviewOpen', open); }, open);
    await page.wait(80);
  };
  const drag = async (delta) => {
    const r = await page.eval("(()=>{const r=document.querySelector('.panel-resize').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+90}})()");
    await page.mouse('mousePressed', r.x, r.y);
    await page.mouse('mouseMoved', r.x + delta, r.y, { buttons: 1 });
    await page.mouse('mouseReleased', r.x + delta, r.y);
    await page.wait(80);
  };
  const reset = async () => {
    const r = await page.eval("(()=>{const r=document.querySelector('.panel-resize').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+90}})()");
    for (const clickCount of [1, 2]) {
      await page.mouse('mousePressed', r.x, r.y, { clickCount });
      await page.mouse('mouseReleased', r.x, r.y, { clickCount });
    }
    await page.wait(80);
  };
  await page.waitFor("document.querySelector('#promptEditor textarea')");
  await install();
  assert.equal(await page.eval("document.querySelectorAll('.panel-resize').length"), 1, 'init is idempotent');
  await review(false);
  const initial = await width();
  await drag(95);
  assert.ok(Math.abs(await width() - initial - 95) <= 1, 'pointer drag changes width');
  const resized = await width();
  await page.reload(); await install();
  assert.ok(Math.abs(await width() - resized) <= 1, 'width persists after reload');
  await scale('s125');
  assert.ok(Math.abs(await width() - resized) <= 1, 'custom width stays fixed when text grows');
  await scale('s85');
  await reset();

  // A viewport constraint must not overwrite the user's wider preferred value.
  await review(false);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await drag(400);
  const preferred = await width();
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await review(true);
  assert.ok(await width() < preferred + 184, 'narrow viewport clamps preferred width');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await review(false);
  assert.ok(Math.abs(await width() - preferred) <= 1, 'wider viewport restores preferred pixels');
  await reset();
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  // Reversing a drag all the way to its starting point must also restore its width.
  const startWidth = await width();
  const point = await page.eval("(()=>{const r=document.querySelector('.panel-resize').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+90}})()");
  await page.mouse('mousePressed', point.x, point.y);
  await page.mouse('mouseMoved', point.x + 75, point.y, { buttons: 1 });
  await page.mouse('mouseMoved', point.x, point.y, { buttons: 1 });
  await page.mouse('mouseReleased', point.x, point.y);
  assert.ok(Math.abs(await width() - startWidth) <= 1, 'returning drag to origin restores its width');
  await reset();
  assert.ok(Math.abs(await width() - initial) <= 1, 'double-click restores default');
  assert.equal(await page.eval("JSON.parse(localStorage.getItem('nf.layout')).panelWidth ?? null"), null);
  await scale('s125');
  assert.ok(await width() > initial, 'reset default follows font scale');
  await scale('s85');
  await drag(-2000);
  assert.equal(Math.round(await width()), 340, 'minimum width');
  await drag(3000);
  assert.ok(await width() <= 1280 * .55 + 1, 'maximum width is 55vw');
  await review(true);
  assert.ok(await page.eval("document.querySelector('#stage').getBoundingClientRect().width") >= 359, 'review opening keeps 360px stage');
  await drag(-2000);
  const baseMin = await page.eval("Number(document.querySelector('.panel-resize').getAttribute('aria-valuenow'))");
  assert.equal(baseMin, 340, 'review width is excluded from persisted base width');
  await drag(3000);
  assert.ok(await page.eval("document.querySelector('#stage').getBoundingClientRect().width") >= 359, 'drag with review preserves stage');
  await reset();

  // Exercise the real slider with keyboard input; focus must survive consecutive changes.
  await page.click('#btnTheme');
  await page.run(() => document.querySelector('.text-size-slider').focus());
  await page.key('End');
  assert.equal(await page.eval("getComputedStyle(document.documentElement).getPropertyValue('--fz').trim()"), '1.5');
  assert.equal(await page.eval("document.querySelector('.text-size-value').textContent"), '150%');
  await page.key('Home');
  assert.equal(await page.eval("document.querySelector('.text-size-value').textContent"), '70%');
  await page.key('Escape');

  const sizes = await page.eval("import('/js/themes.js').then(m=>m.TEXT_SIZES.map(([id,k])=>[id,k]))");
  const screenshots = artifact('.');
  for (const [viewportWidth, height] of [[1280, 800], [1920, 1080]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: viewportWidth, height, deviceScaleFactor: 1, mobile: false });
    for (const [id, k] of sizes) {
      await scale(id);
      for (const open of [false, true]) {
        await review(open);
        const issues = await page.run(() => {
          const issues = [];
          for (const sel of ['.top', '.top-r', '#panel', '.panel-scroll', '.gen-dock', '#btnGenerate', '.auto-row', '#archive', '.arch-h', '.arch-f']) {
            const el = document.querySelector(sel);
            if (!el || !el.getBoundingClientRect().width) continue;
            if (el.scrollWidth > el.clientWidth + 1) issues.push(`${sel}: ${el.scrollWidth}>${el.clientWidth}`);
            const r = el.getBoundingClientRect();
            if (r.x < -1 || r.right > innerWidth + 1) issues.push(`${sel}: outside viewport`);
          }
          if (document.documentElement.scrollWidth > innerWidth) issues.push('document overflow');
          if (document.querySelector('#stage').getBoundingClientRect().width < 359) issues.push('stage below 360px');
          const gen = document.querySelector('#btnGenerate').getBoundingClientRect();
          if (gen.bottom > innerHeight || gen.top < 0) issues.push('generate outside viewport');
          return issues;
        });
        assert.deepEqual(issues, [], `${viewportWidth}×${height} ${k * 100}% review=${open}`);
      }
      if (viewportWidth === 1280 && [.8, 1, 1.5].includes(k)) await page.shot(join(screenshots, `layout-${Math.round(k * 100)}.png`));
    }
  }
  log('11 scales × 2 viewports × review open/closed; screenshots: ' + screenshots);
};
