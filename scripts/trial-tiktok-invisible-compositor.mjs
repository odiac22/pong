// Isolated compositor-eligibility experiment; does not weaken paint identity,
// alignment, quality, or green-status evidence. Never installs on the phone.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const root='E:/Pong Benchmarks/tiktok-webview-2026-09-29';
const output=root+'/invisible-compositor-'+Date.now()+'.json';
const pool=output.replace('.json','-pool.json');
const result={experimental:true,acceptance:false,qualityChanged:false,cases:[]};
const pause=readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8');
const sync=readFileSync('android-app/app/src/main/assets/tiktok-frame-sync.js','utf8');
try{
 await pong.read(pause);
 const page=await tik.read('location.origin+location.pathname');
 if(!/^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d{15,22}$/.test(page))throw Error('Expected current observed video page');
 writeFileSync(pool,JSON.stringify({pages:[page]}));
 for(const opacity of [0,.001,.001,0]){
  await pong.read(pause);
  await tik.read(sync);
  await tik.read(`(()=>{const base=window.__pongDomSwapSync;window.__pongDomSwapSync=()=>{const s=window.__pongDomSwap;if(s&&!s.visible&&s.overlay)s.overlay.style.opacity='${opacity}';return base();};return true;})()`);
  const child=spawn(process.execPath,['scripts/diagnose-tiktok-repeatable-pages.mjs',pool,'--current-page'],{
   windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,PONG_AUDIT_PAGE_LIMIT:'1',PONG_AUDIT_VARIANT:'compositor-opacity-'+opacity}});
  let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  const summary=JSON.parse(log.trim().split(/\r?\n/).at(-1));
  result.cases.push({opacity,exit,...summary});
  writeFileSync(output,JSON.stringify(result,null,2));
  if(exit)throw Error('Diagnostic aborted');
 }
}catch(e){result.error=e.message;process.exitCode=1}
finally{
 await pong.read(pause).catch(()=>{});
 result.restored=await tik.read(sync).catch(()=>false);
 tik.close();pong.close();writeFileSync(output,JSON.stringify(result,null,2));
 console.log(JSON.stringify({output,...result}));
}
