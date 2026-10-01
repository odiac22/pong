import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {bufferedCatchupTrial} from './lib/tiktok-buffered-catchup-trial.mjs';
import {warmChaseTrial} from './lib/tiktok-warm-chase-trial.mjs';
const chase=process.argv.includes('--warm-chase');
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/${chase?'warm-chase':'buffered-catchup'}-${Date.now()}.json`;
const result={experimental:true,qualityChanged:false,restored:false};
const pause=readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8');
try{
 await pong.read(pause);
 await tik.read('window.__pongAuditStop?.();window.__pongUndoBufferedCatchup=window.__pongDomSwapSync;true');
 result.installed=await tik.read((chase?warmChaseTrial:bufferedCatchupTrial)(readFileSync('android-app/app/src/main/assets/tiktok-frame-sync.js','utf8')));
 await tik.read(readFileSync('android-app/app/src/main/assets/tiktok-stable-handoff.js','utf8'));
 await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
 const child=spawn(process.execPath,['scripts/trace-tiktok-pipeline.mjs','--production'],{
   windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,
     PONG_AUDIT_COUNT:process.env.PONG_AUDIT_COUNT||'8',PONG_AUDIT_TRANSPORT_NETWORK:'0',
     PONG_AUDIT_VARIANT:chase?'29.27-warm-decode-chase-without-reseek':'29.27-buffered-warm-350ms-catchup-trial'}});
 let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});
 result.exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
 try{result.trace=JSON.parse(log.trim().split(/\r?\n/).at(-1))}catch{result.error='Missing final trace'}
}finally{
 await pong.read(pause).catch(()=>{});
 result.restored=await tik.read('(()=>{window.__pongAuditStop?.();if(!window.__pongUndoBufferedCatchup)return false;window.__pongDomSwapSync=window.__pongUndoBufferedCatchup;delete window.__pongUndoBufferedCatchup;return true})()').catch(()=>false);
 tik.close();pong.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({saved:output,...result}));
}
