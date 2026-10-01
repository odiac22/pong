"""Summarize measured artifacts without converting speed gates into quality claims."""
import json
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parent / 'benchmarks' / 'v2901-audit'
def load(name):
    return json.loads((ROOT/name).read_text(encoding='utf-8-sig'))

corpus = load('final-corpus/report.json')
paired = load('final-paired-quality/report.json')
render = load('correction-ema-trial/report.json')
sweep = load('alignment-ablation/report.json')
before = load('live-baseline-seek.json')
after = load('live-final-seek.json')
summary = corpus['summary']
lines = ['# Pong 29.01 face-swap audit', '',
 'Scope: non-explicit supplied stock footage, Approved 23 and the existing licensed stock corpus. No Recall, scraping, adult-site, Tampermonkey, or native Android behavior changes. All decoding, encoding and inspection was silent and headless.', '',
 '## Outcome', '',
 '**Incremental improvement, not a universal perceptual-quality pass.** GPEN512 contribution is restored from 55 to 80. Temporal-history safety, target association, mask cadence, alignment sampling and restoration transitions were corrected. Some morphing, boundary fluctuation and restoration-generated expression detail remain; the throughput gate must not be mistaken for proof of photorealism.', '',
 'Visible version: **29.01**. Refresh Pong 1 and start a new swap session. No new APK is required: only web version metadata and the local Python renderer/preset changed. Android version metadata is synchronized, but no APK was built.', '',
 '## Baseline and causes', '',
 'See [baseline diagnosis](BASELINE.md), [baseline data](baseline/report.json) and [live baseline](live-baseline.json). The cached matching selected stock fixture contains 857 frames (28.57 seconds). The live first-frame image confirms the same scene; this is not a byte-identical capture of every frame from the live phone session.', '',
 'The selected fixture already ran fresh swap inference every frame, but reused GPEN and mask results on 786/857 frames. Permissive canonical-space reuse, abrupt restoration refreshes and alignment sampling were concrete hazards. Benchmark-only landmark correction and falsely counted identity rejections made previous diagnostics misleading.', '',
 '## Implemented changes', '',
 '- GPEN input alignment uses bilinear sampling and a pixel-center-correct return map; source resolution, model, encoder preset and CQ are unchanged.',
 '- Raw GPEN anchors and displayed corrections are separate. A 40 ms, correspondence-gated correction transition preserves current-frame expression pixels and softens refreshes without installing a partially blended raw anchor.',
 '- GPEN mean/patch reuse limits are 18/40 rather than 55/150. Mask limits are 12/30 rather than 30/120; masks have their own 10 Hz elapsed-time deadline.',
 '- Parser and identity history use their actual evidence timestamps; cuts, target loss and other forced discontinuities invalidate history. Local mask changes reject prior mask history.',
 '- LK smoothing normalizes both motion sensitivity and decay by elapsed time. Detector/LK shape continuity is enabled, with large-disagreement escape to current detector evidence.',
 '- Association considers all detected candidates between recognition checks. Missing tracking history fails closed; frozen-pose fallback after both detector and LK failure was removed. Valid LK grace is time-bounded.',
 '- Identity rejection telemetry now counts actual recognition checks, not ordinary LK frames. Benchmark policy matches the live workload gate, omits benchmark-only post-warp, and records effective configurations and code hashes.',
 '- Existing seven-image Approved 23 multi-view conditioning remains fixed. No new model training, identity substitution, expression-image averaging or automatic per-frame reference switching was introduced.', '',
 'Rejected trials: dense optical-flow output blending reached only 27.42 FPS on the 30 FPS selected fixture. Local attenuation of reused GPEN corrections reduced residual error but caused sharpness pumping, so that optional path is disabled. GPEN strengths 65, 70, 80 and 100 were tested; 100 increased temporal residual/boundary fluctuation in the strength sweep. 80 is the selected measured compromise, not a claim of an absolute optimum.', '',
 '## Per-fixture throughput', '',
 f"24 fixtures; {summary['distinctEligibleClipCount']} distinct identity-eligible fixtures; {summary['passedClips']} pass existing throughput/transformation gates. Median processing {summary['medianProcessingFps']:.2f} FPS; p10 real-time headroom {summary['p10RealtimeHeadroom']:.2f}×.", '',
 'Hardware: RTX 4070 12 GB, driver 616.64. Corpus throughput windows are 5.25 seconds. Full available selected/attachment fixtures were additionally analyzed frame-by-frame. Existing source-native rates cover approximately 24/25/30/60 FPS; 50 FPS has regression-test coverage but no native 50 FPS corpus fixture was available.', '',
 '| Fixture | Source FPS | Processing FPS | Headroom | Transformed face ratio | Fresh / reused output | Existing gates |',
 '|---|---:|---:|---:|---:|---:|---|']
for clip in corpus['clips']:
    t, x = clip['timing'], clip['transformation']
    status = 'pass' if clip['passed'] else ('excluded from identity gate' if not clip['eligibility']['eligible'] else 'FAIL')
    lines.append(f"| {clip['clip']} | {clip['source']['fps']:.2f} | {t['processingFps']:.2f} | {t['realtimeHeadroom']:.2f}× | {x['transformedFaceFrameRatio']:.3f} | {x['exactFrames']} / {x['reusedFrames']} | {status} |")
lines += ['', 'The high-workload policy keeps source/output FPS and quality settings unchanged, but uses validated transported outputs between fresh anchors. It is not fresh neural inference on every high-FPS frame. Fresh inference is required when reuse safety checks fail. No additional degradation under load was introduced; sustained performance on unseen harder footage is not guaranteed.', '',
 '## Paired temporal quality', '',
 'Both sides use the same source-continuity/paired-position diagnostic association and full available fixture window. Lower change percentages below are better. These metrics are diagnostic, not validated human-perception thresholds; higher GPEN contribution also changes detail energy. Regressions remain visible in the table.', '',
 '| Fixture | Pose delta p95 change | Feature relation p95 change | Boundary fluctuation p95 change | Sharpness fluctuation p95 change | Frames analyzed |',
 '|---|---:|---:|---:|---:|---:|']
for clip in paired['clips']:
    d=clip['changePercent']
    lines.append(f"| {clip['clip']} | {d['attachmentPoseDeltaP95']:+.1f}% | {d['featureRelationChangeP95']:+.1f}% | {d['boundaryFlickerMaeP95']:+.1f}% | {d['sharpnessFrameDeltaP95']:+.1f}% | {clip['candidate']['sampleCount']} |")
lines += ['', 'Visual review covered five consecutive decoded frames around each detected temporal spike, using source/output comparison sheets for all three paired fixtures. This was silent frame-sequence inspection, not a claim of watching complete real-time playback. Eye-state and teeth/lip discrepancies, artificial restored detail during fast motion, and imperfect profile geometry remain. The numerical improvements do not eliminate these artifacts.', '', '## Identity-reference measurements', '',
 'Approved reference videos were used only as identity evidence, never as rendering targets or training data. Cosines below are ArcFace diagnostics, not consent verification or a guarantee of identical anatomy. Paired rendered measurements select the face nearest the corresponding source track rather than whichever face detector index appears first.', '',
 '| Reference / fixture | Baseline median cosine | Candidate / reference median cosine |', '|---|---:|---:|']
for name, ref in paired.get('approvedReferences', {}).items():
    lines.append(f"| {name} | — | {ref['medianCosine']:.4f} |")
for clip in paired['clips']:
    b,c=clip.get('baselineIdentity',{}),clip.get('candidateIdentity',{})
    if b.get('medianCosine') is not None and c.get('medianCosine') is not None:
        lines.append(f"| {clip['clip']} | {b['medianCosine']:.4f} | {c['medianCosine']:.4f} |")
lines += ['', 'Identity non-regression is not established: median rendered identity cosine decreased slightly on all three paired fixtures, including 0.8176 to 0.8113 on the selected clip. This is a remaining regression, not evidence of improved identity fidelity.', '', '## Startup and seek', '',
 'Local HTTP source, warm service, three repetitions each. Seek uses the actual `seek` navigation class at 5 seconds. These measure service/session timing, not Android screen presentation latency.', '',
 '| Case | Baseline first transformed frame | 29.01 first transformed frame | Baseline playable 0.5 s | 29.01 playable 0.5 s |', '|---|---:|---:|---:|---:|']
for start,label in ((0,'Initial'),(5,'Seek')):
    b=[c for c in before['cases'] if c['startSeconds']==start]
    c=[c for c in after['cases'] if c['startSeconds']==start]
    med=lambda items,key:statistics.median(v[key] for v in items if v.get(key) is not None)
    lines.append(f"| {label} | {med(b,'firstSwappedFrameMs'):.1f} ms | {med(c,'firstSwappedFrameMs'):.1f} ms | {med(b,'firstPlayableHalfSecondMs'):.1f} ms | {med(c,'firstPlayableHalfSecondMs'):.1f} ms |")
lines += ['', '## Tests, verification and limits', '',
 '- 11 new stage-history/association regression tests pass. The focused temporal/tracking/identity suite passes 70 tests.',
 '- Existing swap discovery: 174 tests, 170 pass, four pre-existing failures remain (two configuration expectations and two foreground/prefetch-priority expectations). See the complete log; unrelated behavior was not changed to make these green.',
 '- All rendered benchmark files are video-only. No browser, emulator or player was opened, and no audio was enabled.',
 '- Live service restart and `/health` + `/settings` verification are recorded in live-final-health.json and live-final-settings.json. Only the face-swap service was restarted.',
 '- Geometric association and detector-order regression tests are stronger than detector-index tracking, but do not prove that every future crowded/occluded scene can never switch identity. Full 3D profile reconstruction and perfectly faithful expressions remain model limitations.',
 '- The perceptual-quality requirement is **not fully met**: do not label this release universally jitter-free or claim every temporal metric improved. No 5× first-frame or 3× scrub speedup is claimed.', '',
 '## Evidence', '',
 '- [Final corpus report](final-corpus/report.json)',
 '- [Paired quality, identity, references and spike-sheet index](final-paired-quality/report.json)',
 '- [Full selected/attachment render report](correction-ema-trial/report.json)',
 '- [GPEN strength sweep](alignment-ablation/report.json)',
 '- [Baseline startup/seek](live-baseline-seek.json) and [final startup/seek](live-final-seek.json)',
 '- [Focused tests](focused-tests-final.log) and [existing suite](all-swap-tests-final.log)',
 '- [Baseline preset backup](baseline-preset.json) and [deployed preset snapshot](deployed-preset.json)', '']
(ROOT/'REPORT.md').write_text('\n'.join(lines), encoding='utf-8')
print(ROOT/'REPORT.md')
