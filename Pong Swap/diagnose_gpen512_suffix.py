"""Compare late GPEN512 TensorRT and ORT suffixes on identical boundaries.

The full frozen ONNX graph runs only in ONNX Runtime to capture every
data-dependent tensor crossing a natural generator cut.  A one-output suffix
model then receives those exact tensors in both ONNX Runtime CUDA and a
benchmark-owned TensorRT engine.  This separates late-block numerical drift
from any error accumulated before the cut.
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
DEFAULT_OUTPUT = ROOT / "benchmarks" / "gpen512-suffix-localization-v1"
CUTS = {
    "64": 925,
    "128": 1061,
    "256": 1197,
    "512-conv12": 1257,
    "512-conv13": 1287,
    "512-torgb": 1301,
    "512-final-add": 1331,
}
TARGETS = {
    "final": "output",
    "conv12": "/generator/convs.12/activate/Mul_output_0",
    "conv13": "/generator/convs.13/activate/Mul_output_0",
    "torgb": "/generator/to_rgbs.6/Add_output_0",
}


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


def graph_metadata(model):
    inferred = onnx.shape_inference.infer_shapes(model)
    value_info = {
        value.name: value
        for value in (
            list(inferred.graph.value_info)
            + list(inferred.graph.input)
            + list(inferred.graph.output)
        )
    }
    producer = {
        output: index
        for index, node in enumerate(model.graph.node)
        for output in node.output
    }
    initializers = {item.name for item in model.graph.initializer}
    depends_on_input = {"input": True}
    for graph_input in model.graph.input:
        depends_on_input.setdefault(graph_input.name, graph_input.name == "input")
    for node in model.graph.node:
        dependent = any(
            depends_on_input.get(name, False)
            for name in node.input
            if name not in initializers
        )
        for output in node.output:
            depends_on_input[output] = dependent
    return inferred, value_info, producer, initializers, depends_on_input


def crossing_tensors(model, cut_index: int, target: str):
    _inferred, _info, producer, initializers, depends_on_input = graph_metadata(model)
    target_index = producer[target]
    if target_index < cut_index:
        raise ValueError(
            f"Target {target} at node {target_index} precedes cut {cut_index}"
        )
    crossings = []
    for node in list(model.graph.node)[cut_index : target_index + 1]:
        for name in node.input:
            if (
                name
                and name not in initializers
                and depends_on_input.get(name, False)
                and producer.get(name, -1) < cut_index
                and name not in crossings
            ):
                crossings.append(name)
    return crossings


def shape_and_dtype(value, np):
    tensor_type = value.type.tensor_type
    shape = []
    for index, dimension in enumerate(tensor_type.shape.dim):
        # The exported generator keeps the batch dimension symbolic after
        # Gather/Tile even though Pong always supplies batch one.  The style
        # Tile's second symbolic dimension is the fixed 16-style schedule.
        if dimension.dim_value:
            shape.append(int(dimension.dim_value))
        elif value.name == "/generator/Tile_output_0" and index == 1:
            shape.append(16)
        else:
            shape.append(1)
    dtype = onnx.helper.tensor_dtype_to_np_dtype(tensor_type.elem_type)
    return tuple(shape), np.dtype(dtype)


def save_models(
    source: Path,
    augmented: Path,
    suffix: Path,
    crossings: list[str],
    target: str,
):
    model = onnx.load(source)
    inferred, value_info, _producer, _initializers, _depends = graph_metadata(model)
    del inferred
    existing = {item.name for item in model.graph.output}
    for name in crossings:
        if name not in value_info:
            raise KeyError(f"Missing crossing tensor metadata: {name}")
        if name not in existing:
            model.graph.output.append(value_info[name])
            existing.add(name)
    onnx.checker.check_model(model)
    augmented.parent.mkdir(parents=True, exist_ok=True)
    temporary = augmented.with_suffix(augmented.suffix + f".{os.getpid()}.tmp")
    try:
        onnx.save(model, temporary)
        os.replace(temporary, augmented)
    finally:
        temporary.unlink(missing_ok=True)

    temporary = suffix.with_suffix(suffix.suffix + f".{os.getpid()}.tmp")
    try:
        onnx.utils.extract_model(
            str(source), str(temporary), crossings, [target], check_model=True
        )
        os.replace(temporary, suffix)
    finally:
        temporary.unlink(missing_ok=True)
    return value_info


def build_plan(
    trt,
    model: Path,
    plan: Path,
    workspace_bytes: int,
    input_shapes: dict[str, tuple[int, ...]],
    target: str,
):
    logger = trt.Logger(trt.Logger.WARNING)
    builder = trt.Builder(logger)
    network = builder.create_network(
        1 << int(trt.NetworkDefinitionCreationFlag.EXPLICIT_BATCH)
    )
    parser = trt.OnnxParser(network, logger)
    if not parser.parse_from_file(str(model)):
        errors = [str(parser.get_error(index)) for index in range(parser.num_errors)]
        raise RuntimeError("TensorRT suffix parse failed: " + " | ".join(errors))
    if network.num_outputs != 1 or network.get_output(0).name != target:
        raise RuntimeError(f"Suffix must expose only the target output: {target}")
    config = builder.create_builder_config()
    config.set_memory_pool_limit(trt.MemoryPoolType.WORKSPACE, workspace_bytes)
    config.builder_optimization_level = 5
    config.clear_flag(trt.BuilderFlag.FP16)
    config.set_flag(trt.BuilderFlag.TF32)
    config.clear_flag(trt.BuilderFlag.INT8)
    dynamic_inputs = []
    profile = builder.create_optimization_profile()
    for index in range(network.num_inputs):
        tensor = network.get_input(index)
        shape = tuple(int(value) for value in tensor.shape)
        if any(value < 0 for value in shape):
            concrete = input_shapes[tensor.name]
            profile.set_shape(tensor.name, concrete, concrete, concrete)
            dynamic_inputs.append(tensor.name)
    if dynamic_inputs:
        config.add_optimization_profile(profile)
    started = time.perf_counter_ns()
    serialized = builder.build_serialized_network(network, config)
    build_ms = (time.perf_counter_ns() - started) / 1e6
    if serialized is None:
        raise RuntimeError("TensorRT suffix build failed")
    atomic_write_bytes(plan, bytes(serialized))
    return {
        "buildMs": build_ms,
        "inputCount": network.num_inputs,
        "output": network.get_output(0).name,
        "tf32": True,
        "fp16": False,
        "workspaceBytes": workspace_bytes,
        "dynamicInputs": dynamic_inputs,
    }


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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--input-dir", type=Path, default=DEFAULT_INPUTS)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--cut", choices=tuple(CUTS), default="64")
    parser.add_argument("--target", choices=tuple(TARGETS), default="final")
    parser.add_argument("--workspace-gib", type=float, default=3.0)
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args()

    args.model = args.model.resolve()
    args.input_dir = args.input_dir.resolve()
    args.output_dir = args.output_dir.resolve()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    source_model = onnx.load(args.model)
    cut_index = CUTS[args.cut]
    target_name = TARGETS[args.target]
    crossings = crossing_tensors(source_model, cut_index, target_name)
    tag = f"cut{args.cut}-target{args.target}"
    augmented = args.output_dir / f"gpen512-source-{tag}.onnx"
    suffix = args.output_dir / f"gpen512-suffix-{tag}.onnx"
    plan = args.output_dir / f"gpen512-suffix-{tag}-fp32-tf32.plan"
    report_path = args.output_dir / f"report-{tag}.json"
    value_info = save_models(args.model, augmented, suffix, crossings, target_name)

    np, torch, ort, dll_handles = bootstrap_libraries(enable_tensorrt=True)
    del dll_handles
    torch.cuda.set_device(0)
    import tensorrt as trt

    build = None
    input_shapes = {
        name: shape_and_dtype(value_info[name], np)[0] for name in crossings
    }
    if args.rebuild or not plan.is_file():
        build = build_plan(
            trt,
            suffix,
            plan,
            int(args.workspace_gib * (1 << 30)),
            input_shapes,
            target_name,
        )

    logger = trt.Logger(trt.Logger.WARNING)
    runtime = trt.Runtime(logger)
    engine = runtime.deserialize_cuda_engine(plan.read_bytes())
    if engine is None:
        raise RuntimeError("TensorRT suffix deserialization failed")
    context = engine.create_execution_context()
    if context is None:
        raise RuntimeError("TensorRT suffix context creation failed")
    engine_inputs = [
        engine.get_tensor_name(index)
        for index in range(engine.num_io_tensors)
        if engine.get_tensor_mode(engine.get_tensor_name(index)) == trt.TensorIOMode.INPUT
    ]
    if set(engine_inputs) != set(crossings):
        raise RuntimeError(
            f"Suffix inputs differ: crossings={crossings}, engine={engine_inputs}"
        )
    if engine.get_tensor_format(target_name) != trt.TensorFormat.LINEAR:
        raise RuntimeError("Suffix output is not linear")

    stream = torch.cuda.Stream(device=0)
    stream_id = int(stream.cuda_stream)
    source_input = torch.empty((1, 3, 512, 512), dtype=torch.float32, device="cuda:0")
    boundary_buffers = {}
    boundary_meta = {}
    for name in crossings:
        shape, dtype = shape_and_dtype(value_info[name], np)
        if dtype != np.float32:
            raise RuntimeError(f"Non-FP32 data-dependent crossing: {name} / {dtype}")
        boundary_buffers[name] = torch.empty(shape, dtype=torch.float32, device="cuda:0")
        boundary_meta[name] = {"shape": list(shape), "dtype": str(dtype)}
    target_shape, target_dtype = shape_and_dtype(value_info[target_name], np)
    if target_dtype != np.float32:
        raise RuntimeError(f"Non-FP32 target: {target_name} / {target_dtype}")
    reference_output = torch.empty(target_shape, dtype=torch.float32, device="cuda:0")
    native_output = torch.empty_like(reference_output)

    source_session = make_ort(ort, augmented, stream_id)
    source_binding = source_session.io_binding()
    source_binding.bind_input(
        "input", "cuda", 0, np.float32, tuple(source_input.shape), source_input.data_ptr()
    )
    for name, tensor in boundary_buffers.items():
        source_binding.bind_output(
            name, "cuda", 0, np.float32, tuple(tensor.shape), tensor.data_ptr()
        )

    suffix_session = make_ort(ort, suffix, stream_id)
    suffix_binding = suffix_session.io_binding()
    for name, tensor in boundary_buffers.items():
        suffix_binding.bind_input(
            name, "cuda", 0, np.float32, tuple(tensor.shape), tensor.data_ptr()
        )
        if not context.set_tensor_address(name, tensor.data_ptr()):
            raise RuntimeError(f"TensorRT rejected suffix input: {name}")
    suffix_binding.bind_output(
        target_name,
        "cuda",
        0,
        np.float32,
        tuple(reference_output.shape),
        reference_output.data_ptr(),
    )
    if not context.set_tensor_address(target_name, native_output.data_ptr()):
        raise RuntimeError("TensorRT rejected suffix output")

    input_paths = sorted(args.input_dir.glob("*.npy"))
    records = []
    previous_by_clip = {}
    for path in input_paths:
        captured = np.load(path, mmap_mode="r")
        for index in range(captured.shape[0]):
            fixture = np.array(captured[index : index + 1], dtype=np.float32, copy=True)
            with torch.cuda.stream(stream):
                source_input.copy_(torch.from_numpy(fixture), non_blocking=False)
                source_session.run_with_iobinding(source_binding)
                suffix_session.run_with_iobinding(suffix_binding)
                stream.synchronize()
                reference_cpu = reference_output.detach().cpu().numpy().copy()
                if not context.execute_async_v3(stream_id):
                    raise RuntimeError("TensorRT suffix execution failed")
                stream.synchronize()
                native_cpu = native_output.detach().cpu().numpy().copy()
            absolute = np.abs(native_cpu - reference_cpu)
            temporal = None
            previous = previous_by_clip.get(path.stem)
            if previous is not None:
                temporal = float(
                    np.mean(
                        np.abs(
                            (native_cpu - previous["native"])
                            - (reference_cpu - previous["reference"])
                        ),
                        dtype=np.float64,
                    )
                )
            previous_by_clip[path.stem] = {
                "native": native_cpu,
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

    temporal_values = [
        record["temporalError"]
        for record in records
        if record["temporalError"] is not None
    ]
    report = {
        "schema": "pong-gpen512-suffix-localization-v1",
        "silent": True,
        "cut": args.cut,
        "cutNodeIndex": cut_index,
        "target": args.target,
        "targetTensor": target_name,
        "sourceModel": str(args.model),
        "sourceModelSha256": sha256(args.model),
        "augmentedModelSha256": sha256(augmented),
        "suffixModelSha256": sha256(suffix),
        "planSha256": sha256(plan),
        "crossings": boundary_meta,
        "build": build,
        "ioContract": {
            "engineInputs": engine_inputs,
            "output": target_name,
            "outputShape": list(target_shape),
            "outputFormat": str(engine.get_tensor_format(target_name)),
            "outputLocation": str(engine.get_tensor_location(target_name)),
            "outputVectorizedDim": int(engine.get_tensor_vectorized_dim(target_name)),
        },
        "summary": {
            "sampleCount": len(records),
            "maeMean": statistics.fmean(record["mae"] for record in records),
            "maeP95": percentile([record["mae"] for record in records], 95),
            "p99AbsMean": statistics.fmean(record["p99Abs"] for record in records),
            "p99AbsP95": percentile([record["p99Abs"] for record in records], 95),
            "maxAbs": max(record["maxAbs"] for record in records),
            "temporalErrorMean": statistics.fmean(temporal_values),
            "temporalErrorP95": percentile(temporal_values, 95),
        },
        "records": records,
    }
    atomic_write_json(report_path, report)
    print(json.dumps(report["summary"], indent=2))
    print(f"report={report_path}")


if __name__ == "__main__":
    main()
