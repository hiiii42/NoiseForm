// 1.6.4: the prompt editor can be resized with its bottom grip; the height persists; double-click restores auto.
export default async ({ page, assert, log }) => {
  const H = () => page.eval("document.querySelector('#promptEditor textarea').getBoundingClientRect().height");
  const grip = () => page.eval("(()=>{const r=document.querySelector('#promptEditor .ed-grip').getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}})()");
  const h0 = await H();
  let g = await grip();
  await page.mouse('mousePressed', g.x, g.y);
  await page.mouse('mouseMoved', g.x, g.y + 120, { buttons: 1 });
  await page.mouse('mouseMoved', g.x, g.y + 240, { buttons: 1 });
  await page.mouse('mouseReleased', g.x, g.y + 240);
  await page.wait(200);
  const h1 = await H();
  assert.ok(h1 > h0 + 200, `taller after drag: ${h0} → ${h1}`);
  // typing does not shrink or grow a user-sized editor
  await page.eval("(()=>{const ta=document.querySelector('#promptEditor textarea'); ta.focus(); ta.value='1girl'; ta.dispatchEvent(new Event('input',{bubbles:true})); return 1})()");
  await page.wait(200);
  assert.ok(Math.abs((await H()) - h1) < 2, 'height kept while typing');
  await page.reload(3000);
  assert.ok(Math.abs((await H()) - h1) < 2, 'height persists after reload');
  g = await grip();
  await page.mouse('mousePressed', g.x, g.y);
  await page.mouse('mouseMoved', g.x, g.y - 400, { buttons: 1 });
  await page.mouse('mouseReleased', g.x, g.y - 400);
  assert.ok((await H()) >= 47, 'minimum height respected');
  g = await grip();
  await page.mouse('mouseMoved', g.x, g.y);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: g.y, button: 'left', clickCount: 2 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.x, y: g.y, button: 'left', clickCount: 2 });
  await page.wait(200);
  assert.ok(Math.abs((await H()) - h0) < 3, 'double-click restores auto height');
  assert.equal(await page.eval("JSON.parse(localStorage.getItem('nf.edh')).data.promptEditor ?? null"), null);
  log(`${Math.round(h0)} → ${Math.round(h1)}px, persisted, reset ok`);
};
