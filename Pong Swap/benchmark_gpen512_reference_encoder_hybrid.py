"""Benchmark an exact CUDA encoder feeding a TensorRT GPEN512 generator.

The split follows every data-dependent edge from the encoder into the
generator (latent plus eight encoder feature maps).  It is analysis-only: it
uses captured silent benchmark tensors, writes only benchmark artifacts, and
does not alter production plans or settings.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import statistics
import time

import onnx

from benchmark_gpen_generated import bootstrap_libraries
from benchmark_gpen512_native_trt import (
    atomic_write_bytes,
    load_native_engine,
    make_ort_reference,
    sha256,
)


ROOT = Path(__file__).resolve().parent
DEFAULT_MODEL = ROOT / "runtime" / "models" / "GPEN-BFR-512.onnx"
DEFAULT_PLAN = (
    ROOT / "runtime" / "models" / "ort_trt_cache_gpen512"
    / "native-fp32-tf32-v1" / "gpen512-f5b1b141086ab85ba280.plan"
)
DEFAULT_INPUTS = ROOT / "benchmarks" / "gpen512-calibration-inputs"
DEFAULT_OUTPUT = ROOT / "benchmarks" / "gpen512-reference-encoder-hybrid-v1"
GENERATOR_START = 276


def percentile(values, percent):
    ordered = sorted(float(value) for value in values)
    position = (len(ordered) - 1) * float(percent) / 100.0
    lower, upper = math.floor(position), math.ceil(position)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def timing(values):
    return {
        "count": len(values),
        "meanMs": statistics.fmean(values),
        "p50Ms": percentile(values, 50),
        "p95Ms": percentile(values, 95),
    }


def metrics(reference, candidate):
    absolute = abs(candidate.astype("float64") - reference.astype("float64"))
    return {
        "mae": float(absolute.mean()),
        "p99Abs": float(percentile(absolute.reshape(-1), 99)),
        "maxAbs": float(absolute.max()),
    }


def temporal_error(reference, candidate):
    if len(reference) < 2:
        return 0.0
    return float(abs(
        reference[1:].astype("float64") - reference[:-1].astype("float64")
        - candidate[1:].astype("float64") + candidate[:-1].astype("float64")
    ).mean())


def dynamic_encoder_boundaries(model):
    nodes = list(model.graph.node)
    produced_at = {
        output: index
        for index, node in enumerate(nodes)
        for output in node.output
    }
    input_dependent = {"input"}
    for node in nodes[:GENERATOR_START]:
        if any(value in input_dependent for value in node.input):
            input_dependent.update(node.output)
    boundaries = []
    for node in nodes[GENERATOR_START:]:
        for value in node.input:
            producer = produced_at.get(value)
            if (
                producer is not None
                and producer < GENERATOR_START
                and value in input_dependent
                and value not in boundaries
            ):
                boundaries.append(value)
    return boundaries


def extract_partition(model_path, prefix_path, suffix_path):
    model = onnx.load(model_path)
    boundaries = dynamic_encoder_boundaries(model)
    if len(boundaries) != 9:
        raise RuntimeError(f"Expected nine dynamic split tensors, found {boundaries}")
    prefix_path.parent.mkdir(parents=True, exist_ok=True)
    onnx.utils.extract_model(
        str(model_path), str(prefix_path), ["input"], boundaries, check_model=True
    )
    onnx.utils.extract_model(
        str(model_path), str(suffix_path), boundaries, ["output"], check_model=True
    )
    return boundaries


def build_suffix_plan(trt, suffix_path, plan_path, *, optimization_level, workspace_bytes):
    logger = trt.Logger(trt.Logger.WARNING)
    builder = trt.Builder(logger)
    network = builder.create_network(
        1 << int(trt.NetworkDefinitionCreationFlag.EXPLICIT_BATCH)
    )
    parser = trt.OnnxParser(network, logger)
    if not parser.parse_from_file(str(suffix_path)):
        errors = [str(parser.get_error(i)) for i in range(parser.num_errors)]
        raise RuntimeError("TensorRT suffix parse failed: " + " | ".join(errors))
    config = builder.create_builder_config()
    config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, int(workspace_bytes))
    config.builder_optimization_level = int(optimization_level)
    config.clear_flag(trt.BuilderFlag.FP16)
    config.set_flag(trt.BuilderFlag.TF32)
    config.clear_flag(trt.BuilderFlag.INT8)
    started = time.perf_counter_ns()
    serialized = builder.build_serialized_network(network, config)
    build_ms = (time.perf_counter_ns() - started) / 1e6
    if serialized is None:
        raise RuntimeError("TensorRT failed to build the generator suffix")
    atomic_write_bytes(plan_path, bytes(serialized))
    return {
        "buildMs": build_ms,
        "builderOptimizationLevel": int(optimization_level),
        "workspaceBytes": int(workspace_bytes),
        "inputs": [network.get_input(i).name for i in range(network.num_inputs)],
        "outputs": [network.get_output(i).name for i in range(network.num_outputs)],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--native-plan", type=Path, default=DEFAULT_PLAN)
    parser.add_argument("--inputs", type=Path, default=DEFAULT_INPUTS)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--iterations", type=int, default=60)
    parser.add_argument("--warmup", type=int, default=12)
    parser.add_argument("--builder-optimization-level", type=int, choices=range(0, 6), default=5)
    parser.add_argument("--workspace-mib", type=int, default=3072)
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    prefix_path = args.output_dir / "gpen512-reference-encoder.onnx"
    suffix_path = args.output_dir / "gpen512-native-generator.onnx"
    plan_path = args.output_dir / "gpen512-native-generator-fp32-tf32.plan"
    boundaries = extract_partition(args.model, prefix_path, suffix_path)

    np, torch, ort, handles = bootstrap_libraries(enable_tensorrt=True)
    del handles
    torch.cuda.set_device(0)
    import tensorrt as trt

    build = None
    if args.rebuild or not plan_path.is_file():
        build = build_suffix_plan(
            trt,
            suffix_path,
            plan_path,
            optimization_level=args.builder_optimization_level,
            workspace_bytes=max(256, int(args.workspace_mib)) << 20,
        )
    suffix_runtime, suffix_engine, suffix_context, suffix_tensors = load_native_engine(
        trt, plan_path
    )
    native_runtime, native_engine, native_context, native_tensors = load_native_engine(
        trt, args.native_plan
    )
    stream = torch.cuda.Stream(device=0)
    stream_id = int(stream.cuda_stream)
    source = torch.empty((1, 3, 512, 512), dtype=torch.float32, device="cuda:0")
    reference_output = torch.empty_like(source)
    native_output = torch.empty_like(source)
    hybrid_output = torch.empty_like(source)

    prefix = make_ort_reference(ort, stream_id, prefix_path)
    prefix_binding = prefix.io_binding()
    prefix_binding.bind_input(
        "input", "cuda", 0, np.float32, tuple(source.shape), source.data_ptr()
    )
    boundary_tensors = {}
    for output in prefix.get_outputs():
        shape = tuple(int(value) for value in output.shape)
        tensor = torch.empty(shape, dtype=torch.float32, device="cuda:0")
        boundary_tensors[output.name] = tensor
        prefix_binding.bind_output(
            output.name, "cuda", 0, np.float32, shape, tensor.data_ptr()
        )
    for name in boundaries:
        if name not in boundary_tensors:
            raise RuntimeError(f"Prefix did not expose {name}")
        if not suffix_context.set_tensor_address(name, boundary_tensors[name].data_ptr()):
            raise RuntimeError(f"TensorRT rejected suffix input {name}")
    suffix_output_name = next(
        item["name"] for item in suffix_tensors if "OUTPUT" in item["mode"].upper()
    )
    if not suffix_context.set_tensor_address(suffix_output_name, hybrid_output.data_ptr()):
        raise RuntimeError("TensorRT rejected hybrid output")

    native_input_name = next(
        item["name"] for item in native_tensors if "INPUT" in item["mode"].upper()
    )
    native_output_name = next(
        item["name"] for item in native_tensors if "OUTPUT" in item["mode"].upper()
    )
    native_context.set_tensor_address(native_input_name, source.data_ptr())
    native_context.set_tensor_address(native_output_name, native_output.data_ptr())
    reference = make_ort_reference(ort, stream_id, args.model)
    reference_binding = reference.io_binding()
    reference_binding.bind_input(
        "input", "cuda", 0, np.float32, tuple(source.shape), source.data_ptr()
    )
    reference_binding.bind_output(
        "output", "cuda", 0, np.float32, tuple(source.shape), reference_output.data_ptr()
    )

    def run_reference():
        reference.run_with_iobinding(reference_binding)

    def run_native():
        if not native_context.execute_async_v3(stream_id):
            raise RuntimeError("Native TensorRT execution failed")

    def run_hybrid():
        prefix.run_with_iobinding(prefix_binding)
        if not suffix_context.execute_async_v3(stream_id):
            raise RuntimeError("Generator TensorRT execution failed")

    captures = sorted(args.inputs.glob("*-gpen-inputs-f32.npy"))
    reference_sequences = []
    native_sequences = []
    hybrid_sequences = []
    records = []
    with torch.cuda.stream(stream), torch.inference_mode():
        for capture in captures:
            values = np.load(capture, allow_pickle=False)
            refs, natives, hybrids = [], [], []
            for index, value in enumerate(values):
                source.copy_(torch.from_numpy(value).to(device="cuda:0"))
                run_reference(); stream.synchronize()
                ref = reference_output[0].cpu().numpy().copy()
                run_native(); stream.synchronize()
                native = native_output[0].cpu().numpy().copy()
                run_hybrid(); stream.synchronize()
                hybrid = hybrid_output[0].cpu().numpy().copy()
                refs.append(ref); natives.append(native); hybrids.append(hybrid)
                records.append({
                    "clip": capture.stem,
                    "index": index,
                    "native": metrics(ref, native),
                    "hybrid": metrics(ref, hybrid),
                })
            reference_sequences.append(np.stack(refs))
            native_sequences.append(np.stack(natives))
            hybrid_sequences.append(np.stack(hybrids))

        timing_value = np.load(captures[0], allow_pickle=False)[0]
        source.copy_(torch.from_numpy(timing_value).to(device="cuda:0"))
        for _ in range(args.warmup):
            run_reference(); run_native(); run_hybrid()
        stream.synchronize()
        timings = {"reference": [], "native": [], "hybrid": []}
        for _ in range(args.iterations):
            for name, operation in (
                ("reference", run_reference),
                ("native", run_native),
                ("hybrid", run_hybrid),
            ):
                stream.synchronize()
                started = time.perf_counter_ns()
                operation()
                stream.synchronize()
                timings[name].append((time.perf_counter_ns() - started) / 1e6)

    native_mae = [item["native"]["mae"] for item in records]
    hybrid_mae = [item["hybrid"]["mae"] for item in records]
    report = {
        "schema": "pong-gpen512-reference-encoder-hybrid-v1",
        "silent": True,
        "modelSha256": sha256(args.model),
        "nativePlanSha256": sha256(args.native_plan),
        "suffixPlanSha256": sha256(plan_path),
        "boundaries": boundaries,
        "build": build,
        "samples": len(records),
        "summary": {
            "nativeMaeMean": statistics.fmean(native_mae),
            "nativeMaeP95": percentile(native_mae, 95),
            "hybridMaeMean": statistics.fmean(hybrid_mae),
            "hybridMaeP95": percentile(hybrid_mae, 95),
            "hybridMaeReductionPercent": 100.0 * (
                1.0 - statistics.fmean(hybrid_mae) / statistics.fmean(native_mae)
            ),
            "nativeTemporalErrorMean": statistics.fmean(
                temporal_error(ref, native)
                for ref, native in zip(reference_sequences, native_sequences)
            ),
            "hybridTemporalErrorMean": statistics.fmean(
                temporal_error(ref, hybrid)
                for ref, hybrid in zip(reference_sequences, hybrid_sequences)
            ),
        },
        "timing": {name: timing(values) for name, values in timings.items()},
        "records": records,
    }
    report_path = args.output_dir / "report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({
        "report": str(report_path),
        "summary": report["summary"],
        "timing": report["timing"],
    }, indent=2))

    del prefix_binding, prefix, reference_binding, reference
    del suffix_context, suffix_engine, suffix_runtime
    del native_context, native_engine, native_runtime
    torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
