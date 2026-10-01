import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/shadow-player-${Date.now()}.json`;
const result={experimental:true};
async function install(enabled){
 await tik.read('window.__pongAuditStop?.();window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.();delete window.__pongDomSwapInstalled;window.__pongSwapShadowTrial='+enabled+';true');
 for(const file of ['tiktok-stream.js','tiktok-frame-sync.js','tiktok-stable-handoff.js']){
  let source=readFileSync('android-app/app/src/main/assets/'+file,'utf8');
  if(enabled&&file==='tiktok-stream.js'){
   if(!source.includes('host.appendChild(s.overlay);'))throw Error('Trial source no longer matches');
   source=source.replace('clearInterval(s.timer);s.abort.abort();','clearInterval(s.timer);s.abort.abort();s.isolationHost?.remove();');
   source=source.replace('host.appendChild(s.overlay);',`const isolation=document.createElement('div');isolation.className='pong-tiktok-swap-isolation';isolation.setAttribute('aria-hidden','true');isolation.style.cssText='position:absolute!important;inset:0!important;width:100%!important;height:100%!important;pointer-events:none!important;z-index:2!important;background:transparent!important;';isolation.attachShadow({mode:'closed'}).appendChild(s.overlay);host.appendChild(isolation);s.isolationHost=isolation;`);
  }
  await tik.read(source);
 }
}
try{
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
 await install(true);
 // Deploy the already-tested toolbar fix without reloading the authenticated
 // site or changing the user's approved controls.
 const html=readFileSync('index.html','utf8');
 await pong.read(html.split('<script id="pong-tiktok-toolbar-approved">')[1].split('</script>')[0]);
 await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
 await new Promise(r=>setTimeout(r,6000));
 const child=spawn(process.execPath,['scripts/benchmark-tiktok-emulator.mjs','8'],{windowsHide:true,stdio:['ignore','pipe','inherit'],env:{...process.env,PONG_AUDIT_VARIANT:'29.12-shadow-isolation-toolbar-fix'}});
 let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});result.exit=await new Promise(r=>child.once('exit',r));result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1));
 result.isolation=await tik.read(`(()=>{const s=window.__pongDomSwap;return {enabled:window.__pongSwapShadowTrial,active:!!s,isolated:!!s?.isolationHost,documentSwapVideos:document.querySelectorAll('video.pong-tiktok-swap-stream').length,visible:s?.visible,ready:s?.overlay.readyState}})()`);
}finally{
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8')).catch(()=>{});
 await install(false).catch(e=>{result.restoreError=e.message});
 result.restored=await tik.read('window.__pongSwapShadowTrial===false').catch(()=>false);
 tik.close();pong.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({output,...result}));
}
