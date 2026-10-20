// Regression (1.4.2): opening the queue history with X/Y + tiled entries (no cells) froze the queue.
import { mockLiveSource } from '../fixtures/mocklive.mjs';
export const options = { init: [mockLiveSource({ tier: 3 })] };
export default async ({ page, assert }) => {
  await page.eval(`(async()=>{const {kv}=await import('/js/db.js'); const params={prompt:'1girl, smile',uc:'',seed:0,steps:28,scale:5,width:832,height:1216,model:'nai-diffusion-4-5-full'};
    const mk=(no,kind)=>({id:'h'+no,no,kind,createdAt:Date.now()-60000,finishedAt:Date.now()-30000,status:'done',done:4,seeds:[1,2,3,4],recs:[],snap:{params},count:4,seedMode:kind==='batch'?'random':'grid'});
    await kv.set('queue',{seq:3,jobs:[],history:[mk(3,'xy'),mk(2,'tiled'),mk(1,'batch')]}); return 1})()`);
  await page.reload(3000);
  await page.eval("(async()=>{const {set}=await import('/js/store.js'); set('settings.autoFreeOnly', false); set('settings.autoCount', 5); return 1})()");
  await page.eval("(()=>{const ta=document.querySelector('#promptEditor textarea'); ta.focus(); ta.value='1girl, smile'; ta.dispatchEvent(new Event('input',{bubbles:true})); ta.blur(); return 1})()");
  await page.click('#btnQueue');
  await page.eval("[...document.querySelectorAll('.qp-tabs button')].find(b=>/历史|History/.test(b.textContent)).click()");
  const cards = await page.eval("document.querySelectorAll('.queue-pop .qj').length");
  assert.equal(cards, 3, 'three history cards render');
  await page.eval("[...document.querySelectorAll('.qp-ctl button')].find(b=>/加入编辑区|Add editor/.test(b.textContent)).click()");
  assert.equal(await page.eval("document.querySelector('#btnQueue .q-n').textContent"), '1', 'job was queued');
  await page.eval("[...document.querySelectorAll('.qp-tabs button')].find(b=>/队列|Queue/.test(b.textContent)).click()");
  await page.eval("[...document.querySelectorAll('.qp-ctl button')].find(b=>/开始|Run/.test(b.textContent)).click()");
  await page.waitFor("window.__gen >= 5 && !document.querySelector('#btnAuto').classList.contains('on')", 30000, 300);
  assert.equal(await page.eval('window.__gen'), 5, 'exactly 5 generate calls');
};
