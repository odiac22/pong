// Summarize measured artifacts; never infer a phone-network time from loopback.
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
const root='E:/Pong Benchmarks/recall-pipeline-2026-09-30';
const repo=path.resolve(import.meta.dirname,'..');
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const report=async label=>read(path.join(root,label,'report.json'));
const local=await report('isolated-approved-service-playback');
const network=await report('public-direct-capture-r2');
const challenged=await report('public-page-capture-r1');
const recorded=await report('public-direct-recording-r3');
const live=await report('live-approved-playback');
if(!live.completed)throw Error('Live test still running');
const before=await read(path.join(root,'preset-before-approved-release.json'));
const after=await read(path.join(repo,'Pong Swap/presets/current.json'));
const oldPlan=before.runtime.restorerNativeTrtQualifiedPlan1024;
const newPlan=after.runtime.restorerNativeTrtQualifiedPlan1024;
before.runtime.restorerNativeTrtQualifiedPlan1024=newPlan;
if(!isDeepStrictEqual(before,after))throw Error('An additional saved setting changed; review before reporting');
const health=await(await fetch('http://127.0.0.1:8792/health')).json();
if(health.serviceVersion!=='30.38.5'||!health.approvedStartupPreparation?.ready||
 health.restorers?.['1024']?.nativePlanSha256!=='830adda04355c958f5fe7c36b1230ea7bb10c03aa88a7a7abd1414fdf764d98b'||
 !health.exactAcceleration?.acceleration?.installed)throw Error('Live approved release not verified');
const rows=r=>r.clips.map(c=>({clip:c.clip,originalReadyMs:c.recallFirstFrameMs,
 swappedPreviewMs:c.firstVisibleSwapMs,firstPresentedSwappedVideoMs:c.faceAppliedMs,
 swapUiReadyMs:c.swapFirstPlayableMs,completed:c.fullPlaybackCompleted,
 bufferSeconds:c.bufferedWaitSeconds,transformedFrames:c.finalSession?.transformedFrames,
 totalFrames:c.finalSession?.frames,sourceFps:c.finalSession?.sourceFps,
 outputFps:c.finalSession?.fps,maxPresentedGapMs:c.maxPresentedGapMs,error:c.error||null}));
const liveJank=live.clips.filter(c=>c.acceptance?.presentationGaps===false).map(c=>({clip:c.clip,maxPresentedGapMs:c.maxPresentedGapMs}));
const n=network.clips[0],s=n.startupSession;
const phase=(a,b)=>1000*(s[b]-s[a]);
const summary={date:new Date().toISOString(),silent:true,
 deployment:{version:health.serviceVersion,approvedPlan:newPlan,previousPlan:oldPlan,
  onlySavedSettingChanged:'runtime.restorerNativeTrtQualifiedPlan1024',
  startupPreparation:health.approvedStartupPreparation,
  acceleration:health.exactAcceleration.acceleration.gate.features},
 scope:'Silent Android Pong2 emulator on this PC. Approved 8, GPEN1024. Not physical-phone/Wi-Fi latency. Source cadences preserved. No website-wide or perpetual latency guarantee.',
 localFive:rows(local),liveFive:rows(live),liveAcceptance:live.acceptance,livePresentationGapFailures:liveJank,
 publicDirect:{captureAcceptedMs:n.capture.acceptedMs,captureObservedReadyMs:n.capture.readyMs,
  captureTiming:n.capture.job.targets[0],receiptMs:n.capture.receiptReadMs,...rows(network)[0],
  playedDurationSeconds:n.playback.duration,playWallSeconds:n.playWallSeconds,
  engineMilestonesMsFromSessionCreate:Object.fromEntries(['modelsReadyAt','sourceOpenedAt','encoderStartedAt','firstSourceFrameAt','firstTransformedFrameAt','firstRenderedFrameReadyAt','firstByteAt','playableAt'].map(k=>[k,phase('createdAt',k)])),
  timingTotals:n.finalSession.timingTotals},
 publicPageFailure:{acceptedMs:challenged.clips[0].capture.acceptedMs,
  observedFailureMs:challenged.clips[0].capture.readyMs,error:challenged.clips[0].capture.job.targets[0].error},
 recording:{file:'recall-process-silent.mp4',scope:'Separate observation run with Android screenrecord enabled; NOT a valid normal-playback benchmark. Severe slowdown coincided with recording; the cause is not isolated.',...rows(recorded)[0]},
 browserShell:{desktopMobileEmulation:true,lcpMs:107,ttfbMs:4,cls:0,
  note:'Shell paint is not media readiness. Restored expired sources generated repeated HTTP 502 requests and cache status polling; slow dependency entries include scheduled background work, not necessarily blocking work.'},
 limitations:['Original ready measured at readyState >=2, not a painted-frame callback.',
 'Swapped video paint measured by requestVideoFrameCallback and matching owned stream/target lock; preview is separately identified.',
 'Desktop queue completion sampled every 200 ms; acknowledgment excludes phone transmission.',
 'A webpage challenge failed; the direct-media run does not qualify generic page extraction.',
 'Per-frame totals group model/mask/compositing work; this trace cannot split GPEN versus InSwapper kernel time.',
 'Startup preparation runs before request admission. Existing 15-minute idle unloading can make a later request cold again.',
 'One five-clip post-deployment run is a smoke test, not a universal frame-rate or latency guarantee.']};
await writeFile(path.join(root,'summary.json'),JSON.stringify(summary,null,2));
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const ms=n=>Number.isFinite(n)?`${Math.round(n)} ms`:'not measured';
const table=(headers,body)=>`<table><thead><tr>${headers.map(x=>`<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${body.map(r=>`<tr>${r.map(x=>`<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pong Recall pipeline audit</title><style>body{background:#10151e;color:#e6edf7;font:16px/1.55 system-ui;max-width:1050px;margin:auto;padding:24px}h1,h2{color:#e7b845}table{border-collapse:collapse;width:100%;margin:20px 0}td,th{border-bottom:1px solid #354052;text-align:left;padding:9px}th{color:#76d5ce}a{color:#80c9fa}video{max-width:380px;width:100%}.warn{border-left:4px solid #d8a543;padding:12px;background:#25231b}small{color:#b5c2d4}</style><h1>Pong Recall: where time goes</h1><p>Approved GPEN1024 release <b>${esc(health.serviceVersion)}</b> is active. Only the approved engine path changed in saved settings. Startup preparation ran successfully before serving requests.</p><p>${esc(summary.scope)}</p><h2>Measured public-media flow</h2>${table(['Stage','Measured time','What it means'],[
 ['Desktop accepts link',ms(n.capture.acceptedMs),'Loopback HTTP acknowledgment, not phone-to-PC latency'],
 ['Desktop prepares link',ms(n.capture.readyMs),'Cached resolution plus accessibility check; sampled queue completion'],
 ['Recall → original video ready',ms(n.recallFirstFrameMs),'Real Recall button, public CDN/proxy, Android decode readiness'],
 ['Choose face → first swapped preview',ms(n.firstVisibleSwapMs),'A real transformed still frame, not moving playback'],
 ['Choose face → first presented swapped video',ms(n.faceAppliedMs),'Owned video-frame callback'],
 ['Choose face → UI playback ready',ms(n.swapFirstPlayableMs),'UI handoff finished'],
 ['Full video playback',n.playback.duration.toFixed(2)+' s','Completed; '+n.bufferedWaitSeconds.toFixed(2)+' s rebuffering']])}<p>These intervals overlap. Do not add preview and playback times together. The webpage version failed with a challenge after ${(summary.publicPageFailure.observedFailureMs/1000).toFixed(2)} seconds; direct media is a separate successful path.</p><h2>Live deployment: five complete stock clips</h2>${table(['Clip','Original ready','Swapped preview','Moving swapped frame','UI ready','Buffering'],summary.liveFive.map(c=>[c.clip,ms(c.originalReadyMs),ms(c.swappedPreviewMs),ms(c.firstPresentedSwappedVideoMs),ms(c.swapUiReadyMs),(c.bufferSeconds??NaN).toFixed(3)+' s']))}<h2>Largest measured delays</h2><ol><li>Website discovery/verification can dominate or fail entirely. A challenge took about 15 seconds, versus hundreds of milliseconds for a cached direct source.</li><li>Getting original media into Android and handing the encoded swap stream to its player took much longer than computing the first transformed frame (${ms(phase('createdAt','firstTransformedFrameAt'))} in this public-source run).</li><li>Continuing frame processing is the largest measured compute group: ${n.finalSession.timingTotals.frameWorkSeconds.toFixed(2)} seconds across ${n.finalSession.frames} frames. Encoder-write wait was ${n.finalSession.timingTotals.encoderWriteSeconds.toFixed(3)} seconds; these counters are not independent wall-clock stages.</li><li>Cold initialization still matters: this restart prepared the pipeline in ${(health.approvedStartupPreparation.elapsedMs/1000).toFixed(2)} seconds before admitting playback. Idle unloading remains enabled.</li><li>Retry traffic from expired saved sources was observed. It is not proof of slow GPU rendering, and fixing that scheduling should be measured separately.</li></ol><h2>Silent screen recording — separate overhead test</h2><p class="warn">The recorder run buffered ${recorded.clips[0].bufferedWaitSeconds.toFixed(2)} seconds and did not finish. This must not be presented as normal performance, nor hidden as a passing test. Screen recording added substantial load; this single comparison does not isolate the exact cause.</p><video controls muted playsinline preload="metadata" src="recall-process-silent.mp4"></video><h2>Measurement limits</h2><ul>${summary.limitations.map(x=>`<li>${esc(x)}</li>`).join('')}</ul><p><a href="summary.json">Machine-readable summary</a></p><small>Generated ${esc(summary.date)}. No audio track was recorded. No user Recall list was overwritten.</small></html>`;
await writeFile(path.join(root,'report.html'),html);
await writeFile(path.join(root,'report.html'),html.replace('<h2>Largest measured delays</h2>',
 `<p class="warn">No rebuffering is not the same as perfect smoothness. ${liveJank.length} live clips failed the strict presentation-gap check: ${liveJank.map(c=>`clip ${c.clip}: ${ms(c.maxPresentedGapMs)}`).join('; ')}. The complete zero-jank acceptance test did not pass.</p><h2>Largest measured delays</h2>`));
console.log(JSON.stringify({report:path.join(root,'report.html'),summary:path.join(root,'summary.json'),live:summary.liveFive,deployed:summary.deployment.version},null,2));
