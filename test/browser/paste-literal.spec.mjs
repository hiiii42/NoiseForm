// 1.7.2: pasted prompt text is inserted literally — "(…)" is part of Danbooru tags such as
// sunna_(zenless_zone_zero), not an A1111 weight. Blur formatting still turns _ into spaces.
export default async ({ page, assert, log }) => {
  const ta = '#promptEditor textarea';
  await page.eval(`document.querySelector('${ta}').focus(); 1`);
  // the paste handler must not take over the paste (old: preventDefault + rewrite to sunna_1.1::zenless_zone_zero::)
  const handled = await page.eval(`(() => {
    const t = document.querySelector('${ta}');
    const dt = new DataTransfer();
    dt.setData('text/plain', 'sunna_(zenless_zone_zero), (smile:1.2)');
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    t.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, value: t.value };
  })()`);
  assert.equal(handled.prevented, false, 'paste is left to the browser (no rewrite)');
  assert.equal(handled.value, '', 'nothing rewritten into the editor');
  // what the browser inserts on paste
  await page.send('Input.insertText', { text: 'sunna_(zenless_zone_zero), (smile:1.2)' });
  assert.equal(await page.eval(`document.querySelector('${ta}').value`), 'sunna_(zenless_zone_zero), (smile:1.2)', 'inserted literally');
  // blur formatting keeps the parentheses
  await page.eval("document.querySelector('#btnGenerate').focus(); 1");
  await page.wait(200);
  const after = await page.run(async () => (await import('/js/store.js')).state.params.prompt);
  assert.equal(after.trim(), 'sunna (zenless zone zero), (smile:1.2),', 'blur: underscores → spaces, parentheses kept');
  assert.equal(page.errors.length, 0, 'no page errors: ' + page.errors.join(' | '));
  log('after blur: ' + after.trim());
};
