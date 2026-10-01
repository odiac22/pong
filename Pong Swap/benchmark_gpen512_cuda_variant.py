"""Silent GPEN512 CUDA-EP option microbenchmark against the current path."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import statistics
import time

from benchmark_gpen_generated import bootstrap_libraries


ROOT = Path(__file__).resolve().parent


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--option", action="append", default=[])
    parser.add_argument("--warmup", type=int, default=12)
    parser.add_argument("--iterations", type=int, default=50)
    parser.add_argument("--intra", type=int, default=8)
    args = parser.parse_args()
    extra = dict(item.split("=", 1) for item in args.option)
    np, torch, ort, dll_handles = bootstrap_libraries(enable_tensorrt=False)
    del dll_handles
    model = ROOT / "runtime" / "models" / "GPEN-BFR-512.onnx"
    captured = np.load(
        ROOT / "benchmarks" / "gpen512-calibrator-v1" / "capture"
        / "clip-01-gpen-inputs-f32.npy",
        mmap_mode="r",
    )
    fixture = np.array(captured[0:1], dtype=np.float32, copy=True, order="C")
    stream = torch.cuda.Stream(device=0)
    image = torch.from_numpy(fixture).to("cuda:0")
    shape = (1, 3, 512, 512)

    def run(options, intra):
        provider = {
            "arena_extend_strategy": "kSameAsRequested",
            "cudnn_conv_algo_search": "EXHAUSTIVE",
            "cudnn_conv_use_max_workspace": "1",
            "do_copy_in_default_stream": "1",
            "user_compute_stream": str(int(stream.cuda_stream)),
            **options,
        }
        so = ort.SessionOptions()
        so.log_severity_level = 3
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        so.inter_op_num_threads = 1
        so.intra_op_num_threads = max(1, int(intra))
        session = ort.InferenceSession(
            str(model), sess_options=so,
            providers=[("CUDAExecutionProvider", provider)],
        )
        session.disable_fallback()
        output = torch.empty(shape, dtype=torch.float32, device="cuda:0")
        binding = session.io_binding()
        binding.bind_input("input", "cuda", 0, np.float32, shape, image.data_ptr())
        binding.bind_output("output", "cuda", 0, np.float32, shape, output.data_ptr())
        with torch.cuda.stream(stream):
            for _ in range(args.warmup):
                session.run_with_iobinding(binding)
            stream.synchronize()
            values = []
            for _ in range(args.iterations):
                started = time.perf_counter_ns()
                session.run_with_iobinding(binding)
                stream.synchronize()
                values.append((time.perf_counter_ns() - started) / 1e6)
        return output.cpu().numpy().copy(), values, session.get_provider_options()

    reference, reference_ms, reference_options = run({}, 8)
    candidate, candidate_ms, candidate_options = run(extra, args.intra)
    difference = np.abs(reference.astype(np.float64) - candidate.astype(np.float64))
    result = {
        "schema": "pong-gpen512-cuda-variant-v1",
        "requested": extra,
        "intraOpThreads": int(args.intra),
        "effective": candidate_options.get("CUDAExecutionProvider", {}),
        "referenceP50Ms": statistics.median(reference_ms),
        "candidateP50Ms": statistics.median(candidate_ms),
        "speedupPercent": 100.0 * (
            statistics.median(reference_ms) / statistics.median(candidate_ms) - 1.0
        ),
        "mae": float(difference.mean()),
        "p99Abs": float(np.percentile(difference, 99.0)),
        "maxAbs": float(difference.max()),
        "byteIdentical": bool(np.array_equal(reference, candidate)),
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
