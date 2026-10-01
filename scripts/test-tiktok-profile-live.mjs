import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {execFileSync} from 'node:child_process';
import {writeFileSync,mkdirSync} from 'node:fs';
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const page=await connectWebView(60195,'tiktok'),trials=[];
const directory='E:/Pong Benchmarks/tiktok-webview-2026-09-29';mkdirSync(directory,{recursive:true});
try{
 for(const direction of [1,1,1,-1,-1]){
  const before=await page.read('location.pathname'),start=performance.now();
  if(process.argv.includes('--direct'))await page.read(`window.__pongTikTokStep(${direction})`);
  else execFileSync(adb,['-s','emulator-5582','shell','input','swipe','650',direction>0?'1550':'650','650',direction>0?'650':'1550','180']);
  let after=before;
  while(after===before&&performance.now()-start<2500){await new Promise(r=>setTimeout(r,60));after=await page.read('location.pathname')}
  const trial={direction,before,after,changed:before!==after,ms:performance.now()-start};trials.push(trial);console.log(JSON.stringify(trial));
  await new Promise(r=>setTimeout(r,350));
 }
}finally{page.close();const path=`${directory}/profile-navigation-${Date.now()}.json`;writeFileSync(path,JSON.stringify(trials,null,2));console.log(JSON.stringify({saved:path,passed:trials.length===5&&trials.every(t=>t.changed)}))}
