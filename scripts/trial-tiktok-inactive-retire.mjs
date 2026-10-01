// Reversible ownership trial: a confirmed photo/profile has no visible video
// for the outgoing renderer to serve. Retire only that external wrapper;
// preserve selected faces, source cache, and prepared incoming sessions.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const pong=await connectWebView(60195,'pong');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/inactive-retire-${Date.now()}.json`;
const result={experimental:true,startedAt:Date.now()};
try{
  await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
  result.installed=await pong.read(`(()=>{
    const previous=window.PongTikTokLiveFeed;
    const needle="body:JSON.stringify({positionSeconds:Math.max(0,pongTikTokLiveState.timelineSeconds-start),paused:true})\\n        }).catch(()=>{});";
    let source=previous.toString();
    if(source.split(needle).length!==2)throw Error('Inactive ownership branch changed');
    source=source.replace(needle,needle+"\\n        void stopPongFaceSwapForWrapper(wrapper,{restore:false});");
    window.PongTikTokLiveFeed=eval('('+source+')');
    window.__pongUndoInactiveRetire=()=>{window.PongTikTokLiveFeed=previous;delete window.__pongUndoInactiveRetire;};
    return true;
  })()`);
  const child=spawn(process.execPath,['scripts/trace-tiktok-pipeline.mjs'],{
    windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,
      PONG_AUDIT_COUNT:process.env.PONG_AUDIT_COUNT||'8',PONG_AUDIT_VARIANT:'29.21-inactive-retire'}});
  let log='';child.stdout.on('data',chunk=>{log+=chunk;process.stdout.write(chunk)});
  result.exit=await new Promise(resolve=>child.once('exit',resolve));
  result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1));
}finally{
  await pong.read('window.__pongUndoInactiveRetire?.();true').catch(()=>{});
  pong.close();result.finishedAt=Date.now();writeFileSync(output,JSON.stringify(result,null,2));
  console.log(JSON.stringify({saved:output,...result}));
}
