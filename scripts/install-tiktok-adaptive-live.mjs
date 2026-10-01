import {execFileSync} from 'node:child_process';
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
async function evaluate(expression){
 const pages=await fetch('http://127.0.0.1:60194/json/list').then(r=>r.json());
 const page=pages.find(p=>p.type==='page'&&new URL(p.url).pathname==='/pong');if(!page)throw Error('Pong not loaded');
 const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 try{return await new Promise((r,j)=>{const t=setTimeout(()=>j(Error('Timeout')),5000);ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===1){clearTimeout(t);m.result?.exceptionDetails?j(Error('Pong not initialized')):r(m.result?.result?.value)}};ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));});}finally{ws.close();}
}
const saved=await evaluate(`({faces:[...pongFaceSwapState.selectedFaceIds],enabled:pongFaceSwapState.enabled,tiktok:document.documentElement.classList.contains('pong-tiktok-original-overlay')})`);
console.log('Captured existing selection in memory; installing without clearing app data.');
console.log(execFileSync(adb,['install','-r','android-app/app/build/outputs/apk/pong1/release/app-pong1-release.apk'],{encoding:'utf8',timeout:60000}));
execFileSync(adb,['shell','am','start','-n','com.odiac22.pong1/com.odiac22.pong.MainActivity'],{timeout:15000});
let restored=false;
for(let n=0;n<25&&!restored;n++){
 await new Promise(r=>setTimeout(r,1000));
 try{
  const pid=execFileSync(adb,['shell','pidof','com.odiac22.pong1'],{encoding:'utf8',timeout:5000}).trim();
  if(!/^\d+$/.test(pid))continue;
  execFileSync(adb,['forward','tcp:60194','localabstract:webview_devtools_remote_'+pid],{timeout:5000});
  restored=await evaluate(`(()=>{if(typeof setPongFaceSwapSelection!=='function')return false;setPongFaceSwapSelection(${JSON.stringify(saved.faces)});setPongFaceSwapPersistentEnabled(${JSON.stringify(saved.enabled)});document.querySelectorAll('video,audio').forEach(v=>{v.muted=true;v.volume=0});return true})()`);
 }catch{}
}
if(!restored)throw Error('Installed, but automatic selection restore could not be verified');
console.log('Installed Pong 1; prior selected faces and enabled state restored. Login data preserved.');
