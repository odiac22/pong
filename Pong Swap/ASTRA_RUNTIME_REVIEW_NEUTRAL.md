# CUDA Tensor Runtime Review

## Task

Review a Windows CUDA/ONNX Runtime benchmark and propose exact-result-preserving
latency improvements. This is a read-only source and measurements exercise. Do
not execute code, access the network, or modify files.

The host has an NVIDIA RTX 4070. There is one processing worker. All graphs use
CUDAExecutionProvider with CPU fallback, ORT sequential execution, full graph
optimization, one inter-op thread, and one intra-op thread. CUDA options use
exhaustive cuDNN search, maximum workspace, same-as-requested arena extension,
and default-stream copies.

The invariant is strict: graph definitions, input/output tensors, dimensions,
precision, preprocessing, postprocessing, numerical output, and downstream
encoding must remain unchanged. Reduced work, reduced precision, reduced
dimensions, or altered numerics are not acceptable retained optimizations.

## Shared helper under review

```python
OUTPUTS = {}                 # keyed by id(session)
DISABLED = set()             # keyed by id(session)

def run(session, inputs):
    if id(session) in DISABLED:
        return session.run(None, inputs)
    try:
        metadata = session.get_outputs()
        arrays = OUTPUTS.get(id(session))
        if arrays is None:
            arrays = [numpy.empty(resolve_shape(x, inputs), dtype(x.type))
                      for x in metadata]
            OUTPUTS[id(session)] = arrays
        binding = session.io_binding()
        for name, value in inputs.items():
            binding.bind_cpu_input(name, numpy.ascontiguousarray(value))
        for output, array in zip(metadata, arrays):
            binding.bind_output(output.name, 'cpu', 0, array.dtype,
                                array.shape, array.ctypes.data)
        session.run_with_iobinding(binding)
        return arrays
    except Exception:
        OUTPUTS.pop(id(session), None)
        DISABLED.add(id(session))
        return session.run(None, inputs)
```

Session construction:

```python
opts.execution_mode = ORT_SEQUENTIAL
opts.graph_optimization_level = ORT_ENABLE_ALL
opts.inter_op_num_threads = 1
opts.intra_op_num_threads = 1
opts.enable_mem_pattern = True
opts.enable_cpu_mem_arena = True
session = InferenceSession(path, sess_options=opts, providers=providers)
```

The benchmark is single-threaded, but this helper is shared code. Binding is
rebuilt for every invocation. Output arrays are mutable and reused. Session
input/output metadata is also enumerated in each caller for every invocation.
Any helper exception silently disables the optimized path for that numeric
object ID. CPU inputs and outputs require host/device transfers.

## Stage A families

Every call performs affine preparation, tensor normalization, one fixed-shape
graph invocation, output normalization, masking, and compositing. Native graph
dimensions and warm complete-call latency are:

| ID | Dimension | Family | Graph precision | p50 | p95 |
|---|---:|---|---|---:|---:|
| M01 | 128 | A | FP16 | 21.82 ms | 23.44 ms |
| M02 | 256 | B | FP32 | 24.97 ms | 26.60 ms |
| M03 | 256 | C | FP32 | 27.84 ms | 30.63 ms |
| M04 | 256 | D | FP32 | 28.05 ms | 29.44 ms |
| M05 | 128 | A | FP32 | 28.85 ms | 29.94 ms |
| M06 | 256 | E | FP32 | 28.98 ms | 30.32 ms |
| M07 | 256 | E | FP32 | 29.20 ms | 30.34 ms |
| M08 | 256 | E | FP32 | 29.47 ms | 30.54 ms |
| M09 | 256 | D | FP32 | 31.94 ms | 34.12 ms |
| M10 | 256 | D | FP32 | 35.52 ms | 38.32 ms |
| M11 | 256 | F | FP32 | 44.27 ms | 45.98 ms |
| M12 | 512 | B | FP32 | 54.31 ms | 57.52 ms |
| M13 | 256 | G | FP32 | 77.51 ms | 79.61 ms |
| M14 | 256 | H | FP32 | 109.93 ms | 114.19 ms |

Family mechanics:

- A executes a per-call matrix transform and L2 norm of a static source vector,
  normalizes a varying target vector, and mixes them before graph execution.
- D and B execute a small vector-converter graph for source preparation.
- F and H prepare a separate aligned source tensor instead of a source vector.
- Every family queries graph input metadata and constructs a Python input
  dictionary per call.
- Preprocessing reverses channels, divides, normalizes by family constants,
  transposes, expands, and converts to float32.
- One native-size graph invocation occurs per call.

## Stage B families

Each call aligns a tensor, prepares it from uint8 HWC to normalized float32
NCHW, invokes a fixed-shape graph, clips and denormalizes output, rounds and
converts to uint8, applies a mask, composites, and blends. A one-element float64
weight array is allocated on every call even when the graph has no such input.
Graph input metadata is enumerated on every call.

| ID | Dimension | p50 | p95 |
|---|---:|---:|---:|
| R01 | 256 | 22.33 ms | 23.61 ms |
| R02 | 512 | 60.56 ms | 63.46 ms |
| R03 | 512 | 60.57 ms | 64.35 ms |
| R04 | 512 | 60.76 ms | 65.10 ms |
| R05 | 512 | 88.45 ms | 92.81 ms |
| R06 | 512 | 99.18 ms | 102.51 ms |
| R07 | 512 | 108.13 ms | 111.01 ms |

## Existing controlled result

Reusable CPU outputs plus I/O binding reduced M01 complete p50 from 22.61 to
21.87 ms and p95 from 24.51 to 23.22 ms. It reduced R05 complete p50 from 90.47
to 86.76 ms and p95 from 94.19 to 93.24 ms. Decoded outputs were bit-identical.

## Required response

Return an exhaustive engineering audit with:

1. correctness defects in the helper, including lifetime, numeric-ID reuse,
   thread safety, mutable buffers, temporary contiguous input ownership,
   fallback observability, and invalidation;
2. a separate row for each M01-M14 and R01-R07 describing probable bottleneck,
   exact-result-preserving changes, graph-inspection needs, expected bounded
   latency opportunity, memory impact, risk, and confidence;
3. analysis of persistent I/O binding, stable input/output OrtValues, pinned
   host memory, device-resident tensors, CUDA Graph capture, provider
   partitioning, CPU fallback, allocator strategy, and synchronization;
4. clear separation between changes expected to be bit-identical and changes
   that may alter floating-point results and must remain experimental;
5. exact instrumentation needed to measure preprocessing, graph execution,
   transfers, postprocessing, first-call initialization, CUDA node placement,
   allocations, and fallback;
6. a prioritized patch plan with benefit, complexity, regression risk, and
   validation gates;
7. a timing-only A/B design with randomized order, repeated samples, warmups,
   p50/p90/p95, thermal controls, failure reporting, and exact array equality.

Do not claim a percentage improvement without a measurement. Do not recommend
lower precision, smaller dimensions, skipped operations, or changed numerical
output as a retained optimization.
