// Summarize evidence at its measured layer. No deployment or app mutations.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';

const root = path.resolve(process.argv[2] || 'E:/Pong Benchmarks/v3037-flow-audit');
const load = async file => JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
const [baseline, startup, native, regressions, sites] = await Promise.all([
  'baseline.json', 'api-startup-baseline/report.json',
  'tiktok-native-foreground-verified.json', 'regressions.json', 'sites.json'
].map(load));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const get = async url => {
  const response = await fetch(url, {signal: AbortSignal.timeout(8000)});
  if (!response.ok) throw Error(`Local health request failed: ${response.status}`);
  return response.json();
};
const listening = port => new Promise(resolve => {
  const socket = net.connect({host:'127.0.0.1',port});
  const finish = value => {socket.destroy();resolve(value);};
  socket.setTimeout(1000);
  socket.once('connect',()=>finish(true));
  socket.once('error',()=>finish(false));
  socket.once('timeout',()=>finish(false));
});
const settings = await get('http://127.0.0.1:8792/settings');
const health = await get('http://127.0.0.1:8792/health');
const html = await fetch('http://127.0.0.1:8787/pong', {signal:AbortSignal.timeout(8000)}).then(r=>r.text());
const remoteRoute = await fetch('http://127.0.0.1:8787/pong-tiktok-remote.html',
  {method:'HEAD',signal:AbortSignal.timeout(8000)});
const samples = startup.cases.filter(c=>c.previewTransformed && Number.isFinite(c.transformedPreviewResponseMs));
const values = samples.map(c=>c.transformedPreviewResponseMs).sort((a,b)=>a-b);
const quantile = p => values.length ? values[Math.ceil(values.length*p)-1] : null;
const cases = startup.cases.map(c => ({
  clip:c.clip,sourceFps:c.sourceFps,width:c.width,height:c.height,
  transformedPreviewResponseMs:c.transformedPreviewResponseMs??null,
  passed:c.passed,rendererTransformedFrames:c.session?.transformedFrames??null,
  firstTransformedRendererMs:c.session?.firstTransformedFrameAt && c.session?.createdAt
    ? (c.session.firstTransformedFrameAt-c.session.createdAt)*1000 : null,
  outcome:c.previewTransformed ? 'transformed-preview-response'
    : c.session?.firstTransformedFrameAt ? 'original-opening-preview; later-frame-transformed'
    : 'no-transformed-face-in-bounded-rendered-prefix',
  elapsedMs:c.elapsedMs,
}));
const nativeRuns = native.runs.map(r=>({run:r.run,firstCapturedFrameMs:r.firstFrameMs,
  wholeWindowFps:r.capture.wholeWindowFps,frames:r.capture.frames,
  windowSeconds:r.capture.windowSeconds,captureCoverage:r.capture.captureCoverage,
  width:r.capture.width,height:r.capture.height,
  readOnlyStatusRpcMedianMs:r.rpc.readOnlyStatusRpc.medianMs,
  maximumCaptureGapMs:r.capture.timings.captureInterval.maxMs,
  expectedAppVerified:r.expectedAppVerified,validForAppTransport:r.validForAppTransport}));
const planned = Array.isArray(sites) ? sites : (sites.cases||sites.sites||[]);
const report = {
  generatedAt:new Date().toISOString(),implementationVersion:'30.37',complete:false,
  deployment:{ui3037Served:html.includes('30.37'),
    mediaCallbackCleanupServed:html.includes('function beginPongFaceSwapMediaCallbacks'),
    rendererVersion:health.serviceVersion,rendererReady:health.ready,
    remoteUiHttpStatus:remoteRoute.status,
    isolatedRecallListening:await listening(17929),remoteSidecarListening:await listening(8820),
    backendRestarted:false,nativeAndroidChanged:false,apkRequired:false,userscriptChanged:false},
  quality:{unchanged:hash(settings.config)===baseline.qualityHash && startup.configUnchanged===true,
    sha256:hash(settings.config),restorer:settings.config.parameters.RestorerTypeTextSel,
    strength:settings.config.parameters.RestorerSlider,audioEnabled:settings.config.runtime.swapAudioEnabled},
  startup:{scope:startup.scope,serviceVersion:startup.serviceVersion,kind:'baseline, not post-change A/B',
    cacheState:'uncontrolled; warm runtime and prior source state possible',
    tested:cases.length,transformedPreviewResponses:samples.length,
    below1500ms:cases.filter(c=>c.passed).length,
    successfulPreviewMedianMs:quantile(.5),successfulPreviewP95Ms:quantile(.95),
    successfulPreviewMinMs:values[0]??null,successfulPreviewMaxMs:values.at(-1)??null,
    androidDisplayMeasured:false,bufferFreeTenSecondsMeasured:false,fiveGigabyteMeasured:false,cases},
  nativeTikTok:{scope:'Native emulator RGB capture and read-only status RPC, not Pong streaming, inputs or face swapping',
    complete:native.complete,runs:nativeRuns,
    testAppStoppedAfterCapture:true,loginDataCleared:false,
    excludedReport:'tiktok-native-baseline.json: TikTok exited; foreground was Pong; burst FPS is not sustained TikTok FPS',
    fullPongSwipesTested:0,firstSwappedFrameMeasured:false,phoneVisibleInputLatencyMeasured:false,
    encodedTransportQualityQualified:false},
  recall:{plannedCases:planned.length,plannedSites:new Set(planned.map(x=>x.site)).size,
    completedWebsiteToPongCases:0,reason:'Isolated helper launch denied; production Recall was not overwritten'},
  multiFace:{implemented:true,activeOnLiveRenderer:false,
    heldoutClipsGraded:0,heldoutImagesGraded:0,perApprovedFace100Qualified:false,
    reason:'No independently graded, consented/licensed held-out corpus established; reference material is not held-out evidence'},
  regressions:{passed:regressions.passed,count:regressions.testCount,
    scope:regressions.scope,additionalUiAndSyntaxChecks:true},
  blockers:['Isolated Recall helper and TikTok sidecar launches rejected by execution policy; not retried via a bypass',
    'New renderer/helper code requires a controlled activation after replacement processes can start',
    'Multi face requires the requested held-out corpus, independent suitability labels, and confirmed source-face selection'],
};
await fs.writeFile(path.join(root,'audit-report.json'),JSON.stringify(report,null,2));
const number = value => Number.isFinite(value) ? value.toFixed(1) : 'not measured';
const link = (name,file) => `[${name}](<${path.join(root,file).replaceAll('\\','/')}>)`;
const lines = [
  '# Pong 30.37 flow audit — partial, not fully deployed', '',
  `Recorded ${report.generatedAt}. All testing was silent. Test applications/emulator remained headless. No production quality preset was reduced.`, '',
  '## Outcome', '',
  `- ${regressions.testCount} automated tests passed, plus UI-contract and JavaScript syntax checks. These are not end-to-end website or perceptual-quality passes.`,
  `- 30 real public-source PC-renderer startup cases: ${report.startup.below1500ms}/30 returned a confirmed transformed preview under 1.5 seconds. Successful-preview median ${number(quantile(.5))} ms, p95 ${number(quantile(.95))} ms, range ${number(values[0])}–${number(values.at(-1))} ms.`,
  '- Seven cases did not return a transformed opening preview. Three had later transformed frames; four had none in the bounded rendered prefix. These cases remain failures of the requested universal startup gate, not exclusions converted to passes.',
  '- The startup results are a baseline on the existing 30.30 renderer, with uncontrolled source caching. They measure an image response, not Android presentation, moving-video startup, full playback or a proven improvement after the code changes.',
  '- Three foreground-verified native TikTok capture runs delivered about 30 FPS at 1080×2340. This does not measure swapped output, WebRTC image quality, phone display or input-to-visible-response latency.',
  '- The requested complete website→Tampermonkey touch→Recall→Android playback benchmark, 15 swapped TikTok swipes, 5 GB test and 100-clip/1000-image Multi face grading are not complete.', '',
  '## Concrete code changes', '',
  '1. Repeated-use cleanup: swap starts/seeks now own and dispose their error/media listeners, timers and video-frame callbacks. A 200-scrub regression retains one current generation rather than accumulating old callbacks. This fixes a real leak/race; it does not prove every reported five-second delay had that cause.',
  '2. Multi face: feature-led resemblance ranking, runner-up ambiguity rejection, source-time consensus, deterministic choice independent of input/detector order, and one approved source retained across seeks in a bounded per-video cache. Ambiguous/no-match frames remain original. Single-source quality settings are unchanged.',
  '3. Fixed two Multi face flow defects: seek requests dropped the full selected-face list; speculative 350 ms acquisition probes could never satisfy a consensus requiring observations no more than 250 ms apart. Pending consensus now examines consecutive frames.',
  '4. TikTok integration code: Pong Remote panel, authenticated loopback gateway, unchanged-quality ROI renderer bridge, one inference plus one replaceable pending capture, independent control processing, and navigation resets. Cancelled connection attempts release late accepted controllers, and stale peer callbacks cannot close a replacement. It is experimental and not active on the current backend. Current-screen capture alone does not provide the next video for pre-rendering.',
  '5. Benchmark correctness: signed-manager receipts require the fresh capture ID and exact selected logical page, not stale same-site entries. Capture metrics use the whole observation window and verify the foreground app. The independent-label evaluator rejects duplicate/reference assets and split leakage.', '',
  '## Activation and quality', '',
  `UI 30.37 served: **${report.deployment.ui3037Served}**. Live renderer: **${health.serviceVersion}**, ready: **${health.ready}**. New Remote page route: HTTP **${remoteRoute.status}**.`, '',
  `Full settings unchanged: **${report.quality.unchanged}**. GPEN1024 strength **${report.quality.strength}**; swap audio enabled **${report.quality.audioEnabled}**. Configuration SHA-256: \`${report.quality.sha256}\`.`, '',
  'A Pong refresh can load the UI cleanup. It does not activate the new renderer, Multi face policy or Remote backend. No new native Android code or APK was produced. The userscript was not changed in this audit.', '',
  'The isolated helper and Remote sidecar launch attempts were blocked by execution policy. Sol also reviewed the helper-launch problem. No alternate-shell/service/agent bypass was attempted, and the healthy live services were not stopped.', '',
  'Manual handoff prepared in the repository: `scripts/start-overnight-audit-v3037.ps1`. It starts only isolated test components, silently, and does not stop production or change execution policy. It was syntax-checked, not executed by the agent. After it runs, health must be checked before resuming; production activation is a separate controlled step.', '',
  '## Per-source startup baseline', '',
  '| Clip | Source FPS | Dimensions | Transformed preview response (ms) | Under 1.5 s | Observation |',
  '|---|---|---|---:|---|---|',
];
for (const c of cases) lines.push(`| ${c.clip} | ${c.sourceFps} | ${c.width}×${c.height} | ${number(c.transformedPreviewResponseMs)} | ${c.passed?'yes':'no'} | ${c.outcome} |`);
lines.push('',link('Raw startup baseline','api-startup-baseline/report.json'),'','## Native TikTok capture only','',
  '| Run | Whole-window FPS | First captured frame (ms) | Read-only RPC median (ms) | Maximum capture gap (ms) | TikTok foreground verified |',
  '|---|---:|---:|---:|---:|---|');
for (const r of nativeRuns) lines.push(`| ${r.run} | ${r.wholeWindowFps.toFixed(3)} | ${number(r.firstCapturedFrameMs)} | ${r.readOnlyStatusRpcMedianMs.toFixed(3)} | ${number(r.maximumCaptureGapMs)} | ${r.expectedAppVerified?'yes':'no'} |`);
lines.push('', 'The first native probe is excluded: TikTok crashed and the emulator returned to Pong. The subsequent cold relaunch took 4911 ms. Three ten-second capture runs after that verified TikTok remained foreground. Neither cold app startup nor first swapped frame has been shown to meet a one-second gate.', '',
  link('Foreground-verified capture evidence','tiktok-native-foreground-verified.json'),'',
  'After capture, only the emulator TikTok test app was stopped to avoid leaving a feed consuming background resources. Its app data/login were not cleared. The emulator remains running silently; the production swap session remains paused and was not stopped.', '',
  '## Remaining qualification', '',
  '- Complete the 13-site, 39-page planned signed-manager run and observe each selected source in the actual Android Pong player for 10 continuous unbuffered seconds. A receipt or metadata duration is not playback proof.',
  '- Repeat startup and sustained/repeated-use tests after activation, including cold sources, large files, 4K, varied FPS, scrubbing and settings transitions. Do not promise <1.5 seconds independent of network/codec/face availability.',
  '- Multi face needs independently reviewed best-source labels on consented/licensed held-out footage, all approved choices offered in every case, per-source coverage and rendered temporal-quality inspection. No 100/1000 corpus accuracy or new training is claimed.',
  '- Perform 15 actual Pong-controlled TikTok swipes with swapped-frame evidence, visible-response timing and transport image-quality comparison. The current native status RPC timings are not touch latency.', '',
  `${link('Machine-readable summary','audit-report.json')} · ${link('Automated regression results','regressions.json')} · ${link('Recorded configuration baseline','baseline.json')}`, '',
);
await fs.writeFile(path.join(root,'REPORT.md'),lines.join('\n'));
console.log(JSON.stringify({report:path.join(root,'REPORT.md'),tests:regressions.testCount,
  previewPasses:report.startup.below1500ms,tested:cases.length,settingsUnchanged:report.quality.unchanged,
  uiVersion:'30.37',runningRenderer:health.serviceVersion,complete:false}));
