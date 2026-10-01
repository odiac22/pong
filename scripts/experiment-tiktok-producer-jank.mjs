// Manual-only diagnostic: same already-visible TikTok video, no navigation.
// Run only after live work pauses: node scripts/experiment-tiktok-producer-jank.mjs --run-isolated-jank-trial [--same-playhead [--start-seconds 6]]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectWebView } from './lib/tiktok-audit-cdp.mjs';

export const WINDOW_MS = 6000;
export const CONDITIONS = ['original-only', 'producer-headless', 'full-swap'];
export const ID_PATTERN = /^[0-9]{15,22}$/;

export function parseJankTrialArgs(args) {
  if (!Array.isArray(args) || args[0] !== '--run-isolated-jank-trial')
    throw Error('Explicit --run-isolated-jank-trial is required');
  let samePlayhead = false, startSeconds = 0, sawStart = false;
  for (let index = 1; index < args.length; index++) {
    if (args[index] === '--same-playhead' && !samePlayhead) {
      samePlayhead = true;
    } else if (args[index] === '--start-seconds' && !sawStart) {
      const raw = args[++index];
      if (typeof raw !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw))
        throw Error('--start-seconds requires a finite nonnegative number');
      startSeconds = Number(raw);
      if (!Number.isFinite(startSeconds))
        throw Error('--start-seconds requires a finite nonnegative number');
      sawStart = true;
    } else {
      throw Error(`Unexpected jank-trial argument: ${String(args[index])}`);
    }
  }
  if (sawStart && !samePlayhead) throw Error('--start-seconds requires --same-playhead');
  return {samePlayhead, startSeconds};
}

export function attributableHeadless({ probe, guard, producer }) {
  return Boolean(probe?.sameVideo && probe?.original?.frameCallbacks > 0 &&
    probe?.original?.mediaProgress > 0 && !probe?.original?.unexpectedSeek &&
    probe?.swapSeenFrames === 0 &&
    probe?.swapDomInsertions === 0 && !probe?.overlay?.active && !probe?.overlay?.warm &&
    guard?.pongInstalled && guard?.pongStillInstalled && guard?.invalidCalls === 0 &&
    guard?.tiktokInstalled &&
    guard?.tiktokStillInstalled && guard?.suppressedReadyCalls > 0 &&
    !guard?.tiktokActive && !guard?.tiktokWarm && guard?.overlayCount === 0 &&
    guard?.nativePrepareBlocked >= 0 && guard?.nativeAttachBlocked >= 0 &&
    producer?.id && producer?.transformedFrames > 0 && producer?.bytesWritten > 0 &&
    producer?.completeFragments > 0);
}

export function compactRenderer(raw, expectedId) {
  if (!raw || raw.id !== expectedId) return null;
  const num = key => Number.isFinite(Number(raw[key])) ? Number(raw[key]) : 0;
  return { id: raw.id, state: String(raw.state || ''), frames: num('frames'),
    transformedFrames: num('transformedFrames'), bytesWritten: num('bytesWritten'),
    completeFragments: num('completeFragments'), muxedMediaSeconds: num('muxedMediaSeconds'),
    sourceOpened: num('sourceOpenedAt') > 0, firstByte: num('firstByteAt') > 0 };
}

export function attributableFullSwap({probe, producer}) {
  return Boolean(probe?.sameVideo && probe?.swapSeenFrames > 0 &&
    probe?.overlay?.maxDecoded > 0 &&
    producer?.id && producer?.transformedFrames > 0 &&
    producer?.bytesWritten > 0 && producer?.completeFragments > 0);
}

export const installProbe = String.raw`(() => {
  if (window.__pongProducerJankProbe) throw Error('Probe already installed');
  const observed=window.__pongTikTokObservedVideo;
  const original=observed?.video, page=String(observed?.pageUrl||'');
  const id=page.match(/\/video\/(\d{15,22})(?:\/?(?:\?|$))?/)?.[1]||'';
  if(!id||!original?.isConnected||original.readyState<2||original.paused||
     !Number.isFinite(original.duration)||original.duration<=1)
    throw Error('Need the same playing observed video with finite duration');
  const initialTime=Number(original.currentTime||0),initialPlaying=!original.paused;
  original.muted=true;original.defaultMuted=true;original.volume=0;
  let phase=null,raf=0,frameCallback=0,observer=null,mutations=null,timer=0,done=null;
  const q=()=>original.getVideoPlaybackQuality?.();
  const identity=()=>window.__pongTikTokObservedVideo?.video===original&&
    window.__pongTikTokObservedVideo?.pageUrl===page&&original.isConnected&&
    location.hostname==='www.tiktok.com';
  const overlay=()=>{const s=window.__pongDomSwap,w=window.__pongDomSwapWarm;
    const o=s?.overlay,b=o?.buffered;let end=0;
    try{for(let i=0;b&&i<b.length;i++)end=Math.max(end,b.end(i));}catch{}
    return {active:!!s,warm:!!w,visible:!!s?.visible,ready:Number(o?.readyState||0),
      decoded:Number(o?.getVideoPlaybackQuality?.()?.totalVideoFrames||0),bufferedEnd:end,
      transport:s?{bytes:Number(s.transport?.bytes||0),chunks:Number(s.transport?.chunks||0),
        appendCalls:Number(s.transport?.appendCalls||0),coalescedReads:Number(s.transport?.coalescedReads||0),
        fragmentBatch:!!s.transport?.fragmentBatch,packets:Number(s.transport?.packets||0),
        workerPackets:Number(s.transport?.packets||0)}:null};};
  function finish(){
    if(!phase)return null;
    const p=phase;phase=null;clearTimeout(timer);cancelAnimationFrame(raf);
    if(frameCallback)original.cancelVideoFrameCallback?.(frameCallback);
    observer?.disconnect();observer=null;mutations?.disconnect();mutations=null;
    const quality=q(),after=performance.now(),endOverlay=overlay();
    endOverlay.maxDecoded=Math.max(p.maxSwapDecoded,endOverlay.decoded);
    if(!endOverlay.transport)endOverlay.transport=p.lastTransport;
    const result={condition:p.condition,elapsedMs:after-p.at,sameVideo:p.sameVideo&&identity(),
      raf:{count:p.rafCount,gaps:p.rafGaps,over50ms:p.rafOver50,maxGapMs:p.rafMax},
      longTasks:{count:p.longCount,totalMs:p.longMs,maxMs:p.longMax},
      original:{frameCallbacks:p.frames,firstMediaTime:p.firstMedia,lastMediaTime:p.lastMedia,
        mediaProgress:p.mediaProgress,loops:p.loops,unexpectedSeek:p.unexpectedSeek,
        firstCurrentTime:p.currentAt,
        lastCurrentTime:original.currentTime,readyState:original.readyState,paused:original.paused,
        decodedDelta:quality&&p.quality?quality.totalVideoFrames-p.quality.totalVideoFrames:null,
        droppedDelta:quality&&p.quality?quality.droppedVideoFrames-p.quality.droppedVideoFrames:null},
      swapSeenFrames:p.swapSeenFrames,swapDomInsertions:p.swapDomInsertions,overlay:endOverlay};
    p.resolve(result);return result;
  }
  const waitForSeek=target=>new Promise((resolve,reject)=>{
    let timeout=0;
    const clean=()=>{clearTimeout(timeout);original.removeEventListener('seeked',onSeeked);};
    const onSeeked=()=>{if(original.seeking)return;clean();resolve();};
    original.addEventListener('seeked',onSeeked);
    timeout=setTimeout(()=>{clean();reject(Error('Observed source seek timed out'));},4000);
    try{original.currentTime=target;if(!original.seeking&&Math.abs(original.currentTime-target)<.08)onSeeked();}
    catch(error){clean();reject(error);}
  });
  const api={id,async preparePlayhead(target=0){
    if(phase||!identity()||!Number.isFinite(target)||target<0||original.duration-target<7)
      throw Error('Observed source cannot support paired six-second window');
    original.pause();
    await waitForSeek(target);
    if(!identity())throw Error('Observed source changed during seek');
    await original.play();
    if(original.paused||!identity())throw Error('Observed source did not resume');
    if(typeof original.requestVideoFrameCallback!=='function')
      throw Error('Paired window needs an observed presented source frame');
    const firstMediaTime=await new Promise((resolve,reject)=>{
      let callback=0,timeout=0;
      timeout=setTimeout(()=>{original.cancelVideoFrameCallback?.(callback);
        reject(Error('Observed source frame after seek timed out'));},4000);
      callback=original.requestVideoFrameCallback((_at,meta)=>{clearTimeout(timeout);
        resolve(Number(meta?.mediaTime));});
    });
    if(!identity()||!Number.isFinite(firstMediaTime)||Math.abs(firstMediaTime-target)>.25)
      throw Error('Observed source presented a different playhead');
    return {requestedSeconds:target,actualStartSeconds:Number(original.currentTime),
      firstPresentedMediaTime:firstMediaTime};
  },async restorePlayhead(){
    if(phase)finish();
    if(!identity())return {restored:false,reason:'source-replaced'};
    original.pause();await waitForSeek(initialTime);
    if(!identity())return {restored:false,reason:'source-replaced-during-seek'};
    if(initialPlaying)await original.play();
    return {restored:true,currentTime:Number(original.currentTime),playing:!original.paused};
  },begin(condition,ms){
    if(phase||ms!==6000||!identity())throw Error('Probe state/identity changed');
    let resolve;done=new Promise(r=>resolve=r);
    const quality=q();phase={condition,at:performance.now(),sameVideo:true,rafCount:0,
      rafGaps:0,rafOver50:0,rafMax:0,lastRaf:0,longCount:0,longMs:0,longMax:0,
      frames:0,firstMedia:null,lastMedia:null,mediaProgress:0,loops:0,unexpectedSeek:false,
      currentAt:original.currentTime,quality,
      swapSeenFrames:0,maxSwapDecoded:0,lastTransport:null,swapDomInsertions:0,resolve};
    const tick=at=>{const p=phase;if(!p)return;p.rafCount++;
      if(p.lastRaf){const gap=at-p.lastRaf;p.rafGaps+=gap;if(gap>50)p.rafOver50++;p.rafMax=Math.max(p.rafMax,gap);}
      p.lastRaf=at;p.sameVideo&&=identity();
      if(window.__pongDomSwap||window.__pongDomSwapWarm){p.swapSeenFrames++;
        const current=overlay();p.lastTransport=current.transport||p.lastTransport;
        p.maxSwapDecoded=Math.max(p.maxSwapDecoded,current.decoded);}
      raf=requestAnimationFrame(tick);};raf=requestAnimationFrame(tick);
    const videoFrame=(at,meta)=>{const p=phase;if(!p)return;p.frames++;
      const media=Number(meta.mediaTime),prior=p.lastMedia,duration=Number(original.duration);
      if(p.firstMedia===null)p.firstMedia=media;
      if(prior!==null){const delta=media-prior;
        if(delta>=0&&delta<=2)p.mediaProgress+=delta;
        else if(delta<0&&prior>=duration-.75&&media<=.75){
          p.mediaProgress+=Math.max(0,duration-prior+media);p.loops++;
        }else p.unexpectedSeek=true;
      }
      p.lastMedia=media;
      frameCallback=original.requestVideoFrameCallback(videoFrame);};
    if(original.requestVideoFrameCallback)frameCallback=original.requestVideoFrameCallback(videoFrame);
    try{observer=new PerformanceObserver(list=>{const p=phase;if(!p)return;
      for(const entry of list.getEntries()){p.longCount++;p.longMs+=entry.duration;p.longMax=Math.max(p.longMax,entry.duration);}});
      observer.observe({type:'longtask',buffered:false});}catch{}
    try{mutations=new MutationObserver(records=>{const p=phase;if(!p)return;
      for(const record of records)for(const node of record.addedNodes)
        if(node.nodeType===1&&(node.matches?.('.pong-tiktok-swap-stream')||
          node.querySelector?.('.pong-tiktok-swap-stream')))p.swapDomInsertions++;});
      mutations.observe(document.documentElement,{subtree:true,childList:true});}catch{}
    timer=setTimeout(finish,ms);return {id,condition};
  },wait:()=>done,finish,restore(){finish();if(window.__pongProducerJankProbe===api)delete window.__pongProducerJankProbe;}};
  window.__pongProducerJankProbe=api;return {id};
})()`;

export const installHeadlessPong = String.raw`(() => {
  if(window.__pongProducerHeadless)throw Error('Headless guard already installed');
  const key='PongTikTokLiveIntegratedState';
  const descriptor=Object.getOwnPropertyDescriptor(window,key);
  if(!descriptor?.configurable||descriptor.get||descriptor.set||typeof descriptor.value!=='function')
    throw Error('Integrated state is not a replaceable data property');
  let latest=descriptor.value;
  const guard={installed:true,calls:0,suppressedReadyCalls:0,replacements:0,invalidCalls:0};
  const wrapped=function(...args){guard.calls++;
    const raw=Reflect.apply(latest,this,args);let state;
    try{state=typeof raw==='string'?JSON.parse(raw):raw;}catch{guard.invalidCalls++;return raw;}
    if(!state||typeof state!=='object'||Array.isArray(state)){guard.invalidCalls++;return raw;}
    if(state.ready)guard.suppressedReadyCalls++;
    const suppressed={...state,ready:false};
    return typeof raw==='string'?JSON.stringify(suppressed):suppressed;};
  const get=()=>wrapped,set=value=>{if(typeof value!=='function')throw Error('Unexpected state publisher');
    latest=value;guard.replacements++;};
  Object.defineProperty(window,key,{configurable:true,enumerable:descriptor.enumerable,get,set});
  guard.inspect=()=>{const current=Object.getOwnPropertyDescriptor(window,key);
    return {installed:true,stillInstalled:current?.get===get&&current?.set===set,
      calls:guard.calls,suppressedReadyCalls:guard.suppressedReadyCalls,
      replacements:guard.replacements,invalidCalls:guard.invalidCalls};};
  guard.restore=()=>{const current=Object.getOwnPropertyDescriptor(window,key);
    if(current?.get===get&&current?.set===set)
      Object.defineProperty(window,key,{...descriptor,value:latest});
    if(window.__pongProducerHeadless===guard)delete window.__pongProducerHeadless;};
  window.__pongProducerHeadless=guard;return guard.inspect();
})()`;

export const installHeadlessTikTok = String.raw`(() => {
  if(window.__pongProducerTikTokGuard)throw Error('TikTok guard already installed');
  window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.();
  if(window.__pongDomSwap||window.__pongDomSwapWarm||
     document.querySelector('.pong-tiktok-swap-stream'))throw Error('Prior decoder did not clear');
  const prepare=window.__pongDomSwapPrepare,attach=window.__pongDomSwapAttach;
  if(typeof prepare!=='function'||typeof attach!=='function')throw Error('Swap guard hooks unavailable');
  const guard={installed:true,nativePrepareBlocked:0,nativeAttachBlocked:0};
  const blockedPrepare=function(){guard.nativePrepareBlocked++;return false;};
  const blockedAttach=function(){guard.nativeAttachBlocked++;return false;};
  window.__pongDomSwapPrepare=blockedPrepare;window.__pongDomSwapAttach=blockedAttach;
  guard.inspect=()=>({installed:true,stillInstalled:window.__pongDomSwapPrepare===blockedPrepare&&
    window.__pongDomSwapAttach===blockedAttach,nativePrepareBlocked:guard.nativePrepareBlocked,
    nativeAttachBlocked:guard.nativeAttachBlocked,active:!!window.__pongDomSwap,
    warm:!!window.__pongDomSwapWarm,overlayCount:document.querySelectorAll('.pong-tiktok-swap-stream').length});
  guard.restore=()=>{if(window.__pongDomSwapPrepare===blockedPrepare)window.__pongDomSwapPrepare=prepare;
    if(window.__pongDomSwapAttach===blockedAttach)window.__pongDomSwapAttach=attach;
    if(window.__pongProducerTikTokGuard===guard)delete window.__pongProducerTikTokGuard;};
  window.__pongProducerTikTokGuard=guard;return guard.inspect();
})()`;

const pauseOwned = readFileSync(new URL('./pause-tiktok-audit-owned-sessions.js', import.meta.url), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const outputDir = 'E:/Pong Benchmarks/tiktok-webview-2026-09-29';
const rendererBase = 'http://127.0.0.1:8792';
const cdpPort = 60195;

async function rendererSession(sessionId) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) return null;
  const response = await fetch(`${rendererBase}/sessions/${encodeURIComponent(sessionId)}`,
    { signal: AbortSignal.timeout(3000) });
  if (!response.ok) return null;
  return compactRenderer((await response.json()).session, sessionId);
}

async function main() {
  const {samePlayhead:pairedPlayhead,startSeconds} = parseJankTrialArgs(process.argv.slice(2));
  const result={diagnosticOnly:true,device:'emulator-5582',conditions:CONDITIONS,
    note:'Same visible video, sequential non-randomized six-second windows. rAF is UI scheduling, not physical FPS. Warm/cache and later playback time may differ; no acceptance claim.',
    started:new Date().toISOString(),windows:[],headlessAttribution:false,
    fullSwapAttribution:false,samePlayhead:pairedPlayhead,
    requestedStartSeconds:pairedPlayhead?startSeconds:null};
  if(pairedPlayhead)result.note+=' Each arm resets the same observed source to the requested playhead and awaits its first presented frame; conditions remain non-randomized and diagnostic only.';
  let tik,pong;
  let restorePlayhead=false;
  try {
    const health=await fetch(`${rendererBase}/health`,{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
    if(!health.ready||Number(health.activeSessions)!==0)throw Error('Renderer must start ready and idle');
    tik=await connectWebView(cdpPort,'tiktok');pong=await connectWebView(cdpPort,'pong');
    const observed=await tik.read(installProbe);
    if(!ID_PATTERN.test(observed?.id))throw Error('Visible video identity not established');
    restorePlayhead=pairedPlayhead;
    result.videoId=observed.id;
    const pongPreflight=await pong.read(`(()=>({videoId:(pongTikTokLiveState.current||'').match(/video\\/(\\d+)/)?.[1]||'',
      selected:pongFaceSwapFaceIds().length,enabled:!!pongFaceSwapState.enabled}))()`);
    if(pongPreflight.videoId!==observed.id||pongPreflight.selected<1)
      throw Error('Pong selection/current post does not match the visible video');
    // The Original control is transient; saved model/config presets are untouched.
    await pong.read(pauseOwned);
    await tik.read('window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.();true');
    const waitForIdle=async()=>{
      const deadline=Date.now()+5000;
      while(Date.now()<deadline){
        const health=await fetch(`${rendererBase}/health`,{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
        if(Number(health.activeSessions)===0)return;
        await delay(100);
      }
      throw Error('Prior owned renderer session did not retire before paired arm');
    };
    const runWindow=async condition=>{
      let playhead=null;
      if(pairedPlayhead){
        await pong.read(pauseOwned);
        await waitForIdle();
        await tik.read('window.__pongDomSwapClear?.();window.__pongDomSwapWarmClear?.();true');
        playhead=await tik.read(`window.__pongProducerJankProbe.preparePlayhead(${startSeconds})`);
      }
      const currentSeconds=pairedPlayhead
        ? Number(playhead?.actualStartSeconds)
        : await tik.read('Number(window.__pongTikTokObservedVideo?.video?.currentTime||0)');
      await tik.read(`window.__pongProducerJankProbe.begin(${JSON.stringify(condition)},${WINDOW_MS})`);
      if(condition!=='original-only'){
        const activated=await pong.read(`(()=>{const e=JSON.parse(window.PongTikTokLiveEnableSelectedSwap());
          if(e.status!=='started')return e;
          const started=window.PongTikTokLiveSwapCurrent(pongTikTokLiveState.current,${Math.max(0,Number(currentSeconds)||0)});
          return {status:e.status,started:!!started};})()`);
        if(activated.status!=='started'||!activated.started)throw Error('Swap activation did not start');
      }
      const probe=await tik.read('window.__pongProducerJankProbe.wait()');
      const state=await pong.read(`(()=>{const w=pongFaceSwapCurrentWrapper();return {
        session:String(w?.dataset.pongFaceSwapSessionId||''),enabled:!!pongFaceSwapState.enabled,
        active:w?.dataset.pongFaceSwapActive==='true',
        currentId:(pongTikTokLiveState.current||'').match(/video\\/(\\d+)/)?.[1]||''};})()`);
      const producer=await rendererSession(state.session);
      let guard=null;
      if(condition==='producer-headless'){
        const pongGuard=await pong.read('window.__pongProducerHeadless?.inspect()||null');
        const tikGuard=await tik.read('window.__pongProducerTikTokGuard?.inspect()||null');
        guard={pongInstalled:!!pongGuard?.installed,pongStillInstalled:!!pongGuard?.stillInstalled,
          suppressedReadyCalls:Number(pongGuard?.suppressedReadyCalls||0),invalidCalls:Number(pongGuard?.invalidCalls||0),
          tiktokInstalled:!!tikGuard?.installed,tiktokStillInstalled:!!tikGuard?.stillInstalled,
          nativePrepareBlocked:Number(tikGuard?.nativePrepareBlocked||0),
          nativeAttachBlocked:Number(tikGuard?.nativeAttachBlocked||0),
          tiktokActive:!!tikGuard?.active,tiktokWarm:!!tikGuard?.warm,
          overlayCount:Number(tikGuard?.overlayCount||0)};
      }
      const row={condition,playhead,probe,pong:state,producer,guard,
        transformedEvidence:{rendererFrames:Number(producer?.transformedFrames||0),
          swapSurfaceSeenFrames:Number(probe?.swapSeenFrames||0),
          swapDecodedFrames:Number(probe?.overlay?.maxDecoded||0)}};
      result.windows.push(row);
      if(!probe?.sameVideo||state.currentId!==observed.id)throw Error('Visible video changed; attribution rejected');
      if(condition==='original-only'&&(probe.overlay.active||probe.overlay.warm||probe.swapSeenFrames||
          state.active||['created','starting','streaming','stopping'].includes(producer?.state)))
        throw Error('Original-only window had swap work');
      if(condition==='producer-headless'){
        result.headlessAttribution=attributableHeadless(row);
        if(!result.headlessAttribution)throw Error('Headless producer/decode isolation was not proven');
      }
      if(condition==='full-swap'){
        result.fullSwapAttribution=attributableFullSwap(row);
        if(!result.fullSwapAttribution)throw Error('Full-swap transformed output and decoder presentation were not proven');
      }
      return row;
    };
    await runWindow('original-only');
    await tik.read(installHeadlessTikTok);
    await pong.read(installHeadlessPong);
    await runWindow('producer-headless');
    // Stop this experiment-owned session while suppression still holds, so a
    // delayed native poll cannot attach its decoder as the wrapper is restored.
    await pong.read(pauseOwned);
    await pong.read('window.__pongProducerHeadless?.restore();true');
    await tik.read('window.__pongProducerTikTokGuard?.restore();true');
    await delay(100);
    await runWindow('full-swap');
    result.completed=true;
  } catch (error) {
    result.error=String(error?.message||error).replace(/https?:\/\/\S+/g,'[redacted]');
    process.exitCode=1;
  } finally {
    // Preserve any newer production replacement; only remove our exact wrapper.
    if(pong)await pong.read(pauseOwned).catch(()=>{});
    if(pong)await pong.read('window.__pongProducerHeadless?.restore();true').catch(()=>{});
    if(tik)await tik.read('window.__pongProducerTikTokGuard?.restore();true').catch(()=>{});
    if(tik&&restorePlayhead)await tik.read('window.__pongProducerJankProbe?.restorePlayhead()').catch(()=>{});
    if(tik)await tik.read('window.__pongProducerJankProbe?.restore();true').catch(()=>{});
    tik?.close();pong?.close();
    mkdirSync(outputDir,{recursive:true});
    const file=`${outputDir}/producer-jank-${Date.now()}.json`;
    writeFileSync(file,JSON.stringify(result,null,2));
    console.log(JSON.stringify({file,completed:!!result.completed,
      headlessAttribution:result.headlessAttribution,error:result.error||null}));
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) await main();
