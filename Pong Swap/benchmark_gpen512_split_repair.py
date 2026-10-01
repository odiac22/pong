"""Qualify a TensorRT GPEN prefix plus an exact TF32 final to-RGB repair.

The prefix retains the original graph through the final feature, modulation
weight, and previous-RGB upsample.  The final 3x128 projection is executed as
the measured ORT-equivalent TF32 addmm on the same CUDA stream.  This script is
analysis-only and never changes the production model, plan, or configuration.
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
from benchmark_gpen512_native_trt import atomic_write_bytes, atomic_write_json


ROOT = Path(__file__).resolve().parent
MODEL = ROOT / "runtime" / "models" / "GPEN-BFR-512.onnx"
INPUTS = ROOT / "benchmarks" / "gpen512-calibration-inputs"
OUTPUT = ROOT / "benchmarks" / "gpen512-split-repair-v1"
FEATURE = "/generator/to_rgbs.6/conv/Reshape_2_output_0"
WEIGHT = "/generator/to_rgbs.6/conv/Reshape_1_output_0"
PREVIOUS_RGB = "/generator/to_rgbs.6/upsample/Reshape_4_output_0"
BIAS = "generator.to_rgbs.6.bias"
PREFIX_OUTPUTS = (FEATURE, WEIGHT, PREVIOUS_RGB)


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


def save_prefix(source: Path, destination: Path):
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + f".{os.getpid()}.tmp")
    try:
        onnx.utils.extract_model(
            str(source), str(temporary), ["input"], list(PREFIX_OUTPUTS), check_model=True
        )
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def build_plan(trt, model: Path, plan: Path, workspace_bytes: int):
    logger = trt.Logger(trt.Logger.WARNING)
    builder = trt.Builder(logger)
    network = builder.create_network(
        1 << int(trt.NetworkDefinitionCreationFlag.EXPLICIT_BATCH)
    )
    parser = trt.OnnxParser(network, logger)
    if not parser.parse_from_file(str(model)):
        errors = [str(parser.get_error(index)) for index in range(parser.num_errors)]
        raise RuntimeError("TensorRT prefix parse failed: " + " | ".join(errors))
    if network.num_inputs != 1 or network.get_input(0).name != "input":
        raise RuntimeError("Prefix must expose only the original input")
    outputs = {network.get_output(index).name for index in range(network.num_outputs)}
    if outputs != set(PREFIX_OUTPUTS):
        raise RuntimeError(f"Unexpected prefix outputs: {outputs}")
    config = builder.create_builder_config()
    config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, workspace_bytes)
    config.builder_optimization_level = 5
    config.clear_flag(trt.BuilderFlag.FP16)
    config.set_flag(trt.BuilderFlag.TF32)
    config.clear_flag(trt.BuilderFlag.INT8)
    started = time.perf_counter_ns()
    serialized = builder.build_serialized_network(network, config)
    build_ms = (time.perf_counter_ns() - started) / 1e6
    if serialized is None:
        raise RuntimeError("TensorRT prefix build failed")
    atomic_write_bytes(plan, bytes(serialized))
    return {
        "buildMs": build_ms,
        "workspaceBytes": workspace_bytes,
        "tf32": True,
        "fp16": False,
        "outputs": sorted(outputs),
    }


def make_reference(ort, model: Path, stream_id: int):
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=MODEL)
    parser.add_argument("--input-dir", type=Path, default=INPUTS)
    parser.add_argument("--output-dir", type=Path, default=OUTPUT)
    parser.add_argument("--workspace-gib", type=float, default=4.0)
    parser.add_argument("--iterations", type=int, default=80)
    parser.add_argument("--warmup", type=int, default=16)
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args()

    args.model = args.model.resolve()
    args.input_dir = args.input_dir.resolve()
    args.output_dir = args.output_dir.resolve()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    prefix_model = args.output_dir / "GPEN-BFR-512-prefix.onnx"
    plan = args.output_dir / "gpen512-prefix-fp32-tf32.plan"
    save_prefix(args.model, prefix_model)

    np, torch, ort, dll_handles = bootstrap_libraries(enable_tensorrt=True)
    del dll_handles
    torch.cuda.set_device(0)
    import tensorrt as trt

    build = None
    if args.rebuild or not plan.is_file():
        build = build_plan(
            trt, prefix_model, plan, int(args.workspace_gib * (1 << 30))
        )
    logger = trt.Logger(trt.Logger.WARNING)
    runtime = trt.Runtime(logger)
    engine = runtime.deserialize_cuda_engine(plan.read_bytes())
    if engine is None:
        raise RuntimeError("TensorRT prefix deserialization failed")
    context = engine.create_execution_context()
    if context is None:
        raise RuntimeError("TensorRT prefix context creation failed")
    engine_outputs = {
        engine.get_tensor_name(index)
        for index in range(engine.num_io_tensors)
        if engine.get_tensor_mode(engine.get_tensor_name(index)) == trt.TensorIOMode.OUTPUT
    }
    if engine_outputs != set(PREFIX_OUTPUTS):
        raise RuntimeError(f"Unexpected engine outputs: {engine_outputs}")
    for name in ("input", *PREFIX_OUTPUTS):
        if engine.get_tensor_dtype(name) != trt.float32:
            raise RuntimeError(f"Non-FP32 TensorRT tensor: {name}")
        if engine.get_tensor_location(name) != trt.TensorLocation.DEVICE:
            raise RuntimeError(f"Non-device TensorRT tensor: {name}")
        if engine.get_tensor_format(name) != trt.TensorFormat.LINEAR:
            raise RuntimeError(f"Non-linear TensorRT tensor: {name}")
        if engine.get_tensor_vectorized_dim(name) != -1:
            raise RuntimeError(f"Vectorized TensorRT tensor: {name}")

    model = onnx.load(args.model)
    bias_array = next(
        numpy_helper.to_array(item).copy()
        for item in model.graph.initializer
        if item.name == BIAS
    )
    stream = torch.cuda.Stream(device=0)
    stream_id = int(stream.cuda_stream)
    image = torch.empty((1, 3, 512, 512), dtype=torch.float32, device="cuda:0")
    feature = torch.empty((1, 128, 512, 512), dtype=torch.float32, device="cuda:0")
    weight = torch.empty((3, 128, 1, 1), dtype=torch.float32, device="cuda:0")
    previous_rgb = torch.empty((1, 3, 512, 512), dtype=torch.float32, device="cuda:0")
    repaired = torch.empty_like(previous_rgb)
    reference_output = torch.empty_like(previous_rgb)
    bias = torch.from_numpy(bias_array.astype(np.float32, copy=False)).to("cuda:0")
    addresses = {
        "input": image,
        FEATURE: feature,
        WEIGHT: weight,
        PREVIOUS_RGB: previous_rgb,
    }
    for name, tensor in addresses.items():
        if not context.set_tensor_address(name, tensor.data_ptr()):
            raise RuntimeError(f"TensorRT rejected address: {name}")

    reference = make_reference(ort, args.model, stream_id)
    binding = reference.io_binding()
    binding.bind_input("input", "cuda", 0, np.float32, tuple(image.shape), image.data_ptr())
    binding.bind_output(
        "output", "cuda", 0, np.float32, tuple(reference_output.shape), reference_output.data_ptr()
    )

    def run_repaired():
        if not context.execute_async_v3(stream_id):
            raise RuntimeError("TensorRT prefix execution failed")
        previous = torch.backends.cuda.matmul.allow_tf32
        torch.backends.cuda.matmul.allow_tf32 = True
        try:
            torch.addmm(
                bias.reshape(3, 1),
                weight.reshape(3, 128),
                feature.reshape(128, -1),
                out=repaired.reshape(3, -1),
            )
            repaired.add_(previous_rgb)
        finally:
            torch.backends.cuda.matmul.allow_tf32 = previous

    records = []
    previous_by_clip = {}
    last_fixture = None
    for path in sorted(args.input_dir.glob("*.npy")):
        captured = np.load(path, mmap_mode="r")
        for index in range(captured.shape[0]):
            fixture = np.array(captured[index : index + 1], dtype=np.float32, copy=True)
            last_fixture = fixture
            with torch.cuda.stream(stream):
                image.copy_(torch.from_numpy(fixture), non_blocking=False)
                reference.run_with_iobinding(binding)
                stream.synchronize()
                reference_cpu = reference_output.detach().cpu().numpy().copy()
                run_repaired()
                stream.synchronize()
                repaired_cpu = repaired.detach().cpu().numpy().copy()
            absolute = np.abs(repaired_cpu - reference_cpu)
            previous = previous_by_clip.get(path.stem)
            temporal = None
            if previous is not None:
                temporal = float(
                    np.mean(
                        np.abs(
                            (repaired_cpu - previous["repaired"])
                            - (reference_cpu - previous["reference"])
                        ),
                        dtype=np.float64,
                    )
                )
            previous_by_clip[path.stem] = {
                "repaired": repaired_cpu,
                "reference": reference_cpu,
            }
            records.append(
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
        image.copy_(torch.from_numpy(last_fixture), non_blocking=False)
        for _ in range(args.warmup):
            run_repaired()
        stream.synchronize()
        elapsed = []
        for _ in range(args.iterations):
            start = torch.cuda.Event(enable_timing=True)
            end = torch.cuda.Event(enable_timing=True)
            start.record(stream)
            run_repaired()
            end.record(stream)
            end.synchronize()
            elapsed.append(float(start.elapsed_time(end)))

    temporal_values = [
        item["temporalError"] for item in records if item["temporalError"] is not None
    ]
    report = {
        "schema": "pong-gpen512-split-repair-v1",
        "silent": True,
        "sourceModel": str(args.model),
        "sourceModelSha256": sha256(args.model),
        "prefixModelSha256": sha256(prefix_model),
        "plan": str(plan),
        "planSha256": sha256(plan),
        "build": build,
        "ioContract": {
            "input": "input",
            "outputs": sorted(engine_outputs),
            "allFp32DeviceLinearUnvectorized": True,
        },
        "quality": {
            "sampleCount": len(records),
            "maeMean": statistics.fmean(item["mae"] for item in records),
            "maeP95": percentile([item["mae"] for item in records], 95),
            "p99AbsMean": statistics.fmean(item["p99Abs"] for item in records),
            "p99AbsP95": percentile([item["p99Abs"] for item in records], 95),
            "maxAbs": max(item["maxAbs"] for item in records),
            "temporalErrorMean": statistics.fmean(temporal_values),
            "temporalErrorP95": percentile(temporal_values, 95),
        },
        "timing": {
            "iterations": len(elapsed),
            "p50Ms": percentile(elapsed, 50),
            "p95Ms": percentile(elapsed, 95),
            "meanMs": statistics.fmean(elapsed),
        },
        "records": records,
    }
    report_path = args.output_dir / "report.json"
    atomic_write_json(report_path, report)
    print(json.dumps({"quality": report["quality"], "timing": report["timing"]}, indent=2))
    print(f"report={report_path}")


if __name__ == "__main__":
    main()
