// Smoke: app boots, DEMO generation lands in the archive.
export default async ({ page, assert }) => {
  await page.waitFor("document.querySelector('#promptEditor textarea')");
  await page.eval("(()=>{const ta=document.querySelector('#promptEditor textarea'); ta.focus(); ta.value='1girl, smile'; ta.dispatchEvent(new Event('input',{bubbles:true})); ta.blur(); return 1})()");
  await page.click('#btnGenerate');
  const n = await page.waitFor("(async()=>{const {images}=await import('/js/db.js'); const l=await images.list(); return l.length})()", 20000, 300);
  assert.ok(n >= 1, 'a record was stored');
};
