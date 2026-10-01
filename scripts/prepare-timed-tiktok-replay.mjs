import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {readFileSync} from 'node:fs';
const id=process.argv[2]||'7682599061894991135';
if(!/^\d{19}$/.test(id))throw Error('Expected benchmark post ID');
const pong=await connectWebView(60195,'pong'),tik=await connectWebView(60195,'tiktok');
try {
  console.log(await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8')));
  await tik.call('Page.navigate',{url:`https://www.tiktok.com/@_/video/${id}`});
  for(let i=0;i<40;i++) {
    await new Promise(r=>setTimeout(r,500));
    const s=await tik.read(`({path:location.pathname,challenge:!!document.querySelector('[id^="captcha-verify-container"]'),title:document.title,ready:document.readyState==='complete'&&window.__pongTikTokObservedVideo?.pageUrl?.endsWith('/${id}')&&window.__pongTikTokObservedVideo?.video?.readyState>=2})`);
    if(s.challenge)throw Error('Verification required; not bypassed');
    if(s.ready) {console.log(s);break;}
    if(i===39)console.log(s);
  }
} finally {pong.close();tik.close();}
