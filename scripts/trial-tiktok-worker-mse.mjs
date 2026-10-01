import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const result={experimental:true};
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/worker-mse-${Date.now()}.json`;
async function install(enabled){
 await tik.read('window.__pongAuditStop?.();window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.();delete window.__pongDomSwapInstalled;window.__pongWorkerMseTrial='+enabled+';true');
 for(const file of ['tiktok-worker-mse.js','tiktok-stream.js','tiktok-frame-sync.js','tiktok-stable-handoff.js']){
  let source=readFileSync('android-app/app/src/main/assets/'+file,'utf8');
  if(enabled&&file==='tiktok-stream.js'){
   source=source.replace('s.direct?.close();','s.direct?.close();s.worker?.close();s.overlay.srcObject=null;');
   source=source.replace('const mediaSource=direct?null:new MediaSource(),objectUrl=direct?',"const workerMse=!direct&&window.MediaSource?.canConstructInDedicatedWorker===true;const mediaSource=direct||workerMse?null:new MediaSource(),objectUrl=direct||workerMse?");
   source=source.replace('if(direct){window.__pongCreateDirectDecoder(s,{owned,fail});return s;}', 'if(direct){window.__pongCreateDirectDecoder(s,{owned,fail});return s;}if(workerMse){window.__pongCreateWorkerMse(s,{owned,fail,sync});return s;}');
  }
  await tik.read(source);
 }
 if(enabled)await tik.read(`(()=>{window.__pongWorkerFailures=[];const create=window.__pongCreateWorkerMse;window.__pongCreateWorkerMse=(s,h)=>create(s,{...h,fail:error=>{window.__pongWorkerFailures.push({at:performance.now(),error:String(error),transport:{...s.transport}});h.fail(error);}});return true})()`);
}
try{
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
 await install(true);
 await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
 await new Promise(r=>setTimeout(r,6000));
 result.preflight=await tik.read('({worker:!!window.__pongDomSwap?.worker,ready:window.__pongDomSwap?.overlay.readyState,failures:window.__pongWorkerFailures})');
 if(result.preflight.failures?.length&&!result.preflight.worker)throw Error('Worker startup failed; no swipes scored');
 const child=spawn(process.execPath,['scripts/benchmark-tiktok-emulator.mjs','8','--videos'],{
  windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,PONG_AUDIT_SAMPLE_MS:'1000',PONG_AUDIT_VARIANT:'29.13-worker-mse-trial'}});
 let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});
 result.exit=await new Promise(r=>child.once('exit',r));result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1));
 result.runtime=await tik.read(`(()=>{const s=window.__pongDomSwap;return {active:!!s,worker:!!s?.worker,visible:s?.visible,transport:s?.transport,failure:window.__pongDomSwapLastFailure||null,error:window.__pongDomSwapLastError||''}})()`);
}catch(error){result.error=error.message;}finally{
 result.failures=await tik.read('window.__pongWorkerFailures').catch(()=>[]);
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8')).catch(()=>{});
 await install(false).catch(e=>{result.restoreError=e.message});
 result.restored=await tik.read('window.__pongWorkerMseTrial===false').catch(()=>false);
 tik.close();pong.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({saved:output,...result}));
}
