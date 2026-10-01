"""Analyze cheap calibration layers for the qualified GPEN512 TensorRT plan.

This is an analysis-only benchmark.  It never builds a plan, mutates a plan
manifest, imports the production Pong engine, or changes runtime settings.
Captured GPEN input tensors are split deterministically into fit and holdout
sets.  Every proposed correction is fitted on one half and evaluated on the
other half against ONNX Runtime CUDA output from the same model.
"""

from __future__ import annotations

import argparse
import cv2
import json
import math
from pathlib import Path
import statistics
import time

from benchmark_gpen512_native_trt import (
    atomic_write_json,
    load_native_engine,
    make_ort_reference,
    percentile,
    sha256,
)
from benchmark_gpen_generated import bootstrap_libraries, numerical_metrics, query_gpu


ROOT = Path(__file__).resolve().parent
DEFAULT_MODEL = ROOT / "runtime" / "models" / "GPEN-BFR-512.onnx"
DEFAULT_PLAN = (
    ROOT
    / "benchmarks"
    / "gpen512-native-trt-strict-v2"
    / "gpen512-fp32-notf32-6c46d7ac9ee0b5546372.plan"
)
DEFAULT_INPUT_DIR = ROOT / "benchmarks" / "gpen512-calibration-inputs"
DEFAULT_OUTPUT = ROOT / "benchmarks" / "gpen512-real-input-calibration-v1"
EXPECTED_PLAN_SHA256 = "73e422a032d86ba9a56fe4a380ac37dac7e60f91adede75f531ace8cfe2ff2ff"


def summarize(values):
    values = [value for value in values if value is not None]
    if not values:
        return None
    return {
        "count": len(values),
        "mean": statistics.fmean(values),
        "p50": percentile(values, 50),
        "p95": percentile(values, 95),
        "max": max(values),
    }


def completed_ms(torch, stream, operation):
    stream.synchronize()
    started = time.perf_counter_ns()
    with torch.cuda.stream(stream):
        operation()
    stream.synchronize()
    return (time.perf_counter_ns() - started) / 1e6


def fit_channel_affine(np, samples):
    count = np.zeros((1, 3, 1, 1), dtype=np.float64)
    sum_x = np.zeros_like(count)
    sum_y = np.zeros_like(count)
    sum_xx = np.zeros_like(count)
    sum_xy = np.zeros_like(count)
    for native, reference in samples:
        x = native.astype(np.float64, copy=False)
        y = reference.astype(np.float64, copy=False)
        pixels = x.shape[0] * x.shape[2] * x.shape[3]
        count += pixels
        sum_x += x.sum(axis=(0, 2, 3), keepdims=True)
        sum_y += y.sum(axis=(0, 2, 3), keepdims=True)
        sum_xx += (x * x).sum(axis=(0, 2, 3), keepdims=True)
        sum_xy += (x * y).sum(axis=(0, 2, 3), keepdims=True)
    covariance = sum_xy - sum_x * sum_y / count
    variance = sum_xx - sum_x * sum_x / count
    scale = covariance / np.maximum(variance, 1e-20)
    bias = sum_y / count - scale * sum_x / count
    bias_only = (sum_y - sum_x) / count
    return scale.astype(np.float32), bias.astype(np.float32), bias_only.astype(np.float32)


def fit_color_matrix(np, samples):
    # Fit y = A*x + b as four normal-equation features [R,G,B,1].
    xtx = np.zeros((4, 4), dtype=np.float64)
    xty = np.zeros((4, 3), dtype=np.float64)
    for native, reference in samples:
        x = native.transpose(0, 2, 3, 1).reshape(-1, 3).astype(np.float64)
        y = reference.transpose(0, 2, 3, 1).reshape(-1, 3).astype(np.float64)
        features = np.concatenate((x, np.ones((x.shape[0], 1), dtype=np.float64)), axis=1)
        xtx += features.T @ features
        xty += features.T @ y
    # A tiny ridge stabilizes the intercept-free color coefficients while being
    # negligible relative to millions of real pixels.
    ridge = np.diag([1e-8, 1e-8, 1e-8, 0.0])
    coefficients = np.linalg.solve(xtx + ridge, xty)
    matrix = coefficients[:3].T.astype(np.float32)
    bias = coefficients[3].reshape(1, 3, 1, 1).astype(np.float32)
    return matrix, bias


def apply_color_matrix(np, values, matrix, bias):
    mixed = np.einsum("oc,nchw->nohw", matrix, values, optimize=True)
    return mixed + bias


def temporal_error(np, reference_previous, reference_current, candidate_previous, candidate_current):
    reference_delta = reference_current.astype(np.float64) - reference_previous.astype(np.float64)
    candidate_delta = candidate_current.astype(np.float64) - candidate_previous.astype(np.float64)
    return float(np.abs(candidate_delta - reference_delta).mean() * 127.5)


def evaluate_variant(np, records, transform):
    frames = []
    temporal = []
    previous = {}
    for record in records:
        candidate = np.ascontiguousarray(transform(record), dtype=np.float32)
        metrics = numerical_metrics(np, record["reference"], candidate)
        frames.append({"clip": record["clip"], "index": record["index"], **metrics})
        old = previous.get(record["clip"])
        if old is not None:
            temporal.append(
                temporal_error(np, old[0], record["reference"], old[1], candidate)
            )
        previous[record["clip"]] = (record["reference"], candidate)
    return {
        "frames": frames,
        "mae": summarize(item["mae"] for item in frames),
        "p99Abs": summarize(item["p99Abs"] for item in frames),
        "maxAbs": summarize(item["maxAbs"] for item in frames),
        "psnrDb": summarize(item["psnrDb"] for item in frames),
        "ssim": summarize(item["ssim"] for item in frames),
        "temporalMae": summarize(temporal) if temporal else None,
    }


def fit_local_residual_conv(np, records, stride=8, ridge=1e-5):
    """Fit a tiny spatially-shared 3x3 correction for TRT -> ORT output.

    Features are the native 3x3 RGB neighborhood, the normalized GPEN input
    pixel, low-order normalized position terms and an intercept.  Normal
    equations are accumulated from a deterministic grid, so no face images or
    outputs are written and the holdout split remains untouched.
    """
    feature_count = 27 + 3 + 5 + 1
    xtx = np.zeros((feature_count, feature_count), dtype=np.float64)
    xty = np.zeros((feature_count, 3), dtype=np.float64)
    sample_count = 0
    for record in records:
        native = record["native"][0].transpose(1, 2, 0).astype(np.float64)
        source = record["input"][0].transpose(1, 2, 0).astype(np.float64)
        reference = record["reference"][0].transpose(1, 2, 0).astype(np.float64)
        windows = np.lib.stride_tricks.sliding_window_view(
            native, (3, 3), axis=(0, 1)
        )
        # sliding_window_view returns H-2,W-2,C,3,3; use a fixed grid.
        patches = windows[::stride, ::stride].transpose(0, 1, 3, 4, 2).reshape(-1, 27)
        centers = source[1:-1:stride, 1:-1:stride].reshape(-1, 3)
        target = (
            reference[1:-1:stride, 1:-1:stride]
            - native[1:-1:stride, 1:-1:stride]
        ).reshape(-1, 3)
        height, width = native.shape[:2]
        yy, xx = np.meshgrid(
            np.linspace(-1.0, 1.0, len(range(1, height - 1, stride))),
            np.linspace(-1.0, 1.0, len(range(1, width - 1, stride))),
            indexing="ij",
        )
        position = np.stack((xx, yy, xx * xx, yy * yy, xx * yy), axis=-1).reshape(-1, 5)
        features = np.concatenate(
            (patches, centers, position, np.ones((patches.shape[0], 1))), axis=1
        )
        xtx += features.T @ features
        xty += features.T @ target
        sample_count += features.shape[0]
    penalty = np.eye(feature_count, dtype=np.float64) * float(ridge)
    penalty[-1, -1] = 0.0
    coefficients = np.linalg.solve(xtx + penalty, xty)
    return coefficients.astype(np.float32), sample_count


def apply_local_residual_conv(np, record, coefficients):
    native_nchw = record["native"]
    native = native_nchw[0].transpose(1, 2, 0).astype(np.float32, copy=False)
    source = record["input"][0].transpose(1, 2, 0).astype(np.float32, copy=False)
    height, width = native.shape[:2]
    correction = np.zeros_like(native)
    kernel_weights = coefficients[:27].reshape(3, 3, 3, 3)
    input_weights = coefficients[27:30]
    position_weights = coefficients[30:35]
    bias = coefficients[35]
    yy, xx = np.meshgrid(
        np.linspace(-1.0, 1.0, height, dtype=np.float32),
        np.linspace(-1.0, 1.0, width, dtype=np.float32),
        indexing="ij",
    )
    position = np.stack((xx, yy, xx * xx, yy * yy, xx * yy), axis=-1)
    for output_channel in range(3):
        channel = np.full((height, width), bias[output_channel], dtype=np.float32)
        for input_channel in range(3):
            channel += cv2.filter2D(
                native[..., input_channel],
                cv2.CV_32F,
                kernel_weights[..., input_channel, output_channel],
                borderType=cv2.BORDER_REFLECT_101,
            )
            channel += source[..., input_channel] * input_weights[input_channel, output_channel]
        channel += np.sum(position * position_weights[:, output_channel], axis=-1)
        correction[..., output_channel] = channel
    return (native + correction).transpose(2, 0, 1)[None]


def evaluate_adaptive_reference(np, records, cadence):
    """Use an exact CUDA sample periodically and transport its TRT error field.

    This estimates a dual-backend temporal calibrator without modifying either
    backend.  Calibration frames use the reference output; intervening frames
    add the most recent input-dependent reference-minus-native correction.
    State is isolated per clip and never fitted from the holdout future.
    """
    frames = []
    temporal = []
    state = {}
    clip_ordinals = {}
    for record in records:
        clip = record["clip"]
        ordinal = clip_ordinals.get(clip, 0)
        clip_ordinals[clip] = ordinal + 1
        previous = state.get(clip)
        is_calibration = previous is None or ordinal % cadence == 0
        if is_calibration:
            correction = record["reference"] - record["native"]
            candidate = record["reference"].copy()
        else:
            correction = previous[2]
            candidate = record["native"] + correction
        candidate = np.ascontiguousarray(candidate, dtype=np.float32)
        metrics = numerical_metrics(np, record["reference"], candidate)
        frames.append(
            {
                "clip": clip,
                "index": record["index"],
                "calibrationFrame": is_calibration,
                **metrics,
            }
        )
        if previous is not None:
            temporal.append(
                temporal_error(
                    np,
                    previous[0],
                    record["reference"],
                    previous[1],
                    candidate,
                )
            )
        state[clip] = (record["reference"], candidate, correction)
    return {
        "cadence": cadence,
        "calibrationFrames": sum(item["calibrationFrame"] for item in frames),
        "totalFrames": len(frames),
        "frames": frames,
        "mae": summarize(item["mae"] for item in frames),
        "p99Abs": summarize(item["p99Abs"] for item in frames),
        "maxAbs": summarize(item["maxAbs"] for item in frames),
        "psnrDb": summarize(item["psnrDb"] for item in frames),
        "ssim": summarize(item["ssim"] for item in frames),
        "temporalMae": summarize(temporal) if temporal else None,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--plan", type=Path, default=DEFAULT_PLAN)
    parser.add_argument("--input-dir", type=Path, default=DEFAULT_INPUT_DIR)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--expected-plan-sha256", default=EXPECTED_PLAN_SHA256)
    parser.add_argument("--iterations", type=int, default=80)
    parser.add_argument("--warmup", type=int, default=12)
    parser.add_argument(
        "--ort-use-tf32",
        choices=("default", "0", "1"),
        default="default",
        help="Diagnostic-only CUDA-EP TF32 policy; default preserves the frozen reference.",
    )
    args = parser.parse_args()
    args.model = args.model.resolve()
    args.plan = args.plan.resolve()
    args.input_dir = args.input_dir.resolve()
    args.output_dir = args.output_dir.resolve()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    if not args.model.is_file() or not args.plan.is_file():
        raise FileNotFoundError(f"Missing model or plan: {args.model} / {args.plan}")
    if sha256(args.plan) != args.expected_plan_sha256.lower():
        raise RuntimeError("Refusing an unqualified or changed TensorRT plan")
    input_paths = sorted(args.input_dir.glob("*.npy"))
    if not input_paths:
        raise FileNotFoundError(f"No captured GPEN inputs under {args.input_dir}")

    gpu_before = query_gpu()
    np, torch, ort, dll_handles = bootstrap_libraries(enable_tensorrt=True)
    del dll_handles
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA unavailable")
    torch.cuda.set_device(0)
    import tensorrt as trt

    manifest_path = Path(str(args.plan) + ".manifest.json")
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if bool((manifest.get("build") or {}).get("torgbPlugin", False)):
            # A serialized Python-plugin plan cannot be deserialized until its
            # implementation is registered in this process.
            import pong_torgb_plugin  # noqa: F401

    runtime, engine, context, tensors = load_native_engine(trt, args.plan)
    del runtime
    input_name = next(item["name"] for item in tensors if "INPUT" in item["mode"].upper())
    output_name = next(item["name"] for item in tensors if "OUTPUT" in item["mode"].upper())
    expected_shape = (1, 3, 512, 512)
    stream = torch.cuda.Stream(device=0)
    stream_id = int(stream.cuda_stream)
    image = torch.empty(expected_shape, dtype=torch.float32, device="cuda:0")
    native_output = torch.empty_like(image)
    reference_output = torch.empty_like(image)
    if not context.set_tensor_address(input_name, image.data_ptr()):
        raise RuntimeError("TensorRT rejected input address")
    if not context.set_tensor_address(output_name, native_output.data_ptr()):
        raise RuntimeError("TensorRT rejected output address")
    ort_use_tf32 = None if args.ort_use_tf32 == "default" else args.ort_use_tf32 == "1"
    reference = make_ort_reference(ort, stream_id, args.model, use_tf32=ort_use_tf32)
    reference_binding = reference.io_binding()
    reference_binding.bind_input(
        reference.get_inputs()[0].name, "cuda", 0, np.float32, expected_shape, image.data_ptr()
    )
    reference_binding.bind_output(
        reference.get_outputs()[0].name,
        "cuda",
        0,
        np.float32,
        expected_shape,
        reference_output.data_ptr(),
    )

    def run_native():
        if not context.execute_async_v3(stream_id):
            raise RuntimeError("TensorRT execute_async_v3 failed")

    def run_reference():
        reference.run_with_iobinding(reference_binding)

    records = []
    for path in input_paths:
        captured = np.load(path, mmap_mode="r")
        if captured.ndim != 4 or tuple(captured.shape[1:]) != expected_shape[1:]:
            raise RuntimeError(f"Unexpected captured tensor shape {captured.shape}: {path}")
        for index in range(captured.shape[0]):
            fixture = np.array(
                captured[index : index + 1], dtype=np.float32, copy=True, order="C"
            )
            with torch.cuda.stream(stream):
                image.copy_(torch.from_numpy(fixture), non_blocking=False)
                run_reference()
                stream.synchronize()
                ref_cpu = reference_output.detach().cpu().numpy().copy()
                run_native()
                stream.synchronize()
                native_cpu = native_output.detach().cpu().numpy().copy()
            records.append(
                {
                    "clip": path.stem,
                    "index": index,
                    "input": fixture,
                    "reference": ref_cpu,
                    "native": native_cpu,
                }
            )

    train_records = [item for item in records if item["index"] % 2 == 0]
    holdout_records = [item for item in records if item["index"] % 2 == 1]
    train_pairs = [(item["native"], item["reference"]) for item in train_records]
    scale, bias, bias_only = fit_channel_affine(np, train_pairs)
    color_matrix, color_bias = fit_color_matrix(np, train_pairs)
    local_conv, local_conv_samples = fit_local_residual_conv(np, train_records)
    spatial_bias = np.mean(
        np.stack([reference - native for native, reference in train_pairs], axis=0),
        axis=0,
        dtype=np.float64,
    ).astype(np.float32)
    affine_spatial_bias = np.mean(
        np.stack(
            [reference - (native * scale + bias) for native, reference in train_pairs],
            axis=0,
        ),
        axis=0,
        dtype=np.float64,
    ).astype(np.float32)

    variants = {
        "raw": lambda record: record["native"],
        "channelBias": lambda record: record["native"] + bias_only,
        "channelAffine": lambda record: record["native"] * scale + bias,
        "colorMatrix": lambda record: apply_color_matrix(
            np, record["native"], color_matrix, color_bias
        ),
        "spatialBias": lambda record: record["native"] + spatial_bias,
        "channelAffineSpatialBias": lambda record: (
            record["native"] * scale + bias + affine_spatial_bias
        ),
        "localResidualConv3x3": lambda record: apply_local_residual_conv(
            np, record, local_conv
        ),
    }
    evaluation = {
        name: {
            "train": evaluate_variant(np, train_records, transform),
            "holdout": evaluate_variant(np, holdout_records, transform),
        }
        for name, transform in variants.items()
    }
    adaptive_evaluation = {
        f"every{cadence}": evaluate_adaptive_reference(np, records, cadence)
        for cadence in (2, 3, 4, 6, 12)
    }

    # Measure complete native inference plus the correction on the same CUDA
    # stream.  The output is overwritten by each subsequent inference, so these
    # in-place operations do not add a copy that production would not need.
    timing_input = torch.from_numpy(records[-1]["input"]).to("cuda:0")
    gpu_scale = torch.from_numpy(scale).to("cuda:0")
    gpu_bias = torch.from_numpy(bias).to("cuda:0")
    gpu_bias_only = torch.from_numpy(bias_only).to("cuda:0")
    gpu_color_matrix = torch.from_numpy(color_matrix).to("cuda:0")
    gpu_color_bias = torch.from_numpy(color_bias).to("cuda:0")
    gpu_spatial_bias = torch.from_numpy(spatial_bias).to("cuda:0")
    gpu_affine_spatial_bias = torch.from_numpy(affine_spatial_bias).to("cuda:0")
    color_scratch = torch.empty_like(native_output)
    with torch.cuda.stream(stream):
        image.copy_(timing_input)
    stream.synchronize()

    operations = {
        "raw": lambda: run_native(),
        "channelBias": lambda: (run_native(), native_output.add_(gpu_bias_only)),
        "channelAffine": lambda: (
            run_native(),
            native_output.mul_(gpu_scale).add_(gpu_bias),
        ),
        "colorMatrix": lambda: (
            run_native(),
            torch.bmm(
                gpu_color_matrix.unsqueeze(0),
                native_output.flatten(2),
                out=color_scratch.flatten(2),
            ),
            native_output.copy_(color_scratch.add_(gpu_color_bias)),
        ),
        "spatialBias": lambda: (run_native(), native_output.add_(gpu_spatial_bias)),
        "channelAffineSpatialBias": lambda: (
            run_native(),
            native_output.mul_(gpu_scale).add_(gpu_bias).add_(gpu_affine_spatial_bias),
        ),
    }
    timing = {}
    for name, operation in operations.items():
        for _ in range(args.warmup):
            completed_ms(torch, stream, operation)
        values = [completed_ms(torch, stream, operation) for _ in range(args.iterations)]
        timing[name] = {
            "count": len(values),
            "meanMs": statistics.fmean(values),
            "p50Ms": percentile(values, 50),
            "p95Ms": percentile(values, 95),
            "p99Ms": percentile(values, 99),
        }
    raw_p50 = timing["raw"]["p50Ms"]
    for value in timing.values():
        value["p50OverheadMs"] = value["p50Ms"] - raw_p50
        value["p50OverheadPercent"] = 100 * (value["p50Ms"] / raw_p50 - 1)

    report = {
        "schema": 1,
        "analysisOnly": True,
        "model": str(args.model),
        "modelSha256": sha256(args.model),
        "ort": {
            "version": ort.__version__,
            "requestedUseTf32": args.ort_use_tf32,
            "providerOptions": reference.get_provider_options(),
        },
        "plan": str(args.plan),
        "planSha256": sha256(args.plan),
        "inputs": [
            {"path": str(path), "sha256": sha256(path)} for path in input_paths
        ],
        "split": {
            "policy": "per-clip even indices fit, odd indices holdout",
            "trainFrames": len(train_records),
            "holdoutFrames": len(holdout_records),
        },
        "calibration": {
            "channelScale": scale.reshape(3).tolist(),
            "channelBias": bias.reshape(3).tolist(),
            "channelBiasOnly": bias_only.reshape(3).tolist(),
            "colorMatrix": color_matrix.tolist(),
            "colorBias": color_bias.reshape(3).tolist(),
            "spatialBiasMeanAbs": float(np.abs(spatial_bias).mean()),
            "spatialBiasMaxAbs": float(np.abs(spatial_bias).max()),
            "affineSpatialBiasMeanAbs": float(np.abs(affine_spatial_bias).mean()),
            "affineSpatialBiasMaxAbs": float(np.abs(affine_spatial_bias).max()),
            "localResidualConv3x3": {
                "sampleCount": int(local_conv_samples),
                "shape": list(local_conv.shape),
                "coefficients": local_conv.tolist(),
            },
        },
        "evaluation": evaluation,
        "adaptiveReferenceEvaluation": adaptive_evaluation,
        "timing": timing,
        "adaptiveReference": {
            name: {
                "referenceFraction": value["calibrationFrames"] / value["totalFrames"],
                "maeMean": value["mae"]["mean"],
                "maeP95": value["mae"]["p95"],
                "temporalMaeMean": value["temporalMae"]["mean"],
                "temporalMaeP95": value["temporalMae"]["p95"],
                "ssimMean": value["ssim"]["mean"],
            }
            for name, value in adaptive_evaluation.items()
        },
        "gpuBefore": gpu_before,
        "gpuAfter": query_gpu(),
    }
    atomic_write_json(args.output_dir / "report.json", report)
    np.save(args.output_dir / "spatial-bias-f32.npy", spatial_bias)
    np.save(args.output_dir / "affine-spatial-bias-f32.npy", affine_spatial_bias)
    compact = {
        "report": str(args.output_dir / "report.json"),
        "holdout": {
            name: {
                "maeMean": result["holdout"]["mae"]["mean"],
                "maeP95": result["holdout"]["mae"]["p95"],
                "temporalMaeMean": result["holdout"]["temporalMae"]["mean"],
                "ssimMean": result["holdout"]["ssim"]["mean"],
            }
            for name, result in evaluation.items()
        },
        "timing": timing,
    }
    print(json.dumps(compact, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
