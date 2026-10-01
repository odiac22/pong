"""Isolated GPEN512 native TensorRT FP32 proof.

Builds a benchmark-owned TensorRT plan from the production GPEN512 ONNX graph,
with both FP16 and TF32 explicitly disabled, then compares its CUDA output and
completed-call latency with ONNX Runtime's CUDA execution provider.  The script
uses only generated tensors and never imports the production engine or config.
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import time

from benchmark_gpen_generated import (
    GATES,
    KINDS,
    bootstrap_libraries,
    generated_fixture,
    numerical_metrics,
    query_gpu,
    temporal_mae,
)


ROOT = Path(__file__).resolve().parent
DEFAULT_MODEL = ROOT / "runtime" / "models" / "GPEN-BFR-512.onnx"
DEFAULT_OUTPUT = ROOT / "benchmarks" / "gpen512-native-trt-fp32-strict"
BUILD_RECIPE_VERSION = "strict-fp32-builder-v2"
QUALITY_GATE_VERSION = "generated-gpen-v1"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write_bytes(path: Path, payload: bytes) -> None:
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    try:
        temporary.write_bytes(payload)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_write_json(path: Path, payload: dict) -> None:
    atomic_write_bytes(
        path,
        json.dumps(payload, indent=2, allow_nan=False).encode("utf-8"),
    )


def percentile(values, percent):
    ordered = sorted(values)
    position = (len(ordered) - 1) * percent / 100
    lower, upper = math.floor(position), math.ceil(position)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def timing_summary(values):
    return {
        "count": len(values),
        "meanMs": statistics.fmean(values),
        "p50Ms": percentile(values, 50),
        "p95Ms": percentile(values, 95),
        "p99Ms": percentile(values, 99),
    }


def completed_ms(torch, operation):
    torch.cuda.synchronize()
    started = time.perf_counter_ns()
    operation()
    torch.cuda.synchronize()
    return (time.perf_counter_ns() - started) / 1e6


def build_plan(
    trt,
    model: Path,
    plan: Path,
    workspace: int,
    *,
    strict_math=False,
    tactic_profile="default",
    allow_tf32=False,
    builder_optimization_level=5,
    strongly_typed=False,
    torgb_plugin=False,
    timing_cache_in=None,
    timing_cache_out=None,
    max_aux_streams=None,
):
    logger = trt.Logger(trt.Logger.WARNING)
    builder = trt.Builder(logger)
    network_flags = 1 << int(trt.NetworkDefinitionCreationFlag.EXPLICIT_BATCH)
    if strongly_typed:
        network_flags |= 1 << int(trt.NetworkDefinitionCreationFlag.STRONGLY_TYPED)
    network = builder.create_network(network_flags)
    parser = trt.OnnxParser(network, logger)
    if not parser.parse_from_file(str(model)):
        errors = [str(parser.get_error(i)) for i in range(parser.num_errors)]
        raise RuntimeError("TensorRT ONNX parse failed: " + " | ".join(errors))
    plugin_rewire = None
    if torgb_plugin:
        import pong_torgb_plugin  # noqa: F401 - registration is the side effect
        import tensorrt.plugin as trtp

        target_name = "/generator/to_rgbs.6/conv/Conv"
        matches = [
            network.get_layer(index)
            for index in range(network.num_layers)
            if network.get_layer(index).name == target_name
        ]
        if len(matches) != 1:
            raise RuntimeError(
                f"Expected one parsed final to-RGB layer, found {len(matches)}"
            )
        target = matches[0]
        original_output = target.get_output(0)
        consumers = []
        for layer_index in range(network.num_layers):
            layer = network.get_layer(layer_index)
            for input_index in range(layer.num_inputs):
                item = layer.get_input(input_index)
                if item is original_output or (
                    item is not None and item.name == original_output.name
                ):
                    consumers.append((layer, input_index))
        if len(consumers) != 1:
            raise RuntimeError(
                f"Expected one final to-RGB consumer, found {len(consumers)}"
            )
        replacement = network.add_plugin(
            trtp.op.pong.torgb_tf32(target.get_input(0), target.get_input(1)),
            aot=False,
        )
        replacement.name = "/pong/repair/torgb_tf32"
        replacement_output = replacement.get_output(0)
        replacement_output.name = "/pong/repair/torgb_tf32_output"
        consumer, input_index = consumers[0]
        consumer.set_input(input_index, replacement_output)
        plugin_rewire = {
            "target": target_name,
            "consumer": consumer.name,
            "consumerInputIndex": input_index,
            "replacement": replacement.name,
        }
    if network.num_inputs != 1 or network.num_outputs != 1:
        raise RuntimeError(
            f"Expected one runtime input/output, got {network.num_inputs}/{network.num_outputs}"
        )
    config = builder.create_builder_config()
    config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, workspace)
    config.builder_optimization_level = int(builder_optimization_level)
    if max_aux_streams is not None:
        config.max_aux_streams = int(max_aux_streams)
    config.clear_flag(trt.BuilderFlag.FP16)
    if allow_tf32:
        config.set_flag(trt.BuilderFlag.TF32)
    else:
        config.clear_flag(trt.BuilderFlag.TF32)
    config.clear_flag(trt.BuilderFlag.INT8)
    timing_cache_bytes = (
        Path(timing_cache_in).read_bytes() if timing_cache_in is not None else b""
    )
    timing_cache = config.create_timing_cache(timing_cache_bytes)
    if timing_cache is None:
        raise RuntimeError("TensorRT failed to create the editable timing cache")
    if not config.set_timing_cache(timing_cache, ignore_mismatch=False):
        raise RuntimeError("TensorRT rejected the supplied timing cache")
    if tactic_profile == "cudnn":
        tactic_sources = sum(
            1 << int(source)
            for source in (
                trt.TacticSource.CUBLAS,
                trt.TacticSource.CUBLAS_LT,
                trt.TacticSource.CUDNN,
            )
        )
        config.set_tactic_sources(tactic_sources)
    elif tactic_profile == "all":
        tactic_sources = sum(
            1 << int(source)
            for source in (
                trt.TacticSource.CUBLAS,
                trt.TacticSource.CUBLAS_LT,
                trt.TacticSource.CUDNN,
                trt.TacticSource.EDGE_MASK_CONVOLUTIONS,
                trt.TacticSource.JIT_CONVOLUTIONS,
            )
        )
        config.set_tactic_sources(tactic_sources)
    constrained_layers = 0
    constrained_outputs = 0
    constraint_failures = []
    if strict_math:
        config.set_flag(trt.BuilderFlag.OBEY_PRECISION_CONSTRAINTS)
        config.set_flag(trt.BuilderFlag.STRICT_NANS)
        for index in range(network.num_layers):
            layer = network.get_layer(index)
            inputs = [layer.get_input(i) for i in range(layer.num_inputs)]
            outputs = [layer.get_output(i) for i in range(layer.num_outputs)]
            # Shape/constant/index layers legitimately use integer tensors.
            # Constrain only the floating data path; forcing an INT64 constant
            # to FP32 is invalid and does not strengthen image arithmetic.
            if not any(item is not None and item.dtype == trt.float32 for item in inputs):
                continue
            if any(item is not None and item.dtype != trt.float32 for item in outputs):
                continue
            try:
                layer.precision = trt.float32
                constrained_layers += 1
            except (AttributeError, RuntimeError) as exc:
                constraint_failures.append(
                    f"layer[{index}].precision: {type(exc).__name__}: {exc}"
                )
            for output_index in range(layer.num_outputs):
                output = outputs[output_index]
                if output is None or output.dtype != trt.float32:
                    continue
                try:
                    layer.set_output_type(output_index, trt.float32)
                    constrained_outputs += 1
                except (AttributeError, RuntimeError) as exc:
                    constraint_failures.append(
                        f"layer[{index}].output[{output_index}]: "
                        f"{type(exc).__name__}: {exc}"
                    )
        if constraint_failures:
            raise RuntimeError(
                "TensorRT rejected strict FP32 constraints: "
                + " | ".join(constraint_failures[:8])
            )
    started = time.perf_counter_ns()
    serialized = builder.build_serialized_network(network, config)
    build_ms = (time.perf_counter_ns() - started) / 1e6
    if serialized is None:
        raise RuntimeError("TensorRT failed to build GPEN512")
    serialized_timing_cache = bytes(config.get_timing_cache().serialize())
    if timing_cache_out is not None:
        Path(timing_cache_out).parent.mkdir(parents=True, exist_ok=True)
        atomic_write_bytes(Path(timing_cache_out), serialized_timing_cache)
    plan.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_bytes(plan, bytes(serialized))
    metadata = {
        "buildMs": build_ms,
        "input": network.get_input(0).name,
        "output": network.get_output(0).name,
        "fp16": bool(config.get_flag(trt.BuilderFlag.FP16)),
        "tf32": bool(config.get_flag(trt.BuilderFlag.TF32)),
        "int8": bool(config.get_flag(trt.BuilderFlag.INT8)),
        "workspaceBytes": workspace,
        "strictMath": bool(strict_math),
        "allowTf32": bool(allow_tf32),
        "stronglyTyped": bool(strongly_typed),
        "torgbPlugin": bool(torgb_plugin),
        "pluginRewire": plugin_rewire,
        "tacticProfile": tactic_profile,
        "tacticSourcesMask": int(config.get_tactic_sources()),
        "builderOptimizationLevel": int(builder_optimization_level),
        "maxAuxStreamsOverride": max_aux_streams,
        "externalPlan": False,
        "timingCacheInputSha256": (
            hashlib.sha256(timing_cache_bytes).hexdigest()
            if timing_cache_bytes else None
        ),
        "timingCacheOutputSha256": hashlib.sha256(
            serialized_timing_cache
        ).hexdigest(),
        "obeyPrecisionConstraints": bool(
            config.get_flag(trt.BuilderFlag.OBEY_PRECISION_CONSTRAINTS)
        ),
        "strictNans": bool(config.get_flag(trt.BuilderFlag.STRICT_NANS)),
        "constrainedLayers": constrained_layers,
        "constrainedOutputs": constrained_outputs,
        "constraintFailures": constraint_failures,
        "buildRecipeVersion": BUILD_RECIPE_VERSION,
    }
    del serialized, config, parser, network, builder
    gc.collect()
    return metadata


def load_native_engine(trt, plan_bytes: bytes):
    logger = trt.Logger(trt.Logger.WARNING)
    runtime = trt.Runtime(logger)
    engine = runtime.deserialize_cuda_engine(plan_bytes)
    if engine is None:
        raise RuntimeError("TensorRT plan deserialization failed")
    context = engine.create_execution_context()
    if context is None:
        raise RuntimeError("TensorRT execution-context creation failed")
    tensors = []
    for index in range(engine.num_io_tensors):
        name = engine.get_tensor_name(index)
        tensors.append({
            "name": name,
            "mode": str(engine.get_tensor_mode(name)),
            "dtype": str(engine.get_tensor_dtype(name)),
            "shape": list(engine.get_tensor_shape(name)),
        })
    return runtime, engine, context, tensors


def make_ort_reference(ort, stream_id, model: Path, use_tf32=None):
    options = ort.SessionOptions()
    options.log_severity_level = 3
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.inter_op_num_threads = 1
    options.intra_op_num_threads = max(2, min(8, (os.cpu_count() or 4) // 2))
    cuda_options = {
        "arena_extend_strategy": "kSameAsRequested",
        "cudnn_conv_algo_search": "EXHAUSTIVE",
        "user_compute_stream": str(stream_id),
    }
    # Keep the production-reference behavior unchanged when this is omitted.
    # Benchmarks may set it explicitly to establish whether ORT's implicit
    # CUDA-EP math policy is part of the frozen reference contract.
    if use_tf32 is not None:
        cuda_options["use_tf32"] = "1" if bool(use_tf32) else "0"
    session = ort.InferenceSession(
        str(model), sess_options=options,
        providers=[("CUDAExecutionProvider", cuda_options)],
    )
    session.disable_fallback()
    if session.get_providers()[0] != "CUDAExecutionProvider":
        raise RuntimeError("CUDA reference provider was not activated")
    return session


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--existing-plan",
        type=Path,
        help="Qualify these exact immutable TensorRT engine bytes without rebuilding.",
    )
    parser.add_argument("--workspace-bytes", type=int, default=1 << 30)
    parser.add_argument("--edge", type=int, choices=(512, 1024), default=512)
    parser.add_argument("--iterations", type=int, default=64)
    parser.add_argument("--warmup", type=int, default=12)
    parser.add_argument("--fixture-steps", type=int, default=2)
    parser.add_argument("--rebuild", action="store_true")
    parser.add_argument("--strict-math", action="store_true")
    parser.add_argument(
        "--tactic-profile",
        choices=("default", "cudnn", "all"),
        default="default",
    )
    parser.add_argument("--allow-tf32", action="store_true")
    parser.add_argument(
        "--builder-optimization-level",
        type=int,
        choices=range(0, 6),
        default=5,
    )
    parser.add_argument("--strongly-typed", action="store_true")
    parser.add_argument("--torgb-plugin", action="store_true")
    parser.add_argument("--timing-cache-in", type=Path)
    parser.add_argument("--timing-cache-out", type=Path)
    args = parser.parse_args()
    if args.edge != 512 and args.torgb_plugin:
        raise ValueError("The toRGB plugin is qualified for GPEN512 only")
    if args.iterations < 8 or args.warmup < 1 or args.fixture_steps < 2:
        raise ValueError("Benchmark sample counts are too small")
    args.model = args.model.resolve()
    args.output_dir = args.output_dir.resolve()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    if args.existing_plan is not None:
        args.existing_plan = args.existing_plan.resolve()
        if not args.existing_plan.is_file():
            raise FileNotFoundError(args.existing_plan)
        if args.rebuild:
            raise ValueError("--existing-plan and --rebuild are mutually exclusive")
    if args.workspace_bytes <= 0:
        raise ValueError("--workspace-bytes must be positive")
    if args.timing_cache_in is not None:
        args.timing_cache_in = args.timing_cache_in.resolve()
        if not args.timing_cache_in.is_file():
            raise FileNotFoundError(args.timing_cache_in)
    if args.timing_cache_out is not None:
        args.timing_cache_out = args.timing_cache_out.resolve()
    if not args.model.is_file():
        raise FileNotFoundError(args.model)

    gpu_before = query_gpu()
    np, torch, ort, dll_handles = bootstrap_libraries(enable_tensorrt=True)
    del dll_handles
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA unavailable")
    torch.cuda.set_device(0)
    import tensorrt as trt

    model_hash = sha256(args.model)
    identity = {
        "schema": 2,
        "buildRecipeVersion": BUILD_RECIPE_VERSION,
        "qualityGateVersion": QUALITY_GATE_VERSION,
        "modelSha256": model_hash,
        "edge": args.edge,
        "tensorrt": trt.__version__,
        "cuda": torch.version.cuda,
        "gpu": torch.cuda.get_device_name(0),
        "capability": list(torch.cuda.get_device_capability(0)),
        "fp16": False,
        "tf32": bool(args.allow_tf32),
        "int8": False,
        "workspaceBytes": int(args.workspace_bytes),
        "builderOptimizationLevel": int(args.builder_optimization_level),
        "strictMath": bool(args.strict_math),
        "tacticProfile": str(args.tactic_profile),
        "stronglyTyped": bool(args.strongly_typed),
        "torgbPlugin": bool(args.torgb_plugin),
        "timingCacheInputSha256": (
            sha256(args.timing_cache_in)
            if args.timing_cache_in is not None else None
        ),
    }
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:20]
    precision_label = "tf32" if args.allow_tf32 else "notf32"
    plan = (
        args.existing_plan
        if args.existing_plan is not None
        else args.output_dir / f"gpen{args.edge}-fp32-{precision_label}-{key}.plan"
    )
    build = None
    if args.existing_plan is not None:
        build = {
            "input": "input",
            "output": "output",
            "fp16": False,
            "tf32": bool(args.allow_tf32),
            "int8": False,
            "workspaceBytes": int(identity["workspaceBytes"]),
            "strictMath": bool(args.strict_math),
            "allowTf32": bool(args.allow_tf32),
            "stronglyTyped": bool(args.strongly_typed),
            "torgbPlugin": bool(args.torgb_plugin),
            "tacticProfile": str(args.tactic_profile),
            "builderOptimizationLevel": int(args.builder_optimization_level),
            "buildRecipeVersion": BUILD_RECIPE_VERSION,
            "externalPlan": True,
        }
    elif args.rebuild or not plan.is_file():
        build = build_plan(
            trt,
            args.model,
            plan,
            identity["workspaceBytes"],
            strict_math=args.strict_math,
            tactic_profile=args.tactic_profile,
            allow_tf32=args.allow_tf32,
            builder_optimization_level=args.builder_optimization_level,
            strongly_typed=args.strongly_typed,
            torgb_plugin=args.torgb_plugin,
            timing_cache_in=args.timing_cache_in,
            timing_cache_out=args.timing_cache_out,
        )
    manifest_path = plan.with_suffix(plan.suffix + ".manifest.json")
    prior_manifest = None
    if manifest_path.is_file():
        try:
            prior_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            prior_manifest = None
    if build is None and isinstance(prior_manifest, dict):
        if prior_manifest.get("planSha256") == sha256(plan):
            prior_build = prior_manifest.get("build")
            if isinstance(prior_build, dict):
                build = prior_build
    if build is None:
        raise RuntimeError(
            "Existing TensorRT plan has no verified build provenance; use "
            "--rebuild or provide it explicitly with --existing-plan and the "
            "matching build-policy arguments."
        )
    # A qualification sidecar is a pass certificate, not mutable build input.
    # Remove any stale certificate before running the tests and publish a new
    # one atomically only after every numerical and speed gate succeeds.
    manifest_path.unlink(missing_ok=True)
    plan_bytes = plan.read_bytes()
    plan_sha256 = hashlib.sha256(plan_bytes).hexdigest()

    runtime, engine, context, tensors = load_native_engine(trt, plan_bytes)
    tensor_by_mode = {entry["mode"]: entry for entry in tensors}
    input_name = next(
        entry["name"] for entry in tensors if "INPUT" in entry["mode"].upper()
    )
    output_name = next(
        entry["name"] for entry in tensors if "OUTPUT" in entry["mode"].upper()
    )
    expected_shape = (1, 3, args.edge, args.edge)
    if tuple(engine.get_tensor_shape(input_name)) != expected_shape:
        raise RuntimeError(f"Unexpected TensorRT input shape {engine.get_tensor_shape(input_name)}")
    if tuple(engine.get_tensor_shape(output_name)) != expected_shape:
        raise RuntimeError(f"Unexpected TensorRT output shape {engine.get_tensor_shape(output_name)}")

    stream = torch.cuda.Stream(device=0)
    stream_id = int(stream.cuda_stream)
    image = torch.empty(expected_shape, dtype=torch.float32, device="cuda:0")
    native_output = torch.empty_like(image)
    reference_output = torch.empty_like(image)
    if not context.set_tensor_address(input_name, image.data_ptr()):
        raise RuntimeError("TensorRT rejected input address")
    if not context.set_tensor_address(output_name, native_output.data_ptr()):
        raise RuntimeError("TensorRT rejected output address")

    reference = make_ort_reference(ort, stream_id, args.model)
    reference_binding = reference.io_binding()
    reference_binding.bind_input(
        "input", "cuda", 0, np.float32, expected_shape, image.data_ptr()
    )
    reference_binding.bind_output(
        "output", "cuda", 0, np.float32, expected_shape, reference_output.data_ptr()
    )

    def run_native():
        if not context.execute_async_v3(stream_id):
            raise RuntimeError("TensorRT execute_async_v3 failed")

    def run_reference():
        reference.run_with_iobinding(reference_binding)

    fixtures = []
    previous_by_kind = {}
    for kind in KINDS:
        for step in range(args.fixture_steps):
            fixture = torch.from_numpy(generated_fixture(np, kind, step, edge=args.edge)).to("cuda:0")
            with torch.cuda.stream(stream):
                image.copy_(fixture)
                run_reference()
                stream.synchronize()
                ref_cpu = reference_output.detach().cpu().numpy().copy()
                run_native()
                stream.synchronize()
                native_cpu = native_output.detach().cpu().numpy().copy()
            metrics = numerical_metrics(np, ref_cpu, native_cpu)
            previous = previous_by_kind.get(kind)
            if previous is not None:
                metrics["temporalMae"] = temporal_mae(
                    np, previous[0], ref_cpu, previous[1], native_cpu
                )
                metrics["temporalPass"] = metrics["temporalMae"] <= GATES["temporalMae"]
            previous_by_kind[kind] = (ref_cpu, native_cpu)
            fixtures.append({"kind": kind, "step": step, **metrics})

    timing_input = torch.from_numpy(generated_fixture(np, "noise", 7, edge=args.edge)).to("cuda:0")
    with torch.cuda.stream(stream):
        image.copy_(timing_input)
        for _ in range(args.warmup):
            run_reference()
        stream.synchronize()
        reference_times = [completed_ms(torch, run_reference) for _ in range(args.iterations)]
        for _ in range(args.warmup):
            run_native()
        stream.synchronize()
        native_times = [completed_ms(torch, run_native) for _ in range(args.iterations)]

    reference_summary = timing_summary(reference_times)
    native_summary = timing_summary(native_times)
    all_quality_pass = all(
        item.get("pass", False) and item.get("temporalPass", True) for item in fixtures
    )
    report = {
        "schema": 1,
        "status": "pass" if all_quality_pass and native_summary["p50Ms"] < reference_summary["p50Ms"] else "fail",
        "identity": identity,
        "model": str(args.model),
        "plan": str(plan),
        "planSha256": plan_sha256,
        "planManifest": str(manifest_path),
        "planBytes": plan.stat().st_size,
        "build": build,
        "engineTensors": tensors,
        "unusedTensorModeIndex": sorted(tensor_by_mode),
        "reference": {"backend": "onnxruntime-cuda", **reference_summary},
        "candidate": {
            "backend": (
                "native-tensorrt-fp32-tf32"
                if args.allow_tf32 else "native-tensorrt-fp32-no-tf32"
            ),
            **native_summary,
        },
        "speedup": {
            "meanPercent": 100 * (1 - native_summary["meanMs"] / reference_summary["meanMs"]),
            "p50Percent": 100 * (1 - native_summary["p50Ms"] / reference_summary["p50Ms"]),
            "p95Percent": 100 * (1 - native_summary["p95Ms"] / reference_summary["p95Ms"]),
        },
        "qualityPass": all_quality_pass,
        "qualityGates": GATES,
        "fixtures": fixtures,
        "gpuBefore": gpu_before,
        "gpuAfter": query_gpu(),
    }
    report_path = args.output_dir / "report.json"
    atomic_write_json(report_path, report)
    if report["status"] == "pass":
        if sha256(plan) != plan_sha256:
            raise RuntimeError(
                "TensorRT plan changed during qualification; no manifest was published"
            )
        plan_manifest = {
            "schema": "pong-gpen-qualified-plan-v2",
            "qualificationStatus": "pass",
            "qualityGateVersion": QUALITY_GATE_VERSION,
            "buildRecipeVersion": BUILD_RECIPE_VERSION,
            "plan": str(plan),
            "planSha256": plan_sha256,
            "report": str(report_path),
            "reportSha256": sha256(report_path),
            "modelSha256": model_hash,
            "edge": args.edge,
            "tensorrt": trt.__version__,
            "cuda": torch.version.cuda,
            "gpu": torch.cuda.get_device_name(0),
            "capability": list(torch.cuda.get_device_capability(0)),
            "precisionPolicy": (
                "strict-fp32-constraints-v1" if args.strict_math
                else "fp32-builder-default-v1"
            ),
            "fp16": False,
            "tf32": bool(args.allow_tf32),
            "int8": False,
            "strictMath": bool(args.strict_math),
            "tacticProfile": str(args.tactic_profile),
            "builderOptimizationLevel": int(args.builder_optimization_level),
            "workspaceBytes": int(identity["workspaceBytes"]),
            "build": build,
        }
        atomic_write_json(manifest_path, plan_manifest)
    print(json.dumps({
        "status": report["status"],
        "qualityPass": all_quality_pass,
        "reference": reference_summary,
        "candidate": native_summary,
        "speedup": report["speedup"],
        "report": str(args.output_dir / "report.json"),
    }, indent=2))
    if report["status"] != "pass":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
