// Disposable direct HTMLVideo demux experiment; preserves renderer bytes.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const result={experimental:true};
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/native-media-${Date.now()}.json`;
const nativeCreate=`
    s.transport.nativeProgressive=true;
    for(const event of ['loadstart','loadedmetadata','loadeddata','canplay','playing'])overlay.addEventListener(event,()=>{
      s.transport[event]??=performance.now();if(!s.warm)sync();
    },{passive:true});
    overlay.addEventListener('error',()=>fail('Native media error '+(overlay.error?.code||0)),{once:true});
    overlay.addEventListener('ended',()=>{if(window.__pongDomSwap!==s)return;if(s.start<.1){try{overlay.currentTime=0;overlay.play().catch(()=>{})}catch{}}else window.__pongDomSwapClear();});
    s.transport.requestAt=performance.now();overlay.src=url;overlay.load();return s;
`;
async function install(enabled){
 await tik.read('window.__pongAuditStop?.();window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.();delete window.__pongDomSwapInstalled;window.__pongNativeMediaTrial='+enabled+';true');
 for(const file of ['tiktok-stream.js','tiktok-frame-sync.js','tiktok-stable-handoff.js']){
  let source=readFileSync('android-app/app/src/main/assets/'+file,'utf8');
  if(enabled&&file==='tiktok-stream.js'){
   source=source.replace('const mediaSource=direct?null:new MediaSource(),objectUrl=direct?',"const mediaSource=null,objectUrl=true?");
   const marker='if(direct){window.__pongCreateDirectDecoder(s,{owned,fail});return s;}';
   if(!source.includes(marker))throw Error('Native trial source mismatch');
   source=source.replace(marker,marker+nativeCreate);
  }
  await tik.read(source);
 }
}
try{
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
 await install(true);
 await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
 await new Promise(r=>setTimeout(r,6000));
 result.preflight=await tik.read(`(()=>{const s=window.__pongDomSwap;return {active:!!s,ready:s?.overlay.readyState,transport:s?.transport,failure:window.__pongDomSwapLastFailure||null,error:window.__pongDomSwapLastError||''}})()`);
 if(!result.preflight.active&&result.preflight.error)throw Error('Direct media startup failed; no swipes scored');
 const child=spawn(process.execPath,['scripts/benchmark-tiktok-emulator.mjs','8','--videos'],{
  windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,PONG_AUDIT_SAMPLE_MS:'1000',PONG_AUDIT_VARIANT:'29.13-native-media-trial'}});
 let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});
 result.exit=await new Promise(r=>child.once('exit',r));result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1));
 result.runtime=await tik.read(`(()=>{const s=window.__pongDomSwap;return {active:!!s,visible:s?.visible,transport:s?.transport,failure:window.__pongDomSwapLastFailure||null,error:window.__pongDomSwapLastError||''}})()`);
}catch(error){result.error=error.message;}finally{
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8')).catch(()=>{});
 await install(false).catch(e=>{result.restoreError=e.message});
 result.restored=await tik.read('window.__pongNativeMediaTrial===false').catch(()=>false);
 tik.close();pong.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({saved:output,...result}));
}
