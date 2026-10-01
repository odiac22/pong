// Emulator-only, reversible capability diagnostic. Never shipped in the APK.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const output=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/codec-trial-${Date.now()}.json`;
const result={kind:'HEVC capability rejection in test WebView only; original playback, no swap',restored:false};
const withSwap=process.argv.includes('--swap');
if(withSwap)result.kind='Emulator AVC compatibility trial with unchanged swap quality';
result.decoderProperties=[];
const removeMediaObserver=tik.onEvent(event=>{
 if(event.method!=='Media.playerPropertiesChanged')return;
 for(const p of event.params.properties||[]){
  if(/^(kVideoDecoderName|kVideoTracks|kResolution|video_decoder|video_codec_name|resolution)$/.test(p.name))
   result.decoderProperties.push({name:p.name,value:String(p.value).slice(0,1024)});
 }
 if(result.decoderProperties.length>100)result.decoderProperties.splice(0,result.decoderProperties.length-100);
});
let identifier;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const probe=`(()=>({hevc:MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"'),avc:MediaSource.isTypeSupported('video/mp4; codecs="avc1.64001F"'),videos:[...document.querySelectorAll('video:not(.pong-tiktok-swap-stream)')].map(v=>({width:v.videoWidth,height:v.videoHeight,ready:v.readyState,paused:v.paused,error:v.error?.code||0}))}))()`;
try{
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
 await tik.call('Media.enable');
 result.before=await tik.read(probe);
 await tik.call('Page.enable');
 ({identifier}=await tik.call('Page.addScriptToEvaluateOnNewDocument',{source:String.raw`(()=>{
  window.__pongAuditCodecTrial=true;
  const hevc=value=>/\b(?:hev1|hvc1|hevc|h265)\b/i.test(String(value||''));
  const supported=MediaSource.isTypeSupported;MediaSource.isTypeSupported=function(type){return !hevc(type)&&supported.call(this,type)};
  const canPlay=HTMLMediaElement.prototype.canPlayType;HTMLMediaElement.prototype.canPlayType=function(type){return hevc(type)?'':canPlay.call(this,type)};
  const caps=navigator.mediaCapabilities;
  if(caps?.decodingInfo){const info=caps.decodingInfo;caps.decodingInfo=function(config){return hevc(config?.video?.contentType)?Promise.resolve({supported:false,smooth:false,powerEfficient:false}):info.call(this,config)}}
 })()`}));
 await tik.call('Page.reload',{ignoreCache:false});
 for(let i=0;i<40;i++){
  const state=await tik.read(`({applied:window.__pongAuditCodecTrial===true,challenge:!!document.querySelector('#captcha-verify-container'),ready:document.readyState==='complete'&&window.__pongAuditCodecTrial===true&&typeof window.__pongTikTokStep==='function'&&!!document.querySelector('video')})`);
  result.lastState=state;
  if(state.challenge)throw Error('Verification appeared; trial stopped, capability overrides removed in cleanup');
  if(state.ready){result.after=await tik.read(probe);if(result.after.videos.some(v=>v.ready>=2&&!v.paused))break;}
  await pause(500);
 }
 if(!result.lastState?.applied)throw Error('Document-start hook was not observed; codec comparison is unqualified');
 if(!result.after?.videos.some(v=>v.ready>=2&&!v.paused))throw Error('No playing video with HEVC rejected');
 if(result.after.hevc!==false)throw Error('Capability override not applied; codec comparison is unqualified');
 // Reloading a cinema URL can produce TikTok's standalone detail page. Compare
 // the same real creator-playlist viewer as the baseline, not another layout.
 await tik.read(readFileSync('scripts/tiktok-audit-open-creator.js','utf8'));
 let creatorReady=false;
 for(let i=0;i<40;i++){
  if(await tik.read(`location.pathname==='/@spambiebambi'&&!!document.querySelector('[data-e2e="user-post-item"] a[href*="/video/"]')`)){creatorReady=true;break;}
  await pause(250);
 }
 if(!creatorReady)throw Error('Creator grid unavailable; no comparable run');
 await tik.read(readFileSync('scripts/tiktok-audit-open-profile-video.js','utf8'));
 let cinemaReady=false;
 for(let i=0;i<40;i++){
  if(await tik.read(`!!document.querySelector('[data-e2e="cinema-mode-exit"]')&&!![...document.querySelectorAll('video')].find(v=>v.readyState>=2&&!v.paused)`)){cinemaReady=true;break;}
  await pause(250);
 }
 result.cinemaReady=cinemaReady;
 if(!cinemaReady)throw Error('Creator cinema unavailable; no comparable run');
 if(withSwap)await pong.read(readFileSync('scripts/tiktok-audit-enable-multi.js','utf8'));
 const nearest=withSwap&&process.argv.includes('--nearest');
 const child=spawn(process.execPath,nearest?['scripts/trial-tiktok-nearest-prefetch.mjs']:['scripts/benchmark-tiktok-emulator.mjs',process.env.PONG_AUDIT_COUNT||(withSwap?'8':'5'),...(withSwap?['--videos']:['--original-only'])],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PONG_AUDIT_SAMPLE_MS:'500',PONG_AUDIT_VARIANT:process.env.PONG_AUDIT_VARIANT||(withSwap?'avc-site-compat-swap-trial':'avc-site-original-only-trial')}});
 let stdout='',stderr='';child.stdout.on('data',part=>{stdout+=part;process.stdout.write(part)});child.stderr.on('data',part=>{stderr+=part;process.stderr.write(part)});
 const code=await new Promise(resolve=>child.on('close',resolve));
 result.benchmarkExitCode=code;result.benchmarkLog=stdout;result.benchmarkError=stderr;
}catch(error){result.error=error.message;process.exitCode=1}
finally{
 if(withSwap)await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8')).catch(()=>{});
 if(identifier){await tik.call('Page.removeScriptToEvaluateOnNewDocument',{identifier});await tik.call('Page.reload',{ignoreCache:false});result.restored=true;}
 await tik.call('Media.disable').catch(()=>{});removeMediaObserver();
 tik.close();pong.close();writeFileSync(output,JSON.stringify(result,null,2));
 console.log(JSON.stringify({saved:output,restored:result.restored,error:result.error||null,before:result.before,after:result.after,lastState:result.lastState}));
}
