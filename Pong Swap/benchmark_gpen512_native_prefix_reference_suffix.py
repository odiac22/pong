"""Qualify a TensorRT GPEN prefix followed by an exact ORT-CUDA suffix.

The experiment keeps the expensive early graph in TensorRT and moves a
natural late suffix back to the frozen CUDA reference.  It uses only captured
stock benchmark tensors and never changes production configuration.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import statistics
import time

import onnx
from onnx import TensorProto, helper

from benchmark_gpen_generated import bootstrap_libraries
from benchmark_gpen512_native_trt import load_native_engine, make_ort_reference, sha256
from diagnose_gpen512_boundaries import build_plan
from diagnose_gpen512_suffix import (
    CUTS,
    crossing_tensors,
    make_ort,
    save_models,
    shape_and_dtype,
)


ROOT = Path(__file__).resolve().parent
MODEL = ROOT / "runtime" / "models" / "GPEN-BFR-512.onnx"
INPUTS = ROOT / "benchmarks" / "gpen512-calibration-inputs"
OUTPUT = ROOT / "benchmarks" / "gpen512-native-prefix-reference-suffix-v1"
PACKED_BOUNDARY = "pong_packed_boundary"


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


def _atomic_onnx_save(model, destination: Path):
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    onnx.save(model, temporary)
    temporary.replace(destination)


def pack_split_models(
    raw_prefix: Path,
    raw_suffix: Path,
    prefix: Path,
    suffix: Path,
    crossings: list[str],
    value_info: dict,
):
    """Replace an unstable multi-output TRT boundary with one packed tensor.

    Reshape, concat, split, and reshape are value-preserving for contiguous
    FP32 tensors.  The transformed suffix restores the original tensor names
    and shapes before any learned operator consumes them.
    """
    shapes = {}
    sizes = {}
    for name in crossings:
        shape, dtype = shape_and_dtype(value_info[name], __import__("numpy"))
        if dtype != __import__("numpy").float32:
            raise RuntimeError(f"Non-FP32 split tensor: {name} / {dtype}")
        shapes[name] = tuple(int(value) for value in shape)
        sizes[name] = math.prod(shapes[name])

    prefix_model = onnx.load(raw_prefix)
    prefix_nodes = []
    flat_names = []
    for index, name in enumerate(crossings):
        flat_name = f"pong_prefix_flat_{index}"
        shape_name = f"pong_prefix_shape_{index}"
        prefix_model.graph.initializer.append(
            helper.make_tensor(shape_name, TensorProto.INT64, [2], [1, sizes[name]])
        )
        prefix_nodes.append(
            helper.make_node("Reshape", [name, shape_name], [flat_name])
        )
        flat_names.append(flat_name)
    prefix_nodes.append(
        helper.make_node("Concat", flat_names, [PACKED_BOUNDARY], axis=1)
    )
    prefix_model.graph.node.extend(prefix_nodes)
    del prefix_model.graph.output[:]
    prefix_model.graph.output.append(
        helper.make_tensor_value_info(
            PACKED_BOUNDARY, TensorProto.FLOAT, [1, sum(sizes.values())]
        )
    )
    onnx.checker.check_model(prefix_model)
    _atomic_onnx_save(prefix_model, prefix)

    suffix_model = onnx.load(raw_suffix)
    retained_inputs = [
        value for value in suffix_model.graph.input if value.name not in crossings
    ]
    del suffix_model.graph.input[:]
    suffix_model.graph.input.extend(retained_inputs)
    suffix_model.graph.input.append(
        helper.make_tensor_value_info(
            PACKED_BOUNDARY, TensorProto.FLOAT, [1, sum(sizes.values())]
        )
    )
    split_outputs = [f"pong_suffix_flat_{index}" for index in range(len(crossings))]
    restore_nodes = [
        helper.make_node(
            "Split",
            [PACKED_BOUNDARY],
            split_outputs,
            axis=1,
            split=[sizes[name] for name in crossings],
        )
    ]
    for index, name in enumerate(crossings):
        shape_name = f"pong_suffix_shape_{index}"
        suffix_model.graph.initializer.append(
            helper.make_tensor(
                shape_name,
                TensorProto.INT64,
                [len(shapes[name])],
                list(shapes[name]),
            )
        )
        restore_nodes.append(
            helper.make_node("Reshape", [split_outputs[index], shape_name], [name])
        )
    existing_nodes = list(suffix_model.graph.node)
    del suffix_model.graph.node[:]
    suffix_model.graph.node.extend(restore_nodes)
    suffix_model.graph.node.extend(existing_nodes)
    onnx.checker.check_model(suffix_model)
    _atomic_onnx_save(suffix_model, suffix)
    return {"shapes": shapes, "sizes": sizes, "packedElements": sum(sizes.values())}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=MODEL)
    parser.add_argument("--input-dir", type=Path, default=INPUTS)
    parser.add_argument("--output-dir", type=Path, default=OUTPUT)
    parser.add_argument("--cut", choices=tuple(CUTS), required=True)
    parser.add_argument("--workspace-gib", type=float, default=3.0)
    parser.add_argument("--builder-optimization-level", type=int, default=4)
    parser.add_argument(
        "--plan",
        type=Path,
        default=None,
        help="Reuse a previously qualified TensorRT prefix plan.",
    )
    parser.add_argument("--iterations", type=int, default=80)
    parser.add_argument("--warmup", type=int, default=12)
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args()
    args.model = args.model.resolve()
    args.input_dir = args.input_dir.resolve()
    args.output_dir = args.output_dir.resolve()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    source_model = onnx.load(args.model)
    crossings = crossing_tensors(source_model, CUTS[args.cut], "output")
    tag = f"cut{args.cut}"
    augmented = args.output_dir / f"gpen512-source-{tag}.onnx"
    raw_prefix = args.output_dir / f"gpen512-prefix-{tag}-raw.onnx"
    raw_suffix = args.output_dir / f"gpen512-suffix-{tag}-raw.onnx"
    prefix = args.output_dir / f"gpen512-prefix-{tag}-packed.onnx"
    suffix = args.output_dir / f"gpen512-suffix-{tag}-packed.onnx"
    plan = (
        args.plan.resolve()
        if args.plan is not None
        else args.output_dir
        / (
            f"gpen512-prefix-{tag}-fp32-tf32-"
            f"opt{args.builder_optimization_level}.plan"
        )
    )
    report_path = args.output_dir / f"report-{tag}.json"
    value_info = save_models(args.model, augmented, raw_suffix, crossings, "output")
    if args.rebuild or not raw_prefix.is_file():
        temporary = raw_prefix.with_suffix(raw_prefix.suffix + ".tmp")
        onnx.utils.extract_model(
            str(args.model), str(temporary), ["input"], crossings, check_model=True
        )
        temporary.replace(raw_prefix)
    if args.rebuild or not prefix.is_file() or not suffix.is_file():
        packing = pack_split_models(
            raw_prefix, raw_suffix, prefix, suffix, crossings, value_info
        )
    else:
        packing = None

    np, torch, ort, handles = bootstrap_libraries(enable_tensorrt=True)
    del handles
    torch.cuda.set_device(0)
    import tensorrt as trt

    build = None
    boundaries = (("packed-boundary", PACKED_BOUNDARY),)
    if args.rebuild or not plan.is_file():
        build = build_plan(
            trt,
            prefix,
            plan,
            int(args.workspace_gib * (1 << 30)),
            boundaries,
            args.builder_optimization_level,
        )
    runtime, engine, context, tensors = load_native_engine(trt, plan)
    stream = torch.cuda.Stream(device=0)
    stream_id = int(stream.cuda_stream)
    source = torch.empty((1, 3, 512, 512), dtype=torch.float32, device="cuda:0")
    reference_output = torch.empty_like(source)
    hybrid_output = torch.empty_like(source)
    if packing is None:
        packed_elements = 0
        for name in crossings:
            shape, dtype = shape_and_dtype(value_info[name], np)
            if dtype != np.float32:
                raise RuntimeError(f"Non-FP32 split tensor: {name} / {dtype}")
            packed_elements += math.prod(shape)
    else:
        packed_elements = packing["packedElements"]
    packed_boundary = torch.empty(
        (1, packed_elements), dtype=torch.float32, device="cuda:0"
    )
    if not context.set_tensor_address("input", source.data_ptr()):
        raise RuntimeError("TensorRT prefix rejected input")
    if not context.set_tensor_address(PACKED_BOUNDARY, packed_boundary.data_ptr()):
        raise RuntimeError("TensorRT prefix rejected packed output")

    suffix_session = make_ort(ort, suffix, stream_id)
    suffix_binding = suffix_session.io_binding()
    suffix_binding.bind_input(
        PACKED_BOUNDARY,
        "cuda",
        0,
        np.float32,
        tuple(packed_boundary.shape),
        packed_boundary.data_ptr(),
    )
    suffix_binding.bind_output(
        "output", "cuda", 0, np.float32, tuple(hybrid_output.shape), hybrid_output.data_ptr()
    )
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

    def run_hybrid():
        if not context.execute_async_v3(stream_id):
            raise RuntimeError("TensorRT prefix execution failed")
        suffix_session.run_with_iobinding(suffix_binding)

    records = []
    previous = {}
    captures = sorted(args.input_dir.glob("*-gpen-inputs-f32.npy"))
    with torch.cuda.stream(stream), torch.inference_mode():
        for capture in captures:
            values = np.load(capture, allow_pickle=False)
            for index, value in enumerate(values):
                source.copy_(torch.from_numpy(value).to(device="cuda:0"))
                run_reference(); stream.synchronize()
                expected = reference_output[0].cpu().numpy().copy()
                run_hybrid(); stream.synchronize()
                candidate = hybrid_output[0].cpu().numpy().copy()
                absolute = np.abs(candidate.astype(np.float64) - expected.astype(np.float64))
                temporal = None
                prior = previous.get(capture.stem)
                if prior is not None:
                    temporal = float(np.abs(
                        (candidate.astype(np.float64) - prior["candidate"])
                        - (expected.astype(np.float64) - prior["expected"])
                    ).mean())
                previous[capture.stem] = {"candidate": candidate, "expected": expected}
                records.append({
                    "clip": capture.stem,
                    "index": index,
                    "mae": float(absolute.mean()),
                    "p99Abs": float(np.percentile(absolute, 99)),
                    "maxAbs": float(absolute.max()),
                    "temporalError": temporal,
                })

        timing_value = np.load(captures[0], allow_pickle=False)[0]
        source.copy_(torch.from_numpy(timing_value).to(device="cuda:0"))
        for _ in range(args.warmup):
            run_reference(); run_hybrid()
        stream.synchronize()
        timings = {"reference": [], "hybrid": []}
        for _ in range(args.iterations):
            for name, operation in (("reference", run_reference), ("hybrid", run_hybrid)):
                stream.synchronize()
                started = time.perf_counter_ns()
                operation(); stream.synchronize()
                timings[name].append((time.perf_counter_ns() - started) / 1e6)

    temporal_values = [r["temporalError"] for r in records if r["temporalError"] is not None]
    report = {
        "schema": "pong-gpen512-native-prefix-reference-suffix-v1",
        "silent": True,
        "cut": args.cut,
        "modelSha256": sha256(args.model),
        "prefixModelSha256": sha256(prefix),
        "suffixModelSha256": sha256(suffix),
        "prefixPlanSha256": sha256(plan),
        "crossings": crossings,
        "packedElements": packed_elements,
        "packing": packing,
        "build": build,
        "summary": {
            "sampleCount": len(records),
            "maeMean": statistics.fmean(r["mae"] for r in records),
            "maeP95": percentile([r["mae"] for r in records], 95),
            "p99AbsMean": statistics.fmean(r["p99Abs"] for r in records),
            "maxAbs": max(r["maxAbs"] for r in records),
            "temporalErrorMean": statistics.fmean(temporal_values),
            "temporalErrorP95": percentile(temporal_values, 95),
        },
        "timing": {name: timing(values) for name, values in timings.items()},
        "records": records,
    }
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"report": str(report_path), "summary": report["summary"], "timing": report["timing"]}, indent=2))
    del suffix_binding, suffix_session, reference_binding, reference
    del context, engine, runtime
    torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
