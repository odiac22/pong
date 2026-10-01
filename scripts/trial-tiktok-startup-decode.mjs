// Isolated synchronization experiment. Give an adopted, already-buffered
// decoder time to paint before flushing it again with startup alignment seeks.
// This does not relax the painted-frame identity or alignment/reveal gates.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/startup-decode-${Date.now()}.json`;
const result={experimental:true,restored:false,qualityChanged:false};
const pause=readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8');
try{
 await pong.read(pause);
 const source=readFileSync('android-app/app/src/main/assets/tiktok-frame-sync.js','utf8');
 const anchor='if(Math.abs(delta)>seekThreshold&&contains&&';
 if(source.split(anchor).length!==2)throw Error('Synchronization source changed; trial not installed');
 await tik.read('window.__pongUndoStartupDecode=window.__pongDomSwapSync;true');
 result.installed=await tik.read(source.replace(anchor,'if((s.visible||clock-s.createdAt>=1500)&&Math.abs(delta)>seekThreshold&&contains&&'));
 await tik.read(readFileSync('android-app/app/src/main/assets/tiktok-stable-handoff.js','utf8'));
 const child=spawn(process.execPath,['scripts/trace-tiktok-pipeline.mjs'],{windowsHide:true,stdio:['ignore','pipe','inherit'],
  env:{...process.env,PONG_AUDIT_COUNT:process.env.PONG_AUDIT_COUNT||'8',PONG_AUDIT_VARIANT:'29.21-first-paint-before-startup-reseek-trial'}});
 let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});
 result.exit=await new Promise(resolve=>child.once('exit',resolve));
 result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1));
}finally{
 await pong.read(pause).catch(()=>{});
 result.restored=await tik.read('(()=>{if(!window.__pongUndoStartupDecode)return false;window.__pongDomSwapSync=window.__pongUndoStartupDecode;delete window.__pongUndoStartupDecode;return true})()').catch(()=>false);
 tik.close();pong.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({saved:output,...result}));
}
