# Pong — holistic improvement plan (2026-11-01, after 30.41.0)

Ranked by expected gain per unit of risk. Numbers come from the matched harness runs in `runs/` and the
two phone recordings in `E:\Pong Benchmarks\perf-audit-20261101\phone`.

## A. TikTok Web feel (swipe, search)

How a swipe works today: the native WebView intercepts a vertical move of >= 42 dp (MainActivity
`setOnTouchListener`), cancels the page's own touch, and calls `__pongTikTokStep(dir)` which clicks
TikTok's desktop `feed-navigation-next` button (tiktok-phone-fit.js). The card therefore jumps on button
click instead of following the finger, and the old swap overlay is torn down (`__pongDomSwapDepart`) before
the next card's stream attaches. That is the structural reason it never feels like the app.

1. Finger-following transition (largest perceived gain). Keep the native interception but, during the
   drag, translate the current card and overlay with the finger (CSS transform on the two cards, GPU
   composited), then commit with the existing button click at release; snap back under 42 dp. The
   decoded swap video keeps playing during the drag. Measurable: rAF gaps during swipes (today p95 67 ms,
   max 0.9 s in the after recording) and gesture-to-card-change latency from `__pongTikTokStepStats`.
2. Remove per-swipe layout storms: `elementFromPoint(...).closest(card)` is called from DOWN, from the
   step, from the 100 ms `__pongDomSwapSync` interval and from four MutationObservers in
   tiktok-phone-fit / tiktok-native-ui / tiktok-pong-overlay while TikTok re-renders the feed. Cache the
   active card per navigation and pause the observers for 300 ms after a step.
3. Search result playback: swipes in the search viewer go through `profileButton()` which only knows
   `arrow-right/left` and the "Go to next video" labels; when TikTok renders the search player with
   other controls the step returns false and nothing happens. Needs one DOM probe on the phone
   (search -> open a result -> list visible buttons/aria-labels) to add the selectors; also the
   `waitForFeedStep` fallback should apply there.
4. Search filters: tiktok-phone-fit.js line 104 hides every header child except the search box on
   `/search`, and `ExploreLayout` padding assumes the desktop grid; TikTok's own filter button ("Filters":
   sort by / date posted) and the Top/Videos/Users tabs are desktop-width elements that are either hidden
   by that rule or collapsed by TikTok's responsive CSS at phone width. Fix: allow-list the filter
   button and tab bar in the discover CSS (or render Pong's own filter row that drives TikTok's URL
   params `?q=...&t=...`), verified on the phone DOM.

## B. Swap speed, in order of expected gain

Measured now (grass, 5 faces, 1920x1080 at 24 fps): fresh frame 44 ms after overlap (was 72); 1/4 reuse
frame 37 ms (was 50); fitness reuse frames 81 ms (CPU, 6-7 bindings). Single face GPEN1024 fresh: 51 ms GPU.

1. Reuse-frame CPU (biggest remaining lever for cadence modes, ~2x on 1/4). A reuse frame still runs
   LK tracking, per-person landmark106 + attachment geometry, batched parser + visibility, and Python
   bookkeeping, then composes. Profile reuse frames only (harness label `*cpu*` at cadence 4) and move
   the per-person CPU math (hungarian, cosine galleries: 34k cosine calls per profiled window, numpy
   norms) to vectorised batch calls; skip landmark106/parser on reuse frames when the LK residual and
   appearance guard already passed (they are recomputed only to feed guards that have already passed).
   Target: reuse frame 37 -> 15 ms, i.e. grass 1/4 from 25.7 to ~45 FPS.
2. Restorer cost at 512/1024 (36 ms per face at 1024). Options: TensorRT FP16 for the whole GPEN1024
   (currently FP16 "islands" plan), restoring at 512 and bounded-cubic return to 1024 for small faces
   (face smaller than ~300 px gains nothing from 1024), and batching two faces per restorer call. The
   ladder makes any of these a drop-in rung.
3. Detection/recognition cadence. RetinaFace 640 + ArcFace per detected face every 4th frame costs
   ~6-19 ms on detection frames; with stable tracks, detect at 8 frames and re-identify only on track
   confidence drops (already measured as "trackingIdentityRechecks" 67 per 240 frames).
4. Decode on the GPU (NVDEC) and pinned upload. Software PyAV decode + `to_ndarray` is 10-14 ms per
   1080p frame on a decoder thread; a pageable `torch.from_numpy(...).to('cuda')` upload then stalls
   the compute stream. NVDEC into a CUDA surface removes both and the 640-px grayscale downscale can be
   done on the GPU.
5. Encoder path: the 3X writer now runs off-thread; next is replacing the RGB->YUV conversion done by
   FFmpeg on the CPU with an on-GPU NV12 conversion fed to NVENC (saves ~3-5 ms per 1080p frame and a
   6 MB pipe write).
6. Python per-frame overhead: `_run_gpu_work` queue + `completed.wait()` round trip per frame, deep
   copies of configs per person, `multi_face_decision` dict rebuilt every frame (~60 keys, several
   nested dict() copies). Cheap to trim; worth 1-3 ms per frame.
7. Prefetch/first swap: with the starvation guard live, next step is `startup_frames` (stored but never
   used) to admit exactly the first 3 frames of the next video at foreground priority, and lowering the
   3X foreground prebuffer floor (1.25 s) once the ladder keeps frame cost under budget.

## C. Coverage/identity (fitness clip)
60 whole frames unswapped and 6-7 bindings on 5 people: profile turns collapse the eye span, duplicate
people get reserved. Fix candidates: head-span based reservation gating during turns, and re-identification
on the alternate detector only when the primary track has a confident embedding (already partly in
`_recover_known_people`). Needs per-frame ground truth before claiming improvement.
