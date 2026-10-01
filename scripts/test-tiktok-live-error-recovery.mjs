import {writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const result={kind:'injected media error event; not a real network outage',checks:[],trajectory:[],pass:false};
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/recovery-${Date.now()}.json`;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const state=String.raw`(()=>{const w=pongFaceSwapCurrentWrapper();return {id:w?.dataset.pongFaceSwapSessionId||'',green:pongSwapHasPresentedEvidence(w),enabled:pongFaceSwapState.enabled,phase:w?.dataset.pongFaceSwapPhase}})()`;
try{
 let before,initialReady=false;
 const deadline=performance.now()+25000;
 while(performance.now()<deadline){
  before=await tik.read(`(()=>{const s=window.__pongDomSwap;return s?{id:s.sessionId,visible:s.visible,ready:s.overlay.readyState,originalPlaying:!s.original.paused}:null})()`);
  const p=await pong.read(state);
  if(before?.visible&&before.id===p.id&&before.originalPlaying&&before.ready>=2){initialReady=true;break;}
  if(await tik.read('!!document.querySelector("#captcha-verify-container,[class*=captcha-drag-icon]")'))throw Error('Verification; no injection attempted');
  await pause(200);
 }
 if(!initialReady)throw Error('No visible active swap; recovery test not scored');
 result.before=before;
 const injected=await tik.read(`(()=>{const s=window.__pongDomSwap;if(!s||s.sessionId!==${JSON.stringify(before.id)})return null;const original=s.original;s.overlay.dispatchEvent(new Event('error'));return {cleared:window.__pongDomSwap!==s,originalOpacity:original.style.opacity,originalPlaying:!original.paused}})()`);
 result.checks.push({name:'error restores original synchronously',ok:!!injected?.cleared&&injected.originalOpacity!=='0'&&injected.originalPlaying});
 let next,revoked=false;const began=performance.now();
 while(performance.now()-began<20000){
  next=await pong.read(state);if(!next.green)revoked=true;
  if(next.id&&next.id!==before.id)break;
  await pause(150);
 }
 result.checks.push({name:'stale green is revoked',ok:revoked});
 result.checks.push({name:'replacement session starts',ok:!!next?.id&&next.id!==before.id,ms:performance.now()-began});
 if(!next?.id||next.id===before.id)throw Error('Replacement not observed');
 result.replacement=next.id;
 const recoveredAt=performance.now();let visible=false;
 while(performance.now()-recoveredAt<20000){
  const sample=await tik.read(`(()=>{const s=window.__pongDomSwap;return s?{id:s.sessionId,start:s.start,visible:s.visible,originalTime:s.original?.currentTime,overlayTime:s.overlay.currentTime,originalPaused:s.original?.paused,overlayPaused:s.overlay.paused,ready:s.overlay.readyState,paintAge:s.lastPaintedAt?performance.now()-s.lastPaintedAt:null,bufferEnd:s.overlay.buffered.length?s.overlay.buffered.end(s.overlay.buffered.length-1):0}:null})()`);
  result.trajectory.push({at:performance.now()-began,view:sample,pong:await pong.read(state)});
  visible=!!sample&&sample.id===next.id&&sample.visible&&!sample.overlayPaused&&sample.paintAge!==null&&sample.paintAge<750;
  if(visible)break;await pause(200);
 }
 result.checks.push({name:'replacement presents continuing frames',ok:visible,ms:performance.now()-began});
 result.pass=result.checks.every(c=>c.ok);
}catch(error){result.error=error.message;process.exitCode=1}
finally{tik.close();pong.close();writeFileSync(output,JSON.stringify(result,null,2));const {trajectory,...summary}=result;console.log(JSON.stringify({saved:output,...summary,samples:trajectory.length}));}
