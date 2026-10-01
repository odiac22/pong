// Manual, emulator-only decoder attribution. Never a swap-performance pass.
// No navigation, renderer restart, preset edit, or source/quality change.
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {connectWebView} from './lib/tiktok-audit-cdp.mjs';
import {installProbe,installHeadlessPong,installHeadlessTikTok,WINDOW_MS} from './experiment-tiktok-producer-jank.mjs';

export const CONDITIONS=['producer-headless','active-no-warm','paused-original-active-no-warm','restored-full-swap'];
const PAUSE_OWNED=readFileSync(new URL('./pause-tiktok-audit-owned-sessions.js',import.meta.url),'utf8');
const BASE='http://127.0.0.1:8792';

// Diagnostic seek only: no forged frame/currentTime receipt. The native
// HTMLMediaElement seeked event is the barrier before each measured arm.
export const seekObservedToStart=String.raw`(async()=>{
  const p=window.__pongDecoderAudioPrior,v=p?.video;
  if(!v?.isConnected||window.__pongTikTokObservedVideo?.video!==v||
     window.__pongTikTokObservedVideo?.pageUrl!==p.pageUrl||
     window.__pongDomSwap||window.__pongDomSwapWarm||
     !Number.isFinite(v.duration)||v.duration<7.5)
    throw Error('Observed seek ownership/duration invalid');
  v.pause();
  const settled=new Promise((resolve,reject)=>{
    let finished=false;
    const done=(error)=>{if(finished)return;finished=true;
      clearTimeout(timer);v.removeEventListener('seeked',onSeeked);
      v.removeEventListener('error',onError);error?reject(error):resolve()};
    const onSeeked=()=>done(),onError=()=>done(Error('Observed seek error'));
    const timer=setTimeout(()=>done(Error('Observed seek timed out')),3000);
    v.addEventListener('seeked',onSeeked,{once:true});
    v.addEventListener('error',onError,{once:true});
    try{v.currentTime=0;if(!v.seeking&&v.currentTime<=.05)done()}catch(e){done(e)}
  });
  await settled;
  if(window.__pongTikTokObservedVideo?.video!==v||
     window.__pongTikTokObservedVideo?.pageUrl!==p.pageUrl||v.currentTime>.1)
    throw Error('Observed seek landed on another source/time');
  await v.play();
  if(v.paused)throw Error('Observed video did not resume');
  return {seekSettled:true,currentTime:v.currentTime,duration:v.duration};
})()`;

// Sample each owned media *object*, not only the DOM nodes. A detached warm
// element is not a DOM insertion, and two insertions may be sequential active
// replacements rather than two simultaneous decoders.
export const installSurfaceCounter=String.raw`(() => {
  if(window.__pongDecoderSurfaceCounter)throw Error('Surface counter already installed');
  let timer=0,seen=new Map(),row=null,activeLast=null,warmLast=null;
  const quality=o=>{try{return Number(o?.getVideoPlaybackQuality?.()?.totalVideoFrames||0)}catch{return 0}};
  function sample(){if(!row)return;
    const active=window.__pongDomSwap,warm=window.__pongDomSwapWarm;
    if(active&&warm){
      if(active===warm)row.sameObjectRoleOverlapSamples++;
      else row.simultaneousSamples++;
    }
    if(active&&active!==activeLast){
      row.activeSessions++;if(activeLast)row.activeReplacements++;activeLast=active;}
    if(warm&&warm!==warmLast){
      row.warmSessions++;if(warmLast)row.warmReplacements++;warmLast=warm;}
    let activeGain=0,warmGain=0;
    for(const [role,s] of [['active',active],['warm',warm]]){
      if(!s?.overlay)continue;
      if(!seen.has(s)){
        if(seen.size>=16){row.overflow=true;continue;}
        seen.set(s,{role,last:quality(s.overlay)});row[role+'Objects']++;
      }else{
        const prior=seen.get(s),now=quality(s.overlay);
        if(prior.role!==role){row.adoptions++;prior.role=role;}
        const gain=Math.max(0,now-prior.last);
        row[role+'DecodedDelta']+=gain;
        if(role==='active')activeGain+=gain;else warmGain+=gain;
        prior.last=now;
      }
    }
    if(active!==warm&&activeGain>0&&warmGain>0)row.simultaneousDecodedSamples++;
    row.samples++;
  }
  const api={begin(){if(row||timer)throw Error('Counter phase active');seen=new Map();
      activeLast=null;warmLast=null;
      row={activeObjects:0,warmObjects:0,activeDecodedDelta:0,warmDecodedDelta:0,
        activeSessions:0,warmSessions:0,activeReplacements:0,warmReplacements:0,
        adoptions:0,simultaneousSamples:0,sameObjectRoleOverlapSamples:0,
        simultaneousDecodedSamples:0,
        samples:0,overflow:false};
      sample();timer=setInterval(sample,50);return true;},
    end(){if(!row)return null;clearInterval(timer);timer=0;sample();const out=row;row=null;return out;},
    restore(){api.end();if(window.__pongDecoderSurfaceCounter===api)
      delete window.__pongDecoderSurfaceCounter;}};
  window.__pongDecoderSurfaceCounter=api;return true;
})()`;

export const installWarmSuppressor=String.raw`(() => {
  if(window.__pongDiagnosticWarmSuppressor)throw Error('Warm suppressor already installed');
  window.__pongDomSwapWarmClear?.();
  if(window.__pongDomSwapWarm)throw Error('Old warm media remained');
  const original=window.__pongDomSwapPrepare;
  if(typeof original!=='function')throw Error('Warm prepare unavailable');
  let calls=0;
  const blocked=function(){calls++;return false};
  window.__pongDomSwapPrepare=blocked;
  const api={inspect:()=>({installed:window.__pongDomSwapPrepare===blocked,calls,
        warm:!!window.__pongDomSwapWarm}),
    restore(){const own=window.__pongDomSwapPrepare===blocked;
      if(own)window.__pongDomSwapPrepare=original;
      if(window.__pongDiagnosticWarmSuppressor===api)delete window.__pongDiagnosticWarmSuppressor;
      return own;}};
  window.__pongDiagnosticWarmSuppressor=api;return api.inspect();
})()`;

export const installPausedOriginalIsolation=String.raw`(() => {
  if(window.__pongDiagnosticPausedOriginal)throw Error('Pause isolation already installed');
  const v=window.__pongTikTokObservedVideo?.video;
  if(window.__pongDomSwap||!v?.isConnected||v.paused||window.__pongDomSwapWarm||
     !window.__pongDiagnosticWarmSuppressor?.inspect()?.installed)
    throw Error('Need no prior decoder, playing observed original, no warm');
  const sync=window.__pongDomSwapSync;
  if(typeof sync!=='function')throw Error('Frame synchronizer unavailable');
  let s=null,o=null,priorOpacity='',poll=0,restored=false;
  // Pre-arm before activation. No production synchronizer call can reveal the
  // new decoder even if native attach invokes it before CDP observes the node.
  const suppressed=function(){return {active:!!window.__pongDomSwap,visible:false,
    diagnosticPausedOriginal:true,readyState:window.__pongDomSwap?.overlay?.readyState||0,
    sessionId:window.__pongDomSwap?.sessionId||''}};
  window.__pongDomSwapSync=suppressed;
  const api={inspect:()=>({syncOwned:window.__pongDomSwapSync===suppressed,
      sameSession:!!s&&window.__pongDomSwap===s,originalPaused:v.paused,
      overlayPlaying:!!o&&!o.paused,visible:!!s?.visible}),
    ready:()=>new Promise((resolve,reject)=>{
      const deadline=performance.now()+5000;
      poll=setInterval(()=>{
        if(window.__pongDomSwapSync!==suppressed||!v.isConnected||
           window.__pongTikTokObservedVideo?.video!==v||window.__pongDomSwapWarm){
          clearInterval(poll);poll=0;reject(Error('Isolation ownership changed'));return;}
        const current=window.__pongDomSwap;
        if(current?.overlay){
          clearInterval(poll);poll=0;
          if(current.original!==v||current.visible||!current.timer){
            reject(Error('Active decoder is not safely hidden'));return;}
          s=current;o=s.overlay;priorOpacity=o.style.opacity;
          clearInterval(s.timer);s.timer=0;o.style.opacity='0';v.pause();
          try{Promise.resolve(o.play()).catch(()=>{})}catch(_){}
          resolve(api.inspect());return;}
        if(performance.now()>deadline){clearInterval(poll);poll=0;
          reject(Error('Hidden active decoder did not attach'));}
      },20);
    }),
    async restore(){if(restored)return true;restored=true;
      const own=window.__pongDomSwapSync===suppressed,same=window.__pongDomSwap===s;
      if(poll){clearInterval(poll);poll=0;}
      if(own)window.__pongDomSwapSync=sync;
      if(same&&s){o.style.opacity=priorOpacity;o.pause();
        if(own)s.timer=setInterval(()=>window.__pongDomSwap===s&&window.__pongDomSwapSync(),100);}
      if(v.isConnected)try{await v.play()}catch(_){}
      if(window.__pongDiagnosticPausedOriginal===api)delete window.__pongDiagnosticPausedOriginal;
      return own&&(!s||same)&&v.isConnected&&!v.paused;}};
  window.__pongDiagnosticPausedOriginal=api;
  return api.inspect();
})()`;

export function validWindow(row,{paused=false,noWarm=false}={}){
  const p=row?.probe,c=row?.surfaces;
  if(!p?.sameVideo||!c||c.overflow||c.samples<2||!Number.isFinite(p.raf?.count))return false;
  if(noWarm&&(c.warmObjects>0||c.warmDecodedDelta>0||c.simultaneousSamples>0))return false;
  if(paused){
    if(!p.original?.paused||c.activeObjects<1||c.activeDecodedDelta<30||
       p.overlay?.visible||p.original?.unexpectedSeek||
       !Number.isFinite(p.original?.firstCurrentTime)||
       !Number.isFinite(p.original?.lastCurrentTime)||
       Math.abs(Number(p.original?.lastCurrentTime)-Number(p.original?.firstCurrentTime))>.1)
      return false;
  }else if(p.original?.paused||p.original?.unexpectedSeek)return false;
  return true;
}

export function armEvidence(row,{paused=false,noWarm=false,headless=false}={}){
  const reasons=[],p=row?.probe,c=row?.surfaces;
  if(!validWindow(row,{paused,noWarm})){
    if(c?.overflow)reasons.push('surface-count-overflow');
    if(noWarm&&(c?.warmObjects||c?.warmDecodedDelta||c?.simultaneousSamples))
      reasons.push('warm-decoder-present');
    if(p?.original?.unexpectedSeek)reasons.push('original-unexpected-seek');
    if(paused&&Number.isFinite(p?.original?.firstCurrentTime)&&
       Number.isFinite(p?.original?.lastCurrentTime)&&
       Math.abs(p.original.lastCurrentTime-p.original.firstCurrentTime)>.1)
      reasons.push('paused-original-clock-moved');
    if(paused&&c?.activeDecodedDelta<30)reasons.push('paused-active-decoder-under-30');
    if(!paused&&p?.original?.paused)reasons.push('original-paused');
    if(!reasons.length)reasons.push('window-evidence');
  }
  if(headless&&(!row?.producer?.transformedFrames||!row?.producer?.bytesWritten||
      row?.surfaces?.activeObjects||row?.surfaces?.warmObjects))
    reasons.push('headless-producer-or-decoder');
  if(!headless&&!paused&&noWarm&&
     (!row?.surfaces?.activeObjects||row?.surfaces?.activeDecodedDelta<30))
    reasons.push('active-decoder-under-30');
  return {valid:reasons.length===0,reasons};
}

async function rendererSession(sessionId){
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId))return null;
  const response=await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}`,
    {signal:AbortSignal.timeout(3000)});
  if(!response.ok)return null;
  const raw=(await response.json()).session;
  if(!raw||raw.id!==sessionId)return null;
  return {state:String(raw.state||''),frames:Number(raw.frames||0),
    transformedFrames:Number(raw.transformedFrames||0),
    bytesWritten:Number(raw.bytesWritten||0),completeFragments:Number(raw.completeFragments||0)};
}

async function main(){
  if(process.argv.length!==3||process.argv[2]!=='--run-emulator-decoder-attribution')
    throw Error('Explicit --run-emulator-decoder-attribution required');
  const report={diagnosticOnly:true,device:'emulator-5582',conditions:CONDITIONS,
    note:'Sequential same-page 6s attribution, not playback FPS or green-paint qualification. Paused-original arm intentionally freezes TikTok clock/audio.',
    windows:[]};
  let tik,pong;
  try{
    const health=await fetch(`${BASE}/health`,{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
    if(!health.ready||Number(health.activeSessions)!==0)throw Error('Renderer must start ready and idle');
    tik=await connectWebView(60195,'tiktok');pong=await connectWebView(60195,'pong');
    await tik.read(`(()=>{const v=window.__pongTikTokObservedVideo?.video;
      if(!v?.isConnected)throw Error('Observed video unavailable');
      window.__pongDecoderAudioPrior={video:v,muted:v.muted,defaultMuted:v.defaultMuted,
        volume:v.volume,wasPlaying:!v.paused,currentTime:v.currentTime,
        pageUrl:window.__pongTikTokObservedVideo?.pageUrl};
      return true;})()`);
    const observed=await tik.read(installProbe);
    if(!/^[0-9]{15,22}$/.test(observed?.id))throw Error('Visible canonical video unavailable');
    report.videoIdHash=createHash('sha256').update(observed.id).digest('hex').slice(0,16);
    const selection=await pong.read(`(()=>({videoId:(pongTikTokLiveState.current||'').match(/video\\/(\\d+)/)?.[1]||'',
      count:pongFaceSwapFaceIds().length}))()`);
    if(selection.videoId!==observed.id||selection.count<1)throw Error('Selection/current video mismatch');
    await tik.read(installSurfaceCounter);
    const prepareArm=async()=>{
      await pong.read(PAUSE_OWNED);
      await tik.read('window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.();true');
      const settled=await tik.read(seekObservedToStart);
      if(!settled?.seekSettled)throw Error('Observed source seek not settled');
      const currentId=await pong.read(`(pongTikTokLiveState.current||'').match(/video\\/(\\d+)/)?.[1]||''`);
      if(currentId!==observed.id)throw Error('Pong current video changed before arm');
      return settled;
    };
    const start=async()=>{
      const current=await tik.read('Number(window.__pongTikTokObservedVideo?.video?.currentTime||0)');
      const result=await pong.read(`(()=>{const e=JSON.parse(window.PongTikTokLiveEnableSelectedSwap());
        if(e.status!=='started')return e;
        return {status:e.status,started:!!window.PongTikTokLiveSwapCurrent(pongTikTokLiveState.current,${Math.max(0,Number(current)||0)})};})()`);
      if(result.status!=='started'||!result.started)throw Error('Swap activation rejected');
    };
    const windowRun=async(condition,{activate=true,paused=false,noWarm=false}={})=>{
      let probe,surfaces;
      await tik.read('window.__pongDecoderSurfaceCounter.begin()');
      try{
        await tik.read(`window.__pongProducerJankProbe.begin(${JSON.stringify(condition)},${WINDOW_MS})`);
        if(activate)await start();
        probe=await tik.read('window.__pongProducerJankProbe.wait()');
      }finally{
        if(!probe)probe=await tik.read('window.__pongProducerJankProbe?.finish()').catch(()=>null);
        surfaces=await tik.read('window.__pongDecoderSurfaceCounter.end()').catch(()=>null);
      }
      const session=await pong.read(`String(pongFaceSwapCurrentWrapper()?.dataset.pongFaceSwapSessionId||'')`);
      const producer=await rendererSession(session);
      const row={condition,probe,surfaces,producer};report.windows.push(row);
      if(noWarm&&!await tik.read('window.__pongDiagnosticWarmSuppressor?.inspect()?.installed===true'))
        throw Error('Warm hook was replaced');
      if(paused){const isolation=await tik.read('window.__pongDiagnosticPausedOriginal?.inspect()');
        if(!isolation?.syncOwned||!isolation.sameSession||!isolation.originalPaused||
           isolation.visible)throw Error('Paused-original isolation ownership changed');}
      const currentId=await tik.read(`(window.__pongTikTokObservedVideo?.pageUrl||'').match(/video\\/(\\d+)/)?.[1]||''`);
      if(currentId!==observed.id||!probe?.sameVideo)throw Error('Observed page/video changed');
      row.evidence=armEvidence(row,{paused,noWarm,headless:condition==='producer-headless'});
      return row;
    };
    await prepareArm();
    await tik.read(installHeadlessTikTok);await pong.read(installHeadlessPong);
    const headless=await windowRun('producer-headless');
    const pg=await pong.read('window.__pongProducerHeadless?.inspect()||null');
    const tg=await tik.read('window.__pongProducerTikTokGuard?.inspect()||null');
    if(!pg?.stillInstalled||!tg?.stillInstalled)
      throw Error('Headless guard ownership changed');
    if(pg.suppressedReadyCalls<1){headless.evidence.valid=false;
      headless.evidence.reasons.push('headless-ready-not-suppressed');}
    await prepareArm();
    if(!await pong.read(`(()=>{const g=window.__pongProducerHeadless;
      if(!g?.inspect().stillInstalled)return false;g.restore();return !window.__pongProducerHeadless;})()`))
      throw Error('Headless Pong hook restore failed');
    if(!await tik.read(`(()=>{const g=window.__pongProducerTikTokGuard;
      if(!g?.inspect().stillInstalled)return false;g.restore();return !window.__pongProducerTikTokGuard;})()`))
      throw Error('Headless TikTok hook restore failed');
    await tik.read(installWarmSuppressor);
    const active=await windowRun('active-no-warm',{noWarm:true});
    await prepareArm();
    await tik.read(installPausedOriginalIsolation);
    try{
      await start();
      const ready=await tik.read('window.__pongDiagnosticPausedOriginal.ready()');
      if(!ready?.syncOwned||!ready.sameSession||!ready.originalPaused||ready.visible)
        throw Error('Paused-original decoder did not attach hidden');
      await windowRun('paused-original-active-no-warm',
        {activate:false,paused:true,noWarm:true});
    }catch(error){
      if(!/Hidden active decoder did not attach|Swap activation rejected/.test(String(error?.message)))
        throw error;
      report.windows.push({condition:'paused-original-active-no-warm',
        evidence:{valid:false,reasons:['hidden-decoder-setup']},
        setupError:String(error?.message||error)});
    }finally{
      if(!await tik.read('window.__pongDiagnosticPausedOriginal?.restore()'))
        throw Error('Paused original/synchronizer restore failed');
    }
    await prepareArm();
    if(!await tik.read('window.__pongDiagnosticWarmSuppressor?.restore()'))
      throw Error('Warm hook restore failed');
    await windowRun('restored-full-swap');
    report.completed=true;
    report.validArms=report.windows.filter(w=>w.evidence?.valid).length;
  }catch(error){report.error=String(error?.message||error).replace(/https?:\/\/\S+/g,'[redacted]');process.exitCode=1;}
  finally{
    if(pong)await pong.read(PAUSE_OWNED).catch(()=>{});
    if(tik){
      await tik.read('window.__pongDiagnosticPausedOriginal?.restore()').catch(()=>{});
      await tik.read('window.__pongDiagnosticWarmSuppressor?.restore()').catch(()=>{});
      await tik.read('window.__pongProducerTikTokGuard?.restore()').catch(()=>{});
      await tik.read('window.__pongDecoderSurfaceCounter?.restore()').catch(()=>{});
      await tik.read('window.__pongProducerJankProbe?.restore()').catch(()=>{});
      await tik.read('window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.();true').catch(()=>{});
      const restored=await tik.read(`(async()=>{const p=window.__pongDecoderAudioPrior;
        if(!p?.video?.isConnected||window.__pongTikTokObservedVideo?.video!==p.video||
           window.__pongTikTokObservedVideo?.pageUrl!==p.pageUrl){
          delete window.__pongDecoderAudioPrior;
          return {restored:false,reason:'source-changed'};}
        const v=p.video;v.pause();
        let seekError=null,playError=null;
        try{
          if(Number.isFinite(p.currentTime)&&Number.isFinite(v.duration)){
            const target=Math.max(0,Math.min(p.currentTime,Math.max(0,v.duration-.05)));
            await new Promise((resolve,reject)=>{
              let finished=false;
              const done=error=>{if(finished)return;finished=true;clearTimeout(timer);
                v.removeEventListener('seeked',onSeeked);v.removeEventListener('error',onError);
                error?reject(error):resolve()};
              const onSeeked=()=>done(),onError=()=>done(Error('restore-seek-error'));
              const timer=setTimeout(()=>done(Error('restore-seek-timeout')),3000);
              v.addEventListener('seeked',onSeeked,{once:true});
              v.addEventListener('error',onError,{once:true});
              try{v.currentTime=target;if(!v.seeking&&Math.abs(v.currentTime-target)<.05)done()}
              catch(e){done(e)}
            });
          }
        }catch(e){seekError=String(e?.message||e)}
        try{v.muted=p.muted;v.defaultMuted=p.defaultMuted;v.volume=p.volume;
          if(p.wasPlaying)await v.play();}
        catch(e){playError=String(e?.message||e)}
        delete window.__pongDecoderAudioPrior;
        return {restored:!seekError&&!playError,
          reason:seekError||playError||null,playhead:v.currentTime,playing:!v.paused};
      })()`).catch(error=>({restored:false,reason:String(error?.message||error)}));
      report.sourceRestore=restored;
    }
    if(pong)await pong.read('window.__pongProducerHeadless?.restore()').catch(()=>{});
    tik?.close();pong?.close();
    const file=`E:/Pong Benchmarks/tiktok-webview-2026-09-29/decoder-attribution-${Date.now()}.json`;
    writeFileSync(file,JSON.stringify(report,null,2));
    console.log(JSON.stringify({file,completed:!!report.completed,error:report.error||null}));
  }
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main();
