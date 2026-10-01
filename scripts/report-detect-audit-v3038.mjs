// Summarize recorded evidence; never changes live settings, services or media.
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=process.argv[2]||'E:/Pong Benchmarks/v3038-detect';
const load=async relative=>JSON.parse(await readFile(path.join(root,relative),'utf8'));
const percentile=(values,p)=>{const n=values.filter(Number.isFinite).sort((a,b)=>a-b);return n.length?n[Math.max(0,Math.ceil(n.length*p)-1)]:null;};
function summarize(report){
  const cases=report.cases||[];
  return {
    scope:report.scope,uiVersion:report.uiVersion,rendererVersion:report.serviceVersion,
    cases:cases.map(c=>({clip:c.clip,sourceFps:c.sourceFps,
      originalReadyMs:c.originalReadyMs??null,swapReadyMs:c.swapDisplayReadyMs??null,
      transformedOpening:c.rendererOpeningFrameTransformed??null,previewReadyMs:c.startupPreviewActivationMs??null,
      detectMs:c.detect?.paintOpportunityMs??null,boxes:c.detect?.boxCount??0,
      selectedFaceReadyMs:c.confirmToStreamReadyMs??null,backendIdentityLocked:c.backendIdentityLocked??null,
      playbackTargetMode:c.playbackTargetMode??null,failure:c.failure??null,
      playback:c.playback?{wallMs:c.playback.wallMs,ended:c.playback.ended,frames:c.playback.frames,
        presentedFps:c.playback.frames/(c.playback.wallMs/1000),waiting:c.playback.waiting,
        maxGapMs:c.playback.maxGapMs,droppedFrames:c.playback.quality?.dropped,
        transformedRatio:c.rendererAfter?.transformedFrames/Math.max(1,c.rendererAfter?.frames||0),
        rendererWorkFps:c.rendererAfter?.frames/c.rendererAfter?.timingTotals?.frameWorkSeconds}:null})),
    aggregate:{cases:cases.length,detectUnder1s:cases.filter(c=>c.detectUnder1s).length,
      detectMedianMs:percentile(cases.map(c=>c.detect?.paintOpportunityMs),.5),
      detectMaxMs:percentile(cases.map(c=>c.detect?.paintOpportunityMs),1),
      originalUnder1_5s:cases.filter(c=>c.originalReadyMs<1500).length,
      swapUnder1_5s:cases.filter(c=>c.swapDisplayReadyMs<1500).length,
      transformedPreviewUnder1_5s:cases.filter(c=>c.rendererOpeningFrameTransformed===true&&Number.isFinite(c.startupPreviewActivationMs)&&c.startupPreviewActivationMs<1500).length,
      identityLockedAfterTap:cases.filter(c=>c.backendIdentityLocked).length,
      noFaceOpening:cases.filter(c=>c.detect?.ok===false&&!c.detect?.boxCount).length,
      zeroWaiting:cases.filter(c=>c.playback&&c.playback.waiting===0).length,
      completedToEnd:cases.filter(c=>c.playback?.ended).length},
    settingsUnchanged:report.settingsUnchanged,foreignSessionsPreserved:report.foreignSessionsPreserved
  };
}
const before=await load('android-select-run10-profile/report.json');
const after=await load('android-select-run11-muted-reader-fix/report.json');
const short=await load('android-validation-10/report.json');
const long=await load('android-long-validation-10/report.json');
const finalLong=await load('android-final-long-10/report.json');
const nativePreview=await load('android-native-preview-fix/report.json');
const startup30=await load('android-startup-30/report.json');
if(!Object.hasOwn(startup30,'settingsUnchanged'))throw Error('Startup run still in progress; do not summarize a partial file as final');
const tests=await load('regressions.json');
const report={version:'30.38',createdAt:new Date().toISOString(),
  status:'partial; not all requested promotion gates are met',
  settingsHash:short.configHash,
  deployment:{ui:'30.38 live on 8787',renderer:'30.30 still running; new detection calibration not active',
    tiktok:'30.38 source staged; sidecar 8820 not running, live swapped TikTok unqualified'},
  controlledComparison:{scope:'Same stock clip1, face Approved3, emulator, quality and main-thread profiling; not randomized/cold-cache controlled',
    before:summarize(before),after:summarize(after)},
  tenSecondValidation:summarize(short),longValidation:summarize(long),finalLongValidation:summarize(finalLong),
  nativePreviewCheck:{...summarize(nativePreview),pairedProbe:nativePreview.cases.map(c=>({clip:c.clip,requests:c.nativeImageOriginProbe}))},
  startup30:summarize(startup30),
  tests:{passed:tests.passed,count:tests.testCount,groups:tests.groups.map(g=>({name:g.name,exitCode:g.exitCode,testCount:g.testCount}))},
  missingGates:['All video and first-swap presentations below 1.5 s','Zero buffering and frame drops across full corpus',
    'Real device/Recall/Tampermonkey multi-site performance (these runs use direct public stock import)',
    '100 labeled clips and 1000 images plus independently labeled 100 lookalikes per approved identity',
    '15 real TikTok swipes, swapped and presented below 1 s, with input-to-visible response timing'],
  caveats:['Detect is timed from invocation of the real handler to two animation-frame paint opportunities, not physical-button input latency.',
    'Red-box selection uses real emulator touch injection; confirmation readiness requires the new owning session and presented generation.',
    'Original and initial swap startup checks use decoded readiness; they are not a pixel-matched first-transformed-frame proof.',
    'Long runs start shortly after the initial displayed frame; they run through actual ended. They are not exact frame-zero full-content comparisons.',
    'Some tracks are not transformed throughout. Unchanged identity gates can reject or lose a face; playback success is not identity-quality success.',
    'The pre-final runs checked the UI target map, not backend identity lock. They remain playback evidence only; a later fix preserves the descriptor through restart and the final run checks backend identityLocked.',
    'android-no-face-recovery returned correctly to a paused state, but the harness failed to set play intent before its full-playback measurement. Its zero-frame windows are not used as playback evidence.',
    'Detector calibration is bounded threshold adaptation, not neural training or a promise of universal recognition.',
    'No source/encoder/restorer quality, reference identity, temporal geometry or output FPS limits were reduced.']};
await writeFile(path.join(root,'audit-summary.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({short:report.tenSecondValidation.aggregate,long:report.longValidation.aggregate,finalLong:report.finalLongValidation.aggregate,startup30:report.startup30.aggregate,tests:report.tests.count,settingsUnchanged:short.settingsUnchanged&&long.settingsUnchanged&&finalLong.settingsUnchanged&&nativePreview.settingsUnchanged&&startup30.settingsUnchanged}));
