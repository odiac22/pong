# Signed-in TikTok transport audit — 30.31-prototype.3

Historical report. The current 30.37 native-capture measurements, rejected
foreground-invalid run, launch blockers and still-unqualified swapped playback
are recorded in [the new audit](<E:/Pong Benchmarks/v3037-flow-audit/REPORT.md>).
The measurements below were not rerun as a controlled 30.37 before/after test.

2026-09-28. Silent, headless, local-only. No production helper/renderer restart,
no changes to Pong face settings, no user credential access. The emulator was
started manually by the user. The agent verified authentication, installed the
official APK, and closed only the manual-login mirror after user login.

## Findings

- Android APK 38.3.3 runs at 1080 × 2340 on Android 15 x86_64 with ARM64
  translation. WHPX and RTX 4070 host graphics acceleration are active.
- Config specifies 4 virtual CPU cores and 2G RAM. Android reports about 2.4 GiB
  total RAM; TikTok's snapshot showed approximately 171 MiB swap PSS, while the
  guest had roughly 1.2 GiB of swap occupied. These are signs to investigate,
  not proof that all latency comes from memory or translation.
- Accumulated TikTok UI counters (including user login/navigation) showed
  639/2971 janky frames, 21.51%. This is not a controlled playback benchmark
  and does not measure the separate video surface's source FPS.
- The initial read-only probe was on the static profile screen and produced
  only 1–2 changed frames per 10 seconds. Those results are intentionally NOT
  used as playback FPS. After observing the screen, Home was selected for the
  feed transport runs. No likes, follows, messages or uploads were made.

## Local measurements

Three consecutive ten-second runs per condition, with no audio stream.
The feed was live rather than a synchronized replay, so throughput differences
are observational, not a controlled causal claim about the optimization.

| Measurement | Original .2 | Final .3 |
|---|---|---|
| Local decoded stream FPS, each run | 35.77 / 35.60 / 32.29 | 33.17 / 34.67 / 32.82 |
| First decoded frame, each connection | 162 / 133 / 105 ms | 138 / 111 / 180 ms |
| Median capture-to-encoder submission, each run | 4.35 / 3.90 / 3.48 ms | 0.68 / 0.64 / 1.03 ms |
| Actual phone/Wi-Fi visible input response | Not measured | Not measured |
| First swapped frame | Not integrated | Not integrated |

Native capture before encoding measured 35.27 / 33.75 / 34.42 FPS. Its first
frame arrived in 45.9 / 45.6 / 39.3 ms. Read-only status RPC medians were
0.90–0.92 ms. RPC ACK is not app response latency.

Raw native RGB capture transfers about 7.23 MiB per frame over local gRPC,
roughly 250 MiB/s at the observed cadence. This remains an architectural cost;
it is not network traffic to the phone. The final WebRTC codec/bitrate path
has not been qualified against Pong's visual-quality baseline.

## Changes and controlled evidence

1. Removed redundant RGB ownership copies without resizing or changing pixels.
   A 200-sample microbenchmark at native dimensions measured median buffer
   preparation of 5.107 ms before versus 0.0031 ms after. Both paths reproduced
   every source pixel exactly. This is a single-stage improvement, NOT a
   thousand-fold application speedup or a face-swap throughput measurement.
2. Fixed static-screen first-frame starvation. A synthetic one-frame source
   timed out before the fix; it now displays within the one-second regression
   deadline. Short startup flushes and 100 ms static display keepalives deliver
   the unchanged screen without inventing motion. Keepalives never count as
   fresh capture or inference; captured/fresh-submitted/repeated counts differ.
3. Added a reusable read-only live transport probe. It stores numbers, not
   videos, titles, feed links, account names, tokens or login material.

All 22 regression tests pass. Immutable buffer lifetime, exact RGB channels,
full resolution and isolation from mutable input buffers are explicitly tested.
No source resolution, encoder parameters, swap quality, GPEN or identity settings
were reduced. Pre-encode pixel equality does not certify final encoded quality.

## Artifacts

- `E:\Pong Benchmarks\tiktok-remote\native-feed-baseline.json`
- `E:\Pong Benchmarks\tiktok-remote\rtc-feed-baseline.json`
- `E:\Pong Benchmarks\tiktok-remote\rtc-feed-zero-copy.json` (intermediate)
- `E:\Pong Benchmarks\tiktok-remote\rtc-feed-prototype3-final.json` (completed rerun)
- `E:\Pong Benchmarks\tiktok-remote\frame-wrap-comparison.json`

## Remaining work

One live run stalled after two results and was stopped without enough phase
evidence to identify its cause. The probe now logs stages, saves incremental
results and bounds connection/cleanup waits. Its next 3/3 runs completed.
A separate provable cancellation flaw was fixed in session teardown with a
shielded cleanup task and cancellation regression. That fix is NOT proof that
the earlier live stall is resolved. More sustained repeated-session testing
remains necessary. Overall live FPS/first-frame improvement is not established;
the controlled improvement proven here is the pixel-exact buffer preparation.

- Measure causal input-to-visible response on a phone, not just local ACKs.
- Qualify transport encoding quality and sustained headroom under GPU swapping.
- Connect a warm, full-quality swap renderer to a video-only region with
  navigation/cut/identity resets; UI must remain unswapped.
- Compare the Edge PWA. It was not available through the connected browser
  inventory, so no desktop latency or headless signed-in result is claimed.
- Preparing the next swapped video needs actual next-video frames. Streaming
  the current screen alone does not expose them. Do not promise next-video
  pre-rendering until a permitted, reliable source is implemented and verified.
- More guest RAM may help memory pressure, but was not changed live or tested;
  any restart must preserve the user's login and authenticated loopback setup.

The prototype is not connected to Pong's TikTok button or deployed to the phone.
The real emulator is still running, but temporary benchmark servers are closed.
