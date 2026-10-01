# Exact face-swap acceleration

The service qualifies and installs `pong_exact_runtime` during ASGI startup,
before its warm/idle workers or requests can enter. Importing the offline
engine alone does not install this implementation. `PONG_EXACT_ACCELERATION=0`
selects the original implementation on a cold service start; no preset changes
are needed.

## Safety contract

- Original model/engine bytes, precisions, resolution, encoder settings,
  restoration strength, tracking decisions and temporal refresh policies remain
  unchanged. This is execution scheduling and exact arithmetic optimization.
- Qualification checks the package integrity, original source hashes, model
  hashes, library versions and GPU architecture. An unsupported installation
  retains the original renderer and exposes the reason in `/health` under
  `exactAcceleration`. Do not remove these checks to force a speed result.
- Supported calls use pre-generated ordinary Python methods. The development
  source-rewrite installers are not invoked by production startup.
- Model/backend changes reject active playback, close new admissions, drain
  admitted work, unload owned resources and then restore original methods.
  That fallback is terminal for the process; re-acceleration requires a cold
  service restart. Ordinary quality sliders remain editable without changing
  their semantics.
- Ordered asynchronous output uses two pinned-memory leases, completion fences,
  and cancellation cleanup. Unsupported sessions use the original synchronous
  path. A full pool falls back synchronously rather than waiting five seconds.
- `PONG_MASK_OVERLAP_POLICY=guarded` is the qualified default. An explicit
  different environment choice is respected and reported as outside the
  performance-qualified policy. It does not rewrite a visual preset.

## Validation and maintenance

The controlled reports are under `E:/Pong Benchmarks/v3030-fps/RESULTS.md`.
Completed render/encode/HTTP capacity, render-work FPS, source cadence, browser
presentation and buffering are separate measurements. Do not substitute GPU
submission counts, duplicated frames or short warm microbenchmarks for full
completed-output measurements.

Before refreshing the frozen bundle after an engine change, run the CPU tests
(`test_pong_exact_acceleration`, `test_pong_exact_runtime`,
`test_pong_exact_service_adapter`, `test_pong_swap_exact_service_startup`) and
repeat full-frame output/temporal parity plus complete throughput, player,
pause/seek/cancellation and unload/model-transition tests. The manifest is an
audited compatibility record, not an automatically trusted hash refresh.

`run_swap_exact_service.py --service-startup --port 8812 --output-dir FRESH`
tests the real ASGI startup on isolated storage and refuses preset writes.
`run_swap_experiment_service.py` explicitly disables automatic installation so
an original/prototype A/B comparison cannot accidentally run the candidate on
both sides. Keep all benchmark applications hidden and audio disabled.
