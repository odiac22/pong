# Pong Complete Engineering Handoff

Prepared for Claude and the owner on 2026-10-01. This document covers Pong, Recall capture, the Android apps, face swapping, TikTok, testing, deployment, and evidence storage. Its immediate priority is the unresolved seek and buffering failure. Read this document before changing production, then inspect current source and live state. Historical reports are evidence for their particular runs, not proof that the current app passes.

## Start here

The working repository is:

`C:\Users\arian\Documents\Codex\2026-07-15\files-mentioned-by-the-user-chatgpt\work\pong`

The chat workspace is different:

`C:\Users\arian\Documents\New project`

All relative paths below are relative to the Pong repository unless a drive-qualified path is given. Do not accidentally edit a similarly named snapshot, APK build intermediate, or copied audit server.

1. Read the unresolved playback section below and `CLAUDE_CHANGELOG.md` beside this document.
2. Inspect `git status --short`; this is a heavily modified working tree with many untracked scripts and artifacts. Preserve unrelated work. Do not reset it to Git HEAD or commit everything indiscriminately.
3. Check service health and the actual phone/emulator connection before claiming to watch or fix the app.
4. Reproduce one failure with timestamps and source/session ownership recorded. Keep audio silent.
5. Change one cause, run focused regressions, activate the appropriate layer, and retest real playback.
6. Record every change, test, activation, failure, and remaining gap in the shared change log.

At handoff preparation, local HTTP checks to `127.0.0.1:8787/health` and `127.0.0.1:8792/health` returned HTTP 000 within a two-second timeout. No listeners were found on the listed normal service ports. This is a current reachability observation, not proof of a particular cause. No services were started or stopped to write this handoff. Earlier messages saying fixes were live refer to the earlier running session; recheck everything now.

## Required change recording for Claude

The owner explicitly requires Claude to record all modifications in a file that Codex can read later. Use:

`docs/CLAUDE_CHANGELOG.md`

Append an entry for each meaningful change or experiment, including unsuccessful and reverted ones. Include timestamp and timezone, request, observed evidence, hypothesis, exact files/functions, old and new settings, tests and raw-result paths, production activation, APK/userscript requirements, rollback method, and unresolved issues. Separate planned, implemented, deployed, and verified. Include commits when available, but the log is required even without a commit.

Do not put passwords, tokens, cookies, signed media URLs, private keys, or screenshots of credentials in the log. Record private file locations only when necessary. Keep benchmark evidence append-only and use a fresh output directory for reruns. If interrupted, leave a continuation entry describing running processes and pending work.

## Owner requirements and working preferences

- Asked to debug means investigate and fix confirmed problems, not repeatedly ask whether a fix is wanted. Relevant fixes should be activated live after proportional verification; do not claim activation based solely on editing a file.
- Preserve approved UI placement. TikTok uses the existing Pong controls transparently over TikTok, not a new remote-control setup panel or replacement controls. Normal Pong and TikTok have different saved control positions.
- No new white buttons. The TikTok exit control should be red, top right. Keep the purple face-control panel size unchanged unless requested.
- Normal Pong timeline jumps require independent double-tap pairs: a third tap after a completed pair must not immediately seek again. Direct single-touch dragging on the progress bar was explicitly rejected; scrubbing on the upper video surface was allowed. Keep these gesture areas distinct from TikTok's native controls. Always provide a thumbnail/paused preview, and preserve swapped presentation when paused with swap active.
- Keep all tests silent. Do not audibly play media. Do not clear app data or TikTok login as a troubleshooting shortcut.
- Quality is the owner's decision. Proposed speed/quality tradeoffs need matched before/after videos and owner review, not silent rejection or promotion by the agent.
- GPEN1024 is generally preferred. TikTok-only size-adaptive GPEN512 for small faces and GPEN1024 for large faces was explicitly authorized. Approved 28 has a separate 50% restoration-strength rule.
- The later TikTok FPS target was reduced from 55 to 30. The owner wants no dips below 30, sub-one-second visible swaps after a face becomes visible, and no playback glitches. These are targets, not established guarantees.
- For TikTok latency, do not count ads, still photos, or footage before a usable face appears as missed face swaps. Also do not silently exclude actual eligible failures.
- The phone should only submit selected links for Recall; PC processing must continue after Firefox closes. Accepted by a queue is not ready for Pong playback.
- Do not inspect the owner's unrelated torrent/download activity. It was mentioned only as a possible performance confounder.
- Historical permission to use Sol for helper problems exists, but follow the current tool/agent authorization rules. No agent may bypass execution restrictions. Inspect normal service ownership instead of killing all Node or Python processes.

## Components and service map

| Component | Main source or launcher | Address or role |
|---|---|---|
| Pong web UI and playback | `index.html`, `pong-sync.js` | `/pong` on helper |
| Maintained modern UI | `ui/pong-modern.js`, `ui/pong-modern.css` | Built into marked inline sections of `index.html` |
| Node helper | `local-ai-server.mjs` | Normally port 8787 |
| Helper watchdog | `scripts/run-pong-server-watchdog.ps1` | Starts helper and related capture companion |
| Public gateway watchdog | `scripts/run-pong-gateway-watchdog.ps1` | SSH gateway forwarding; inspect current topology |
| Python swap renderer | `Pong Swap/pong_swap_service.py`, `pong_swap_engine.py` | Loopback 8792; proxied through helper |
| Swap control planes | Helper control routes | Historically 8793 and 8795; verify current listeners |
| Capture companion | Watchdog-managed helper component | Historically 8797 |
| Preference AI and Local2 support | `scripts/manage-pong-ai-workers.ps1`, preference scripts | 8791; Ollama 11434; optional LoRA 8790 |
| Legacy TikTok Remote | `scripts/tiktok_remote/server.py` | Historically 8820; not the preferred current WebView flow |
| Private quality review | `scripts/quality-review-server.mjs` | Historically 8896 plus temporary public tunnel |
| Isolated historical audit helper | `scripts/start-overnight-audit-v3037.ps1` | 17929 with isolated controls 17933 and 17935 |

Ports, PIDs, network addresses, and old health receipts are not permanent identifiers. Verify before stopping or connecting. Do not expose ADB/emulator gRPC ports to the LAN or make renderer authentication anonymous to simplify setup.

Other useful entry points: `scripts/get-pong-live-status.ps1`, `scripts/toggle-pong.ps1`, `scripts/install-pong-control.ps1`, `scripts/start-public-recall-server.ps1`, `scripts/activate-latency-improvements.ps1`. Read a launcher before running it: some historical activation scripts interrupt render sessions or clear volatile Recall state.

## Recall and userscript flow

Primary userscript: `universal-video-scraper.user.js`. Its header currently says 7.35.3; this does not prove the phone has that installed. The Firefox extension is separate under `firefox-extension/`.

Intended flow:

1. On a source site, the userscript identifies selectable logical videos, not merely a short preview or advertising MP4.
2. The owner selects targets and Recall destination 1 or 2. The panel includes a selected/ready count, movable launcher, compact organized buttons, and pairing/VPN controls.
3. Send submits one acknowledged background job to the PC. `desktop-capture-jobs.mjs` and helper routes own resolution and progressive Recall commits.
4. Where needed, the desktop VPN is verified before the desktop resolver opens protected source pages. The PC must resolve its own playable URLs, not rely on a URL/session that only works through Android's VPN.
5. The resolver checks logical-video identity, duration/trailer mismatch, available quality, accessibility, and media transport. Only committed ready results become green/ready.
6. Pong Recall reads the chosen channel and builds the deck. Playback goes through the media proxy/cache or appropriate resolved transport. The browser on Android need not remain alive for a correctly accepted PC-owned job.

Relevant modules include `desktop-capture-jobs.mjs`, `pong-vpn-control.mjs`, `video-source-policy.mjs`, `youtube-capture-resolver.mjs`, `hls-proxy-path.mjs`, `video-cache-range-policy.mjs`, `video-cache-segmented-downloader.mjs`, `video-cache-startup-policy.mjs`, and the helper itself. Search routes `/media-page/desktop-capture`, `/media-page/resolve`, `/video-cache/stream`, and `/pong-swap/` rather than guessing new endpoints.

Past failure patterns: phone IP-bound signed URLs; a tiny successful range probe mistaken for playback verification; 240p measured while higher variants stayed unknown; 10-second previews mistaken for full videos; stale cache after quality changes; Recall channel confusion; helper restart clearing volatile lists; premature assurances that Firefox can close. Preserve quality/identity verification, but report unknown quality honestly instead of equating it to highest quality.

The phone-transfer checkbox was explicitly removed in favor of desktop ownership. Do not reintroduce a phone relay as the default. NordVPN switching is not device-wide synchronization between phone and PC. Existing paired PC controls should connect/verify/disconnect on the desktop, with California alternatives where supported. Inspect the current controller implementation before promising a region or automatic failover.

## Local discovery, preference AI, and other imports

Local2/Local2.2 are discovery and preference workflows, not the swap renderer and not Recall channels. The older running handoff lists Load Videos, Open Albums, Saved Erome, R40 Local 2, R40 Local 2.2, Recall 1/2, and Train AI. It says the visible Local1 label was replaced, while `local1_model` remained a compatibility health field. Verify current UI labels instead of resurrecting old controls.

Main routing is in `local-ai-server.mjs`; `local2-flash-engine.mjs` handles the newer Local2/Local2.2 engine, with older components in `local2-pipeline.mjs` and `local2-node-adapter.mjs`. Supporting modules include `local2-scheduling.mjs`, `local2-source-hints.mjs`, and `local2-media-mirrors.mjs`. Inspect `/local2-fast` and `/local22-turbo` routes: start, health, candidates, acknowledgement, playback priority, and stop. The historical pipeline describes discovery, profile triage, real-media verification, preference classification, and accepted-result delivery. Thumbnail counts alone must not substitute for verified playable media.

Preference service: `scripts/preference_ai_service.py`, `scripts/local2_clean.py`, and `scripts/local2_vision_adapter.py`; launch/manage through the existing worker scripts. Historical feature extraction uses YOLO pose, DINO, and SigLIP, with Ollama for ambiguity paths. Read actual health/model configuration before assuming they are loaded. A 200 health reply proves an HTTP endpoint responded, not that every model is ready; the owner's previous logs included model-loading and token-configuration warnings. Local2 plus swapping may compete for GPU memory/compute: measure contention without lowering saved quality or stopping unrelated workloads.

Regression entry points include `local2-flash-engine.test.mjs`, `local2-pipeline.test.mjs`, `local2-run-lifecycle.test.mjs`, `local2-verifier-regressions.test.mjs`, `local22-history-only.test.mjs`, and `local1-fresh-flow.test.mjs`. Benchmark scripts include `scripts/benchmark-local2-paired.mjs`, `benchmark-local2-offline.py`, `benchmark-local2-saved-cohort.py`, and `benchmark-local1-exact.mjs`. Old concurrency and acceptance settings in `CURRENT_WORKFLOW_HANDOFF.md` are historical, not authoritative live defaults.

File/album/Saved imports and Recall converge on the playback deck but have different resolver, cache, and ownership paths. When debugging a seek, record the import path and original transport; a local file, completed range-capable MP4, growing swap stream, and TikTok bridge must not share unqualified seeking assumptions. Preserve saved lists, Save/Red-X feedback, and preference data during service changes.

## Face swap pipeline

Core sources are in `Pong Swap/`:

- `pong_swap_service.py`: HTTP API, service startup, faces, sessions, stream delivery, previews.
- `pong_swap_engine.py`: models, source decode, target acquisition, embeddings, rendering, restoration, masks, encoder, session lifecycle.
- `pong_swap_source_pool.py`: bounded source decoder standby reuse for seeks.
- `pong_swap_buffer_policy.py`: stream/buffer policy.
- `pong_multi_face.py`, `pong_hair_policy.py`, `pong_match_feedback.py`, `pong_detection_learning.py`: policy and owner feedback.
- `pong_face_restoration.py`: per-approved-face restoration-strength override.
- `pong_exact_acceleration.py`, `pong_exact_runtime/`: qualified optimized runtime.

Normal operation: resolve original source and full duration; create or adopt a session for the selected face set and absolute source position; decode original frames; detect/track target; choose approved source; swap; restore/mask/blend; NVENC encode; stream fragmented MP4; wait for actual presented-frame evidence; show transformed output and maintain source-timeline progress. The audio companion must follow the original timeline without leaking sound from hidden or outgoing videos.

Separate these facts: session exists; source decoded; rendered frame exists; frame was actually transformed; bytes arrived; browser decoded; browser presented. A green panel must not be driven by merely enabling swap or by a previous session's transformed-frame count.

Session APIs include `/sessions`, `/sessions/{id}`, `/sessions/{id}/stream`, `/sessions/{id}/first-frame` and activation/suspend/resume/playback lifecycle routes. On the phone these are normally proxied as `/pong-swap/...`. Read the route definitions for exact method/payload.

The ordinary native swap HTTP stream advertises `Accept-Ranges: none`, and `stream_session()` reads its spool from offset zero. It is not a normal completed MP4 supporting arbitrary byte ranges. MSE/browser-owned buffer behavior is a separate path. Do not apply direct original-video `currentTime` writes indiscriminately to a growing managed stream.

## Settings and acceleration integrity

Authoritative saved preset: `Pong Swap/presets/current.json`. Read it again before changes; other work may update it. At handoff inspection, selected fields were GPEN1024, RestorerSwitch true, global RestorerSlider 100, Mean source merge, backend trt, encoder p1/CQ18, browser startup 49152 bytes and 0.5 seconds, foreground fragment 0.5 seconds, dynamicQualityEnabled false, frameEnhancerEnabled false, maximumFaces 1, and qualityPreservingMaxFps 30. This is a selected snapshot, not a substitute for the full configuration or live health.

The machine used in earlier benchmarks was an RTX 4070 with 12 GB. Verify hardware and contention before comparing results. Do not assert TensorRT, FP16, GPU decode, or batching is automatically faster or pixel-identical. Measure the actual selected paths.

`Pong Swap/EXACT_ACCELERATION.md` explains integrity qualification. Service startup installs the frozen runtime; simply importing the engine in an offline benchmark does not necessarily install the same implementation. Model/source/library/GPU compatibility gates must not be bypassed by blindly updating hashes. `PONG_EXACT_ACCELERATION=0` selects the original implementation on cold startup. Unsupported qualification falls back and reports its reason.

For an engine change, inspect the exact diff, run CPU/runtime/service tests, regenerate only after review, and verify output/temporal parity and full completed throughput. Build commands from `Pong Swap/` are `runtime/venv/Scripts/python.exe -m pong_exact_runtime.build_frozen --write` and `--check`. A successful `--check` is not visual or performance qualification. Preserve qualified model engines and their manifests.

Historical service A/B tools: `run_swap_exact_service.py`, `run_swap_experiment_service.py`. Use isolated ports/storage, avoid writing production presets, and ensure candidate and baseline do not accidentally both run the accelerated implementation.

## Approved faces and consolidation

Approved references live in `Pong Swap/approved-faces/`, one folder per numbered approved face. Existing archives/inbox directories are separate; never merge or delete them casually. Face IDs are content-addressed: the scanner hashes relative paths and image bytes. Adding images changes the ID, invalidates the old embedding key, and requires refreshed face inventory/selection. Keep the numbered folder/name stable.

Approved 28 current state from this chat:

- Folder `Pong Swap/approved-faces/Approved 28`.
- Current verified ID after additions: `approved-28-918c129b5b2d`.
- 32 PNG references: the original seven plus 25 additional reviewed frames from two newly supplied videos.
- Previous ID was `approved-28-b14cb1d667c1`; do not hard-code it as current.
- Original filenames `00-clip-2-07.png` through `06-clip-4-04.png` remain. New files are prefixed `additional-20260930-`.
- New candidate review: `artifacts/approved-28-additional-20260930/selection.json`, `candidates/`, `contact-0.jpg` through `contact-2.jpg`. The 53-candidate manifest includes rejected candidates; only 25 were copied to the face folder. Folder contents are the actual accepted set.
- Source videos: attachment directory `C:/Users/arian/Documents/New project/.codex-remote-attachments/01a0dbe8-530e-7f00-b933-da90986c6315/7f49cb10-78b8-4f16-b918-1207af620f99/`.
- Earlier four-video references came from sibling attachment directory `9b5e2c5e-f155-452c-8068-94623e6d3f89/`.
- Selection script `scripts/select-approved-28-frames.py` supports `--source`, `--output`, and `--max-per-clip`. It uses CPU candidate filtering and contact sheets; human visual review still matters. Its Haar filter can admit occluded/poor frames, so never blindly import every output.

The owner explicitly selected **50% restoration whenever Approved 28 is used**, including Multi Face and TikTok. `apply_face_restoration` matches the Approved 28 ID family, saves the prior session-local strength, and restores it when switching to another approved source. Preview and session/source-selection call sites apply it. It does not globally set every face to 50, change GPEN model choice, or force a disabled restorer on. Tests: `Pong Swap/test_pong_face_restoration.py`. New ID was checked against the rule and returned 50.

Consolidation means multiple source references used for merged embeddings, not a guarantee of preserving every freckle. Restoration may smooth fine detail; reducing strength does not guarantee identity-specific freckles are reconstructed. The owner requested 50 after the 90/60/30 comparison was provided; do not invent numeric quality scores for it.

Comparison assets: `artifacts/approved-28-tan-dark-restoration/Approved-28-90-60-30.mp4`, a silent 2100x872 side-by-side comparison, 8.008 seconds, 192 frames. Source provenance is in that artifact folder and `scripts/render-approved-28-restoration.py`. The selected stock source was Pexels video 5096930. Earlier `approved-28-restoration`, `approved-28-straight-restoration`, and `approved-28-tan-restoration` are alternate/rejected attempts, not the final approved comparison. Do not infer ethnicity from appearance.

Approved 27 previously used `approved-27-09cb8ccbb56c`; requery instead of assuming any ID remains fixed. `/faces` returns imageCount and current IDs and schedules idle embedding priming. Initial recomputation after new references can take longer; do not present that as a steady-state benchmark.

## Multi Face and feedback behavior

Multi Face offers several approved sources but selects one source for a video; it is not a request to paste all selected identities onto all people. Maintain target identity and video/source-set ownership through seeks and reacquisition.

Owner-requested hair rules apply only in Multi Face and across TikTok and other flows: Approved 2 dark, 3 dark, 8 light, 13 dark, 19 light, 23 dark. The owner also requested tan skin for 2/3, slim face or body for 13, and dark skin for 23. Do not assume every requested attribute was implemented or validated; inspect the policy and its tests. The inspected hair implementation uses original segmented hair pixels, not face embeddings or background brightness. Confidence/lighting/roots/occlusion remain failure modes.

The owner explicitly resolved ambiguity: **when hair is uncertain, choose the best match among all selected faces**, not no face and not just unrestricted faces. `hair_allows()` currently permits all selected sources for unknown/mixed/low-confidence hair. Confident conflicting hair can restrict a source. This does not override no-face, invalid-source, identity, or safety conditions. A prior instruction says not to swap male-presenting targets unless Approved 18 is selected; inspect `test_pong_male_target_policy.py` and actual routing, and avoid treating presentation heuristics as factual gender identity.

Detect should show original-frame face boxes quickly. Fix above a box means **choose a better approved face match**, not geometric alignment correction. `pong_match_feedback.py` stores bounded local descriptor-based ranking preferences (up to 1000 examples; current constants include correction strength 8 and maximum bonus 18). It changes ranking, not model weights or detector geometry. `pong_detection_learning.py` is bounded detector calibration, not neural-model self-training; it stores `presets/detection-learning.json`, requires corroborating sources, and excludes rendering/identity thresholds. Do not promise the model retrains itself from a click.

Historical `MULTI_FACE_VALIDATION.md` describes an older conservative policy and explicitly says it was not a qualified 100-clip/1000-image model. Some old no-match behavior was superseded by owner instructions. Treat that document as a validation protocol, not current-policy authority. No evidence here establishes that all requested 100 clips, 1000 images, and 100 similar faces per approved source have passed independent grading.

## TikTok current WebView flow

Current requested direction is the actual TikTok website in Android WebView, making desktop requests with a phone-sized viewport and responsive styling, with existing Pong overlays. It is not a recreated TikTok feed and not the older emulator remote-control panel.

Mobile TikTok website requests repeatedly produced only two videos followed by app-install/login prompts, also in Chrome/Firefox. Desktop mode worked better; desktop-request/mobile-presentation became the chosen workaround. This is site behavior to reverify, not a guaranteed permanent TikTok contract. Preserve cookies/login. Verification challenges require the owner; do not solve or bypass them.

Android source: `android-app/app/src/main/java/` and `android-app/app/src/main/assets/`. Key classes include `MainActivity.java`, `PongBinaryMediaChannel.java`, `PongVisibleFrameAuditChannel.java`, `TikTokNativeAlignmentGate.java`, `TikTokNativeClockGate.java`, and `TikTokCatchUpReceiptGate.java`.

Key assets and responsibilities:

| Asset | Area to inspect |
|---|---|
| `tiktok-mobile.js`, `tiktok-phone-fit.js` | Responsive desktop layout, contained video and viewport fit |
| `tiktok-pong-overlay.js` | Existing Pong control overlay and interaction |
| `tiktok-scrub.js` | TikTok seek gestures |
| `tiktok-stream.js`, `tiktok-stable-handoff.js` | Session/source handoff and stream ownership |
| `tiktok-frame-sync.js`, `tiktok-playback-lifecycle.js` | Timeline alignment, pause/play, lifecycle |
| `tiktok-native-presentation.js`, `tiktok-direct-decoder.js` | Native presentation/decoder paths |
| `tiktok-avc-fragments.js`, `tiktok-fragment-batch.js` | Encoded fragment paths |
| `tiktok-worker-mse.js` and audit companions | Worker/MSE experiments and instrumentation |
| `tiktok-visible-frame-audit.js`, `pong-swap-media-audit.js` | Presentation evidence |

Presence of an asset does not prove its path is enabled. Inspect feature flags and `MainActivity` injection/bridge wiring. Changes to bundled Java/assets normally need an APK rebuild and install; changing server `index.html` alone cannot update bundled assets.

Desired sequence: native website navigation identifies active original video; bridge/helper resolve the correct source; renderer receives current identity/timeline; prepared output remains hidden until ownership and alignment match; transformed video is composited in the video region while native TikTok controls remain touchable and above it. Swiping a creator's profile videos must work as well as For You. No flash to bare black Pong, wrong old video, or false green swap-ready indicator.

Keep the original complete frame with black bars if needed, not cropped/zoomed video. For You/Following at top center, mobile-like navigation at bottom. Hide the ordinary gray Pong progress bar in TikTok. Swapped pixels must not cover TikTok's reddish progress bar. Preserve the normal Pong layout outside TikTok.

Size-adaptive restoration is documented in `docs/tiktok-adaptive-gpen-2026-09-29.md`: private session profile, source-face size hysteresis, both restorers warmed/resident, no saved-preset mutation. That report explicitly did NOT pass the end-to-end subsecond requirement. A fast first transformed frame on the PC is not a fast visible swap on the phone.

## Legacy emulator remote flow

Retain for reference, not the default UI: `scripts/tiktok_remote/README.md`, `LIVE_BASELINE.md`, `patch_transport.README.md`, Python sidecar and client tests. The owner tried a logged-in native TikTok emulator, wanted transparent Pong controls and no manual token UI; later chose WebView because emulator output was too slow.

Separate source emulator and Pong receiver emulator are different devices. The source owns TikTok/login; the receiver runs the actual Pong APK for parity tests. Historical setup uses authenticated emulator gRPC, scoped pairing keys, silent/headless execution, and remote input/encoded output. Do not start another source emulator over the same AVD or destroy its data. `scripts/start-pong-receiver-audit.ps1`, `scripts/activate-tiktok-integrated.ps1`, and a historical Desktop `Pong-TikTok.ps1` exist as entry points; inspect prerequisites first.

A desktop browser alone is not a 1:1 substitute for Android WebView/native surfaces, mobile gesture handling, codec behavior, or network conditions. A matching Android receiver APK/emulator is closer but still not physical-phone performance proof.

## Highest priority unresolved scrub and playback failure

The owner repeatedly reports: swipe to a video, play about a second, scrub anywhere, then progress jumps to the end, playback stops, or buffering/retries begin. Earlier fixes did not solve the whole issue. Do not say permanently fixed based on unit tests.

Physical Pong 1 trace captured in this chat:

- One seek requested about 169.900 seconds in a 1698.56-second original.
- Replacement swap declared duration 1528.659688 seconds and reached `ended` before presenting a tracked frame.
- Recovery then restored original time 1698.51 and created a new swap at 1698.559991, effectively the end.
- Other failures showed repeated `STREAM_FAILED`, `SWAP_FAILED`, and `PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed`.
- Some sessions were genuinely producing frames; other replacements failed. There is no proven single cause for every failure.

Changes applied to repository `index.html` and hot-applied to the then-open Pong page:

1. `pongFaceSwapAbsoluteTime`: terminal/error readers use the current generation's last presented time. If no frame was presented, relative time is zero, retaining the requested source offset instead of trusting synthetic EOF.
2. `pongFaceSwapEndedEarly`: uses that safe absolute clock when no tracked frame exists.
3. `seekPongVideoTo`: retains explicit play intent through temporary reader pauses; a user pause still wins for fresh requests.
4. Native direct `currentTime` buffered seek shortcut now requires `blob:` media. Forward-only HTTP swap streams use replacement sessions rather than pretending arbitrary native byte seeking is supported. This is a defensible transport correction, not yet a measured solution to all buffering.
5. `handlePongFaceSwapTerminalFailure`: no longer disqualifies resume intent solely because the failed reader says ended.
6. Earlier `stopPongFaceSwapForWrapper` restoration callbacks have source-generation/URL/managed-owner guards to stop late original callbacks seeking a replacement stream.

Last focused test command passed **85 tests**:

```powershell
node --test scripts/test-swap-terminal-clock.mjs scripts/test-face-swap-prefetch-seek-contract.mjs scripts/test-smooth-scrub-playback-intent.mjs
```

Live post-fix verification was incomplete: the owner kept changing cards, and the final automated attempt found no currently playing video. No broad success claim is justified. The owner was asked to leave a failing video selected for 20 seconds. Latest current service reachability is also unverified/down as noted above.

Evidence limitation: the recent raw seek observations were read through CDP and transient page arrays such as `window.__seekWatch`, `__scrubErrors`, and `__scrubFixTest`. A complete durable raw trace was not established in the evidence archive. These arrays can disappear on refresh. The numbers above are a handoff summary of observed output, not a claim that a corresponding complete JSON recording exists. Save fresh sanitized raw telemetry to a new artifact directory for the next reproduction.

Key code to trace next: `seekPongVideoTo`, `preparePongFaceSwapSeek`, pending seek generation/intent, `startPongFaceSwap`, `stopPongFaceSwapForWrapper`, `monitorPongFaceSwapEncoding`, `handlePongFaceSwapTerminalFailure`, `restoreDeckVideoNetwork`, smooth scrub in `pong-sync.js`, stream proxy teardown, Python `stream_session`, producer cancellation and source EOF.

Capture backend status **before failed sessions are deleted**. Record original duration, source offset, actual muxed duration, frames/transformed frames, terminal error, subscriber/stream counts, request ranges, activation sequence, source generation, user pause/play intent, native error code/message, current/buffered/seekable ranges, and presented-frame timestamps. Never equate HTTP 200 or a ready flag with playable moving frames. A prior hidden card repeatedly emitted `emptied`/source-generation changes; determine whether it still competes for resources rather than assuming.

Regression matrix: normal and swapped playback; forward/backward seeks; rapid successive seeks; busy startup; seek before first frame; true natural end versus truncated EOF; explicit pause and resume; swipe away/back during seek; app background/foreground; failed source recovery; cancelled preview requests; audio silence; preview ownership; source-cache handoff. Verify the landed original timestamp and at least ten seconds of sustained motion after each successful seek.

## Android builds and live debugging

`android-app/app/build.gradle` currently declares APK versionName 29.44/versionCode 2944. This is source state, not confirmation of installed APK. App IDs are `com.odiac22.pong1` and `com.odiac22.pong2`. Web UI, helper, renderer, APK, and userscript versions are independent.

Use `scripts/build-paired-pong-apks.ps1` for the configured paired signed build. It expects private inputs under `C:/Users/arian/Documents/New project/vps-private-input/`, including signing inputs and gateway/observer provisioning. Do not print their contents. Release builds require authenticated HTTPS gateway/observer pairing and refuse placeholder credentials. Output defaults to `downloads/`; Gradle outputs also live under `android-app/app/build/outputs/apk/pong1/release/` and `pong2/release/`.

Use `adb install -r` with the correctly signed flavor to preserve data/login; never uninstall/clear data casually. For server-only HTML changes, refresh is normally enough. For Python changes, a controlled renderer restart may be necessary. For helper code changes, restart only the verified helper instance and protect Recall state. For userscript changes, update the installed userscript and reload the source site. Verify the served/public version, not just the local header.

Known ADB executable:

`C:/Users/arian/Documents/New project/ifab-quiz-project/tools/android-sdk/platform-tools/adb.exe`

Last physical device was Samsung SM_F946U1. Last connection `192.168.1.69:37539`, discovered service `adb-R3CWA0HL7DF-ym0O4w._adb-tls-connect._tcp`; all can change. Last Pong 1 socket was `webview_devtools_remote_23955`, forwarded to 60196. Pong 2 used a different socket/60197 and at one point displayed 502 Bad Gateway. Re-discover; never assume the first WebView is Pong 1.

```powershell
& 'C:\Users\arian\Documents\New project\ifab-quiz-project\tools\android-sdk\platform-tools\adb.exe' devices -l
& 'C:\Users\arian\Documents\New project\ifab-quiz-project\tools\android-sdk\platform-tools\adb.exe' mdns services
```

Use the current wireless **connection** port, not the pairing-code port. Inspect `/proc/net/unix` for WebView sockets, forward the chosen socket, then inspect `/json/list` titles. URLs may contain observer tokens in fragments; redact them. `scripts/lib/tiktok-audit-cdp.mjs`, `scripts/cdp-eval.mjs`, `scripts/inspect-phone-seek-state.mjs`, and `scripts/probe-phone-seek.mjs` help. Some scripts hard-code old ports or a seek target; inspect before running. Normal app operation should not depend on debugging being enabled.

## Benchmark and data directory map

The companion `PONG_HANDOFF_EVIDENCE_INDEX.json` inventories 3,779 directory/evidence entries at creation across six roots, including paths, sizes, and modification times. It deliberately does not copy file contents, media, weights, or credentials. Generated by `scripts/inventory-claude-handoff.mjs`. Search it to locate reports instead of blindly recursively dumping all files. File presence and date-like folder names do not prove completed runs; some research directory labels differ from this handoff's date.

| Location | What it contains and how to use it |
|---|---|
| `E:/Pong Benchmarks/` | Main external-drive benchmark archive; many versioned and paired runs |
| `E:/Pong Benchmarks/user-quality-review-2026-09-30/` | Owner quality review, baseline/candidate renders, composites, ratings, promotion ledger |
| `.../ratings.json`, `quality-review-ledger.json`, `tests-2-5-results.json` | Actual user scores and review decisions; read before claiming approval |
| `.../gallery.json`, `historical-inventory.json`, `composites/`, `faces/` | Review catalog, historical test list, side-by-side media, face thumbnails |
| `.../approved8-*`, `gpen1024-*`, `approved-release-service-*` | Specific baseline/FP16/GPEN/decode-overlap/combined/service trials; use their own reports |
| `E:/Pong Benchmarks/paired-architecture-2026-09-30/` | Stock/TikTok paired architecture evidence, `comparison.json`, `report.html`, NVDEC feasibility variants |
| `E:/Pong Benchmarks/recall-pipeline-2026-09-30/` | Recall process recording, summary/report, renderer/helper logs, corrected face-visible TikTok timing |
| `.../recall-process-silent.mp4` | Silent recording of Recall process |
| `.../face-visibility-reviewed.json`, `face-visible-latency-summary.json`, `corrected-tiktok-before*.json` | Corrected eligibility and first-visible-face timing; preferred to old activation-only metrics |
| `E:/Pong Benchmarks/phone-live-2026-09-30/` | Physical phone layout/hair/rapid-swipe traces and screenshots, including 29.42/29.44 observations |
| `E:/Pong Benchmarks/tiktok-webview-2026-09-29/` | WebView tests and iterations |
| `E:/Pong Benchmarks/tiktok-remote/` | Legacy remote runtime bindings/dependencies/tests; may contain private runtime state |
| `E:/Pong Benchmarks/tiktok-stage-offline-2026-09-30/` | Offline stage work, not automatically visible-device performance |
| `E:/Pong Benchmarks/tiktok-lk-lookahead-paired-r1/` and `r2/` | Paired lookahead experiments |
| `E:/Pong Benchmarks/v3030-fps/` | Exact acceleration throughput reports; see RESULTS.md |
| `E:/Pong Benchmarks/v3030-exact-stage-profile/`, `v3030-swapper-trt-candidates/` | Stage profiling and candidate model/engine work |
| `E:/Pong Benchmarks/v3037-flow-audit/` | Overnight audit snapshot/server, manual launch logs, isolated test outputs |
| `E:/Pong Benchmarks/v3038-detect/`, `v3039-continuation/` | Detection/remote and continuation evidence |
| `E:/Pong Benchmarks/v3031-tampermonkey-*` | Real manager/browser touch/mouse userscript tests; distinguish fixtures from real sites |
| `E:/Pong Benchmarks/v2904-*` through `v3029-*` | Earlier quality, throughput, UI, recognition, and overnight experiments |
| Repository `artifacts/` | Per-fix reports, screenshots, JSON, videos, source captures; see evidence index |
| `Pong Swap/benchmarks/`, `Pong Swap/reports/` | Renderer-specific benchmark inputs/reports and older audits |
| `Pong Swap/original_models/` | Research models, datasets, manifests, benchmark and experiment artifacts; not all deployed |
| `Pong Swap/runtime/` | Python venv, runtime models and TensorRT caches; preserve |
| `Pong Swap/cache/` | Embeddings, thumbnails, session spool/cache and lab data; not equivalent to original references |
| `Pong Swap/logs/` | Renderer stdout/stderr and older diagnostic logs; some contain mixed encodings |
| `.pong-local-ai/` | Helper state, worker environments, training/preferences, private state and historical Recall restart snapshots |
| `pong-data/detection-feedback/` | Local feedback data; inspect schema rather than assuming model training |
| `F:/.pong-ephemeral-video-cache` | Default Windows rolling original-video cache when F exists; configured default cap 12 GiB |
| `F:/Pong-Audit-v3037/`, `F:/pong-benchmark/` | Historical isolated audit/benchmark storage; verify before reuse |
| `downloads/` | Distributed APK outputs and other deliverables; inspect timestamps/version |
| Chat workspace `.codex-remote-attachments/` | Owner uploads; retain original files and provenance |

`PONG_VIDEO_FILE_CACHE_DIR` can override the default. If F is absent, helper falls back under `.pong-local-ai/.ephemeral-video-cache`. Do not delete caches while live sessions reference them. Do not clean archives or benchmark trees merely because they are large.

## Quality review and online access

`scripts/quality-review-server.mjs` serves allowlisted review assets behind a private route token. The 90/60/30 page is `scripts/quality-review/restoration.html`. Existing server tests include `scripts/test-quality-review-server.mjs`. The owner wants a single synchronized side-by-side video when quality comparison is needed, and a 0–10 slider with 0.01 precision for scoring.

The owner could not reach LAN-only links while on mobile data/VPN. An existing temporary Cloudflare tunnel was reused for the gallery. Its recorded public origin is in `E:/Pong Benchmarks/user-quality-review-2026-09-30/public-origin.json`, with private access token in sibling `access-token`. Never copy that token into a public handoff or expose directory listings. Temporary URLs require the PC server and tunnel to remain up and may expire. Inspect current address and test range playback before providing a new link. An online review URL is not a permanent file backup.

## Benchmark acceptance and next tests

The owner's historical requests include ten or more sites with multiple videos each, 10-second unbuffered playback, initial load/swap under 1.5 seconds, subsecond Detect, a large independently graded Multi Face corpus, and 40 TikTok swipes with four-second dwell and subsecond face-visible swapping. Later paired tests used five stock clips and ten TikTok clips with five-second dwell, initially Approved 3 then changed to Approved 8. Do not blend these distinct protocols into one invented pass rate.

For a valid speed/quality comparison, keep the exact same source clips, source frames, approved identity, output dimensions, codec quality, restoration profile/strength, timing definition, and controlled warm/cold state. Record network/VPN state, GPU contention, cache state, source FPS, output FPS, dropped/presented frames, stalls, first original frame, first transformed frame, first visible transformed frame, and touch-to-visible response. A 30 FPS output cannot meaningfully be graded by 55 FPS source presentation requirements; document each clock separately.

The owner evaluates quality. Use their recorded scores to decide promotion; do not infer an FPS gain from score changes. Report measured before/after FPS and `(after/before - 1) * 100` only for matched valid runs. Keep failures/no-face cases visible in reports. Same-source leakage and model-generated labels are not independent ground truth.

Useful focused commands, run from the appropriate directory:

```powershell
# Pong repository
npm run test:ui
node --test scripts/test-swap-terminal-clock.mjs scripts/test-swap-media-callback-ownership.mjs scripts/test-face-swap-prefetch-seek-contract.mjs scripts/test-smooth-scrub-playback-intent.mjs

# Pong Swap directory
& 'runtime/venv/Scripts/python.exe' -m unittest test_pong_face_restoration test_pong_swap_exact_service_startup
& 'runtime/venv/Scripts/python.exe' -m unittest test_pong_hair_policy test_pong_multi_face test_pong_match_feedback test_pong_detection_learning
```

The first Python command previously ran 43 tests due to imported lifecycle suites. Confirm actual current results. Existing script names are not authorization to run disruptive/full GPU suites while the owner is watching. Read E2E scripts for data/channel mutation and mute requirements before use.

## Safe deployment and rollback

Before any restart, identify the listening process and its command line, snapshot relevant settings/state privately, and check active sessions. Stop only the intended service. A watchdog may restart it automatically; do not race that by starting duplicates. Historical PowerShell errors included an empty `$PSScriptRoot` from pasted script bodies and line-wrapped script filenames. Run the saved full-path script with `& 'absolute-path.ps1'` on one line.

Do not change execution policy as a generic fix. If a legitimate action requires owner interaction, give an exact scoped command and clearly state its interruption. No claiming another agent can bypass a restriction.

For UI changes, use `npm run build:ui` only when maintained modern UI sources change; it updates marked inline blocks, not arbitrary unrelated handlers. For native assets, rebuild/install the paired APK. For changes to qualified renderer code, follow the exact-runtime review and regeneration procedure. Roll back only your own patch from a saved diff/copy; never discard the whole dirty working tree.

Verify live version/code marker, backend health, active exact acceleration policy, preserved preset, correct phone app/channel, and an actual playing seek/swap afterward. Record what was not verified. The owner has repeatedly encountered regressions after assurances of completion; evidence and explicit limits are essential.

## Other references and scope boundaries

- `CURRENT_WORKFLOW_HANDOFF.md`: long historical running handoff, many old versions/PIDs; useful context, not current status.
- `FINAL_LOCAL_VALIDATION.md`: earlier validation, read scope/date.
- `ui/README.md`: maintained UI build contract.
- `docs/tiktok-live-observations-2026-09-29.md`: observed TikTok UI/gesture issues and limits.
- `docs/tiktok-adaptive-gpen-2026-09-29.md`: adaptive model policy and failed latency qualification.
- `Pong Swap/PREFETCH_SEEK_AUDIT.md`: older architectural analysis; portions were subsequently implemented, so compare current code.
- `Pong Swap/MULTI_FACE_VALIDATION.md`: independent corpus requirements, not proof of completion.
- `scripts/tiktok-frame-timeline.README.md`: timeline instrumentation.
- `Pong Swap/original_models/README.md` and research reports: research context; do not deploy experimental weights just because they exist.

This handoff does not certify every historical test, identify people in uploads, or authorize publishing private faces/media. Use approved adult references and consented/licensed non-explicit material for new comparisons. Keep private keys, logins, reference faces, and derived embeddings local unless the owner explicitly requests a scoped review upload.

## Recommended takeover order

1. Restore/verify intended service availability without clearing user data.
2. Finish the real-phone scrub reproduction and capture stream failure details before session deletion.
3. Verify the recently patched timing/play-intent behavior and fix remaining producer/transport/lifecycle causes with regression coverage.
4. Confirm updated Approved 28 inventory, selection reconciliation, 50% rule, and cached merged embedding readiness.
5. Verify current TikTok WebView layout, login, profile swipes, overlay ownership, and visible swapped-frame timing with the installed APK version.
6. Reconcile user quality approvals with deployed runtime flags; do not redo rejected experiments without recording why.
7. Run controlled paired benchmarks only once functional playback is stable, then report real improvements and remaining misses.
8. Append all work to `CLAUDE_CHANGELOG.md` and leave a clear next-action summary for Codex.
