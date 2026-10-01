"""Evaluate sub-millisecond replacements for GPEN512's final to-RGB block.

The frozen ORT graph supplies identical feature and modulated-weight tensors.
Only the 3x128 1x1 projection plus bias is recomputed.  This is analysis-only;
no production model, plan, preset, or runtime setting is changed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import time

import onnx
from onnx import numpy_helper

from benchmark_gpen_generated import bootstrap_libraries
from benchmark_gpen512_native_trt import atomic_write_json


ROOT = Path(__file__).resolve().parent
MODEL = ROOT / "runtime" / "models" / "GPEN-BFR-512.onnx"
INPUTS = ROOT / "benchmarks" / "gpen512-calibration-inputs"
OUTPUT = ROOT / "benchmarks" / "gpen512-torgb-repair-v1"
FEATURE = "/generator/to_rgbs.6/conv/Reshape_2_output_0"
WEIGHT = "/generator/to_rgbs.6/conv/Reshape_1_output_0"
TARGET = "/generator/to_rgbs.6/Add_output_0"
BIAS = "generator.to_rgbs.6.bias"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def percentile(values, percent):
    values = sorted(values)
    position = (len(values) - 1) * percent / 100.0
    lower, upper = math.floor(position), math.ceil(position)
    return float(values[lower] + (values[upper] - values[lower]) * (position - lower))


def save_augmented_model(source: Path, destination: Path):
    model = onnx.load(source)
    inferred = onnx.shape_inference.infer_shapes(model)
    info = {
        value.name: value
        for value in (
            list(inferred.graph.value_info)
            + list(inferred.graph.input)
            + list(inferred.graph.output)
        )
    }
    existing = {item.name for item in model.graph.output}
    for name in (FEATURE, WEIGHT, TARGET):
        if name not in existing:
            model.graph.output.append(info[name])
            existing.add(name)
    onnx.checker.check_model(model)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + f".{os.getpid()}.tmp")
    try:
        onnx.save(model, temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def make_ort(ort, model: Path, stream_id: int):
    options = ort.SessionOptions()
    options.log_severity_level = 3
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.inter_op_num_threads = 1
    options.intra_op_num_threads = max(2, min(8, (os.cpu_count() or 4) // 2))
    session = ort.InferenceSession(
        str(model),
        sess_options=options,
        providers=[
            (
                "CUDAExecutionProvider",
                {
                    "arena_extend_strategy": "kSameAsRequested",
                    "cudnn_conv_algo_search": "EXHAUSTIVE",
                    "user_compute_stream": str(stream_id),
                    "use_tf32": "1",
                },
            )
        ],
    )
    session.disable_fallback()
    return session


def summarize(records):
    temporal = [item["temporalError"] for item in records if item["temporalError"] is not None]
    return {
        "sampleCount": len(records),
        "maeMean": statistics.fmean(item["mae"] for item in records),
        "maeP95": percentile([item["mae"] for item in records], 95),
        "p99AbsMean": statistics.fmean(item["p99Abs"] for item in records),
        "p99AbsP95": percentile([item["p99Abs"] for item in records], 95),
        "maxAbs": max(item["maxAbs"] for item in records),
        "temporalErrorMean": statistics.fmean(temporal),
        "temporalErrorP95": percentile(temporal, 95),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=MODEL)
    parser.add_argument("--input-dir", type=Path, default=INPUTS)
    parser.add_argument("--output-dir", type=Path, default=OUTPUT)
    parser.add_argument("--iterations", type=int, default=100)
    parser.add_argument("--warmup", type=int, default=20)
    args = parser.parse_args()

    args.model = args.model.resolve()
    args.input_dir = args.input_dir.resolve()
    args.output_dir = args.output_dir.resolve()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    augmented = args.output_dir / "gpen512-torgb-outputs.onnx"
    save_augmented_model(args.model, augmented)

    np, torch, ort, dll_handles = bootstrap_libraries(enable_tensorrt=False)
    del dll_handles
    torch.cuda.set_device(0)
    import torch.nn.functional as functional

    source_model = onnx.load(args.model)
    bias_array = next(
        numpy_helper.to_array(item).copy()
        for item in source_model.graph.initializer
        if item.name == BIAS
    )
    stream = torch.cuda.Stream(device=0)
    stream_id = int(stream.cuda_stream)
    source = torch.empty((1, 3, 512, 512), dtype=torch.float32, device="cuda:0")
    feature = torch.empty((1, 128, 512, 512), dtype=torch.float32, device="cuda:0")
    weight = torch.empty((3, 128, 1, 1), dtype=torch.float32, device="cuda:0")
    reference = torch.empty((1, 3, 512, 512), dtype=torch.float32, device="cuda:0")
    scratch = torch.empty_like(reference)
    bias = torch.from_numpy(bias_array.astype(np.float32, copy=False)).to("cuda:0")

    session = make_ort(ort, augmented, stream_id)
    binding = session.io_binding()
    binding.bind_input("input", "cuda", 0, np.float32, tuple(source.shape), source.data_ptr())
    binding.bind_output(FEATURE, "cuda", 0, np.float32, tuple(feature.shape), feature.data_ptr())
    binding.bind_output(WEIGHT, "cuda", 0, np.float32, tuple(weight.shape), weight.data_ptr())
    binding.bind_output(TARGET, "cuda", 0, np.float32, tuple(reference.shape), reference.data_ptr())

    def conv_tf32():
        previous = torch.backends.cudnn.allow_tf32
        torch.backends.cudnn.allow_tf32 = True
        try:
            torch.add(functional.conv2d(feature, weight), bias, out=scratch)
        finally:
            torch.backends.cudnn.allow_tf32 = previous

    def conv_fp32():
        previous = torch.backends.cudnn.allow_tf32
        torch.backends.cudnn.allow_tf32 = False
        try:
            torch.add(functional.conv2d(feature, weight), bias, out=scratch)
        finally:
            torch.backends.cudnn.allow_tf32 = previous

    def matmul_tf32():
        previous = torch.backends.cuda.matmul.allow_tf32
        torch.backends.cuda.matmul.allow_tf32 = True
        try:
            torch.addmm(
                bias.reshape(3, 1),
                weight.reshape(3, 128),
                feature.reshape(128, -1),
                out=scratch.reshape(3, -1),
            )
        finally:
            torch.backends.cuda.matmul.allow_tf32 = previous

    def matmul_fp32():
        previous = torch.backends.cuda.matmul.allow_tf32
        torch.backends.cuda.matmul.allow_tf32 = False
        try:
            torch.addmm(
                bias.reshape(3, 1),
                weight.reshape(3, 128),
                feature.reshape(128, -1),
                out=scratch.reshape(3, -1),
            )
        finally:
            torch.backends.cuda.matmul.allow_tf32 = previous

    operations = {
        "cudnnTf32": conv_tf32,
        "cudnnFp32": conv_fp32,
        "matmulTf32": matmul_tf32,
        "matmulFp32": matmul_fp32,
    }
    records = {name: [] for name in operations}
    previous_by_variant = {name: {} for name in operations}
    last_fixture = None
    input_paths = sorted(args.input_dir.glob("*.npy"))
    for path in input_paths:
        captured = np.load(path, mmap_mode="r")
        for index in range(captured.shape[0]):
            fixture = np.array(captured[index : index + 1], dtype=np.float32, copy=True)
            last_fixture = fixture
            with torch.cuda.stream(stream):
                source.copy_(torch.from_numpy(fixture), non_blocking=False)
                session.run_with_iobinding(binding)
                stream.synchronize()
                reference_cpu = reference.detach().cpu().numpy().copy()
                for name, operation in operations.items():
                    operation()
                    stream.synchronize()
                    output_cpu = scratch.detach().cpu().numpy().copy()
                    absolute = np.abs(output_cpu - reference_cpu)
                    previous = previous_by_variant[name].get(path.stem)
                    temporal = None
                    if previous is not None:
                        temporal = float(
                            np.mean(
                                np.abs(
                                    (output_cpu - previous["output"])
                                    - (reference_cpu - previous["reference"])
                                ),
                                dtype=np.float64,
                            )
                        )
                    previous_by_variant[name][path.stem] = {
                        "output": output_cpu,
                        "reference": reference_cpu,
                    }
                    records[name].append(
                        {
                            "clip": path.stem,
                            "index": index,
                            "mae": float(np.mean(absolute, dtype=np.float64)),
                            "p99Abs": float(np.percentile(absolute, 99)),
                            "maxAbs": float(np.max(absolute)),
                            "temporalError": temporal,
                        }
                    )

    with torch.cuda.stream(stream):
        source.copy_(torch.from_numpy(last_fixture), non_blocking=False)
        session.run_with_iobinding(binding)
        stream.synchronize()
        timings = {}
        for name, operation in operations.items():
            for _ in range(args.warmup):
                operation()
            stream.synchronize()
            values = []
            for _ in range(args.iterations):
                start = torch.cuda.Event(enable_timing=True)
                end = torch.cuda.Event(enable_timing=True)
                start.record(stream)
                operation()
                end.record(stream)
                end.synchronize()
                values.append(float(start.elapsed_time(end)))
            timings[name] = {
                "iterations": len(values),
                "p50Ms": percentile(values, 50),
                "p95Ms": percentile(values, 95),
                "meanMs": statistics.fmean(values),
            }

    report = {
        "schema": "pong-gpen512-torgb-repair-v1",
        "silent": True,
        "sourceModel": str(args.model),
        "sourceModelSha256": sha256(args.model),
        "augmentedModelSha256": sha256(augmented),
        "reference": {
            "provider": session.get_providers()[0],
            "useTf32": True,
            "target": TARGET,
        },
        "variants": {name: summarize(items) for name, items in records.items()},
        "timing": timings,
    }
    report_path = args.output_dir / "report.json"
    atomic_write_json(report_path, report)
    print(json.dumps({"variants": report["variants"], "timing": timings}, indent=2))
    print(f"report={report_path}")


if __name__ == "__main__":
    main()
