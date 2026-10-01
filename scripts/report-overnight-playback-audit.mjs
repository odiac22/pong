// Summarize recorded evidence without dropping slow/failed cases.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve(process.argv[2] || 'E:/Pong Benchmarks/v3029-overnight');
const load = async name => JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
const before = await load('baseline-full-10/report.json');
const after = await load('final-full-10-clean/report.json');
if (!after.completed || after.clips.length !== 10) throw Error('Final full run is not complete');
const localBefore = await load('baseline-startup-36/report.json');
const localAfter = await load('candidate-preview-startup-36/report.json');
const network = await load('candidate-network-startup-44/report.json');
const candidateNetwork = await load('candidate-newcache-network-startup-4-corsfixed/report.json');
const previewSmoke = await load('final-preview-ownership-smoke/report.json');
const legacyHelperSmoke = await load('final-live-legacy-helper-compatibility/report.json');
const sites = await load('userscript/SUMMARY.json');
const manifest = await load('corpus/manifest.json');
const hls4k = await load('network-audit/hls-range-report.json');
const hls1080 = await load('network-audit/hls-range-1080-report.json');
const checksum = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const settingsHash = checksum(before.settings);
const settingsPreserved = [after, localAfter, network, candidateNetwork, previewSmoke, legacyHelperSmoke].every(r => checksum(r.settings) === settingsHash);
const number = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const median = values => {
  const a = values.filter(Number.isFinite).sort((a,b) => a-b), m = Math.floor(a.length/2);
  return a.length ? (a.length%2 ? a[m] : (a[m-1]+a[m])/2) : null;
};
const startup = r => ({
  tested: r.clips.length,
  matchingEarlyFace: r.clips.filter(c => Number.isFinite(c.firstVisibleSwapMs ?? c.faceAppliedMs)).length,
  visibleUnder1500: r.clips.filter(c => Number.isFinite(c.firstVisibleSwapMs ?? c.faceAppliedMs) && (c.firstVisibleSwapMs ?? c.faceAppliedMs) < 1500).length,
  videoUnder1500: r.clips.filter(c => Number.isFinite(c.faceAppliedMs) && c.faceAppliedMs < 1500).length,
  visibleMedianMs: median(r.clips.map(c => c.firstVisibleSwapMs ?? c.faceAppliedMs)),
  videoMedianMs: median(r.clips.map(c => c.faceAppliedMs)),
  noEarlyMatch: r.clips.filter(c => !Number.isFinite(c.firstVisibleSwapMs ?? c.faceAppliedMs)).map(c => c.clip),
});
const buffering = r => ({
  complete: r.clips.filter(c => c.fullPlaybackCompleted).length,
  zeroStall: r.clips.filter(c => c.fullPlaybackCompleted && c.rebufferCount === 0).length,
  stalls: r.clips.reduce((sum,c) => sum + (c.rebufferCount || 0), 0),
  waitSeconds: r.clips.reduce((sum,c) => sum + (c.bufferedWaitSeconds || 0), 0),
});
const summary = {
  generatedAt: new Date().toISOString(),
  implementationVersion: '30.29', userscriptCandidate: '7.35.1',
  deployment: { uiAndSwapActive: true, liveHelperVersion: '30.25', candidateHelperVersion: '30.29', helperRestart: 'blocked_by_tool_policy', onlineUserscriptUpdated: false },
  settingsPreserved, settingsSha256: settingsHash,
  buffering: { before: buffering(before), after: buffering(after) },
  isolatedHlsFragments: { original4k: hls4k, original1080p: hls1080 },
  finalPreviewSmoke: { completed: previewSmoke.completed, errors: previewSmoke.errors,
    clips: previewSmoke.clips.map(c => ({clip:c.clip,visibleMs:c.firstVisibleSwapMs,
      videoMs:c.faceAppliedMs,transformed:c.startupSession?.firstRenderedFrameTransformed})) },
  liveLegacyHelperSmoke: { completed: legacyHelperSmoke.completed,
    capabilities: legacyHelperSmoke.transportCapabilities,
    clips: legacyHelperSmoke.clips.map(c => ({clip:c.clip,transport:c.recallTransportPath,
      visibleMs:c.firstVisibleSwapMs,videoMs:c.faceAppliedMs})) },
  startup: { localBefore: startup(localBefore), localAfter: startup(localAfter), publicNetwork: startup(network), isolatedNewCacheFour: startup(candidateNetwork) },
  websites: { attempted: sites.sitesAttempted, broad7350: { receipts: sites.sitesWithAnyReceipt,
    touchReceipts: sites.sitesWithTouchReceipt, nativeMutedPlayback: sites.sitesWithMutedPlaybackPass,
    pongChecks: sites.realPongPlayerChecks?.map(c => ({site:c.site,passed:c.passed})) },
    focused7351: { additionalReceiptSites:['w3c','nasa'], additionalNativePlaybackSites:['w3c'],
      additionalPongPlaybackSites:['w3c','nasa'], signedManagerReceiptSites:['w3c','nasa'] },
    boundedHlsCandidatePongPlaybackSites:['videojs'],
    distinctReceiptsAcrossCandidates:sites.sitesWithAnyReceipt+2,
    distinctShortPongPlaybackSitesAcrossCandidates:7 },
};
const link = (label, relative) => `[${label}](<${path.join(root, relative).replaceAll('\\','/')}>)`;
const lines = [
  '# Pong 30.29 overnight playback audit', '',
  `Generated ${summary.generatedAt}. The primary playback/startup corpus used licensed, non-explicit stock footage or public player examples. Browsers were private/headless and media output was muted; swap audio remained disabled.`, '',
  '## Status and limitations', '',
  '- This is a measured partial improvement, not universal success. Sustained compute-bound playback and some website imports still fail.',
  '- UI and swap startup/render-ahead changes are active locally. The production helper restart was rejected by the execution tool; it remains at capability version 30.25. Candidate helper 30.29 was tested in a separate loopback process, not substituted for production.',
  '- Userscript 7.35.1 is the local candidate and has not been published online because the compatible helper changes are not active. No APK/native Android code was changed.',
  '- The physical phone was not connected for these runs. Desktop headless results are not a measured Android latency guarantee.',
  '- No resolution, model precision, GPEN strength, restoration cadence, or video encoding quality was reduced. The existing 30 FPS output cap was retained, so the 59.94 FPS eating source still outputs 29.97 FPS.',
  `- Full settings snapshots remained identical: **${settingsPreserved}**; SHA-256 ${settingsHash}. GPEN1024 strength is 100, using the existing qualified strict-FP32 TensorRT plan.`, '',
  '## What changed', '',
  '1. Optional bounded source negotiation starts when the approved-face menu opens. Foreground decoding can take that already-open source; it never waits for speculative work.',
  '2. The first exact rendered frame is encoded once in the existing quality-100 WebP path and displayed while the video stream becomes ready. Ownership is rechecked after decoding and before painting. A still image does not release the playback gate or count as moving video.',
  '3. An active foreground renderer can bank spare production time, growing its render-ahead ceiling from the existing 3 seconds to at most 12 seconds. Paused, scrubbed, background, and speculative sessions do not accumulate credit. Frame generation math is unchanged.',
  '4. Candidate helper: authorized foreground MP4s can use bounded parallel ranges (two records, four 512 KiB requests each). Strong entity/range validation prevents mixed-file corruption; failures after published bytes terminate old readers rather than splice a new response. Generic progressive Recall selects that cache only when its helper advertises the new bounded-range capability. The old live helper retains its prior proxy path; HLS/authenticated relay paths remain separate.',
  '5. Candidate userscript/helper: recognize custom player elements, give player boxes priority over overlapping links, exclude semantic navigation targets, retain measured quality ordering, and reconcile selected inline media by a same-page source fingerprint instead of detector/DOM order alone.', '',
  '6. A cancellation race could strand a source container after it was registered but before the producer consumed its queue result. Source publication now closes before producer teardown, and an unclaimed container is reclaimed without racing a started decoder. Two deterministic interleaving tests cover cancellation and late completion after admission rejection. Only the idle Python swap worker was reloaded through the existing helper launcher; the Node helper itself was not restarted. The new worker reported ready with zero active sessions and identical full settings.', '',
  '7. Exact startup/seek posters are no longer assumed to contain transformed pixels. The image paints immediately, then a bounded asynchronous metadata check distinguishes a transformed face from legitimate no-face passthrough. Session, identity, seek generation, and image ownership are rechecked before metadata is applied. This correction concerns exact image previews; ordinary video-frame poster ownership still denotes the managed swap session, not per-frame transformation proof.', '',
  '## Ten complete long playback tests', '',
  'All ten sources were 1080p-class or better and longer than 30 seconds. A real Pong Recall controller loaded isolated fixture responses; complete muted face-swapped playback was observed to EOF. Loopback source serving separates GPU/pacing behavior from variable CDN bandwidth. One foreground GPU render ran at a time. No shared Recall playlist was replaced.', '',
  '| Clip | Duration (s) | Before stalls / waiting (s) | After stalls / waiting (s) | After complete | After max frame gap (ms) |',
  '|---|---:|---:|---:|---|---:|',
];
for (const old of before.clips) {
  const row = after.clips.find(c => c.clip === old.clip) || {};
  lines.push(`| ${old.clip} | ${number(old.duration)} | ${old.rebufferCount} / ${number(old.bufferedWaitSeconds)} | ${row.rebufferCount ?? '—'} / ${number(row.bufferedWaitSeconds)} | ${row.fullPlaybackCompleted === true ? 'yes' : 'no'} | ${number(row.maxPresentedGapMs,1)} |`);
}
lines.push('', `Zero-stall clips: **${summary.buffering.before.zeroStall}/10 → ${summary.buffering.after.zeroStall}/10**. Total measured waiting: **${number(summary.buffering.before.waitSeconds)} s → ${number(summary.buffering.after.waitSeconds)} s**.`, '',
  'The eating clip remains compute-bound. Profiling found GPEN1024 exact inference around 41.65 ms median / 42.38 ms p90. Increasing render-ahead cannot create sustained compute capacity when no spare time exists. A tested all-tactics FP32 plan showed tiny numerical differences and negligible gain; it was rejected, and the qualified model remained unchanged.', '',
  'A second isolated experiment shared an identical per-frame mask motion probe. All 450 pre-encoder frame CRC32 hashes matched the baseline, but throughput was 29.60 → 29.47 FPS: no useful gain. That candidate was also rejected rather than changing production for an unproven speed claim.', '',
  link('Rejected shared-probe experiment','shared-mask-probe-RESULT.md'), '',
  'Transformation ratios below 100% can include natural intervals without the selected face; they are retained in raw reports, not treated as permission to swap a bystander. Playback completion is not an identity-quality proof.', '',
  `${link('Baseline full-10 JSON','baseline-full-10/report.json')} · ${link('Final full-10 JSON','final-full-10-clean/report.json')}`, '',
  '## Face-selection latency', '',
  `The stock corpus contains ${manifest.clips.length} distinct 1080p-or-better clips, including two true 4K sources (2160×3840 and 3840×2160). Source rates: ${[...new Set(manifest.clips.map(c=>c.fps))].join(', ')}.`, '',
  '| Run | Videos tested | Early matching face | First visible swap <1.5 s | Moving transformed frame <1.5 s | Visible median (ms) | Moving-frame median (ms) |',
  '|---|---:|---:|---:|---:|---:|---:|');
for (const [name, data] of Object.entries(summary.startup)) lines.push(`| ${name} | ${data.tested} | ${data.matchingEarlyFace} | ${data.visibleUnder1500} | ${data.videoUnder1500} | ${number(data.visibleMedianMs,1)} | ${number(data.videoMedianMs,1)} |`);
lines.push('', 'The still-preview latency is reported separately, not passed off as playback acceleration. Slow starts are not removed. A matching face cannot be shown before it appears in the source; no early match is an exclusion with a stated reason, not a passing test. Public-network timings include residual CDN variability. The four new-cache cases used a separate candidate helper and cannot be called live deployment.', '',
  'After the final lifecycle/preview-label fixes and Python worker reload, a three-clip headless smoke run confirmed transformed=true on the matching 1080p and 4K previews and transformed=false on the no-early-match clip. The cold 1080p preview appeared at 1.05 s but its moving frame still took 1.66 s; the 4K preview appeared at 0.90 s and moving frame at 1.04 s. No browser errors occurred. The no-face preview was not counted as a fast face swap.', '',
  link('Final live preview ownership smoke','final-preview-ownership-smoke/report.json'), '',
  'Deployment compatibility matters: the earlier 44-source network run exercised the proposed progressive-cache routing against the old helper. The final UI now keeps the prior proxy transport until the compatible downloader is active. A last live public-source check confirmed boundedRanges=false and /proxy, with no browser errors, but its cold visible swap took 2.16 s and moving frame 2.80 s. It is an explicit remaining failure, not covered up by the better local/candidate medians.', '',
  link('Final old-helper compatibility and cold-network check','final-live-legacy-helper-compatibility/report.json'), '',
  '| Public clip | Dimensions | First visible swap (ms) | Moving transformed frame (ms) | Outcome |',
  '|---|---|---:|---:|---|');
for (const c of network.clips) {
  const source = manifest.clips.find(m=>m.ordinal===c.clip);
  lines.push(`| ${c.clip} | ${source.width}×${source.height} | ${number(c.firstVisibleSwapMs,1)} | ${number(c.faceAppliedMs,1)} | ${c.error ? 'error' : !Number.isFinite(c.firstVisibleSwapMs) ? 'no early matching face' : c.firstVisibleSwapMs < 1500 ? 'visible under 1.5s' : 'over 1.5s'} |`);
}
lines.push('', `${link('44 public-source startup cases','candidate-network-startup-44/report.json')} · ${link('36 local baseline cases','baseline-startup-36/report.json')} · ${link('36 local candidate cases','candidate-preview-startup-36/report.json')} · ${link('Four candidate-helper public cases','candidate-newcache-network-startup-4-corsfixed/report.json')}`, '',
  '## Download-path audit', '',
  'A separate cold 37.4-second public clip went from 22 mid-play waits / 47.32 seconds waiting through the prior cache to zero waits in the final isolated candidate test (40.60 seconds total wall time). Other clips already had zero waits. The CDN itself varied sharply, so this is not a universal network-speed multiplier.', '',
  'Read-only adapter inspection found NordLynx active and the physical Ethernet link negotiated at 100 Mbps. The VPN was not changed; there is no VPN-on/off causal comparison. A Video.js/Mux 4K test required a 19.35 MB first segment and only began moving after roughly 90 seconds on this route. Resolution was not lowered to hide that latency.', '',
  `A later isolated fragment-transfer comparison preserved each complete SHA-256 hash: the 19.35 MB 4K fragment took **${number(hls4k.direct.seconds)} s single GET → ${number(hls4k.ranged.seconds)} s ranged**, and the 4.46 MB 1080p fragment took **${number(hls1080.direct.seconds)} s → ${number(hls1080.ranged.seconds)} s**. Each ranged timing includes its metadata request. These are network microbenchmarks, not face-swap or complete-player speed claims; the CDN is variable and the source URL is refreshed per arm.`, '',
  'The candidate HLS optimization is limited to complete immutable .m4s responses with strong entity validators. Incoming byte-range requests, init files, playlists, and unsupported sources retain their original path. At most one resource uses four 512 KiB ranges concurrently. Entity mismatch terminates a committed response; cancellation aborts and drains pending work before releasing its slot. No video bytes, quality level, or manifest selection is changed.', '',
  `${link('4K byte-equality transfer evidence','network-audit/hls-range-report.json')} · ${link('1080p byte-equality transfer evidence','network-audit/hls-range-1080-report.json')}`, '',
  'An actual isolated Pong/Firefox test then confirmed the bounded route on the 19.35 MB fragment: it completed in 20.97 s and muted 3840×2160 playback reached 3.21 s by 27.80 s elapsed. There was one transient nonfatal startup buffer-stall event, then playback advanced; no fatal HLS error was reported. The earlier original path first advanced near 90.77 s, but the two runs occurred at different times and are not a controlled network A/B. The initial minimal retry-free harness stalled at zero and was not treated as a product verdict.', '',
  link('Actual candidate Pong 4K playback evidence','network-audit/actual-pong-hls-range-r2.json'), '',
  'A final isolated progressive-fetch experiment was rejected: it did play at 4K, but its first buffer append (23.68 s) still followed complete fragment loading (23.59 s). Playback was first observed advancing at 24.12 s. The small total-time difference versus the preceding run was not a controlled network A/B and did not demonstrate removal of the whole-segment startup gate. Production progressive mode remains unchanged/off. [HLS.js 1.6.15 documentation](https://github.com/video-dev/hls.js/blob/v1.6.15/docs/API.md#progressive) marks this mode experimental.', '',
  link('Rejected progressive-fetch player experiment','network-audit/actual-pong-hls-progressive.json'), '',
  link('Detailed range-download evidence and limits','network-audit/parallel-range-summary.md'), '',
  '## Website and userscript tests', '',
  `The frozen broad 7.35.0 survey attempted ${sites.sitesAttempted} distinct actual websites. ${sites.sitesWithAnyReceipt} had a resolved isolated Recall receipt; ${sites.sitesWithTouchReceipt} had touch receipts; ${sites.sitesWithMutedPlaybackPass} passed a separate muted native Firefox decode. The subsequent focused 7.35.1 fixes added correct W3C and NASA receipts, bringing observed distinct receipt sites across candidates to ${sites.sitesWithAnyReceipt+2}. Actual short Pong playback was demonstrated on seven distinct sites across these runs, including the separately tested candidate-helper Video.js 4K path. These are different gates and software snapshots, not 30 universally working sites or one fully deployed passing build.`, '',
  'The broad survey used the candidate userscript in a GM-compatible Firefox test extension. Additional signed Tampermonkey 5.5.0 runs installed userscript 7.35.0 and verified trusted touch selection plus touch Send with completed one-video receipts on W3Schools, MDN, MediaElement.js, and Pexels. Version 7.35.1 then passed W3C and NASA+ with the correct selected asset; NASA required a real touch to open its page video modal first. Their only userscript substitution was production endpoint → isolated test endpoint. An early pointer failure was a test-harness offscreen-center error, corrected by scrolling and hit-testing. Pixabay touch worked but two signed-manager desktop jobs failed resolution; an independent desktop request returned an HTTP 403 access challenge. Earlier GM-shim success on that site is therefore intermittent, not a reliable pass.', '',
  'The 7.35.1 fixes retain explicitly selected native video sources even when their filenames contain trailer, while filtering unrelated page previews; recognize class-based Video.js player containers as well as custom tags; and preserve current-player identity over related cards. The earlier NASA related-card receipt was the wrong requested asset and is excluded. Archive item/embed tests had no visible rendered player in this headless fixture, so they are not successes.', '',
  'Actual Pong player checks and every failed/blocked website are listed in the site report. Native Firefox failing to play HLS by itself is not treated as proof that Pong HLS.js fails. Conversely, server acceptance without a resolved or playable video is not a pass. Low-resolution demonstration pages are compatibility fixtures only, not additions to the 1080p/4K performance corpus.', '',
  link('Full website results','userscript/REPORT.md'), '',
  link('Focused 7.35.1 same-asset and playback results','userscript/FOCUSED-7351.md'), '',
  link('Actual signed Tampermonkey touch results','signed-tampermonkey-7350/REPORT.md'), '',
  '[Signed 7.35.1 W3C/NASA results](<E:/Pong Benchmarks/v3031-tampermonkey-7351-w3c/REPORT.md>) (the historical folder name does not change the Pong version).', '',
  '## Validation and provenance', '',
  '- 120 focused JS pacing, startup ownership, control, readiness, range-download and safety checks passed; 52 userscript/identity/selection checks passed (overlapping suites are not summed as unique tests).',
  '- Python checks passed: 5 buffer-policy, 7 source-pool, 4 asynchronous exact-preview, 3 source-preparation, and 38 temporal-safety/history tests. One old history test required a recognition-model mock to reflect the existing immediate identity recheck after lost tracking; no tracker behavior was changed to satisfy it.',
  '- Final combined UI, Recall, transport, and ownership rerun passed 125 JavaScript checks. Earlier focused reruns passed 66 Python checks; 43 lifecycle/source/preview tests, including two new source-publication races, also passed. These overlap earlier suites and must not be added as unique totals.',
  '- A legacy live lifecycle test accidentally overlapped an earlier candidate run. It now requires an explicit licensed fixture and idle session guard. The final ten-clip report is a new clean run; the earlier overlapping run is not used as final evidence.',
  '- Earlier candidate attempts with a truthy Event instead of Event.is_set(), unregistered proxy sources, nested transport URLs, and missing test CORS preflight were rejected as invalid harness/integration attempts, fixed, and retained for traceability. They are not product passes.',
  '- The benchmark fixture transport handles OPTIONS explicitly for cross-origin candidate routing. Actual app, model, and source-quality behavior was not mocked.',
  '- No production Recall state was replaced. An idle Recall snapshot was saved for a planned restart; the restart was blocked before process mutation. Production helper PID remained unchanged.',
  '- Final isolated helpers on ports 17929, 17931, and 17932 were stopped. The existing production browser-relay keeper was left intact. The live helper and the reloaded, warmed swap service remained running.',
  '- No source-site cookies, account secrets, or titles are required to read this summary. Raw local reports retain the attributed licensed source URLs.', '',
  '## Remaining work', '',
  '- Activate the tested helper after an authorized restart and only then publish the compatible userscript; the blocked restart was not worked around.',
  '- Sustained GPEN1024 throughput on the hardest clip still needs a parity-tested compute improvement. No unsafe CUDA-stream rewrite, lower precision, lower strength, or lower resolution was accepted.',
  '- First moving-frame latency is not consistently below 1.5 seconds on every public 4K source. Exact preview improves immediate feedback but does not remove network/rendering limits.',
  '- Thirty websites have not all passed end-to-end import/playback. Access challenges, dynamic players, unresolved identities, and slow high-quality segments remain explicitly failed or unverified.',
  '- Physical Android Wi-Fi/WebView validation remains unperformed; refresh picks up the live UI changes, but an APK is not required for this code.', '',
);
await fs.writeFile(path.join(root, 'SUMMARY.json'), JSON.stringify(summary,null,2));
await fs.writeFile(path.join(root, 'REPORT.md'), lines.join('\n'));
console.log(JSON.stringify(summary,null,2));
