"""Create an experimental GPEN512 graph with only the final 1x1 Conv rewritten.

The replacement is mathematically identical: a dynamic 3x128 1x1 convolution
over a 1x128x512x512 feature map becomes a 3x128 by 128x262144 MatMul, then is
reshaped back.  It is intended to make TensorRT select the TF32 GEMM behavior
that was measured bit-exact against the frozen ORT CUDA reference for this
specific block.  The source ONNX file is never modified.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

import numpy as np
import onnx
from onnx import helper, numpy_helper


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "runtime" / "models" / "GPEN-BFR-512.onnx"
OUTPUT = ROOT / "benchmarks" / "gpen512-torgb-matmul-v1" / "GPEN-BFR-512-torgb-matmul.onnx"
TARGET_NODE = "/generator/to_rgbs.6/conv/Conv"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument(
        "--operator", choices=("matmul", "gemm", "plugin"), default="matmul"
    )
    args = parser.parse_args()
    args.source = args.source.resolve()
    args.output = args.output.resolve()

    model = onnx.load(args.source)
    matches = [
        (index, node)
        for index, node in enumerate(model.graph.node)
        if node.name == TARGET_NODE
    ]
    if len(matches) != 1:
        raise RuntimeError(f"Expected one target Conv, found {len(matches)}")
    index, node = matches[0]
    if node.op_type != "Conv" or len(node.input) != 2 or len(node.output) != 1:
        raise RuntimeError(f"Unexpected target node contract: {node}")
    feature, weight = node.input
    output = node.output[0]

    weight_shape_name = "/pong/repair/torgb/weight-shape"
    feature_shape_name = "/pong/repair/torgb/feature-shape"
    output_shape_name = "/pong/repair/torgb/output-shape"
    gemm_zero_name = "/pong/repair/torgb/gemm-zero"
    flat_weight = "/pong/repair/torgb/flat-weight"
    flat_feature = "/pong/repair/torgb/flat-feature"
    flat_output = "/pong/repair/torgb/flat-output"
    model.graph.initializer.extend(
        [
            numpy_helper.from_array(np.array([3, 128], dtype=np.int64), weight_shape_name),
            numpy_helper.from_array(
                np.array([128, 512 * 512], dtype=np.int64), feature_shape_name
            ),
            numpy_helper.from_array(
                np.array([1, 3, 512, 512], dtype=np.int64), output_shape_name
            ),
        ]
    )
    if args.operator == "gemm":
        model.graph.initializer.append(
            numpy_helper.from_array(np.zeros((3, 1), dtype=np.float32), gemm_zero_name)
        )
    projection_op = {
        "matmul": "MatMul",
        "gemm": "Gemm",
        "plugin": "torgb_tf32",
    }[args.operator]
    projection_name = f"/pong/repair/torgb/{projection_op}"
    projection_inputs = [flat_weight, flat_feature]
    if args.operator == "gemm":
        projection_inputs.append(gemm_zero_name)
    if args.operator == "plugin":
        projection_inputs = [feature, weight]
    replacements = [
        helper.make_node(
            "Reshape",
            [weight, weight_shape_name],
            [flat_weight],
            name="/pong/repair/torgb/ReshapeWeight",
        ),
        helper.make_node(
            "Reshape",
            [feature, feature_shape_name],
            [flat_feature],
            name="/pong/repair/torgb/ReshapeFeature",
        ),
        helper.make_node(
            projection_op,
            projection_inputs,
            [flat_output],
            name=projection_name,
        ),
        helper.make_node(
            "Reshape",
            [flat_output, output_shape_name],
            [output],
            name="/pong/repair/torgb/ReshapeOutput",
        ),
    ]
    if args.operator == "plugin":
        replacements = [
            helper.make_node(
                projection_op,
                projection_inputs,
                [output],
                name=projection_name,
                plugin_namespace="pong",
                aot=False,
            )
        ]
    del model.graph.node[index]
    for offset, replacement in enumerate(replacements):
        model.graph.node.insert(index + offset, replacement)
    metadata = model.metadata_props.add()
    metadata.key = "pong.gpen512.repair"
    metadata.value = f"final-torgb-conv-to-{args.operator}-v1"
    if args.operator != "plugin":
        onnx.checker.check_model(model)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + f".{os.getpid()}.tmp")
    try:
        onnx.save(model, temporary)
        os.replace(temporary, args.output)
    finally:
        temporary.unlink(missing_ok=True)
    report = {
        "schema": "pong-gpen512-torgb-rewrite-v1",
        "source": str(args.source),
        "sourceSha256": sha256(args.source),
        "output": str(args.output),
        "outputSha256": sha256(args.output),
        "replacedNode": TARGET_NODE,
        "operator": args.operator,
        "replacement": [item.name for item in replacements],
    }
    report_path = args.output.with_suffix(args.output.suffix + ".rewrite.json")
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
