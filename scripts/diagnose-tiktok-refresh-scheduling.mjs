// Original-only, same canonical page, emulator receiver only. Diagnostic, not FPS qualification.
import {readFileSync,writeFileSync} from 'node:fs';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {installProbe} from './experiment-tiktok-producer-jank.mjs';
if(process.argv.length!==3||process.argv[2]!=='--run-emulator-refresh-diagnostic')
  throw Error('Explicit emulator refresh diagnostic flag required');
const out={diagnosticOnly:true,started:new Date().toISOString(),windows:[]};
let tik,pong;
try{
  pong=await connectWebView(60195,'pong');tik=await connectWebView(60195,'tiktok');
  await pong.read(readFileSync('scripts/pause-tiktok-audit-owned-sessions.js','utf8'));
  await tik.read('window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.();true');
  const page=await tik.read('location.origin+location.pathname');
  if(!/^https:\/\/www\.tiktok\.com\/@[^/?]+\/video\/\d{15,22}$/.test(page))
    throw Error('Canonical video required');
  for(const condition of ['before-refresh','after-refresh']){
    if(condition==='after-refresh'){
      const oldTimeOrigin=await tik.read('performance.timeOrigin');
      await tik.call('Page.reload',{ignoreCache:false});
      let ready=false;
      for(let i=0;i<60;i++){
        const status=await tik.read(`(()=>{const v=window.__pongTikTokObservedVideo?.video;
          return {same:location.origin+location.pathname===${JSON.stringify(page)},
            challenge:!!document.querySelector('[id^="captcha-verify-container"],[class*="captcha-drag-icon"]'),
            ready:performance.timeOrigin!==${oldTimeOrigin}&&document.readyState==='complete'&&v?.isConnected&&v.readyState>=2&&!v.paused};})()`).catch(()=>({}));
        if(status.challenge)throw Error('Verification present; diagnostic stopped');
        if(status.ready&&status.same){ready=true;break;}
        await new Promise(r=>setTimeout(r,250));
      }
      if(!ready)throw Error('Same video not ready after refresh');
    }
    // Retirement can briefly pause the source; explicitly restore muted play
    // intent before measuring either arm, without altering its playhead.
    await tik.read(`(async()=>{const v=window.__pongTikTokObservedVideo?.video;
      if(!v?.isConnected)throw Error('Observed source missing');
      v.muted=true;v.defaultMuted=true;v.volume=0;
      if(v.paused)await v.play();return true;})()`);
    let sourceReady=false;
    for(let i=0;i<20;i++){
      sourceReady=await tik.read(`(()=>{const v=window.__pongTikTokObservedVideo?.video;
        return !!v?.isConnected&&v.readyState>=2&&!v.paused&&Number.isFinite(v.duration)&&v.duration>1;})()`);
      if(sourceReady)break;await new Promise(r=>setTimeout(r,100));
    }
    if(!sourceReady)throw Error('Source not ready before timing window');
    await tik.read(installProbe);
    await tik.read(`window.__pongProducerJankProbe.begin(${JSON.stringify(condition)},6000)`);
    const probe=await tik.read('window.__pongProducerJankProbe.wait()');
    out.windows.push({condition,probe});
    await tik.read('window.__pongProducerJankProbe.restore()');
    if(!probe.sameVideo||probe.swapSeenFrames||probe.overlay.active||probe.overlay.warm)
      throw Error('Original-only attribution failed');
  }
  out.completed=true;
}catch(e){out.error=String(e.message).replace(/https?:\/\/\S+/g,'[redacted]');process.exitCode=1;}
finally{
  if(tik)await tik.read('window.__pongProducerJankProbe?.restore();true').catch(()=>{});
  tik?.close();pong?.close();
  const file=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/refresh-scheduling-${Date.now()}.json`;
  writeFileSync(file,JSON.stringify(out,null,2));console.log(JSON.stringify({file,...out}));
}
