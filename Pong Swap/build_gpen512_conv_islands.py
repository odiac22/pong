"""Export an unqualified GPEN512 convolution-only FP16 candidate.

This is an offline graph experiment. It never edits the source model, runtime
cache, saved preset, or qualified TensorRT plan. Only explicitly selected
generator convolutions receive FP16 operands; their results are immediately
cast back to FP32. Everything outside those narrow islands remains FP32.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re

import onnx
from onnx import TensorProto, helper


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "runtime" / "models" / "GPEN-BFR-512.onnx"
EXPECTED_SOURCE_SHA256 = "0960f836488735444d508b588e44fb5dfd19c68fde9163ad7878aa24d1d5115e"
OUTPUT_PARENT = Path(r"E:\Pong Benchmarks\tiktok-webview-2026-09-29")
OUTPUT_NAME = "GPEN-BFR-512-conv-islands.onnx"
MANIFEST_NAME = "manifest.json"
LAYER_COUNT = 14
SENSITIVE_OPS = {"Pow", "ReduceSum", "Sqrt", "Div"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_layers(raw: str) -> tuple[int, ...]:
    parts = raw.split(",")
    if not parts or any(not re.fullmatch(r"(?:0|[1-9][0-9]?)", part) for part in parts):
        raise ValueError("--layers must be comma-separated generator indices 0..13")
    indices = tuple(int(part) for part in parts)
    if any(index >= LAYER_COUNT for index in indices) or len(set(indices)) != len(indices):
        raise ValueError("--layers must contain unique generator indices 0..13")
    return indices


def target_name(index: int) -> str:
    op = "ConvTranspose" if index % 2 == 0 else "Conv"
    return f"/generator/convs.{index}/conv/{op}"


def _tensor_types(model: onnx.ModelProto) -> dict[str, int]:
    typed = {}
    for value in (*model.graph.input, *model.graph.output, *model.graph.value_info):
        if value.type.HasField("tensor_type"):
            typed[value.name] = value.type.tensor_type.elem_type
    for value in model.graph.initializer:
        typed[value.name] = value.data_type
    return typed


def _validate_source(model: onnx.ModelProto, layers: tuple[int, ...]) -> dict[str, object]:
    onnx.checker.check_model(model)
    inferred = onnx.shape_inference.infer_shapes(model, check_type=True, strict_mode=True)
    typed = _tensor_types(inferred)
    if len(model.graph.output) != 1 or len(model.graph.input) < 1:
        raise ValueError("unexpected GPEN graph I/O")
    if any(typed.get(value.name) != TensorProto.FLOAT for value in model.graph.input):
        raise ValueError("source graph inputs are not all FP32")
    if any(typed.get(value.name) != TensorProto.FLOAT for value in model.graph.output):
        raise ValueError("source graph outputs are not all FP32")
    # Empty debug names are legal ONNX (the GPEN1024 export has several).
    # Named operations, especially the explicitly selected ones, must be unique.
    names = [node.name for node in model.graph.node if node.name]
    if len(names) != len(set(names)):
        raise ValueError("source graph has duplicate node names")
    selected = set(target_name(index) for index in layers)
    nodes = {node.name: node for node in model.graph.node if node.name in selected}
    if set(nodes) != selected:
        raise ValueError("selected generator convolution is missing")
    shapes = {}
    inferred_values = {value.name: value for value in (*inferred.graph.input, *inferred.graph.output,
                                                        *inferred.graph.value_info)}
    for index in layers:
        node = nodes[target_name(index)]
        if node.op_type not in ("Conv", "ConvTranspose") or len(node.input) != 2 or len(node.output) != 1:
            raise ValueError(f"unexpected convolution topology: {node.name}")
        if any(typed.get(name) != TensorProto.FLOAT for name in (*node.input, *node.output)):
            raise ValueError(f"selected convolution has a non-FP32 data edge: {node.name}")
        value = inferred_values.get(node.output[0])
        if value is None or not value.type.tensor_type.HasField("shape"):
            raise ValueError(f"selected convolution output shape is unknown: {node.name}")
        shapes[node.name] = [dimension.dim_value if dimension.HasField("dim_value") else
                             dimension.dim_param for dimension in value.type.tensor_type.shape.dim]
    return shapes


def make_candidate(model: onnx.ModelProto, layers: tuple[int, ...]) -> tuple[onnx.ModelProto, dict]:
    """Mutate an in-memory model; callers load a fresh copy, never SOURCE bytes."""
    if not layers or len(set(layers)) != len(layers) or any(i < 0 or i >= LAYER_COUNT for i in layers):
        raise ValueError("select one or more unique generator layers 0..13")
    original_shapes = _validate_source(model, layers)
    original_ops = [(node.name, node.op_type, tuple(node.input), tuple(node.output))
                    for node in model.graph.node]
    original_initializers = [hashlib.sha256(value.SerializeToString()).digest()
                             for value in model.graph.initializer]
    original_untouched_nodes = [
        hashlib.sha256(node.SerializeToString()).digest()
        for node in model.graph.node if node.name not in {target_name(i) for i in layers}
    ]
    original_cast_count = sum(node.op_type == "Cast" for node in model.graph.node)
    inserted_names = set()
    original_io = tuple(value.SerializeToString() for value in
                        (*model.graph.input, *model.graph.output))
    selected = {target_name(index): index for index in layers}
    used = {name for node in model.graph.node for name in (*node.input, *node.output) if name}
    used.update(node.name for node in model.graph.node)
    replacement = []
    for node in model.graph.node:
        index = selected.get(node.name)
        if index is None:
            replacement.append(node)
            continue
        prefix = f"pong_conv_island_v1_{index}"
        cast_inputs = []
        for position, source_name in enumerate(node.input):
            cast_name = f"{prefix}_input{position}_cast"
            cast_output = f"{prefix}_input{position}_fp16"
            if cast_name in used or cast_output in used:
                raise ValueError("candidate cast name collides with source graph")
            used.update((cast_name, cast_output))
            inserted_names.add(cast_name)
            replacement.append(helper.make_node("Cast", [source_name], [cast_output],
                                                name=cast_name, to=TensorProto.FLOAT16))
            cast_inputs.append(cast_output)
        original_output = node.output[0]
        fp16_output = f"{prefix}_output_fp16"
        cast_back_name = f"{prefix}_output_cast"
        if fp16_output in used or cast_back_name in used:
            raise ValueError("candidate cast name collides with source graph")
        used.update((fp16_output, cast_back_name))
        inserted_names.add(cast_back_name)
        node.input[:] = cast_inputs
        node.output[:] = [fp16_output]
        replacement.append(node)
        replacement.append(helper.make_node("Cast", [fp16_output], [original_output],
                                            name=cast_back_name, to=TensorProto.FLOAT))
    model.graph.ClearField("node")
    model.graph.node.extend(replacement)
    onnx.checker.check_model(model)
    inferred = onnx.shape_inference.infer_shapes(model, check_type=True, strict_mode=True)
    typed = _tensor_types(inferred)
    actual_shapes = {value.name: [dimension.dim_value if dimension.HasField("dim_value") else
                                  dimension.dim_param for dimension in value.type.tensor_type.shape.dim]
                     for value in (*inferred.graph.input, *inferred.graph.output,
                                   *inferred.graph.value_info) if value.type.tensor_type.HasField("shape")}
    for index in layers:
        name = target_name(index)
        node = next(value for value in model.graph.node if value.name == name)
        if typed.get(node.output[0]) != TensorProto.FLOAT16:
            raise ValueError(f"FP16 convolution output not inferred: {name}")
        cast_back = next(value for value in model.graph.node if value.name == f"pong_conv_island_v1_{index}_output_cast")
        if typed.get(cast_back.output[0]) != TensorProto.FLOAT:
            raise ValueError(f"FP32 island boundary not inferred: {name}")
        if actual_shapes.get(cast_back.output[0]) != original_shapes[name]:
            raise ValueError(f"convolution output shape changed: {name}")
    for node in model.graph.node:
        if node.op_type in SENSITIVE_OPS and typed.get(node.output[0]) != TensorProto.FLOAT:
            raise ValueError(f"sensitive operation lost FP32: {node.name}")
    if [hashlib.sha256(value.SerializeToString()).digest()
        for value in model.graph.initializer] != original_initializers:
        raise ValueError("source initializer changed")
    if tuple(value.SerializeToString() for value in
             (*model.graph.input, *model.graph.output)) != original_io:
        raise ValueError("source graph I/O changed")
    if [hashlib.sha256(node.SerializeToString()).digest() for node in model.graph.node
        if node.name not in inserted_names and node.name not in selected] != original_untouched_nodes:
        raise ValueError("nonselected source operation changed")
    retained = [(node.name, node.op_type) for node in model.graph.node if node.name not in inserted_names]
    if retained != [(name, op) for name, op, _, _ in original_ops]:
        raise ValueError("source operation order or type changed")
    metadata = {
        "selectedLayers": list(layers),
        "selectedNodes": [target_name(index) for index in layers],
        "sourceNodeCount": len(original_ops),
        "candidateNodeCount": len(model.graph.node),
        "castNodeCount": sum(node.op_type == "Cast" for node in model.graph.node),
        "insertedCastNodeCount": len(inserted_names),
        "sourceOutputShapes": original_shapes,
        "modelIoFp32": all(typed.get(value.name) == TensorProto.FLOAT for value in
                           (*model.graph.input, *model.graph.output)),
        "sensitiveOpsFp32": True,
        "initializersUnchanged": True,
    }
    if metadata["castNodeCount"] != original_cast_count + 3 * len(layers) or not metadata["modelIoFp32"]:
        raise ValueError("unexpected precision topology")
    return model, metadata


def output_directory(raw: str) -> Path:
    path = Path(raw).resolve()
    if path.parent != OUTPUT_PARENT.resolve() or not re.fullmatch(r"gpen512-conv-islands-[a-z0-9-]+", path.name):
        raise ValueError(f"output must be a new gpen512-conv-islands-* directory under {OUTPUT_PARENT}")
    if path.exists():
        raise FileExistsError(path)
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--layers", default="13", help="unique generator indices 0..13, e.g. 9,11,13")
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    layers = parse_layers(args.layers)
    destination = output_directory(args.output_dir)
    source_hash = sha256_file(SOURCE)
    if source_hash != EXPECTED_SOURCE_SHA256:
        raise RuntimeError("qualified source model identity changed")
    model, topology = make_candidate(onnx.load(str(SOURCE)), layers)
    if sha256_file(SOURCE) != source_hash:
        raise RuntimeError("source model changed during export")
    destination.mkdir(parents=True, exist_ok=False)
    candidate_path = destination / OUTPUT_NAME
    onnx.save_model(model, str(candidate_path), save_as_external_data=False)
    onnx.checker.check_model(str(candidate_path))
    manifest = {
        "schema": "pong-gpen512-conv-islands-candidate-v1",
        "productionEligible": False,
        "qualityQualified": False,
        "performanceQualified": False,
        "sourceSha256": source_hash,
        "candidateSha256": sha256_file(candidate_path),
        "candidateBytes": candidate_path.stat().st_size,
        **topology,
    }
    if sha256_file(SOURCE) != source_hash:
        raise RuntimeError("source model changed during export")
    (destination / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(candidate_path), **manifest}, indent=2))


if __name__ == "__main__":
    main()
