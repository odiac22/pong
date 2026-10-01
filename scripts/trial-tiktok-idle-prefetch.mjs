// Isolated idle-photo admission trial. Preserve model/pixels, server GPU
// headroom, priming/seek guards, and the existing bounded prefetch budget.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const pong=await connectWebView(60195,'pong');
const pause=readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/idle-prefetch-${Date.now()}.json`;
const result={experimental:true,qualityChanged:false,restored:false};
try{
 await pong.read(pause);
 result.installed=await pong.read(`(()=>{
  const previous=schedulePongFaceSwapPrefetch;
  const anchor='!foregroundAlreadyPresented\\n  ) return;';
  let source=previous.toString();
  if(source.split(anchor).length!==2)throw Error('Scheduler changed; no trial installed');
  source=source.replace(anchor,\`!foregroundAlreadyPresented && !(
    document.documentElement.classList.contains('pong-tiktok-original-overlay') &&
    pongTikTokLiveState.activeVideo === false &&
    !!pongCanonicalTikTokVideoPage(pongTikTokLiveState.next) &&
    videoMetadata.length > 0 && videoMetadata.every(meta => meta?.source === 'tiktok-live')
  )\\n  ) return;\`);
  schedulePongFaceSwapPrefetch=eval('('+source+')');
  window.__pongUndoIdlePrefetch=()=>{schedulePongFaceSwapPrefetch=previous;delete window.__pongUndoIdlePrefetch;};
  return true;
 })()`);
 await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
 // Admission has no visible side effect: native owns the current photo and
 // no synthetic URL or hidden active wrapper is created for it.
 await pong.read('schedulePongFaceSwapPrefetch(0);true');
 const child=spawn(process.execPath,['scripts/trace-tiktok-pipeline.mjs','--production'],{
  windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,
   PONG_AUDIT_COUNT:process.env.PONG_AUDIT_COUNT||'8',PONG_AUDIT_VARIANT:'29.21-idle-photo-prefetch-gate-trial'}});
 let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});
 result.exit=await new Promise(resolve=>child.once('exit',resolve));
 result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1));
}finally{
 await pong.read(pause).catch(()=>{});
 result.restored=await pong.read('(()=>{if(!window.__pongUndoIdlePrefetch)return false;window.__pongUndoIdlePrefetch();return true})()').catch(()=>false);
 pong.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({saved:output,...result}));
}
