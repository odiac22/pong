import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
const adb='C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe';
const device='emulator-5582',directory='E:/Pong Benchmarks/tiktok-webview-2026-09-29';
const feedOnly=process.argv.includes('--feed-only');
const output=`${directory}/controls-${Date.now()}.json`,checks=[];
const tik=await connectWebView(60195,'tiktok'),pong=await connectWebView(60195,'pong');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(expression,seconds=10){
 const started=performance.now();let value;
 while(performance.now()-started<seconds*1000){
   value=await tik.read(expression);if(value)return {ok:true,ms:performance.now()-started};
   if(await tik.read('!!document.querySelector("[id^=captcha-verify-container],[class*=captcha-drag-icon]")'))
     throw Error('Verification appeared; no puzzle interaction attempted');
   await pause(150);
 }
 return {ok:false,ms:performance.now()-started};
}
try{
 await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
 if(!feedOnly){
 await tik.read('document.querySelector("[data-e2e=cinema-mode-exit]")?.click();true');
 await pause(350);
 const profile=await tik.read(readFileSync('scripts/tiktok-audit-profile.js','utf8'));
 checks.push({name:'own Profile navigation',clicked:profile.clicked,...await until('location.pathname.startsWith("/@") && !!document.querySelector("[data-e2e=user-title]")')});
 await tik.read(readFileSync('scripts/tiktok-audit-open-creator.js','utf8'));
 checks.push({name:'creator video grid',...await until(`location.pathname==="/@spambiebambi" && !!document.querySelector('[data-e2e=user-post-item] a[href*="/video/"]')`)});
 const opened=await tik.read(readFileSync('scripts/tiktok-audit-open-profile-video.js','utf8'));
 checks.push({name:'creator video playback',clicked:opened.opened,...await until('[...document.querySelectorAll("video:not(.pong-tiktok-swap-stream)")].some(v=>!v.paused&&v.readyState>=2)')});
 }
 const before=await tik.read('location.pathname');
 await pong.call('Page.reload',{ignoreCache:true});
 await pause(1500);
 checks.push({name:'Pong refresh preserves TikTok route and controls',ok:
   await tik.read('location.pathname')===before && await pong.read('document.documentElement.classList.contains("pong-tiktok-original-overlay")')});
 // Native Exit is outside the web DOM. Obtain its actual Android bounds.
 execFileSync(adb,['-s',device,'shell','uiautomator','dump','--compressed','/data/local/tmp/pong-audit-ui.xml'],{encoding:'utf8',timeout:20000});
 const xml=execFileSync(adb,['-s',device,'exec-out','cat','/data/local/tmp/pong-audit-ui.xml'],{encoding:'utf8'});
 const exitNode=xml.match(/<node\b[^>]*\btext="Exit"[^>]*>/)?.[0];
 const bounds=exitNode?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
 if(!bounds)throw Error('Native Exit bounds not found; no guessed tap sent');
 const x=Math.round((Number(bounds[1])+Number(bounds[3]))/2),y=Math.round((Number(bounds[2])+Number(bounds[4]))/2);
 execFileSync(adb,['-s',device,'shell','input','tap',String(x),String(y)],{timeout:5000});
 await pause(500);
 checks.push({name:'native red Exit returns to Pong',ok:await pong.read('!document.documentElement.classList.contains("pong-tiktok-original-overlay")')});
 checks.push({name:'Exit leaves TikTok media paused',ok:await tik.read('[...document.querySelectorAll("video,audio")].every(v=>v.paused)')});
 await pong.read(readFileSync('scripts/open-tiktok-emulator.js','utf8'));
 await pause(500);
 checks.push({name:'reopen retains route without a token panel',ok:
   await tik.read('location.pathname')===before && await pong.read('document.documentElement.classList.contains("pong-tiktok-original-overlay")')});
 checks.push({name:'reopen resumes the previously playing original',...await until('[...document.querySelectorAll("video:not(.pong-tiktok-swap-stream)")].some(v=>!v.paused&&v.readyState>=2)')});
}catch(error){checks.push({name:'smoke run error',ok:false,error:error.message});process.exitCode=1}
finally{
 tik.close();pong.close();const result={checks,scope:feedOnly?'refresh-exit-reopen-only':'full-controls',
   pass:checks.length===(feedOnly?5:8)&&checks.every(c=>c.ok),silentEmulator:true};
 writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify({saved:output,...result},null,2));
}
