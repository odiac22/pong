// Real APK crash simulation, not a visible-FPS or swipe-latency qualification.
import {execFileSync, spawn} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/crash-retirement-${Date.now()}.json`;
const shell=(...a)=>execFileSync(adb,['-s','emulator-5582',...a],{encoding:'utf8',timeout:10000,windowsHide:true});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const json=path=>fetch('http://127.0.0.1:8792'+path,{signal:AbortSignal.timeout(2000)}).then(async r=>({status:r.status,body:await r.json()}));
const run=()=>new Promise((resolve,reject)=>{
 const c=spawn(process.execPath,['scripts/prepare-tiktok-audit-receiver.mjs','--no-swap'],{windowsHide:true,stdio:'inherit'});
 c.once('error',reject);c.once('exit',code=>code===0?resolve():reject(Error('Receiver restore failed')));
});
const result={pass:false,kind:'real-app-crash-retirement',samples:[]};
let pong,tik,ownedId='',crashed=false;
try{
 if((await json('/sessions')).body.sessions.length)throw Error('Renderer not idle; no app stopped');
 if(!['ranchu','goldfish'].includes(shell('shell','getprop','ro.hardware').trim()))throw Error('Not test emulator');
 // Reload the owned app only, ensuring it received the new session contract.
 shell('shell','am','force-stop','com.odiac22.pong2');await run();
 pong=await connectWebView(60195,'pong');tik=await connectWebView(60195,'tiktok');
 // Previously observed non-explicit public source; no requirement for a face
 // in this lifetime-only test. Photo-only For You runs are not navigation bugs.
 const page='https://www.tiktok.com/@cosmic.zoom1/video/7681931721016741140';
 await tik.call('Page.navigate',{url:page});
 let source;
 for(let i=0;i<30;i++){
  await pause(500);
  source=await tik.read(`(()=>{const o=window.__pongTikTokObservedVideo;return {challenge:!!document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]'),duration:o?.video?.duration,ready:o?.video?.readyState,videoId:o?.pageUrl?.match(/video\\/(\\d+)/)?.[1]};})()`);
  if(source.challenge)throw Error('Verification required; no input dispatched');
  if(source.ready>=2&&source.duration>=30)break;
 }
 if(!(source?.ready>=2&&source.duration>=30))throw Error('No long playable source found; no crash simulated');
 result.source={videoId:source.videoId,duration:source.duration};
 await pong.read(`pongFaceSwapRestorationProfile=()=> 'tiktok-gpen512';true`);
 await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
 const deadline=performance.now()+15000;
 while(performance.now()<deadline){
  ownedId=await pong.read('pongFaceSwapCurrentWrapper()?.dataset.pongFaceSwapSessionId||""');
  if(ownedId){
   const s=(await json('/sessions/'+ownedId)).body.session;
   if(s?.frames>=5&&!s.complete){result.before={frames:s.frames,state:s.state,transformedFrames:s.transformedFrames};break;}
  }
  await pause(250);
 }
 if(!result.before)throw Error('No active owned producer to test');
 pong.close();tik.close();pong=tik=null;
 const start=performance.now();
 shell('shell','am','force-stop','com.odiac22.pong2');crashed=true;
 while(performance.now()-start<25000){
  const response=await json('/sessions/'+ownedId),s=response.body.session;
  const at=performance.now()-start;
  result.samples.push({at,status:response.status,state:s?.state,frames:s?.frames,complete:s?.complete});
  if(response.status===404){result.retiredUpperMs=at;break;}
  await pause(500);
 }
 result.pass=result.retiredUpperMs<20000;
 if(!result.pass)throw Error('Owned render not retired within bounded cleanup window');
}catch(e){result.error=e.message;process.exitCode=1;}
finally{
 if(pong)await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8')).catch(()=>{});
 pong?.close();tik?.close();
 if(ownedId)await fetch('http://127.0.0.1:8792/sessions/'+ownedId+'?defer=1',{method:'DELETE'}).catch(()=>{});
 if(crashed)await run().then(()=>{result.receiverRestored=true}).catch(e=>{result.restoreError=e.message;process.exitCode=1});
 writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({output,...result,samples:result.samples.length}));
}
