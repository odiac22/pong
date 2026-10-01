# Generated-tensor GPEN benchmark

Run from this directory with the existing GPU environment:

```powershell
& '.\runtime\venv\Scripts\python.exe' -I -B '.\benchmark_gpen_generated.py' --mode smoke --output-dir '<new-report-directory>'
& '.\runtime\venv\Scripts\python.exe' -I -B '.\benchmark_gpen_generated.py' --mode full --output-dir '<new-report-directory>'
```

Those commands run CUDA-only arms B/C. TensorRT arms A/D are disabled unless
they are explicitly named with `--arms` and paired with
`--enable-tensorrt-build`. Do not enable them on a shared or unattended host.

Use an isolated RTX 4070 for the full run. Smoke has two alternating rounds and
16 measured calls per primary arm. Full has eight balanced, alternating rounds
and 1,024 calls per primary arm. Each arm runs in its own fresh subprocess.
Sessions from different arms never coexist. A new benchmark work directory holds
generated tensors, worker logs, and benchmark-only TRT caches. The first round
starts with empty caches; subsequent rounds reuse only this run's caches.
`--work-dir` can select a new/empty directory; it cannot reuse existing contents.
`--worker-timeout` defaults to 120 seconds per subprocess and is hard-capped at
300 seconds, including imports and cold construction. An independent watchdog
kills the worker even if GPU telemetry is blocked. `--run-timeout` defaults to
300 seconds (maximum 1,800) for the whole run, including metrics. Exit code 124
means the total deadline fired; the incremental report is incomplete and must
not be accepted. Full runs may need an explicitly larger total budget.

Containment requires Windows Job Objects. Before any GPU import, each worker
waits on a supervisor pipe; the parent assigns it to a non-inheritable,
kill-on-close Job before releasing it. The Job kills the worker and descendants
on timeout, headroom loss, telemetry failure, interruption, or parent exit.
Failure to assign the Job aborts before GPU imports. No process-name sweeps or
service control are used. Existing output directories must be empty.

Arms:

| Arm | Execution policy |
| --- | --- |
| A | Frozen pre-patch GPEN256: TRT first, FP16 enabled, 3 GiB workspace, optimization level 5, unbound TRT stream; CUDA fallback on the shared stream; fresh direct bindings |
| B | Frozen pre-patch GPEN512: CUDA provider name only, default session options and stream; fresh direct bindings |
| C | Current GPEN512 runtime with explicit CUDA preference, persistent buffers and copies |
| D | Current GPEN512 runtime with explicit TRT preference, FP16 enabled, 1 GiB workspace, persistent buffers and copies |
| E | Benchmark-only GPEN512 CUDA Graph replay using C's fixed buffers and stream |
| F | Benchmark-only GPEN256 CUDA runtime diagnostic using F's native 256 input |

CUDA arms B/C/E/F do not discover or load TensorRT libraries. Both GPEN sizes
receive an explicit CUDA preference, and a session-factory guard rejects any
TensorRT request from a CUDA arm. TensorRT A/D require both explicit arm
selection and `--enable-tensorrt-build`; these flags do not waive time or VRAM
limits. DLL directory and library handles are retained for process lifetime.

A/B retain the old `syncvec.cpu()` fence and headless Shared-mode policy. Their
cache locations are redirected into benchmark storage. C/D directly import only
the standalone `gpen_runtime.py`; no production ENGINE, Models, configuration,
faces, media, audio, networking, or services are involved. The harness never
stops or restarts a service and does not change runtime or compositing code.

Six deterministic RGB patterns use two temporal steps in smoke and four in full.
All 512 arms receive identical FP32 tensors. A receives bilinear 256 resizing of
those tensors, performed before timing. Timing excludes input construction,
preprocessing, CPU output downloads, quality calculations and compositing.
Every measurement uses the same host clock and CUDA completion boundary; CUDA
events on the caller stream would miss work on the old unbound provider streams.
Reported throughput is sequential completed calls per second, not pipeline FPS.
Factory/build, runtime prepare, first caller invocation and extra warmup durations
are recorded separately. Cold preparation may include an internal runtime warmup.

C/D also alternate three same-session ablations: fresh direct bindings, persistent
direct bindings, and persistent buffers with input/output copies. Paired deltas
separate binding creation, two device copies, and runtime wrapper overhead. Each
variant is checked against primary output after poisoning output with NaNs.
Small signed timing differences can be noise; smoke cannot establish a speed win.

E never uses alternate bindings because CUDA Graph replay requires stable input
and output addresses. Its acceptance gate compares E against contemporaneous C
over eight paired rounds: at least 2% lower mean latency, a paired round-level
95% improvement interval entirely above zero, no p95/p99 regression, and
bit-exact generated outputs.

The 2026-09-18 full E experiment was rejected: C averaged 58.105145 ms and E
57.118033 ms (1.69884% faster), below the predeclared 2% requirement. Its paired
95% improvement interval was 1.64428% to 1.75071%; p95/p99 improved and all 192
comparisons were bit-exact. E therefore remains benchmark-only and is not a
production setting.

F exists only for a provider- and runtime-policy-matched GPEN256-versus-GPEN512
diagnostic. Both models receive deterministic inputs prepared at their native
resolution before timing. Cross-model pixel equality is not treated as a
correctness gate because the checkpoints and native resolutions differ.

The 2026-09-18 full F/C diagnostic measured 1,024 calls per model across eight
paired rounds. GPEN256 averaged 8.298197 ms (p50 8.29615, p95 8.402665,
p99 8.467939); GPEN512 averaged 58.189948 ms (p50 58.18205, p95 58.39799,
p99 58.476723). GPEN512 was 7.01236x the native model latency, with paired
round ratio 95% interval 7.00181x–7.02397x. This is a checkpoint-and-native-
resolution comparison, not a claim that resolution alone causes the ratio.

Safety-audit qualification: the earlier F harness omitted the GPEN256 backend
preference, allowing its legacy TensorRT-first policy. The corrected harness
sets both sizes explicitly and rejects unapproved TensorRT session creation.
The historical F/C figures above are retained as prior notes; revalidate their
effective-provider evidence and repeat under the corrected guard before using
them as a CUDA-only comparison. This safety pass did not rerun F, E, A, or D.

`report.json` records p50/p95/p99/mean, throughput, cold timings, provider options,
fallback reasons, source/model hashes, process RSS/peak RSS, Torch allocation
peaks, sampled device memory, and process GPU memory when the driver exposes it.
WDDM process GPU memory is reported as null, never zero. Provider registration
does not establish node placement or realized precision. Per-worker raw samples,
fixture/output hashes, and generated arrays remain in the work directory.

C/D fidelity is measured against same-round B after clamping and converting to
floating RGB 0..255: MAE <= 0.10, p99 absolute error <= 1, maximum <= 4,
PSNR >= 50 dB, Gaussian 11x11/sigma 1.5 SSIM >= .999, and temporal first-difference
MAE <= .20. Exact equality has `psnrDb: null` and `exactMatch: true`. Missing,
nonfinite, mismatched or unwritten output cannot pass. These generated patterns
cannot establish perceptual face quality or compositing correctness.

The full latency gate compares C/D against A: p50 and p95 ratios <= 1 plus the
one-sided 95th percentile of 4,000 seeded bootstrap means of paired round mean
ratios <= 1. Candidate acceptance also requires fidelity and the requested
provider with no reported fallback. Smoke always leaves acceptance unestablished.

Before workers start, GPU index 0 must be an RTX 4070 with at least 8 GiB free
and <=5% utilization. Invalid/nonfinite telemetry and GPU remapping abort.
While running, the parent terminates only its own child if device free memory
drops below max(2 GiB, 20% of VRAM), or the child times out. Device telemetry is
sampled; this guard cannot guarantee zero interference with other GPU applications.
Blocked/aborted runs still produce a report with the reason and available data.

CPU-only checks:

```powershell
& '.\runtime\venv\Scripts\python.exe' -I -B '.\test_gpen_generated_benchmark.py'
& '.\runtime\venv\Scripts\python.exe' -I -B '.\test_native_dll_bootstrap.py'
& '.\runtime\venv\Scripts\python.exe' -I -B '.\test_gpen_runtime_contract.py'
& '.\runtime\venv\Scripts\python.exe' -I -B '.\test_gpen_safety_contract.py'
& '.\runtime\venv\Scripts\python.exe' -I -B '.\test_gpen_benchmark_guard.py'
```

The guard suite uses only synthetic Python child processes. It exercises
cleanup, deadlines, headroom loss, lost telemetry, interruption, and abrupt
supervisor exit without importing GPU libraries or opening model files.
