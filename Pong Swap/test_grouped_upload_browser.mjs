import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = require('C:/Users/arian/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = import.meta.dirname;
const storage = 'E:/Pong Face References';
await fs.mkdir(storage, {recursive:true});
const temporary = await fs.mkdtemp(path.join(storage, 'upload-qa-'));
const token = crypto.randomBytes(20).toString('hex');
const probe = net.createServer();
await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
const port=probe.address().port;
await new Promise(resolve=>probe.close(resolve));
const url = `http://127.0.0.1:${port}/${token}`;
const child = spawn(path.join(root, 'runtime/venv/Scripts/python.exe'), ['face_upload.py'], {
  cwd: root, windowsHide: true, stdio: ['ignore','pipe','pipe'],
  env: {...process.env, PONG_SWAP_FACE_UPLOAD_TOKEN:token, PONG_SWAP_FACE_UPLOAD_PORT:String(port), PONG_SWAP_FACE_UPLOAD_INBOX:temporary}
});
let serverErrors = ''; child.stderr.on('data', chunk => {serverErrors += chunk;});
let browser;
try {
  let ready = false;
  for(let i=0;i<150;i++) {
    try { if((await fetch(url)).ok) {ready=true;break;} } catch {}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert(ready, serverErrors);
  browser = await chromium.launch({headless:true, executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', args:['--mute-audio','--autoplay-policy=user-gesture-required']});
  const context = await browser.newContext({viewport:{width:390,height:844}});
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e=>errors.push(e.message));
  await page.goto(url);
  await page.locator('article').last().waitFor();
  assert.equal(await page.locator('article').count(), 5);
  await page.locator('article img').evaluateAll(images=>images.forEach(image=>image.loading='eager'));
  await page.waitForFunction(()=>[...document.images].every(image=>image.complete&&image.naturalWidth>0));
  assert.equal(await page.locator('video,audio').count(), 0);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await page.screenshot({path:path.join(root,'logs/face-upload-29.02-mobile.png'), fullPage:true});
  let retried = false;
  await page.route(url+'?**', async route => {
    if(!retried && new URL(route.request().url()).searchParams.get('action')==='chunk') {
      retried=true; await route.abort();
    } else await route.continue();
  });
  const original = await fs.readFile(path.join(root, 'approved-faces/Approved 2/source.jpg'));
  // A complete JPEG plus harmless trailing bytes exercises multiple chunks.
  const payload = Buffer.concat([original, Buffer.alloc(5*1024*1024)]);
  const card = page.locator('[data-group="approved-2"]');
  await card.locator('input').setInputFiles([{name:'upload-qa.jpg',mimeType:'image/jpeg',buffer:payload}]);
  await card.locator('button').click();
  await card.locator('.success').waitFor({timeout:30000});
  assert(retried);
  const folders = await fs.readdir(path.join(temporary,'approved-2'));
  assert.equal(folders.length,1);
  const received = await fs.readFile(path.join(temporary,'approved-2',folders[0],'media.jpg'));
  assert.equal(crypto.createHash('sha256').update(received).digest('hex'),crypto.createHash('sha256').update(payload).digest('hex'));
  const status = await (await fetch(url+'?action=groups')).json();
  assert.deepEqual(status.groups.map(group=>group.received),[1,0,0,0,0]);
  assert.deepEqual(errors,[]);
  await page.setViewportSize({width:1280,height:900});
  await page.screenshot({path:path.join(root,'logs/face-upload-29.02-desktop.png'),fullPage:true});
  const report={passed:true,groupCount:5,mobileWidth:390,overflow:false,referenceImagesLoaded:5,byteExactChunkedUpload:true,networkRetry:true,audioElements:0,headless:true,qaFiles:temporary};
  await fs.writeFile(path.join(root,'logs/face-upload-29.02-browser-test.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally {
  if(browser) await browser.close();
  // The child is only the private QA uploader, never the real service.
  child.kill();
}
