# Pong 30.03

Fixed the paused-swap resume deadlock; moved identical-quality seek-preview encoding off the video producer. Paired Recall 2 median displayed seek latency: 1,149 → 1,073 ms across 17 seeks. Full-profile smoothing experiments were rejected for quality regressions and are not active.

Ten short playback fixtures passed their existing output cadence. Sustained eating playback still failed at 0.765× real time; native 60 FPS and the 2× throughput target remain unresolved. No quality settings were reduced.

Full report and raw evidence: [Benchmark report](<E:/Pong Benchmarks/v3003-profile-controls/REPORT.md>).

Refresh loads the UI fix. The backend preview change needs a normal service restart; it was only tested in isolated QA renderers. No APK is required.
