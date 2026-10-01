"""Localize consequential TensorRT/ORT drift at natural GPEN512 boundaries.

This is an analysis-only tool.  It clones the frozen ONNX graph, exposes a
small set of existing tensors as additional outputs, builds a benchmark-owned
TensorRT plan, and compares those outputs with ONNX Runtime CUDA on identical
captured inputs.  It does not import or modify the production engine, plan,
configuration, presets, or approved-face inventory.
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

from benchmark_gpen_generated import bootstrap_libraries
from benchmark_gpen512_native_trt import atomic_write_bytes, atomic_write_json


ROOT = Path(__file__).resolve().parent
DEFAULT_MODEL = ROOT / "runtime" / "models" / "GPEN-BFR-512.onnx"
DEFAULT_INPUTS = ROOT / "benchmarks" / "gpen512-calibration-inputs"
DEFAULT_OUTPUT = ROOT / "benchmarks" / "gpen512-boundary-localization-v1"

ALL_BOUNDARIES = (
    ("encoder-latent", "/final_linear/final_linear.0/Mul_output_0"),
    ("style-latent", "/generator/style/style.8/Mul_output_0"),
    ("rgb-4", "/generator/to_rgb1/Add_output_0"),
    ("rgb-8", "/generator/to_rgbs.0/Add_1_output_0"),
    ("rgb-16", "/generator/to_rgbs.1/Add_1_output_0"),
    ("rgb-32", "/generator/to_rgbs.2/Add_1_output_0"),
    ("rgb-64", "/generator/to_rgbs.3/Add_1_output_0"),
    ("rgb-128", "/generator/to_rgbs.4/Add_1_output_0"),
    ("rgb-256", "/generator/to_rgbs.5/Add_1_output_0"),
    ("rgb-512", "output"),
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def percentile(values, percent):
    ordered = sorted(values)
    if not ordered:
        return 0.0
    position = (len(ordered) - 1) * percent / 100.0
    lower, upper = math.floor(position), math.ceil(position)
    return float(
        ordered[lower]
        + (ordered[upper] - ordered[lower]) * (position - lower)
    )


def clone_with_outputs(
    source: Path,
    destination: Path,
    boundaries: tuple[tuple[str, str], ...],
) -> dict[str, list[int]]:
    model = onnx.load(source)
    inferred = onnx.shape_inference.infer_shapes(model)
    value_info = {
        value.name: value
        for value in (
            list(inferred.graph.value_info)
            + list(inferred.graph.input)
            + list(inferred.graph.output)
        )
    }
    shapes: dict[str, list[int]] = {}
    for _label, name in boundaries:
        if name not in value_info:
            raise KeyError(f"Boundary tensor not found in inferred graph: {name}")
        tensor_type = value_info[name].type.tensor_type
        shape = []
        for dimension in tensor_type.shape.dim:
            if not dimension.dim_value:
                raise ValueError(f"Boundary tensor has a dynamic shape: {name}")
            shape.append(int(dimension.dim_value))
        shapes[name] = shape
    if len(boundaries) == 1:
        # TensorRT 10.16 can crash while compiling the full GPEN graph when
        # internal tensors are added as extra outputs.  A one-output prefix is
        # both smaller and closer to the normal production I/O contract.
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(destination.suffix + f".{os.getpid()}.tmp")
        try:
            onnx.utils.extract_model(
                str(source),
                str(temporary),
                ["input"],
                [boundaries[0][1]],
                check_model=True,
            )
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)
        return shapes

    existing = {value.name for value in model.graph.output}
    for _label, name in boundaries:
        if name not in existing:
            model.graph.output.append(value_info[name])
            existing.add(name)
    onnx.checker.check_model(model)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + f".{os.getpid()}.tmp")
    try:
        onnx.save(model, temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return shapes


def build_plan(
    trt,
    model: Path,
    destination: Path,
    workspace_bytes: int,
    boundaries: tuple[tuple[str, str], ...],
    builder_optimization_level: int = 5,
) -> dict:
    logger = trt.Logger(trt.Logger.WARNING)
    builder = trt.Builder(logger)
    network = builder.create_network(
        1 << int(trt.NetworkDefinitionCreationFlag.EXPLICIT_BATCH)
    )
    parser = trt.OnnxParser(network, logger)
    if not parser.parse_from_file(str(model)):
        errors = [str(parser.get_error(index)) for index in range(parser.num_errors)]
        raise RuntimeError("TensorRT ONNX parse failed: " + " | ".join(errors))
    if network.num_inputs != 1:
        raise RuntimeError(f"Expected one runtime input, found {network.num_inputs}")
    expected_outputs = {name for _label, name in boundaries}
    actual_outputs = {
        network.get_output(index).name for index in range(network.num_outputs)
    }
    if expected_outputs != actual_outputs:
        raise RuntimeError(
            f"Unexpected diagnostic outputs: expected={sorted(expected_outputs)} "
            f"actual={sorted(actual_outputs)}"
        )
    config = builder.create_builder_config()
    config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, workspace_bytes)
    config.builder_optimization_level = int(builder_optimization_level)
    config.clear_flag(trt.BuilderFlag.FP16)
    config.set_flag(trt.BuilderFlag.TF32)
    config.clear_flag(trt.BuilderFlag.INT8)
    if hasattr(trt.BuilderFlag, "VERSION_COMPATIBLE"):
        config.clear_flag(trt.BuilderFlag.VERSION_COMPATIBLE)
    started = time.perf_counter_ns()
    serialized = builder.build_serialized_network(network, config)
    build_ms = (time.perf_counter_ns() - started) / 1e6
    if serialized is None:
        raise RuntimeError("TensorRT failed to build the diagnostic plan")
    destination.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_bytes(destination, bytes(serialized))
    return {
        "buildMs": build_ms,
        "workspaceBytes": workspace_bytes,
        "builderOptimizationLevel": int(builder_optimization_level),
        "tf32": True,
        "fp16": False,
        "outputs": sorted(actual_outputs),
    }


def make_ort_session(ort, model: Path, stream_id: int):
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
    if session.get_providers()[0] != "CUDAExecutionProvider":
        raise RuntimeError("CUDA reference provider was not activated")
    return session


def summarize_records(
    np,
    records: list[dict],
    boundaries: tuple[tuple[str, str], ...],
) -> dict:
    summary = {}
    for label, name in boundaries:
        items = [record["outputs"][name] for record in records]
        temporal = []
        previous_by_clip = {}
        for record, item in zip(records, items):
            previous = previous_by_clip.get(record["clip"])
            if previous is not None:
                temporal.append(
                    float(
                        np.mean(
                            np.abs(
                                (item["native"] - previous["native"])
                                - (item["reference"] - previous["reference"])
                            ),
                            dtype=np.float64,
                        )
                    )
                )
            previous_by_clip[record["clip"]] = item
        maes = [item["mae"] for item in items]
        p99s = [item["p99Abs"] for item in items]
        relatives = [item["relativeL2"] for item in items]
        summary[label] = {
            "tensor": name,
            "shape": list(items[0]["reference"].shape),
            "sampleCount": len(items),
            "maeMean": statistics.fmean(maes),
            "maeP95": percentile(maes, 95),
            "p99AbsMean": statistics.fmean(p99s),
            "p99AbsP95": percentile(p99s, 95),
            "maxAbs": max(item["maxAbs"] for item in items),
            "relativeL2Mean": statistics.fmean(relatives),
            "relativeL2P95": percentile(relatives, 95),
            "temporalErrorMean": statistics.fmean(temporal) if temporal else 0.0,
            "temporalErrorP95": percentile(temporal, 95),
        }
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--input-dir", type=Path, default=DEFAULT_INPUTS)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--workspace-gib", type=float, default=4.0)
    parser.add_argument("--rebuild", action="store_true")
    parser.add_argument(
        "--labels",
        default="encoder-latent,style-latent,rgb-512",
        help="Comma-separated natural boundaries to expose in one diagnostic build.",
    )
    args = parser.parse_args()

    args.model = args.model.resolve()
    args.input_dir = args.input_dir.resolve()
    args.output_dir = args.output_dir.resolve()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    requested_labels = tuple(
        label.strip() for label in args.labels.split(",") if label.strip()
    )
    available = dict(ALL_BOUNDARIES)
    unknown = sorted(set(requested_labels) - set(available))
    if unknown:
        raise ValueError(f"Unknown boundary labels: {unknown}")
    if not requested_labels:
        raise ValueError("At least one boundary label is required")
    boundaries = tuple((label, available[label]) for label in requested_labels)
    build_key = hashlib.sha256(",".join(requested_labels).encode()).hexdigest()[:12]
    diagnostic_model = args.output_dir / f"gpen512-boundaries-{build_key}.onnx"
    plan = args.output_dir / f"gpen512-boundaries-{build_key}-fp32-tf32.plan"
    report_path = args.output_dir / f"report-{build_key}.json"
    shapes = clone_with_outputs(args.model, diagnostic_model, boundaries)

    np, torch, ort, dll_handles = bootstrap_libraries(enable_tensorrt=True)
    del dll_handles
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA unavailable")
    torch.cuda.set_device(0)
    import tensorrt as trt

    build = None
    if args.rebuild or not plan.is_file():
        build = build_plan(
            trt,
            diagnostic_model,
            plan,
            int(args.workspace_gib * (1 << 30)),
            boundaries,
        )

    logger = trt.Logger(trt.Logger.WARNING)
    runtime = trt.Runtime(logger)
    engine = runtime.deserialize_cuda_engine(plan.read_bytes())
    if engine is None:
        raise RuntimeError("TensorRT failed to deserialize the diagnostic plan")
    context = engine.create_execution_context()
    if context is None:
        raise RuntimeError("TensorRT failed to create a diagnostic context")
    input_names = [
        engine.get_tensor_name(index)
        for index in range(engine.num_io_tensors)
        if engine.get_tensor_mode(engine.get_tensor_name(index)) == trt.TensorIOMode.INPUT
    ]
    output_names = [
        engine.get_tensor_name(index)
        for index in range(engine.num_io_tensors)
        if engine.get_tensor_mode(engine.get_tensor_name(index)) == trt.TensorIOMode.OUTPUT
    ]
    if input_names != ["input"]:
        raise RuntimeError(f"Unexpected TensorRT runtime inputs: {input_names}")
    if set(output_names) != set(shapes):
        raise RuntimeError(f"Unexpected TensorRT runtime outputs: {output_names}")

    for name in input_names + output_names:
        if engine.get_tensor_dtype(name) != trt.float32:
            raise RuntimeError(f"TensorRT tensor is not FP32: {name}")
        if engine.get_tensor_location(name) != trt.TensorLocation.DEVICE:
            raise RuntimeError(f"TensorRT tensor is not device-resident: {name}")
        if engine.get_tensor_format(name) != trt.TensorFormat.LINEAR:
            raise RuntimeError(
                f"TensorRT tensor is not linear: {name} / {engine.get_tensor_format(name)}"
            )
        if engine.get_tensor_vectorized_dim(name) != -1:
            raise RuntimeError(f"TensorRT tensor is vectorized: {name}")

    stream = torch.cuda.Stream(device=0)
    stream_id = int(stream.cuda_stream)
    input_tensor = torch.empty((1, 3, 512, 512), dtype=torch.float32, device="cuda:0")
    native_outputs = {
        name: torch.empty(tuple(shapes[name]), dtype=torch.float32, device="cuda:0")
        for name in output_names
    }
    reference_outputs = {
        name: torch.empty(tuple(shapes[name]), dtype=torch.float32, device="cuda:0")
        for name in output_names
    }
    if not context.set_tensor_address("input", input_tensor.data_ptr()):
        raise RuntimeError("TensorRT rejected the input address")
    for name, tensor in native_outputs.items():
        if not context.set_tensor_address(name, tensor.data_ptr()):
            raise RuntimeError(f"TensorRT rejected an output address: {name}")

    reference = make_ort_session(ort, diagnostic_model, stream_id)
    binding = reference.io_binding()
    binding.bind_input(
        "input", "cuda", 0, np.float32, tuple(input_tensor.shape), input_tensor.data_ptr()
    )
    for name, tensor in reference_outputs.items():
        binding.bind_output(
            name, "cuda", 0, np.float32, tuple(tensor.shape), tensor.data_ptr()
        )

    input_paths = sorted(args.input_dir.glob("*.npy"))
    if not input_paths:
        raise FileNotFoundError(f"No captured GPEN inputs under {args.input_dir}")
    records = []
    for path in input_paths:
        captured = np.load(path, mmap_mode="r")
        for index in range(captured.shape[0]):
            fixture = np.array(captured[index : index + 1], dtype=np.float32, copy=True)
            with torch.cuda.stream(stream):
                input_tensor.copy_(torch.from_numpy(fixture), non_blocking=False)
                reference.run_with_iobinding(binding)
                stream.synchronize()
                reference_cpu = {
                    name: tensor.detach().cpu().numpy().copy()
                    for name, tensor in reference_outputs.items()
                }
                if not context.execute_async_v3(stream_id):
                    raise RuntimeError("TensorRT diagnostic execution failed")
                stream.synchronize()
                native_cpu = {
                    name: tensor.detach().cpu().numpy().copy()
                    for name, tensor in native_outputs.items()
                }
            outputs = {}
            for name in output_names:
                difference = native_cpu[name] - reference_cpu[name]
                absolute = np.abs(difference)
                reference_norm = float(
                    np.linalg.norm(reference_cpu[name].astype(np.float64).ravel())
                )
                outputs[name] = {
                    "reference": reference_cpu[name],
                    "native": native_cpu[name],
                    "mae": float(np.mean(absolute, dtype=np.float64)),
                    "p99Abs": float(np.percentile(absolute, 99)),
                    "maxAbs": float(np.max(absolute)),
                    "relativeL2": float(
                        np.linalg.norm(difference.astype(np.float64).ravel())
                        / max(reference_norm, 1e-12)
                    ),
                }
            records.append({"clip": path.stem, "index": index, "outputs": outputs})

    report = {
        "schema": "pong-gpen512-boundary-localization-v1",
        "silent": True,
        "sourceModel": str(args.model),
        "sourceModelSha256": sha256(args.model),
        "diagnosticModel": str(diagnostic_model),
        "diagnosticModelSha256": sha256(diagnostic_model),
        "plan": str(plan),
        "planSha256": sha256(plan),
        "build": build,
        "reference": {
            "provider": reference.get_providers()[0],
            "useTf32": True,
            "outputCount": len(reference.get_outputs()),
        },
        "ioContract": {
            "input": input_names,
            "outputs": output_names,
            "allFp32": True,
            "allDevice": True,
            "allLinear": True,
            "allUnvectorized": True,
        },
        "inputs": [
            {"path": str(path), "sha256": sha256(path)} for path in input_paths
        ],
        "boundaries": [
            {"label": label, "tensor": name} for label, name in boundaries
        ],
        "summary": summarize_records(np, records, boundaries),
    }
    atomic_write_json(report_path, report)
    print(json.dumps(report["summary"], indent=2))
    print(f"report={report_path}")


if __name__ == "__main__":
    main()
