// Summarize the recorded runs, including failed qualification and missing evidence.
// This script only reads artifacts/services and writes a report; it runs no videos.
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
const root='E:/Pong Benchmarks/paired-architecture-2026-09-30';
const ttRoot='E:/Pong Benchmarks/tiktok-webview-2026-09-29';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const before=read(join(root,'before-stock/report.json'));
const replacement=read(join(root,'before-stock-clip1-r2/report.json'));
const after=read(join(root,'after-stock-r2/report.json'));
const ttBefore=read(join(ttRoot,'swipes-1790799873446.json'));
const ttAfter=read(join(ttRoot,'swipes-1790800658951.json'));
const nv=read(join(root,'nvdec-feasibility-pinned.json'));
const round=(n,d=1)=>Number.isFinite(n)?Number(n.toFixed(d)):null;
const median=a=>{const s=a.filter(Number.isFinite).sort((a,b)=>a-b);return s.length?(s[Math.floor((s.length-1)/2)]+s[Math.floor(s.length/2)])/2:null};
const stockNotes=[
 'Aligned at both sampled poses; eyes look somewhat synthetic.',
 'Side-profile alignment retained. Subtle result; sampled frames are insufficient for a fidelity verdict.',
 'Frontal attachment and blending look stable in the sampled stills.',
 'Attachment follows head tilt in the sampled stills; no large seam visible.',
 'Aligned, but facial texture and lighting look more processed than the original.'
];
function stockRow(r,c){
 const fps=r.fpsSummary.clips.find(x=>x.clip===c.clip);
 return {clip:c.clip,sourceSeconds:c.duration,sourceFps:round(fps.sourceFps,3),
  loadMs:round(c.recallFirstFrameMs),visiblePreviewMs:round(c.firstVisibleSwapMs),
  confirmedVideoSwapMs:round(c.faceAppliedMs),continuousReadyMs:round(c.swapFirstPlayableMs),
  renderWorkFps:round(fps.renderWorkFps,3),presentedFps:round(fps.browserPresentedFps,3),
  transformedFrames:fps.transformedFrames,totalRenderedFrames:fps.totalFrames,
  bufferEvents:c.rebufferCount,bufferSeconds:c.bufferedWaitSeconds,
  maximumPresentationGapMs:round(c.maxPresentedGapMs),
  outputPlaybackPass:c.acceptance.outputPlaybackPass,
  visualGrade:c.clip===1||c.clip===5?'C — visible processing artifacts':'B — sampled alignment acceptable',
  visualNotes:stockNotes[c.clip-1],
  visualScope:'Two output stills, at approximately 1 s and 3 s, plus original reference. Not a full temporal, identity, or pixel-equivalence grade.',
  outputFile:c.outputFile};
}
const stockBefore=[...replacement.clips.filter(x=>x.clip===1).map(c=>stockRow(replacement,c)),...before.clips.filter(x=>x.clip>1).map(c=>stockRow(before,c))];
const stockAfter=after.clips.map(c=>stockRow(after,c));
function summarizeStock(rows){return {count:rows.length,loadMedianMs:round(median(rows.map(r=>r.loadMs))),
 previewMedianMs:round(median(rows.map(r=>r.visiblePreviewMs))),videoSwapMedianMs:round(median(rows.map(r=>r.confirmedVideoSwapMs))),
 readyMedianMs:round(median(rows.map(r=>r.continuousReadyMs))),renderWorkMedianFps:round(median(rows.map(r=>r.renderWorkFps)),3),
 presentedMedianFps:round(median(rows.map(r=>r.presentedFps)),3),bufferEvents:rows.reduce((n,r)=>n+r.bufferEvents,0),
 bufferSeconds:rows.reduce((n,r)=>n+r.bufferSeconds,0),worstPresentationGapMs:Math.max(...rows.map(r=>r.maximumPresentationGapMs)),
 transformedRatio:rows.reduce((n,r)=>n+r.transformedFrames,0)/rows.reduce((n,r)=>n+r.totalRenderedFrames,0)};}
const ttNotes={
 1:'Ungradable: no owned output retained; no first transformed presentation confirmed.',
 2:'No clear eligible close face in the retained driveway-scene sample. Do not score as a face-swap failure.',
 3:'Animation without a human face in the reviewed samples. Face-swap target not applicable.',
 4:'Several visible faces; output appears aligned at sampled times, but first confirmed transformed presentation was late. Small sample cannot establish fidelity.',
 6:'Scene cuts from a group to a single person. Only part of the generated output is transformed; eligibility over the full interval is ungraded.',
 8:'Small faces in the retained courtroom scene. Subsecond transformed paint is recorded, but image detail is insufficient for a high-confidence quality grade.',
 9:'Distant person and scene text dominate; face eligibility is uncertain. Do not treat low transformed cadence as total display FPS.',
 10:'Visible faces in the retained scene, but only two generated frames were transformed and no transformed presentation was confirmed. Unresolved selection/detection case.',
 11:'Ungradable: no owned output retained; current-session association was missing.',
 12:'Distant person moving through trees; eligibility uncertain. First confirmed transformed paint was late.'
};
function ttRows(r,phase){return r.trials.filter(t=>t.distinctVideo).map(t=>{
 const owned=t.samples.filter(s=>s.view.session&&s.view.session===s.pong.session&&s.renderer.id===s.view.session&&s.pong.videoId&&s.pong.videoId!==t.beforeVideoId);
 const last=owned.at(-1),s=last?.renderer,c=t.swappedCadence||{};
 return {trial:t.index,dwellMs:round(t.observedDwellMs),navigationObservedMs:round(t.navigationObservedMs),
  firstTransformedPaintUpperMs:round(t.firstPaintUpperMs),underOneSecond:t.firstPaintUpperMs!=null&&t.firstPaintUpperMs<1000,
  firstOriginalPaintUpperMs:round(t.firstOriginalPaintUpperMs),
  sourceFps:round(s?.sourceFps??s?.fps,3),generatedFrames:s?.frames??null,generatedTransformedFrames:s?.transformedFrames??null,
  uniqueTransformedPaints:c.uniqueFrames??0,postStartupWindowMs:round(c.windowMs),
  transformedPaintsPerSecond:c.windowMs>0?round(c.uniqueFrames/(c.windowMs/1000),2):null,
  minimumRollingOneSecondTransformedFrames:c.minimumRollingOneSecondFrames??null,
  maxTransformedPresentationGapMs:round(c.maxPresentationGapMs),
  frameRateScope:'Owned transformed decoder presentations only; not total video FPS, physical display FPS, or an eligible-face-only denominator.',
  mainThreadLongTasksMs:round(t.samples.flatMap(s=>s.view.longTasks||[]).reduce((n,t)=>n+(t?.ms||0),0)),
  sourceOpenFromSessionCreationMs:s?.sourceOpenedAt>0?round((s.sourceOpenedAt-s.createdAt)*1000):null,
  firstByteFromSessionCreationMs:s?.firstByteAt>0?round((s.firstByteAt-s.createdAt)*1000):null,
  visualGrade:phase==='before'?'Ungradable — before-run media capture failed':ttNotes[t.index],
  transformedVisibilityNotConfirmed:t.firstPaintUpperMs==null};
 });}
const tBefore=ttRows(ttBefore,'before'),tAfter=ttRows(ttAfter,'after');
function summarizeTt(run,rows){return {videos:rows.length,physicalSwipes:run.trials.length,
 photoPosts:run.trials.filter(t=>t.photoPost).length,ads:run.trials.filter(t=>t.adPost).length,
 underOneSecond:rows.filter(t=>t.underOneSecond).length,
 lateConfirmed:rows.filter(t=>t.firstTransformedPaintUpperMs>=1000).length,
 unconfirmedWithinDwell:rows.filter(t=>t.firstTransformedPaintUpperMs===null).length,
 qualifyingSwapMedianMs:round(median(rows.map(t=>t.firstTransformedPaintUpperMs))),
 note:'Counts are observations, NOT face-eligible success rates. Live feed posts differ between runs; no matched A/B speed claim.'};}
const finalHealth=await fetch('http://127.0.0.1:8792/health',{signal:AbortSignal.timeout(5000)}).then(r=>r.json());
const finalSettings=await fetch('http://127.0.0.1:8792/settings',{signal:AbortSignal.timeout(5000)}).then(r=>r.json());
const report={date:'2026-09-30',status:'NOT QUALIFIED — no production optimization promoted',silent:true,
 stock:{before:stockBefore,after:stockAfter,beforeSummary:summarizeStock(stockBefore),afterSummary:summarizeStock(stockAfter)},
 tiktok:{before:tBefore,after:tAfter,beforeSummary:summarizeTt(ttBefore,tBefore),afterSummary:summarizeTt(ttAfter,tAfter)},
 settingsChecks:{beforeVersusAfterConfigEqual:isDeepStrictEqual(before.settings.config,after.settings.config),
  beforeVersusCurrentConfigEqual:isDeepStrictEqual(before.settings.config,finalSettings.config),
  stockClip1VersusOtherBeforeConfigEqual:isDeepStrictEqual(replacement.settings.config,before.settings.config),
  swapAudioEnabled:finalHealth.runtime?.swapAudioEnabled,
  activeSessions:finalHealth.activeSessions,gpuQueued:finalHealth.gpuWorker?.queued,gpuInflight:finalHealth.gpuWorker?.inflight,
  modelPlans: Object.fromEntries(Object.entries(finalHealth.restorers||{}).map(([k,v])=>[k,{sha256:v.nativePlanSha256,qualified:v.nativePlanQualified}]))},
 experiments:{eventDrivenHandoff:{testsPassed:46,liveImprovementQualified:false,defaultEnabled:false},
  gpenPrecision:{promoted:false,reason:'TensorRT numeric quality gates failed; no lower-precision replacement installed.'},
  nvdec:{promoted:false,note:'Isolated CPU-decode/pinned-upload versus GPU decode-to-RGB; not end-to-end face-swap speed. Four RGB samples per clip differ by up to 2/255. Not proof of degradation, but equivalence is unqualified.',
   clips:nv.clips.map(c=>({clip:c.clip,cpuDecodePinnedUploadMsPerFrame:round(c.cpuDecodePinnedUpload.elapsedMs/c.cpuDecodePinnedUpload.frames,3),gpuDecodeRgbMsPerFrame:round(c.nvdecRgb.elapsedMs/c.nvdecRgb.frames,3),byteExact:c.byteExactInput}))}},
 limitations:[
  'Real Pong2 APK 29.42 in silent Android emulator; not a physical-phone latency benchmark.',
  'Stock sources are the same five licensed Pexels clips (6 s each), but Recall responses use isolated local fixtures, not website scraping. Playback advances slightly before face selection, so output starts are not frame-identical.',
  'The renderer did not change between stock rounds. Stock timing differences are repeatability observations, not attributed optimization gains.',
  'Stock sources run at approximately 24/25/30 FPS. Thirty distinct source frames every second is impossible for the lower-rate inputs without interpolation or duplication.',
  'TikTok runs used different live feed posts. Full face-eligibility review and before-run retained-media grading are incomplete. The before-run media capture failed and this is not hidden by reusing after-run media.',
  'After-run retained media are bounded copies of already-generated local spools. They are not screen recordings; an encoded frame does not prove phone display. Copying adds diagnostic file IO.',
  'No reliable TikTok network-buffer-event total is available. Presentation gaps and main-thread stalls cannot be labelled network buffering from these records alone.',
  'Invalid stock preflight attempts are preserved separately: before-stock clip 1 DOM race, before-stock-clip1 readiness race, and after-stock while native TikTok remained open. Valid stock rows use before-stock-clip1-r2, before-stock clips 2–5, and after-stock-r2 only.',
  'Existing legacy 34/40 renderer-FPS thresholds remain in raw reports. This summary does not misrepresent them as the newer 30-FPS requirement.'
 ],
 conclusion:'The requested speed-only architecture upgrade is not complete. Startup/source acquisition, current-post ownership, face eligibility and WebView presentation remain bottlenecks. The candidate removes a poll/frame handoff delay but does not establish an overall live improvement. Keep it opt-in; qualify GPU decoding and a matched-content browser benchmark before any production promotion.'};
writeFileSync(join(root,'comparison.json'),JSON.stringify(report,null,2));
const esc=s=>String(s??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const table=(headers,rows)=>`<table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(c=>`<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const stockTable=rows=>table(['Clip','Load ms','Preview ms','Video swap ms','Ready ms','Render work FPS','Presented FPS','Buffer events','Max gap ms','Still grade'],rows.map(r=>[r.clip,r.loadMs,r.visiblePreviewMs,r.confirmedVideoSwapMs,r.continuousReadyMs,r.renderWorkFps,r.presentedFps,r.bufferEvents,r.maximumPresentationGapMs,r.visualGrade]));
const ttTable=rows=>table(['Trial','Dwell ms','Swap paint ms','Generated/swapped frames','Transformed paints/s*','Long tasks ms','Visual / eligibility review'],rows.map(r=>[r.trial,r.dwellMs,r.firstTransformedPaintUpperMs,`${r.generatedFrames??'—'} / ${r.generatedTransformedFrames??'—'}`,r.transformedPaintsPerSecond,r.mainThreadLongTasksMs,r.visualGrade]));
const b=report.stock.beforeSummary,a=report.stock.afterSummary;
const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pong paired architecture audit — 30 September 2026</title><style>body{background:#111820;color:#dbe5ef;font:16px/1.55 system-ui;margin:0 auto;padding:32px;max-width:1450px}h1,h2,h3{line-height:1.2}h2{margin-top:2em}a{color:#7ac9e9}table{border-collapse:collapse;width:100%;font-size:14px;margin:20px 0}th,td{text-align:left;border-bottom:1px solid #354251;padding:9px;vertical-align:top}th{background:#213043}.status{background:#4c3030;border-left:5px solid #e79872;padding:18px}img{max-width:100%;height:auto}code{color:#a5d8ec}li{margin:8px 0}</style><h1>Pong: before / after architecture audit</h1><p>30 September 2026 · silent · one approved face (Approved 3) · real Pong2 APK, desktop Android emulator</p><div class="status"><strong>${esc(report.status)}</strong><p>${esc(report.conclusion)}</p></div>
<h2>Summary</h2>${table(['Metric','Before','After candidate'],[['Stock median load ms',b.loadMedianMs,a.loadMedianMs],['Stock median visible swapped preview ms',b.previewMedianMs,a.previewMedianMs],['Stock median confirmed swapped-video frame ms',b.videoSwapMedianMs,a.videoSwapMedianMs],['Stock median continuous-ready ms',b.readyMedianMs,a.readyMedianMs],['Stock median render-work FPS',b.renderWorkMedianFps,a.renderWorkMedianFps],['Stock buffering events',b.bufferEvents,a.bufferEvents],['Stock worst presentation gap ms',b.worstPresentationGapMs,a.worstPresentationGapMs],['TikTok subsecond / late / unconfirmed',`${report.tiktok.beforeSummary.underOneSecond} / ${report.tiktok.beforeSummary.lateConfirmed} / ${report.tiktok.beforeSummary.unconfirmedWithinDwell}`,`${report.tiktok.afterSummary.underOneSecond} / ${report.tiktok.afterSummary.lateConfirmed} / ${report.tiktok.afterSummary.unconfirmedWithinDwell}`]])}
<p><strong>Do not infer a causal gain from this table:</strong> the stock renderer was unchanged; the TikTok feed changed between runs. Missing swaps on posts without eligible faces are not automatically failures. The 217 ms stock presentation gap fails that clip’s gap criterion despite zero recorded buffering events.</p>
<h2>Stock: five clips longer than five seconds</h2><p>Identical input files, existing non-TikTok preset, Approved 3. All rendered frames were marked transformed in both valid runs. Load is Recall to source-ready; preview is the first transformed still; video swap is a confirmed owned presented video frame; ready is continuous swap startup. Render-work FPS excludes source startup, starvation and intentional pacing; it is not screen FPS. Presented FPS is browser decoder evidence, not physical-display tracing.</p><h3>Before</h3>${stockTable(stockBefore)}<h3>After</h3>${stockTable(stockAfter)}
<p>Still rubric: B = acceptable sampled attachment with limitations; C = aligned but visible processing artifacts; no A/perfect grade is claimed. Same grades before and after. This is limited visual review, not full temporal grading or an identity-match measurement.</p><ul>${stockNotes.map((n,i)=>`<li>Clip ${i+1}: ${esc(n)}</li>`).join('')}</ul><details><summary>Before visual samples</summary><img src="before-stock-contact.png" alt="Five stock clips, original and two before-run output frames"></details><details><summary>After visual samples</summary><img src="after-stock-contact.png" alt="Five stock clips, original and two after-run output frames"></details>
<h2>TikTok: ten distinct videos per run, five-second dwell</h2><p>Before needed 16 swipes (6 photos); after needed 12 (1 photo, 1 ad). Those extra posts are not counted as video successes. Times use cross-clock-bounded, session-owned presentation evidence. A dash means no confirmed transformed paint within the dwell, not an invented latency. The feed was not replayed identically.</p><h3>Before</h3>${ttTable(tBefore)}<h3>After event-driven reveal candidate</h3>${ttTable(tAfter)}<p>* Transformed paints/s counts only owned transformed presentations after startup. It includes intervals without an eligible face, so it is <strong>not total playback FPS</strong>. Neither a 30-FPS floor nor zero TikTok buffering was established. There is a confirmed slow visible-face case (after trial 4) and an unresolved detection/selection case (trial 10).</p><details><summary>Retained after-output samples (not phone screenshots)</summary><img src="after-tiktok-contact.png" alt="Ten TikTok trials with missing evidence explicitly labelled"></details>
<h2>Changes tested and disposition</h2><ul><li>Event-driven first-frame reveal: 46 relevant tests pass, but the live results do not qualify an overall improvement. Kept behind an explicit audit opt-in; default behavior and physical-phone APK unchanged.</li><li>GPEN precision candidates: rejected because TensorRT numeric quality checks failed. No production model was replaced.</li><li>GPU decode: promising isolated speed, but RGB samples differ and CPU tracking still requires integration. Not enabled.</li></ul>${table(['Stock clip','CPU decode + pinned upload ms/frame','GPU decode-to-RGB ms/frame'],report.experiments.nvdec.clips.map(c=>[c.clip,c.cpuDecodePinnedUploadMsPerFrame,c.gpuDecodeRgbMsPerFrame]))}<p>Decode numbers are isolated feasibility measurements, not claimed end-to-end multipliers. Changing the decoder alone does not fix CDN startup, main-thread stalls or current-post ownership.</p>
<h2>Preservation checks</h2>${table(['Check','Result'],Object.entries(report.settingsChecks).filter(([k])=>k!=='modelPlans').map(([k,v])=>[k,v]))}<p>No test render sessions remain queued or active at report generation. Current model-plan fingerprints are retained in comparison.json.</p><h2>Limitations and excluded attempts</h2><ul>${report.limitations.map(x=>`<li>${esc(x)}</li>`).join('')}</ul><h2>Raw evidence</h2><p><a href="comparison.json">Machine-readable comparison</a> · <a href="before-stock/report.json">Stock baseline clips 2–5</a> · <a href="before-stock-clip1-r2/report.json">Stock baseline clip 1</a> · <a href="after-stock-r2/report.json">Stock repeat</a> · <a href="../tiktok-webview-2026-09-29/swipes-1790799873446.json">TikTok before</a> · <a href="../tiktok-webview-2026-09-29/swipes-1790800658951.json">TikTok after</a> · <a href="nvdec-feasibility-pinned.json">NVDEC feasibility</a></p></html>`;
writeFileSync(join(root,'report.html'),html);
console.log(JSON.stringify({stock:{before:b,after:a},tiktok:{before:report.tiktok.beforeSummary,after:report.tiktok.afterSummary},checks:report.settingsChecks,report:join(root,'report.html')},null,2));
