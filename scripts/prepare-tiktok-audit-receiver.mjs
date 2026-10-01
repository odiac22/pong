import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const shell=(...args)=>execFileSync(adb,['-s','emulator-5582',...args],{encoding:'utf8',timeout:10000}).trim();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const openProfileVideo=process.argv.includes('--profile-video');
const normalLayer=process.argv.includes('--normal-layer');
const nativeSwap=process.argv.includes('--native-swap');
const nativeSmallReads=process.argv.includes('--native-small-reads');
const nativeFragmentStart=process.argv.includes('--native-fragment-start');
const nativeSurface=process.argv.includes('--native-surface');
const nativeBufferLead=process.argv.includes('--native-buffer-lead');
if(nativeBufferLead&&!nativeSwap)throw Error('Native buffer lead trial requires --native-swap');
if(nativeSurface&&!nativeSwap)throw Error('Native surface trial requires --native-swap');
if(nativeSmallReads&&!nativeSwap)throw Error('Small-read native trial requires --native-swap');
if(nativeFragmentStart&&!nativeSwap)throw Error('Fragment-start native trial requires --native-swap');
const workerMse=process.argv.includes('--worker-mse');
const binaryMedia=process.argv.includes('--binary-media');
const visibleFrameBinary=process.argv.includes('--visible-frame-binary');
const visibleFrameRender=process.argv.includes('--visible-frame-render');
const visibleFrameReverse=process.argv.includes('--visible-frame-reverse');
const frameCapability=visibleFrameRender?process.env.PONG_AUDIT_FRAME_CAPABILITY:'';
if(visibleFrameRender&&(!visibleFrameBinary||!/^[a-f0-9]{64}$/.test(frameCapability||'')))
  throw Error('Visible-frame render requires binary mode and private audit capability');
const noSwap=process.argv.includes('--no-swap');
if(binaryMedia&&!workerMse)throw Error('Binary media trial requires --worker-mse');
const streamReads=process.argv.includes('--stream-reads');
const deadline=performance.now()+45000;
const booted=()=>{
  try{return execFileSync(adb,['-s','emulator-5582','shell','getprop','sys.boot_completed'],
    {encoding:'utf8',timeout:3000,stdio:['ignore','pipe','pipe']}).trim()==='1'}catch{return false;}
};
while(!booted()){
  if(performance.now()>deadline)throw Error('Receiver has not finished booting');
  await pause(1000);
}
// sys.boot_completed can precede PackageManager restoring user-installed apps
// after a cold AVD boot. Do not mistake that transient race for a missing APK.
let activityReady=false;
while(!activityReady){
  try{
    activityReady=shell('shell','cmd','package','resolve-activity','--brief','com.odiac22.pong2')
      .split(/\r?\n/).some(line=>line.trim()==='com.odiac22.pong2/com.odiac22.pong.MainActivity');
  }catch{}
  if(activityReady)break;
  if(performance.now()>deadline)throw Error('Pong2 activity is unavailable after boot; no test started');
  await pause(500);
}
// onNewIntent replaces the launch intent. Carry the experiment through this
// preflight launch as well, or opening TikTok silently loses the earlier extra.
try {shell('shell','am','start','-W','-n','com.odiac22.pong2/com.odiac22.pong.MainActivity',
  '--ez','pong_audit_normal_tiktok_layer',String(normalLayer),
  '--ez','pong_audit_native_swap',String(nativeSwap),
  '--ez','pong_audit_native_small_reads',String(nativeSmallReads),
  '--ez','pong_audit_native_fragment_start',String(nativeFragmentStart),
  '--ez','pong_audit_native_surface',String(nativeSurface),
  '--ez','pong_audit_native_buffer_lead',String(nativeBufferLead),
  '--ez','pong_audit_worker_mse',String(workerMse),
  '--ez','pong_audit_binary_media',String(binaryMedia),
  '--ez','pong_audit_visible_frame_binary',String(visibleFrameBinary),
  '--ez','pong_audit_visible_frame_reverse',String(visibleFrameReverse),
  '--ez','pong_audit_stream_reads',String(streamReads),
  ...(visibleFrameRender?['--es','pong_audit_visible_frame_capability',frameCapability]:[]));
} catch(error) {
  // execFile errors contain the command, which contains the private audit key.
  if(visibleFrameRender)throw Error('Native audit launch failed; private arguments withheld');
  throw error;
}
const pid=shell('shell','pidof','com.odiac22.pong2');
if(!/^\d+$/.test(pid))throw Error('Pong2 PID is not unique');
shell('forward','tcp:60195',`localabstract:webview_devtools_remote_${pid}`);
let pong;
for(let i=0;i<20&&!pong;i++){
  try{pong=await connectWebView(60195,'pong')}catch{await pause(500)}
}
if(!pong)throw Error('Pong WebView unavailable');
try{
  let ready=false,routed=false;
  for(let i=0;i<30&&!ready;i++){
    const state=await pong.read('({ready:typeof window.PongTikTokLiveSwapCurrent==="function",badGateway:document.title.includes("502")||document.title==="Webpage not available"})');
    ready=state.ready;
    if(state.badGateway&&!routed){
      routed=true;
      await pong.call('Page.navigate',{url:'http://192.168.1.124:8787/pong'});
      console.log('Gateway unavailable during startup; test receiver uses its existing paired LAN helper.');
    }
    if(!ready)await pause(500);
  }
  if(!ready)throw Error('Pong app did not initialize; no scored test started');
  console.log(await pong.read(readFileSync('scripts/open-tiktok-emulator.js','utf8')));
  const tik=await connectWebView(60195,'tiktok');
  try{
    let loaded=false,profileOpened=false,profileVideoOpened=false;
    for(let i=0;i<45&&!loaded;i++){
      const state=await tik.read('({pageReady:document.readyState==="complete"&&typeof window.__pongTikTokStep==="function"&&!!document.querySelector("[data-e2e=nav-foryou]"),ready:document.readyState==="complete"&&typeof window.__pongTikTokStep==="function"&&!!document.querySelector("video,img[class*=ImgPhotoSlide]"),challenge:!!document.querySelector(\'[id^="captcha-verify-container"],[class*="captcha-drag-icon"]\'),networkError:document.title==="Webpage not available"})');
      if(state.challenge)throw Error('Verification requires the user; not bypassed');
      if(state.networkError){await tik.call('Page.reload',{ignoreCache:true});await pause(1000)}
      if(openProfileVideo&&state.pageReady&&!profileOpened){
        profileOpened=true;
        await tik.read(readFileSync('scripts/tiktok-audit-open-creator.js','utf8'));
        await pause(500);continue;
      }
      if(openProfileVideo&&profileOpened&&!profileVideoOpened){
        if(await tik.read(`location.pathname==="/@spambiebambi" && !!document.querySelector('[data-e2e=user-post-item] a[href*="/video/"]')`)){
          const opened=await tik.read(readFileSync('scripts/tiktok-audit-open-profile-video.js','utf8'));
          profileVideoOpened=!!opened.opened;
        }
        await pause(500);continue;
      }
      // A ready For You video can precede its navigation bar. Do not let that
      // initial video masquerade as a completed creator-playlist preflight.
      loaded=state.ready&&(!openProfileVideo||(profileOpened&&profileVideoOpened&&
        await tik.read(`location.pathname.startsWith('/@spambiebambi/video/') || !!document.querySelector('[data-e2e="cinema-mode-exit"]')`)));
      if(!loaded)await pause(500);
    }
    if(!loaded)throw Error('TikTok has no loaded video; no scored test started');
    const layer=await tik.read('window.__pongCompositorLayer ?? null');
    if(layer!==(normalLayer?0:2))throw Error(`Compositor experiment not engaged: wanted ${normalLayer?0:2}, got ${layer}; cold-start the test app before retrying`);
    console.log(JSON.stringify({appliedTikTokLayer:layer}));
  }finally{tik.close()}
  if(!noSwap){
    if(process.env.PONG_AUDIT_FACE){
      console.log(await pong.read(`(async()=>{const data=await pongFaceSwapControlFetch('/pong-swap/faces',{cache:'no-store'}).then(r=>r.json());const face=data.faces.find(f=>f.name===${JSON.stringify(process.env.PONG_AUDIT_FACE)});if(!face)throw Error('Requested benchmark approved face missing');pongFaceSwapState.faces=data.faces;setPongFaceSwapSelection([face.id]);window.PongTikTokLiveEnableSelectedSwap();return {enabled:pongFaceSwapState.enabled,selected:1,faceName:face.name}})()`));
    }else console.log(await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8')));
  }
}finally{pong.close()}
