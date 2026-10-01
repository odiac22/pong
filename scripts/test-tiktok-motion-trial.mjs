import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const pong=await connectWebView(60195,'pong'),tik=await connectWebView(60195,'tiktok');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/motion-trial-${Date.now()}.json`;
const presetHash=()=>createHash('sha256').update(readFileSync('Pong Swap/presets/current.json')).digest('hex');
const pauseCode=readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8');
const result={experimental:true,restored:false,presetHashBefore:presetHash(),
 restorationProfileBefore:await pong.read('pongFaceSwapRestorationProfile()')};
try{
 if(await tik.read('window.__pongDirectDecoderTrial===true'))throw Error('Run one architectural change at a time');
 await pong.read(pauseCode);
 await pong.read(`window.__pongAuditSavedRestorationProfile=pongFaceSwapRestorationProfile;pongFaceSwapRestorationProfile=()=>document.documentElement.classList.contains('pong-tiktok-original-overlay')?'tiktok-face-size-motion-trial':window.__pongAuditSavedRestorationProfile();window.__pongMotionTrial=true;`);
 await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
 // Warm the first owner outside the scored interval, just as the baseline
 // does. All subsequent visits still end at exactly four seconds.
 await new Promise(r=>setTimeout(r,6000));
 const child=spawn(process.execPath,['scripts/benchmark-tiktok-emulator.mjs','5'],{windowsHide:true,stdio:['ignore','pipe','inherit']});
 let log='';child.stdout.on('data',b=>{const text=b.toString();log+=text;process.stdout.write(text)});
 result.exit=await new Promise(r=>child.once('exit',r));result.benchmark=JSON.parse(log.trim().split(/\r?\n/).at(-1));
}catch(error){result.error=error.message;process.exitCode=1;}
finally{
 await pong.read(pauseCode).catch(()=>{});
 result.restored=await pong.read(`(()=>{if(window.__pongAuditSavedRestorationProfile){pongFaceSwapRestorationProfile=window.__pongAuditSavedRestorationProfile;delete window.__pongAuditSavedRestorationProfile;}window.__pongMotionTrial=false;return pongFaceSwapRestorationProfile()===${JSON.stringify(result.restorationProfileBefore)};})()`).catch(()=>false);
 result.presetHashAfter=presetHash();result.savedQualityUnchanged=result.presetHashBefore===result.presetHashAfter;
 pong.close();tik.close();writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({saved:output,...result}));
}
