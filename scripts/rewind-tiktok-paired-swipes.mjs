// Replay only real previous-video swipes back to a prior locally recorded trial.
// Does not call a reconstructed feed or change login/account data.
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const directory='E:/Pong Benchmarks/tiktok-webview-2026-09-29';
const name=process.argv[2];
if(!/^swipes-\d+\.json$/.test(name||''))throw Error('Expected a prior local swipes artifact filename');
const baseline=JSON.parse(readFileSync(path.join(directory,name)));
const target=baseline.trials?.[0]?.beforePath;
if(!/^\/@[^/]+\/video\/\d{15,22}$/.test(target||''))throw Error('Prior trial has no canonical creator-video start');
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const rows=[];
try{
  await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
  await tik.read('window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.();true');
  for(let i=0;i<40;i++){
    const before=await tik.read(`(()=>({path:location.pathname,
      challenge:!!document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]'),
      previous:!!document.querySelector('button[aria-label="Previous video"]:not([disabled]),[data-e2e="feed-navigation-prev"]:not([disabled])')}))()`);
    if(before.challenge)throw Error('Verification required; no puzzle interaction');
    if(before.path===target){console.log(JSON.stringify({ready:true,previousSwipes:rows.length}));break;}
    if(!before.previous)throw Error('No real Previous video control');
    execFileSync('C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe',
      ['-s','emulator-5582','shell','input','swipe','650','650','650','1550','150'],
      {timeout:10000,windowsHide:true,stdio:'ignore'});
    let changed=false;
    for(let j=0;j<20;j++){
      await new Promise(r=>setTimeout(r,100));
      const after=await tik.read('location.pathname');
      if(after!==before.path){rows.push({index:i+1,changed:true});changed=true;break;}
    }
    if(!changed)throw Error('Previous swipe did not advance');
    await new Promise(r=>setTimeout(r,500));
  }
  const final=await tik.read('location.pathname');
  if(final!==target)throw Error('Pairing start not reached within bounded previous swipes');
}catch(error){console.error(JSON.stringify({error:String(error.message).replace(/https?:\/\/\S+/g,'[redacted]')}));process.exitCode=1;}finally{
  tik.close();pong.close();writeFileSync(`${directory}/rewind-${Date.now()}.json`,JSON.stringify({baseline:name,rows},null,2));
}
