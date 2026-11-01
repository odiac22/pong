# Pong performance / quality audit — 2026-11-01 (perf-audit-20261101)

Worktree branch `worktree-perf-audit-20261101`; live tree F:\CodexProjects\pong (renderer 30.40.11, 8814 via helper 8787; legacy 8792).
Checkpoints: F:\CodexProjects\pong\artifacts\perf-audit-20261101\baseline\ (settings 8814/8792, sessions, preset, manifest).

## Checklist
- [x] Live state + checkpoints captured.
- [x] Phone passive baseline, TikTok Web, 5 min, metadata only: E:\Pong Benchmarks\perf-audit-20261101\phone\passive-baseline-1.json
- [ ] Phone driven tests (seek both directions, Detect -> face change -> resume, 1<->multi, Adapt/cadence on/off): needs the phone free.
- [ ] Backend matched baseline matrix on live code (runs/perfbefore*.json): queued until renderer idle.
- [x] Settings/implementation audit findings recorded.
- [x] Dynamic restorer ladder GPEN1024->512->357 (measured cost, face count, buffer; hysteresis + probe) + tests.
- [x] Prefetch starvation guard (dead branch) fixed + test.
- [x] Prompt rediscovery of rejected faces (tracker overwrite gap).
- [x] Deferred readback pipeline (CPU/GPU overlap) + tests; functional GPU run OK.
- [ ] Matched after-matrix (overlay); keep/revert per cell.
- [ ] Reuse-frame CPU profile and reductions.
- [ ] Silent quality comparison on approved clips.
- [ ] Deploy (checkpoint, restart owned renderers, warm, verify) and phone re-measure.
- [ ] Handoff entry + final report.

## Findings
1. Live 8814 in-memory config != saved preset (attachmentStabilityEnabled False, StrengthSwitch False, Occluder/FaceParser True, MouthParser 2, Threshold 51, temporal detector recovery off); 8792 == preset. A restart reloads the preset. Earlier benchmark numbers used a third config.
2. Phone 5 min: 67 sessions, 23 videos, 599 swap-overlay `waiting` events, Adapt level 8 buffer-low in 61/67 sessions, zero GPU-patch reuse everywhere (Adapt with every-frame cadence, GPEN1024/512 selected). One face at GPEN1024 = ~51 ms GPU per frame (restorer 36.5 ms).
3. Prefetch sessions rendered 31 frames each while the foreground had 0 buffer: the foreground-reserve guard checked a controller name never reported.
4. Fresh 5-face frame 71 ms (47 ms GPU wall); cadence-4 reuse frames ~40 ms, CPU-dominated; GPU utilisation median 48%.
5. Adapt-only (cadence 1) had no reuse lever; levels only skipped detection.
