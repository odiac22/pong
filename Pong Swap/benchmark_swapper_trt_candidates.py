"""Isolated, strict-quality swapper TRT-EP profile experiment.

Run `capture` first to save real FP32 call-boundary inputs and outputs from the
unchanged renderer, then `verify` to build isolated TRT-EP cache variants.
Neither command edits the production model cache or engine source.
"""

import argparse
import hashlib
import json
import runpy
import statistics
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
MODEL = ROOT / "runtime/models/inswapper_128.fp16.onnx"
PROFILE = Path(r"E:\Pong Benchmarks\v3030-exact-stage-profile\profile_exact_stages.py")
DEFAULT_DIR = Path(r"E:\Pong Benchmarks\v3030-swapper-trt-candidates")
BASELINE_HASH = "471c54071f3976ea2c7b864047e40c0e635a1cf774ba70661214ee682f971d6d"


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(4 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def capture(args):
    # Install before the external profiler imports PongSwapEngine, but do not
    # import that engine here: the profiler must install its temporary config.
    from pong_swap_config import ROPE_ROOT
    sys.path.insert(0, str(ROPE_ROOT))
    from rope.Models import Models

    selected = {1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233}
    original = Models.run_swapper
    calls = [0]
    metadata = []
    args.output_dir.mkdir(parents=True, exist_ok=True)
    capture_dir = args.output_dir / "captures"
    capture_dir.mkdir(exist_ok=True)

    def wrapped(self, image, embedding, output):
        calls[0] += 1
        collect = calls[0] in selected
        if collect:
            target_np = image.detach().cpu().numpy().copy()
            source_np = embedding.detach().cpu().numpy().copy()
        result = original(self, image, embedding, output)
        if collect:
            output_np = output.detach().cpu().numpy().copy()
            if target_np.shape != (1, 3, 128, 128) or source_np.shape != (1, 512):
                raise RuntimeError("Unexpected swapper input shape")
            if any(x.dtype != np.float32 for x in (target_np, source_np, output_np)):
                raise RuntimeError("Expected FP32 caller boundary")
            name = f"call-{calls[0]:04d}.npz"
            np.savez_compressed(capture_dir / name, target=target_np, source=source_np, output=output_np)
            metadata.append({
                "call": calls[0], "file": name,
                "targetSha256": hashlib.sha256(target_np.tobytes()).hexdigest(),
                "sourceSha256": hashlib.sha256(source_np.tobytes()).hexdigest(),
                "outputSha256": hashlib.sha256(output_np.tobytes()).hexdigest(),
                "targetRange": [float(target_np.min()), float(target_np.max())],
                "sourceRange": [float(source_np.min()), float(source_np.max())],
                "outputRange": [float(output_np.min()), float(output_np.max())],
            })
        return result

    Models.run_swapper = wrapped
    old_argv = sys.argv
    try:
        sys.argv = [str(PROFILE), "--source", str(args.source), "--seconds", str(args.seconds),
                    "--output-dir", str(args.output_dir / "profile")]
        runpy.run_path(str(PROFILE), run_name="__main__")
    finally:
        sys.argv = old_argv
        Models.run_swapper = original
    manifest = {"model": str(MODEL), "modelSha256": sha256(MODEL), "source": str(args.source),
                "calls": calls[0], "samples": metadata}
    (capture_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"captureManifest": str(capture_dir / "manifest.json"), "samples": len(metadata)}))


def verify(args):
    sys.path.insert(0, str(ROOT / "engine" / "Rope"))
    from rope import _native_dlls
    import torch
    import onnxruntime as ort
    # The cached ORT plan includes FP32 LayerNorm fallback. A raw TensorRT
    # builder cannot preserve that property and is intentionally not used.
    del _native_dlls
    if not torch.cuda.is_available() or torch.cuda.current_device() != 0:
        raise RuntimeError("This experiment requires CUDA:0")
    if sha256(MODEL) != json.loads((args.output_dir / "captures/manifest.json").read_text())['modelSha256']:
        raise RuntimeError("Capture/model SHA mismatch")
    baseline_plan = ROOT / "runtime/models/ort_trt_cache/TensorrtExecutionProvider_TRTKernel_graph_torch_jit_16043652725959116708_0_0_fp16_sm89.engine"
    if sha256(baseline_plan) != BASELINE_HASH:
        raise RuntimeError("Qualified ORT cached-plan hash changed")
    captures = sorted((args.output_dir / "captures").glob("call-*.npz"))
    if not captures:
        raise RuntimeError("No real swapper captures")
    samples = []
    for path in captures:
        with np.load(path) as values:
            samples.append((path.name, values["target"].copy(), values["source"].copy(), values["output"].copy()))
    stream = torch.cuda.Stream(device="cuda:0")
    torch.cuda.set_stream(stream)
    source_shapes = "target:1x3x128x128,source:1x512"
    report = {"modelSha256": sha256(MODEL), "qualifiedPlanSha256": BASELINE_HASH,
              "modelSizeBytes": MODEL.stat().st_size, "samples": len(samples), "candidates": []}

    for aux in (0, 1):
        label = f"fixed-n1-aux{aux}"
        cache = args.output_dir / "plans" / label
        cache.mkdir(parents=True, exist_ok=True)
        options = {
            "device_id": "0", "user_compute_stream": str(stream.cuda_stream),
            "trt_max_workspace_size": str(4 << 30),
            "trt_engine_cache_enable": "True", "trt_engine_cache_path": str(cache),
            "trt_timing_cache_enable": "True", "trt_timing_cache_path": str(cache),
            "trt_fp16_enable": "True", "trt_layer_norm_fp32_fallback": "True",
            "trt_builder_optimization_level": "5", "trt_auxiliary_streams": str(aux),
            "trt_profile_min_shapes": source_shapes,
            "trt_profile_opt_shapes": source_shapes,
            "trt_profile_max_shapes": source_shapes,
        }
        start_build = time.perf_counter()
        session = ort.InferenceSession(str(MODEL), providers=[
            ("TensorrtExecutionProvider", options),
            ("CUDAExecutionProvider", {"device_id": "0", "user_compute_stream": str(stream.cuda_stream)}),
        ])
        if session.get_providers()[0] != "TensorrtExecutionProvider":
            raise RuntimeError(f"TRT provider did not initialize: {session.get_providers()}")
        input_types = {x.name: (x.type, x.shape) for x in session.get_inputs()}
        output_types = {x.name: (x.type, x.shape) for x in session.get_outputs()}
        # Keep identical FP32 caller / FP16 model / FP32 caller boundaries.
        target = torch.empty((1, 3, 128, 128), device="cuda:0", dtype=torch.float16)
        source = torch.empty((1, 512), device="cuda:0", dtype=torch.float16)
        result = torch.empty_like(target)
        final = torch.empty((1, 3, 128, 128), device="cuda:0", dtype=torch.float32)
        binding = session.io_binding()
        for name, tensor in (("target", target), ("source", source)):
            binding.bind_input(name, "cuda", 0, np.float16, tuple(tensor.shape), tensor.data_ptr())
        binding.bind_output("output", "cuda", 0, np.float16, tuple(result.shape), result.data_ptr())
        diffs = []
        byte_equal = True
        cold_ready_seconds = None
        for filename, image, embedding, expected in samples:
            target.copy_(torch.from_numpy(image))
            source.copy_(torch.from_numpy(embedding))
            session.run_with_iobinding(binding)
            if cold_ready_seconds is None:
                torch.cuda.synchronize()
                cold_ready_seconds = time.perf_counter() - start_build
            final.copy_(result)
            actual = final.cpu().numpy()
            delta = actual.astype(np.float64) - expected.astype(np.float64)
            exact = actual.tobytes() == expected.tobytes()
            byte_equal &= exact
            diffs.append({"file": filename, "byteEqual": exact,
                          "maxAbs": float(np.max(np.abs(delta))),
                          "rmse": float(np.sqrt(np.mean(delta * delta))),
                          "mismatched": int(np.count_nonzero(actual.view(np.uint32) != expected.view(np.uint32)))})
        torch.cuda.synchronize()
        verify_seconds = time.perf_counter() - start_build
        # Warm and time only the unchanged run_swapper I/O boundary. CUDA
        # events include data conversions, ORT enqueue and output copy.
        image = torch.from_numpy(samples[0][1]).to("cuda:0")
        embedding = torch.from_numpy(samples[0][2]).to("cuda:0")
        for _ in range(20):
            target.copy_(image); source.copy_(embedding)
            session.run_with_iobinding(binding); final.copy_(result)
        torch.cuda.synchronize()
        gpu_ms, host_ms = [], []
        for _ in range(100):
            begin = torch.cuda.Event(enable_timing=True)
            end = torch.cuda.Event(enable_timing=True)
            wall = time.perf_counter()
            begin.record(stream)
            target.copy_(image); source.copy_(embedding)
            session.run_with_iobinding(binding); final.copy_(result)
            end.record(stream)
            end.synchronize()
            host_ms.append((time.perf_counter() - wall) * 1000)
            gpu_ms.append(begin.elapsed_time(end))
        plans = [{"file": p.name, "bytes": p.stat().st_size, "sha256": sha256(p)}
                 for p in cache.glob("*.engine")]
        candidate = {"name": label, "options": options, "coldReadySeconds": cold_ready_seconds,
                     "verificationSeconds": verify_seconds,
                     "providers": session.get_providers(), "inputs": input_types, "outputs": output_types,
                     "plans": plans, "allByteEqual": byte_equal, "diffs": diffs,
                     "gpuMedianMs": statistics.median(gpu_ms),
                     "hostMedianMs": statistics.median(host_ms)}
        report["candidates"].append(candidate)
        (args.output_dir / "verify-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps({"candidate": label, "allByteEqual": byte_equal,
                          "gpuMedianMs": candidate["gpuMedianMs"],
                          "hostMedianMs": candidate["hostMedianMs"],
                          "coldReadySeconds": cold_ready_seconds, "plans": plans}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("capture", "verify"))
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_DIR)
    parser.add_argument("--source", type=Path, default=Path(r"E:\Pong Benchmarks\v2906-occlusion\segments\minute.mp4"))
    parser.add_argument("--seconds", type=float, default=8.0)
    args = parser.parse_args()
    if args.mode == "capture":
        capture(args)
    else:
        verify(args)
