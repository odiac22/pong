"""Paired, generated-input latency/fidelity gate for the GPEN512 FP16 graph."""

from __future__ import annotations

import gc
import json
import math
import os
import statistics
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from skimage.metrics import structural_similarity


ROOT = Path(__file__).resolve().parent
BASELINE = ROOT / "runtime" / "models" / "GPEN-BFR-512.onnx"
CANDIDATE = ROOT / "runtime" / "models-candidates" / "gpen512-fp16" / "GPEN-BFR-512.onnx"
REPORT = ROOT / "benchmarks" / "gpen512-fp16-candidate" / "report.json"
ITERATIONS = 96
WARMUP = 12


def percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * q
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def fixtures() -> list[np.ndarray]:
    yy, xx = np.mgrid[0:512, 0:512].astype(np.float32)
    values = []
    for step in range(8):
        phase = step * 0.37
        r = np.sin(xx / (17.0 + step) + phase)
        g = np.cos(yy / (21.0 + step) - phase)
        b = np.sin((xx + yy) / (29.0 + step) + phase)
        image = np.stack([r, g, b], axis=0)[None, ...]
        values.append(np.ascontiguousarray(np.clip(image, -1.0, 1.0)))
    return values


def run_model(path: Path) -> tuple[dict, list[np.ndarray]]:
    stream = torch.cuda.Stream(device=0)
    options = ort.SessionOptions()
    options.log_severity_level = 3
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.inter_op_num_threads = 1
    options.intra_op_num_threads = max(2, min(8, (os.cpu_count() or 4) // 2))
    provider_options = {
        "arena_extend_strategy": "kSameAsRequested",
        "cudnn_conv_algo_search": "EXHAUSTIVE",
        "user_compute_stream": str(int(stream.cuda_stream)),
    }
    created = time.perf_counter()
    session = ort.InferenceSession(
        str(path),
        sess_options=options,
        providers=[("CUDAExecutionProvider", provider_options)],
    )
    create_ms = (time.perf_counter() - created) * 1000.0
    session.disable_fallback()
    input_meta = session.get_inputs()[0]
    output_meta = session.get_outputs()[0]
    dtype = torch.float16 if "float16" in input_meta.type else torch.float32
    np_dtype = np.float16 if dtype is torch.float16 else np.float32
    device_input = torch.empty((1, 3, 512, 512), dtype=dtype, device="cuda:0")
    device_output = torch.empty((1, 3, 512, 512), dtype=dtype, device="cuda:0")
    binding = session.io_binding()
    binding.bind_input(input_meta.name, "cuda", 0, np_dtype, tuple(device_input.shape), device_input.data_ptr())
    binding.bind_output(output_meta.name, "cuda", 0, np_dtype, tuple(device_output.shape), device_output.data_ptr())
    data = fixtures()
    samples = []
    outputs = []
    with torch.cuda.stream(stream):
        for iteration in range(WARMUP + ITERATIONS):
            fixture = data[iteration % len(data)]
            device_input.copy_(torch.from_numpy(fixture).to(device="cuda:0", dtype=dtype))
            stream.synchronize()
            started = time.perf_counter()
            session.run_with_iobinding(binding)
            stream.synchronize()
            elapsed = (time.perf_counter() - started) * 1000.0
            if iteration >= WARMUP:
                samples.append(elapsed)
        for fixture in data:
            device_input.copy_(torch.from_numpy(fixture).to(device="cuda:0", dtype=dtype))
            session.run_with_iobinding(binding)
            stream.synchronize()
            outputs.append(device_output.float().cpu().numpy().copy())
    result = {
        "path": str(path),
        "providers": session.get_providers(),
        "inputType": input_meta.type,
        "outputType": output_meta.type,
        "sessionCreateMs": create_ms,
        "samples": len(samples),
        "meanMs": statistics.mean(samples),
        "p50Ms": percentile(samples, 0.50),
        "p95Ms": percentile(samples, 0.95),
        "p99Ms": percentile(samples, 0.99),
        "callsPerSecond": 1000.0 / statistics.mean(samples),
    }
    del binding, session, device_input, device_output
    gc.collect()
    torch.cuda.empty_cache()
    return result, outputs


def compare(left: list[np.ndarray], right: list[np.ndarray]) -> dict:
    maes = []
    maxes = []
    psnrs = []
    ssims = []
    for baseline, candidate in zip(left, right, strict=True):
        baseline = np.clip((baseline[0] + 1.0) * 127.5, 0, 255)
        candidate = np.clip((candidate[0] + 1.0) * 127.5, 0, 255)
        difference = np.abs(baseline - candidate)
        mse = float(np.mean(np.square(baseline - candidate)))
        maes.append(float(np.mean(difference)))
        maxes.append(float(np.max(difference)))
        psnrs.append(float("inf") if mse == 0 else 20.0 * math.log10(255.0 / math.sqrt(mse)))
        ssims.append(float(structural_similarity(
            np.moveaxis(baseline, 0, -1),
            np.moveaxis(candidate, 0, -1),
            channel_axis=2,
            data_range=255.0,
        )))
    return {
        "meanAbsoluteError": statistics.mean(maes),
        "worstMaximumError": max(maxes),
        "minimumPsnrDb": min(psnrs),
        "minimumSsim": min(ssims),
    }


def run() -> None:
    if not BASELINE.is_file() or not CANDIDATE.is_file():
        raise FileNotFoundError("Build the FP16 candidate first")
    baseline, baseline_outputs = run_model(BASELINE)
    candidate, candidate_outputs = run_model(CANDIDATE)
    fidelity = compare(baseline_outputs, candidate_outputs)
    speedup = baseline["meanMs"] / candidate["meanMs"]
    checks = {
        "cudaOnly": baseline["providers"][0] == "CUDAExecutionProvider" and candidate["providers"][0] == "CUDAExecutionProvider",
        "latencyAtLeastThirtyPercentFaster": speedup >= 1.30,
        "meanAbsoluteError": fidelity["meanAbsoluteError"] <= 0.50,
        "psnr": fidelity["minimumPsnrDb"] >= 45.0,
        "ssim": fidelity["minimumSsim"] >= 0.995,
    }
    report = {
        "schema": "pong-gpen512-fp16-candidate-benchmark-v1",
        "baseline": baseline,
        "candidate": candidate,
        "speedup": speedup,
        "fidelity": fidelity,
        "checks": checks,
        "ok": all(checks.values()),
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    if not report["ok"]:
        raise SystemExit(2)


if __name__ == "__main__":
    run()
