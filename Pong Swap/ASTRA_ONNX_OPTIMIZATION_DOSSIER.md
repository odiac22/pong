# ONNX/CUDA Performance Audit Dossier

## Scope

This is a read-only engineering audit of a deterministic, single-worker ONNX
Runtime image-processing benchmark on Windows and an NVIDIA RTX 4070. Review
only execution, allocation, scheduling, preprocessing, postprocessing, and
measurement mechanics. Do not run code or modify files.

The output-quality contract is strict:

- preserve every graph, input tensor, output tensor, native resolution, blend,
  crop, mask, normalization, and encoder setting;
- reject changes that reduce precision, resolution, graph work, or visual
  quality;
- distinguish exact-output changes from numerically non-identical proposals;
- treat latency estimates as hypotheses until benchmarked;
- report recommendations separately for every graph family, not just a generic
  provider recommendation.

## Runtime and benchmark contract

- Windows host, NVIDIA RTX 4070, CUDAExecutionProvider with CPU fallback.
- ONNX Runtime graph optimization level: `ORT_ENABLE_ALL`.
- Execution mode: `ORT_SEQUENTIAL`.
- `inter_op_num_threads = 1`, `intra_op_num_threads = 1`.
- CUDA provider options: exhaustive cuDNN algorithm search,
  `arena_extend_strategy=kSameAsRequested`, maximum cuDNN workspace, and copies
  on the default stream.
- One application processing worker. Each benchmark clip uses a persistent
  inference session per graph.
- Timing is around the blocking ONNX call and around the complete stage. The
  first frame is reported separately and excluded from warm percentiles.
- All 224 matrix outputs used the same 72-frame, 3.003-second, 720x1280,
  23.976-FPS input and H.264 NVENC configuration. There were zero failures,
  provider fallbacks, bad frame counts, bad durations, or audio streams.
- Before/after validation for the retained shared optimization produced
  bit-identical decoded output (infinite PSNR and SSIM 1.0).

## Current shared implementation

The environment-gated benchmark path currently:

1. Creates one session with the options above.
2. Resolves fixed output shapes from model metadata.
3. Allocates reusable NumPy CPU output arrays, cached by `id(session)`.
4. Creates a new `session.io_binding()` for every invocation.
5. Runs `numpy.ascontiguousarray()` for every input on every invocation.
6. Binds CPU inputs and binds preallocated CPU outputs by pointer.
7. Calls `run_with_iobinding()` and returns the shared arrays.
8. On any exception, silently marks that numeric session ID disabled and falls
   back to `session.run()`.

Important correctness facts:

- The present benchmark is single-threaded, but the shared helper itself has no
  per-session lock and returns reusable mutable arrays.
- Caches use numeric object IDs and are not explicitly cleared with session
  lifetime.
- Input/output metadata is queried repeatedly in processing modules.
- Binding objects are rebuilt per inference.
- A contiguous input conversion may be a view or a fresh allocation; the bound
  object lifetime is only the duration of the helper call.
- Provider-list reporting proves CUDA EP availability, not that every node in
  every graph is assigned to CUDA.
- The catch-all fallback records neither the failing model nor the reason.

## Measured primary-graph latency

`Complete p50/p95` includes crop preparation, graph inference, normalization,
mask work, compositing, and other stage-local work. The final column is the
median full clip wall time with no second-stage graph. Entries are ordered by
complete p50.

| ID | Public graph ID | Native size | Family | Precision | Complete p50 | Complete p95 | Median full wall |
|---|---|---:|---|---|---:|---:|---:|
| M01 | inswapper_128_fp16 | 128 | inswapper | FP16 graph | 21.82 ms | 23.44 ms | 11.60 s |
| M02 | simswap_256 | 256 | simswap | FP32 graph | 24.97 ms | 26.60 ms | 11.47 s |
| M03 | hififace_unofficial_256 | 256 | hififace | FP32 graph | 27.84 ms | 30.63 ms | 11.81 s |
| M04 | ghost_1_256 | 256 | ghost | FP32 graph | 28.05 ms | 29.44 ms | 12.52 s |
| M05 | inswapper_128 | 128 | inswapper | FP32 graph | 28.85 ms | 29.94 ms | 12.22 s |
| M06 | hyperswap_1b_256 | 256 | hyperswap | FP32 graph | 28.98 ms | 30.32 ms | 12.11 s |
| M07 | hyperswap_1a_256 | 256 | hyperswap | FP32 graph | 29.20 ms | 30.34 ms | 12.47 s |
| M08 | hyperswap_1c_256 | 256 | hyperswap | FP32 graph | 29.47 ms | 30.54 ms | 12.40 s |
| M09 | ghost_2_256 | 256 | ghost | FP32 graph | 31.94 ms | 34.12 ms | 13.14 s |
| M10 | ghost_3_256 | 256 | ghost | FP32 graph | 35.52 ms | 38.32 ms | 13.56 s |
| M11 | blendswap_256 | 256 | blendswap | FP32 graph | 44.27 ms | 45.98 ms | 16.16 s |
| M12 | simswap_unofficial_512 | 512 | simswap | FP32 graph | 54.31 ms | 57.52 ms | 13.95 s |
| M13 | alphaface_256 | 256 | alphaface | FP32 graph | 77.51 ms | 79.61 ms | 16.21 s |
| M14 | uniface_256 | 256 | uniface | FP32 graph | 109.93 ms | 114.19 ms | 18.39 s |

Primary-family mechanics that may affect optimization:

- inswapper performs a per-frame matrix transform and norm of a source vector,
  then mixes it with a normalized target vector.
- ghost performs an embedding-converter graph before reshaping the source
  vector.
- simswap also uses an embedding-converter graph.
- blendswap and uniface prepare an aligned source image tensor rather than only
  a source vector.
- all families enumerate session input metadata for each frame.
- all families allocate a Python input dictionary per frame.
- crop preparation reverses channels, divides by 255, normalizes with family
  constants, transposes, expands, and converts to float32.
- stage-local time also contains affine alignment, masks, pixel-boost split and
  merge, normalization, and paste-back compositing. The benchmark uses native
  model size, so pixel-boost produces one graph invocation per frame.

## Measured second-stage graph latency

These entries are ordered by complete stage p50. Except for R01, all operate at
512 native pixels.

| ID | Public graph ID | Native size | Complete p50 | Complete p95 |
|---|---|---:|---:|---:|
| R01 | gpen_bfr_256 | 256 | 22.33 ms | 23.61 ms |
| R02 | gfpgan_1.2 | 512 | 60.56 ms | 63.46 ms |
| R03 | gfpgan_1.4 | 512 | 60.57 ms | 64.35 ms |
| R04 | gfpgan_1.3 | 512 | 60.76 ms | 65.10 ms |
| R05 | gpen_bfr_512 | 512 | 88.45 ms | 92.81 ms |
| R06 | codeformer | 512 | 99.18 ms | 102.51 ms |
| R07 | restoreformer_plus_plus | 512 | 108.13 ms | 111.01 ms |

Second-stage mechanics:

- the aligned crop is converted BGR-to-RGB, divided by 255, normalized from
  `[0,1]` to `[-1,1]`, transposed, expanded, and converted to float32;
- a one-element float64 weight array is constructed per frame even for graphs
  without a weight input;
- session input metadata is enumerated for every frame;
- after inference, output is clipped, denormalized, transposed, multiplied,
  rounded, converted to uint8, and channel-reversed;
- box mask, optional occlusion mask, paste-back, and final blend are included in
  complete stage time.

## Controlled shared-optimization result

| Component | Before p50 | After p50 | Change | Before p95 | After p95 | Change |
|---|---:|---:|---:|---:|---:|---:|
| M01 complete stage | 22.61 ms | 21.87 ms | -3.3% | 24.51 ms | 23.22 ms | -5.3% |
| R05 complete stage | 90.47 ms | 86.76 ms | -4.1% | 94.19 ms | 93.24 ms | -1.0% |

The outputs were pixel-identical. This demonstrates a real but modest shared
gain and suggests that graph-specific execution and surrounding array/image
work now deserve separate measurement.

## Questions the audit must answer

For every M01-M14 and R01-R07, provide:

1. probable dominant graph and non-graph costs given the measured shape and
   family mechanics;
2. exact-output optimizations available under ONNX Runtime CUDA EP;
3. optimizations that need model-graph inspection before use;
4. optimizations likely to change numerics or output quality and therefore must
   stay experimental;
5. expected impact on warm p50, p95, first-frame time, memory, and throughput,
   expressed as a bounded hypothesis rather than a promise;
6. instrumentation required to prove CUDA node placement, host/device copies,
   allocator behavior, kernel time, and pre/post processing time;
7. whether persistent I/O binding, persistent device tensors, OrtValue reuse,
   pinned host buffers, CUDA Graph capture, TensorRT, FP16 conversion, or TF32
   are appropriate for that particular graph;
8. graph-family-specific opportunities such as caching source-side vector
   preparation or converter results without incorrectly caching target-dependent
   mixing;
9. why a recommendation may help M01 but not M14, or R01 but not R07;
10. an implementation and validation plan ranked by benefit, confidence, risk,
    and engineering cost.

Also audit the shared helper for:

- session lifetime-safe state (weak references versus numeric IDs);
- thread safety and mutable-output ownership;
- persistent binding feasibility and required pointer-stability rules;
- how to avoid needless contiguous conversions without binding temporary or
  non-owned arrays;
- metadata and descriptor caching;
- explicit fallback observability;
- safe cache invalidation;
- whether `intra_op_num_threads=1` harms graphs with CPU fallback;
- how to profile provider partitioning and detect hidden CPU nodes;
- accurate synchronization of timings without adding a device-wide barrier to
  the production path;
- benchmark methodology: randomized A/B order, warmup, sample count, thermal
  controls, p50/p90/p95, output equivalence, failure reporting, and protection
  against false wins.

## Relevant files

- `Pong Swap/vendor/facefusion-benchmark/facefusion/inference_manager.py`
- `Pong Swap/vendor/facefusion-benchmark/facefusion/execution.py`
- `Pong Swap/vendor/facefusion-benchmark/facefusion/processors/modules/face_swapper/core.py`
- `Pong Swap/vendor/facefusion-benchmark/facefusion/processors/modules/face_enhancer/core.py`
- `Pong Swap/build_optimized_video_matrix.py`
- `Pong Swap/benchmarks/optimized-comparison-3s/OPTIMIZED_TIMING_SUMMARY.md`

Return a detailed audit with exact file-and-line references, a per-ID table, a
shared-runtime table, prioritized patches, failure modes, and a timing-only
validation design. Do not propose skipping graph work, lowering native size,
lowering precision, weakening masks, changing blend, or changing output/encoder
settings as a production optimization.
