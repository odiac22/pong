# Pong Swap

## 30.38 Detect and playback audit

The refresh-delivered UI is **30.38**. The production renderer was still **30.30**
at the time of this audit; do not confuse source version with activation.
Full current evidence: [30.38 report](<E:/Pong Benchmarks/v3038-detect/REPORT.md>).

Detect now displays geometry-only boxes from the already-presented still while
the original frame and original identity are resolved separately. Taps are
matched spatially to that original; detector ordering and swapped embeddings
are never used as target identity. Ambiguous matches and stale callbacks fail
closed. Closing the editor cancels its owned probes.
Failed original-frame preparation and no-face quick scans return to the prior
playing/paused state rather than leaving a hidden, unusable paused editor. A
tap waits for the original frame and preserves its complete validated identity
descriptor through the immediate restart; the old override copied only x/y.

The staged renderer adds cached immutable-frame detections and explicit,
token-bound confirmation. Detector-only calibration is stored separately in
`presets/detection-learning.json`; three distinct recovered original-face
confirmations lower target detector confidence by 0.01, bounded at 0.35 from the
0.45 default. Repeated clicks and refreshed signed URLs do not multiply evidence.
It does not change strictness/identity thresholds, model weights, source identity
embeddings or rendering quality. There is no background neural self-training.
Only hashed source identifiers and aggregate counters persist. The API exposes
`GET /detection-learning` and an explicit `DELETE /detection-learning` reset.
This calibration is **not active until the staged renderer is restarted**.

Muted, paused or unpresented swaps no longer open/seek unused original-audio
readers. Audible playback still aligns its companion when it actually owns the
screen. This fix is in the live UI and does not alter media encoding or quality.
An inactive card silences only its own companion, not the foreground card.
The native full-resolution first-frame image now requests anonymous CORS so
the separate control port receives its required Origin header. Access checks
remain unchanged. Preview presentation is distinct from moving-video readiness.

The historical benchmark/preset notes below are not the current quality preset
or a claim that the newest requested latency gates have passed.

Pong Swap is the private PC-side face-swap worker for Pong. Pong shows a compact
Face Swap button and an approved-identity picker. All detailed processing
controls stay here on the PC.

## Privacy and storage

- Approved images belong in `approved-faces/` and are ignored by Git.
- Models, third-party engines, caches, logs, derived embeddings and processed
  video bytes remain inside this directory and are ignored by Git.
- The worker binds to loopback only. Phones reach it through the authenticated
  Pong server on port 8787.
- Output is streamed ephemerally; Pong Swap does not create a permanent rendered
  video unless that is explicitly added later.
- Use only your own face, synthetic identities, or adults who explicitly
  approved this use.

## Controls

The PC control page mirrors Rope-Bronze's processing parameters: similarity,
swapper resolution, likeness/fidelity, borders and blending, differencing,
occluder, XSeg, face/background/mouth parsing, restoration including GPEN-256,
color matching and detector controls. Pong itself does not expose these knobs.

## Runtime target

The player never intentionally reduces playback speed. Pong Swap builds a short
lead buffer, uses H.264 NVENC, and falls back to the original video when a swap
stream cannot become ready within the configured startup deadline.

## Imported VisoMaster preset

`presets/visomaster-exact.json` preserves the uploaded VisoMaster settings:
RetinaFace/50, Inswapper128 ArcFace, Optimal similarity, automatic rotation,
RealESRGAN x2 Plus at 100% blend, NVENC p5/CQ18, and no denoiser or landmark
detector. `presets/visomaster-import-audit.json` records the mapping and confirms
that no quality values were silently reduced.

The exact full-frame RealESRGAN profile is suitable for offline/high-quality
rendering but measured only 2.247 FPS after TensorRT on the RTX 4070. The live
profile in `presets/current.json` keeps the same detector, recognition and swap
identity settings, but uses original-resolution output, a CUDA face-region
detail pass, NVENC p1/CQ18, RetinaFace every fourth frame with optical-flow
tracking between detections, and ArcFace revalidation every 24 frames.

The stock 10.01-second benchmark passed at 31.794 FPS versus 23.976 FPS source
(1.326x real-time headroom), processed 240/240 frames, preserved exact duration,
and moved mean identity similarity from 53.771 to 92.817. The full HTTP path
through port 8787 delivered its first bytes in 2.110 seconds, completed in 8.052
seconds, and independently passed identity verification at 92.734 similarity.
