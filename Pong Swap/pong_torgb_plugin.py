"""TensorRT JIT plugin for GPEN512's exact final TF32 to-RGB projection."""

import os
from typing import Tuple

import tensorrt as trt
import tensorrt.plugin as trtp
import torch


PLUGIN_ID = "pong::torgb_tf32"


@trtp.register(PLUGIN_ID)
def torgb_tf32_desc(
    feature: trtp.TensorDesc,
    weight: trtp.TensorDesc,
) -> trtp.TensorDesc:
    return trtp.from_shape_expr(
        (
            feature.shape_expr[0],
            3,
            feature.shape_expr[2],
            feature.shape_expr[3],
        ),
        dtype=trt.float32,
    )


@trtp.autotune(PLUGIN_ID)
def torgb_tf32_autotune(
    feature: trtp.TensorDesc,
    weight: trtp.TensorDesc,
    outputs: Tuple[trtp.TensorDesc],
):
    del feature, weight, outputs
    return [trtp.AutoTuneCombination("FP32, FP32, FP32", "LINEAR")]


@trtp.impl(PLUGIN_ID)
def torgb_tf32_impl(
    feature: trtp.Tensor,
    weight: trtp.Tensor,
    outputs: Tuple[trtp.Tensor],
    stream: int,
) -> None:
    device = torch.device("cuda", torch.cuda.current_device())
    external_stream = torch.cuda.ExternalStream(stream, device=device)
    with torch.cuda.stream(external_stream):
        feature_tensor = torch.as_tensor(feature, device=device)
        weight_tensor = torch.as_tensor(weight, device=device)
        output_tensor = torch.as_tensor(outputs[0], device=device)
        expected = (
            (feature_tensor, (1, 128, 512, 512), "feature"),
            (weight_tensor, (3, 128, 1, 1), "weight"),
            (output_tensor, (1, 3, 512, 512), "output"),
        )
        for tensor, shape, name in expected:
            if tuple(tensor.shape) != shape:
                raise RuntimeError(
                    f"GPEN toRGB {name} shape must be {shape}, got "
                    f"{tuple(tensor.shape)}"
                )
            if tensor.dtype != torch.float32:
                raise RuntimeError(
                    f"GPEN toRGB {name} must be FP32, got {tensor.dtype}"
                )
            if not tensor.is_contiguous():
                raise RuntimeError(f"GPEN toRGB {name} must be contiguous")
        previous = torch.backends.cuda.matmul.allow_tf32
        # The opt-out exists only for same-plan arithmetic attribution. A
        # production-qualified callback always leaves it unset and is pinned by
        # source hash in its artifact manifest.
        use_tf32 = os.environ.get("PONG_TORGB_DIAGNOSTIC_FP32") != "1"
        torch.backends.cuda.matmul.allow_tf32 = use_tf32
        try:
            torch.mm(
                weight_tensor.view(3, 128),
                feature_tensor.view(128, 512 * 512),
                out=output_tensor.view(3, 512 * 512),
            )
        finally:
            torch.backends.cuda.matmul.allow_tf32 = previous
