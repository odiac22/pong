from __future__ import annotations

import argparse
import ctypes
import importlib.util
import json
import os
import statistics
import time
from pathlib import Path

import cv2
import numpy as np
import torch


_DLL_HANDLES: list[object] = []
os.environ["ORT_LOG_SEVERITY_LEVEL"] = "4"
if os.name == "nt":
    _trt_spec = importlib.util.find_spec("tensorrt_libs")
    if _trt_spec is not None:
        _trt_directories = (
            [str(Path(_trt_spec.origin).parent)]
            if _trt_spec.origin
            else list(_trt_spec.submodule_search_locations or [])
        )
        for _directory in _trt_directories:
            _DLL_HANDLES.append(os.add_dll_directory(_directory))
            for _candidate in sorted(Path(_directory).glob("*.dll")):
                if _candidate.is_file():
                    _DLL_HANDLES.append(ctypes.WinDLL(str(_candidate)))

import onnxruntime as ort


ROOT = Path(__file__).resolve().parent
MODEL = ROOT / "runtime" / "models" / "dfl_xseg.onnx"
DEFAULT_VIDEO = ROOT / "cache" / "benchmark" / "target-video.mp4"


def percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    index = (len(ordered) - 1) * q
    lower = int(index)
    upper = min(lower + 1, len(ordered) - 1)
    weight = index - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def fixture_crops(video: Path, count: int) -> list[np.ndarray]:
    capture = cv2.VideoCapture(str(video))
    crops: list[np.ndarray] = []
    try:
        total = max(1, int(capture.get(cv2.CAP_PROP_FRAME_COUNT)))
        for ordinal in range(count):
            capture.set(
                cv2.CAP_PROP_POS_FRAMES,
                int((ordinal + 0.5) * total / max(1, count)),
            )
            ok, frame = capture.read()
            if not ok or frame is None:
                continue
            height, width = frame.shape[:2]
            edge = max(1, min(height, width))
            y0 = max(0, (height - edge) // 2)
            x0 = max(0, (width - edge) // 2)
            crop = frame[y0 : y0 + edge, x0 : x0 + edge]
            crop = cv2.resize(crop, (256, 256), interpolation=cv2.INTER_LINEAR)
            crops.append(np.ascontiguousarray(crop.astype(np.float32) / 255.0))
    finally:
        capture.release()
    if not crops:
        rng = np.random.default_rng(20260924)
        crops = [rng.random((256, 256, 3), dtype=np.float32) for _ in range(count)]
    return crops


def make_session(backend: str, cache_dir: Path) -> ort.InferenceSession:
    session_options = ort.SessionOptions()
    session_options.log_severity_level = 4
    cuda_options = {
        "arena_extend_strategy": "kSameAsRequested",
        "cudnn_conv_algo_search": "EXHAUSTIVE",
    }
    providers: list[object]
    if backend == "trt":
        cache_dir.mkdir(parents=True, exist_ok=True)
        providers = [
            (
                "TensorrtExecutionProvider",
                {
                    "trt_engine_cache_enable": "True",
                    "trt_engine_cache_path": str(cache_dir),
                    "trt_timing_cache_enable": "True",
                    "trt_timing_cache_path": str(cache_dir),
                    "trt_fp16_enable": "False",
                    "trt_builder_optimization_level": "5",
                    "trt_max_workspace_size": str(4 * 1024**3),
                },
            ),
            ("CUDAExecutionProvider", cuda_options),
            "CPUExecutionProvider",
        ]
    else:
        providers = [("CUDAExecutionProvider", cuda_options), "CPUExecutionProvider"]
    return ort.InferenceSession(
        str(MODEL), sess_options=session_options, providers=providers
    )


def run_backend(
    backend: str,
    fixtures: list[np.ndarray],
    iterations: int,
    cache_dir: Path,
) -> tuple[list[np.ndarray], dict]:
    created = time.perf_counter()
    session = make_session(backend, cache_dir)
    create_seconds = time.perf_counter() - created
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    input_tensor = torch.empty((1, 256, 256, 3), device="cuda", dtype=torch.float32)
    output_tensor = torch.empty((1, 256, 256, 1), device="cuda", dtype=torch.float32)
    binding = session.io_binding()
    binding.bind_input(
        name=input_name,
        device_type="cuda",
        device_id=0,
        element_type=np.float32,
        shape=tuple(input_tensor.shape),
        buffer_ptr=input_tensor.data_ptr(),
    )
    binding.bind_output(
        name=output_name,
        device_type="cuda",
        device_id=0,
        element_type=np.float32,
        shape=tuple(output_tensor.shape),
        buffer_ptr=output_tensor.data_ptr(),
    )

    for _ in range(8):
        input_tensor.copy_(torch.from_numpy(fixtures[0]).to(device="cuda").unsqueeze(0))
        session.run_with_iobinding(binding)
    torch.cuda.synchronize()

    timings: list[float] = []
    outputs: list[np.ndarray] = []
    for index in range(iterations):
        fixture = fixtures[index % len(fixtures)]
        input_tensor.copy_(torch.from_numpy(fixture).to(device="cuda").unsqueeze(0))
        torch.cuda.synchronize()
        started = time.perf_counter()
        session.run_with_iobinding(binding)
        torch.cuda.synchronize()
        timings.append((time.perf_counter() - started) * 1000.0)
        if index < len(fixtures):
            outputs.append(output_tensor.detach().cpu().numpy().copy())
    return outputs, {
        "backend": backend,
        "providers": session.get_providers(),
        "createSeconds": create_seconds,
        "iterations": len(timings),
        "meanMs": statistics.fmean(timings),
        "p50Ms": percentile(timings, 0.50),
        "p90Ms": percentile(timings, 0.90),
        "p95Ms": percentile(timings, 0.95),
        "p99Ms": percentile(timings, 0.99),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", type=Path, default=DEFAULT_VIDEO)
    parser.add_argument("--fixtures", type=int, default=12)
    parser.add_argument("--iterations", type=int, default=80)
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=ROOT / "runtime" / "models" / "ort_trt_cache_dfl_xseg",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "benchmarks" / "dfl-xseg-backends" / "report.json",
    )
    args = parser.parse_args()

    fixtures = fixture_crops(args.video, max(2, args.fixtures))
    cuda_outputs, cuda_report = run_backend(
        "cuda", fixtures, args.iterations, args.cache_dir
    )
    trt_outputs, trt_report = run_backend(
        "trt", fixtures, args.iterations, args.cache_dir
    )
    absolute = [np.abs(a - b) for a, b in zip(cuda_outputs, trt_outputs)]
    binary_mismatch = [
        np.mean((a > 0.5) != (b > 0.5))
        for a, b in zip(cuda_outputs, trt_outputs)
    ]
    report = {
        "schema": "pong-dfl-xseg-backend-benchmark-v1",
        "model": str(MODEL),
        "video": str(args.video),
        "fixtureCount": len(fixtures),
        "cuda": cuda_report,
        "trt": trt_report,
        "speedup": cuda_report["meanMs"] / trt_report["meanMs"],
        "parity": {
            "maxAbs": max(float(np.max(value)) for value in absolute),
            "meanAbs": statistics.fmean(float(np.mean(value)) for value in absolute),
            "binaryMismatchMean": statistics.fmean(float(x) for x in binary_mismatch),
            "binaryMismatchMax": max(float(x) for x in binary_mismatch),
            "binaryBitExactFixtures": int(
                sum(bool(value == 0.0) for value in binary_mismatch)
            ),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
