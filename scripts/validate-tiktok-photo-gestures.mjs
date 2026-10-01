import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const client=await connectWebView(60195,'tiktok');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/photo-gestures-${Date.now()}.json`;
const report={diagnosticOnly:true,physicalInput:true,audio:false,horizontal:null,vertical:null};
const state=`(()=>{
  const a=window.__pongPhotoGestureAudit,p=window.__pongTikTokPostEvidence,v=window.__pongTikTokObservedVideo?.video;
  return {kind:p?.kind??'unknown',samePhotoPost:!!a&&p?.kind==='photo'&&p.photoId===a.id,
    photoElementChanged:!!a&&p?.photoMedia!==a.photo,
    photoSourceChanged:!!a&&(p?.photoMedia?.currentSrc||p?.photoMedia?.src||'')!==a.source,
    videoReady:!!v&&v.readyState>=2&&!v.paused,muted:!v||v.muted,
    challenge:!!document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]')};
})()`;
try {
  const started=await client.read(`(()=>{const p=window.__pongTikTokPostEvidence;
    if(p?.kind!=='photo'||!p.photoId||!p.photoMedia?.isConnected)return null;
    window.__pongPhotoGestureAudit={id:p.photoId,photo:p.photoMedia,
      source:p.photoMedia.currentSrc||p.photoMedia.src||''};
    return {photoCount:p.photoCard?.querySelectorAll('img[class*="ImgPhotoSlide"]').length??0};
  })()`);
  if(!started)throw Error('Need a visible real photo post; no gesture sent');
  report.preflight=started;
  execFileSync(adb,['-s','emulator-5582','shell','input','swipe','750','1100','300','1100','200'],{timeout:5000});
  await new Promise(resolve=>setTimeout(resolve,1000));
  report.horizontal=await client.read(state);
  if(report.horizontal.challenge)throw Error('User verification required; no more gestures');
  if(started.photoCount>1&&report.horizontal.samePhotoPost&&
      !report.horizontal.photoElementChanged&&!report.horizontal.photoSourceChanged) {
    // At the carousel's last slide only the opposite direction can advance.
    execFileSync(adb,['-s','emulator-5582','shell','input','swipe','300','1100','750','1100','200'],{timeout:5000});
    await new Promise(resolve=>setTimeout(resolve,1000));
    report.horizontalOpposite=await client.read(state);
    if(report.horizontalOpposite.challenge)throw Error('User verification required; no more gestures');
  }
  const began=performance.now();
  execFileSync(adb,['-s','emulator-5582','shell','input','swipe','650','1550','650','650','150'],{timeout:5000});
  for(let attempt=0;attempt<20;attempt++) {
    const value=await client.read(state);
    report.vertical={...value,observedMs:performance.now()-began};
    if(value.challenge)throw Error('User verification required; no more gestures');
    if(!value.samePhotoPost&&value.kind!=='unknown')break;
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  await new Promise(resolve=>setTimeout(resolve,1500));
  report.durable=await client.read(state);
  const horizontalEvidence=report.horizontalOpposite??report.horizontal;
  report.horizontalQualified=started.photoCount>1&&horizontalEvidence.samePhotoPost&&
    (horizontalEvidence.photoElementChanged||horizontalEvidence.photoSourceChanged);
  report.pass=report.horizontal.samePhotoPost&&(started.photoCount===1||report.horizontalQualified)&&
    !report.vertical.samePhotoPost&&!report.durable.samePhotoPost&&
    report.durable.kind!=='unknown'&&!report.durable.challenge;
}catch(error){report.error=error.message;report.pass=false;}
finally {
  await client.read('delete window.__pongPhotoGestureAudit').catch(()=>{});client.close();
  writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report}));
  if(!report.pass)process.exitCode=1;
}
