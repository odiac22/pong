# perf-audit-20261101 — results (deployed as service 30.41.0, 2026-11-01)

RTX 4070, Ryzen 7 7800X3D, repo on F: (HDD). Offline harness renders the same decoded frames through the
live `ThreeXRenderer` + engine (scripts/benchmark-perf-audit.py); "before" = live 30.40.11 code, "after" =
this branch via module overlay. Same saved preset (GPEN357 selected, 128 swapper, 3X), same 11 selected
sources, same clips, first 10 s. Decode is inline in the harness (adds ~10 ms/frame to both). Silent; no
frames viewed. Loopback pipeline numbers include real decode -> render -> NVENC -> fragment consumer with
the existing 1.25 s prebuffer; Android/Wi-Fi not included.

## Render throughput (renderFps = frames / sum of per-frame render time)

| Cell (clip, cadence, Adapt) | before FPS | after FPS | before p50/p95 ms | after p50/p95 ms | faces/frame | reuse |
|---|---|---|---|---|---|---|
| grass 5 faces, every frame, Adapt off | 13.53 | **21.72** (+61%) | 72.7 / 85.5 | 44.0 / 62.4 | 5 fresh every frame, 0 empty | 0 |
| grass 5 faces, 1/4 + Adapt | 20.05 | **25.73** (+28%) | 49.9 / 71.7 | 37.4 / 56.0 | 5, 0 empty | 877 faces |
| grass 5 faces, 1/4 + Adapt, GPEN1024 selected | 10.58 | **25.52** (ladder -> 357) | 82.9 / 170.6 | 38.0 / 55.2 | 5, 0 empty | 872 |
| fitness, every frame, Adapt off | 15.10 | 16.13 | 80.3 / 98.6 | 73.3 / 94.4 | 846 events, 60 empty (back-facing) | 0 |
| fitness, 1/4 + Adapt | 14.86 | 15.23 | 75.5 / 110.4 | 73.8 / 112.7 | 847 events, 60 empty | 233 |
| clinical 4-person, Adapt | 35.81 | 38.13 | 27.8 / 48.9 | 26.6 / 49.0 | 726-731 events | 410-417 |
| car 1 face, 1/4 + Adapt | 46.99 | 46.14 | 19.2 / 32.9 | 18.7 / 35.2 | 297 events | 149 |
| car 1 face, 1/4 + Adapt, GPEN1024 selected | 27.08 | **44.48** (ladder) | 19.3 / 65.9 | 19.1 / 38.6 | 297 events | 150 |

Where the before-run time went (grass every-frame): render thread blocked 35.3 ms/frame in stream
synchronize + 36.3 ms in the final readback (measured); after: 0.0 / 0.1 ms (readback moved off-thread).
GPU utilisation during the before fresh run was 48% median (prior audit); the overlap closes that gap.

Fitness is CPU-bound in its reuse frames (reuse frames 81-83 ms before and after, process CPU 62-78 ms):
the per-frame work for 6-7 person bindings on 5 people (landmark/geometry/visibility per person) is the
next bottleneck and was not reduced in this pass.

## Dynamic restorer ladder (3X + Adapt)
- Rungs GPEN1024 -> GPEN512 -> GPEN357, all resident after warm (health shows 256/512/1024).
- Opens at 1024 for one visible face, 512 for two, 357 for three or more; steps down within 3 over-budget
  frames or immediately when faces enter / buffer < 0.8 s; climbs after 45 frames of predicted headroom or a
  60-frame probe when the measured cost is under 60% of budget; at least 60 frames between climbs.
- Car (one face, 30 fps source): 1024 for frames 0-17, 512 to frame 22, then 357 — the measured cost at
  1024 with alternate-frame freshness (~36 ms avg) exceeds the 33 ms budget, so the ladder correctly backed
  off; it held 1024 without stalls on the 24 fps grass only until 5 faces were in frame (immediate step down).
- Adapt off: the explicitly selected model is used unchanged (ladder not built). Status fields:
  `multiFace.restorerLadder`, `renderedRestorer`, `adaptiveController=...+restorer-ladder-v1`.

## Loopback pipeline (cadence 4, tiktok-3x-adapt, preset config)

| Metric | before | after |
|---|---|---|
| Grass buffering over 10 s | 0.787 s | **0.023 s** |
| Fitness buffering over 10 s | 7.110 s | 7.051 s |
| Dance buffering over 10 s | 0 | 0 |
| Warm first swap, median of 9 | 157 ms | 150 ms |
| Cold first swap (n=2, HDD) | 12.2 / 7.5 s | 14.2 / 10.2 s (noise; disk-bound) |

## Phone (passive, 5 min before deploy; user browsing TikTok Web)
67 sessions, 23 videos, 599 `waiting` events on the swap overlay, Adapt level 8 / buffer-low in 61 of 67
sessions, zero GPU-patch reuse everywhere (every-frame cadence selected), prefetch sessions rendering while
the foreground had 0 buffer. One face at GPEN1024: 51 ms GPU per frame. After-deploy phone measurement
still to be taken (needs the phone in Pong).

## Deployed (30.41.0)
pong_three_x.py (ladder, Adapt-only guarded reuse at the floor rung, prompt rediscovery, deferred readback,
tracked-frame fence removed), pong_tiktok_restorer.py (ladder warm/select), pong_swap_engine.py (ordered
deferred writer in the 3X feeder, soft-fail warm of optional rungs), pong_prefetch_boost.py (foreground
reserve guard now live; policy 1.9), pong_deferred_readback.py (new). Saved preset unchanged. The restart
reloaded the saved preset: the previous main in-memory config (attachment off, occluder/parser on, strength
off, threshold 51) was archived in deployment/settings-before-8814.json and is NOT what runs now.

## Not achieved / gaps
- 2x sustained FPS reached only for the five-face every-frame case (+61%); cadence runs +28%; fitness ~+3%.
- Five faces fresh every frame is 21.7 FPS offline (24 fps source): still not real-time without reuse.
- Fitness coverage/identity (60 empty frames, 6-7 bindings for 5 people) unchanged.
- No new quality comparison videos were produced this pass (pixels of the fresh path are unchanged by the
  overlap work; the ladder changes which restorer runs, which is visible by design).
- Cold start on the HDD (7-14 s first swap after a cold engine) is disk/initialisation bound.
- Rejected tests: six pre-existing failures on the live tree are unchanged (3 adapt_crowd, 2 adapt_frame_budget, 1 hair rank).
