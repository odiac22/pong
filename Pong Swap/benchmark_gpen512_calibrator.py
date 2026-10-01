"""One-shot GPEN512 native-to-CUDA residual-calibrator feasibility test.

Inputs are benchmark-captured normalized GPEN tensors from the independent
public stock corpus.  The three temporal acceptance videos are never used for
fitting or checkpoint selection.  This script intentionally trains one fixed
architecture, one seed, and one final checkpoint; it is not a sweep.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
import time

import numpy as np

from benchmark_gpen_generated import bootstrap_libraries
from benchmark_gpen512_native_trt import load_native_engine, make_ort_reference


ROOT = Path(__file__).resolve().parent
DEFAULT_CAPTURE = ROOT / "benchmarks" / "gpen512-calibrator-v1" / "capture"
DEFAULT_OUTPUT = ROOT / "benchmarks" / "gpen512-calibrator-v1"
DEFAULT_MODEL = ROOT / "runtime" / "models" / "GPEN-BFR-512.onnx"
DEFAULT_PLAN = (
    ROOT / "runtime" / "models" / "ort_trt_cache_gpen512"
    / "native-fp32-tf32-v1" / "gpen512-f5b1b141086ab85ba280.plan"
)


def percentile(values, percent):
    ordered = sorted(float(value) for value in values)
    position = (len(ordered) - 1) * float(percent) / 100.0
    lower, upper = math.floor(position), math.ceil(position)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def metrics(reference: np.ndarray, candidate: np.ndarray) -> dict:
    delta = np.abs((candidate.astype(np.float64) - reference.astype(np.float64)) * 127.5)
    return {
        "maeRgb": float(delta.mean()),
        "p99AbsRgb": float(np.percentile(delta, 99)),
        "maxAbsRgb": float(delta.max()),
    }


def temporal_error(reference: np.ndarray, candidate: np.ndarray) -> float:
    if len(reference) < 2:
        return 0.0
    reference_delta = np.diff(reference.astype(np.float64), axis=0)
    candidate_delta = np.diff(candidate.astype(np.float64), axis=0)
    return float(np.abs((candidate_delta - reference_delta) * 127.5).mean())


def build_corrector(torch):
    class ResidualCorrector(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.input_conv = torch.nn.Conv2d(6, 8, 3, padding=1)
            self.depthwise = torch.nn.Conv2d(8, 8, 3, padding=1, groups=8)
            self.output_conv = torch.nn.Conv2d(8, 3, 1)
            torch.nn.init.zeros_(self.output_conv.weight)
            torch.nn.init.zeros_(self.output_conv.bias)

        def forward(self, source, native):
            hidden = torch.relu(self.input_conv(torch.cat((source, native), dim=1)))
            hidden = torch.relu(self.depthwise(hidden))
            # RGB-level correction, bounded by construction to +/-4 levels.
            return 4.0 * torch.tanh(self.output_conv(hidden))

    return ResidualCorrector()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--capture-dir", type=Path, default=DEFAULT_CAPTURE)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--plan", type=Path, default=DEFAULT_PLAN)
    parser.add_argument("--updates", type=int, default=2000)
    parser.add_argument("--patch-size", type=int, default=96)
    parser.add_argument("--seed", type=int, default=20260920)
    args = parser.parse_args()
    if args.updates != 2000:
        raise ValueError("The bounded experiment requires exactly 2000 updates")
    for path in (args.capture_dir, args.model, args.plan):
        if not path.exists():
            raise FileNotFoundError(path)
    args.output_dir.mkdir(parents=True, exist_ok=True)

    random.seed(args.seed)
    np.random.seed(args.seed)
    np_lib, torch, ort, dll_handles = bootstrap_libraries(enable_tensorrt=True)
    del np_lib, dll_handles
    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    torch.cuda.set_device(0)
    import tensorrt as trt

    capture_paths = sorted(args.capture_dir.glob("clip-*-gpen-inputs-f32.npy"))
    if len(capture_paths) < 12:
        raise RuntimeError("At least 12 independent captured stock sequences are required")
    train_paths = [path for path in capture_paths if int(path.stem.split("-")[1]) <= 12]
    held_paths = [path for path in capture_paths if int(path.stem.split("-")[1]) > 12]
    if len(train_paths) < 8 or len(held_paths) < 4:
        raise RuntimeError("Sequence-level train/held-out split is too small")

    runtime, engine, context, tensors = load_native_engine(trt, args.plan)
    input_name = next(item["name"] for item in tensors if "INPUT" in item["mode"].upper())
    output_name = next(item["name"] for item in tensors if "OUTPUT" in item["mode"].upper())
    shape = (1, 3, 512, 512)
    stream = torch.cuda.Stream(device=0)
    stream_id = int(stream.cuda_stream)
    input_tensor = torch.empty(shape, dtype=torch.float32, device="cuda:0")
    native_tensor = torch.empty_like(input_tensor)
    cuda_tensor = torch.empty_like(input_tensor)
    if not context.set_tensor_address(input_name, input_tensor.data_ptr()):
        raise RuntimeError("TensorRT rejected calibrator input")
    if not context.set_tensor_address(output_name, native_tensor.data_ptr()):
        raise RuntimeError("TensorRT rejected calibrator output")
    reference = make_ort_reference(ort, stream_id, args.model)
    binding = reference.io_binding()
    binding.bind_input("input", "cuda", 0, np.float32, shape, input_tensor.data_ptr())
    binding.bind_output("output", "cuda", 0, np.float32, shape, cuda_tensor.data_ptr())

    def run_native():
        if not context.execute_async_v3(stream_id):
            raise RuntimeError("TensorRT execution failed")

    def run_cuda():
        reference.run_with_iobinding(binding)

    pairs_dir = args.output_dir / "pairs"
    pairs_dir.mkdir(parents=True, exist_ok=True)
    pair_paths = []
    deterministic = {}
    with torch.cuda.stream(stream), torch.inference_mode():
        for capture_path in capture_paths:
            source_values = np.load(capture_path, allow_pickle=False)
            native_values = np.empty_like(source_values, dtype=np.float32)
            cuda_values = np.empty_like(source_values, dtype=np.float32)
            for index, source in enumerate(source_values):
                input_tensor.copy_(torch.from_numpy(source).to(device="cuda:0"))
                run_cuda()
                stream.synchronize()
                cuda_values[index] = cuda_tensor[0].cpu().numpy()
                run_native()
                stream.synchronize()
                native_values[index] = native_tensor[0].cpu().numpy()
            pair_path = pairs_dir / (
                capture_path.stem.replace("inputs", "pairs") + ".npz"
            )
            np.savez(
                pair_path,
                source=source_values.astype(np.float32, copy=False),
                native=native_values,
                reference=cuda_values,
            )
            pair_paths.append(pair_path)

        # Same-address repeated calls must be deterministic before a residual
        # learned from paired outputs can be meaningful.
        first = np.load(capture_paths[0], allow_pickle=False)[0]
        input_tensor.copy_(torch.from_numpy(first).to(device="cuda:0"))
        run_cuda(); stream.synchronize(); cuda_a = cuda_tensor.clone()
        run_cuda(); stream.synchronize(); cuda_b = cuda_tensor.clone()
        run_native(); stream.synchronize(); native_a = native_tensor.clone()
        run_native(); stream.synchronize(); native_b = native_tensor.clone()
        deterministic = {
            "cudaExact": bool(torch.equal(cuda_a, cuda_b)),
            "nativeExact": bool(torch.equal(native_a, native_b)),
            "cudaMaxAbs": float(torch.max(torch.abs(cuda_a - cuda_b)).item()),
            "nativeMaxAbs": float(torch.max(torch.abs(native_a - native_b)).item()),
        }

    del reference, binding, context, engine, runtime
    torch.cuda.empty_cache()

    pair_by_name = {path.name: path for path in pair_paths}
    train_pair_paths = [
        pair_by_name[path.stem.replace("inputs", "pairs") + ".npz"]
        for path in train_paths
    ]
    held_pair_paths = [
        pair_by_name[path.stem.replace("inputs", "pairs") + ".npz"]
        for path in held_paths
    ]
    train_sequences = [dict(np.load(path, allow_pickle=False)) for path in train_pair_paths]
    held_sequences = [dict(np.load(path, allow_pickle=False)) for path in held_pair_paths]

    model = build_corrector(torch).to("cuda:0").train()
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-5)
    patch = int(args.patch_size)
    if patch < 32 or patch > 256:
        raise ValueError("Patch size must be in [32, 256]")
    losses = []
    for update in range(args.updates):
        sequence = train_sequences[random.randrange(len(train_sequences))]
        count = int(sequence["source"].shape[0])
        first_index = random.randrange(max(1, count - 1))
        second_index = min(first_index + 1, count - 1)
        top = random.randrange(0, 512 - patch + 1)
        left = random.randrange(0, 512 - patch + 1)
        indices = [first_index, second_index]

        def batch(name):
            value = np.ascontiguousarray(
                sequence[name][indices, :, top:top + patch, left:left + patch]
            )
            return torch.from_numpy(value).to(device="cuda:0", dtype=torch.float32)

        source = batch("source")
        native = batch("native")
        target = (batch("reference") - native) * 127.5
        predicted = model(source, native)
        absolute_loss = torch.nn.functional.smooth_l1_loss(
            predicted, target, beta=0.05
        )
        temporal_loss = torch.nn.functional.smooth_l1_loss(
            predicted[1] - predicted[0], target[1] - target[0], beta=0.05
        )
        loss = absolute_loss + 0.25 * temporal_loss
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
        losses.append(float(loss.detach().item()))

    checkpoint = args.output_dir / "gpen512-native-cuda-corrector-v1.pt"
    torch.save({
        "schema": "pong-gpen512-calibrator-v1",
        "seed": args.seed,
        "updates": args.updates,
        "stateDict": model.state_dict(),
        "architecture": "cat(input,native)-conv3x3x8-relu-depthwise3x3-relu-conv1x1x3-tanh4rgb",
        "modelSha256": digest(args.model),
        "planSha256": digest(args.plan),
    }, checkpoint)

    model.eval()
    held_reports = []
    before_all = []
    after_all = []
    temporal_before = []
    temporal_after = []
    with torch.inference_mode():
        for path, sequence in zip(held_pair_paths, held_sequences):
            corrected_frames = []
            for source, native in zip(sequence["source"], sequence["native"]):
                source_t = torch.from_numpy(source[None]).to("cuda:0")
                native_t = torch.from_numpy(native[None]).to("cuda:0")
                correction = model(source_t, native_t)
                # Compare in the restorer's native floating-point domain.  Both
                # production backends legitimately produce a small number of
                # values outside [-1, 1]; clamping here would measure clipping,
                # not the residual corrector.
                corrected = native_t + correction / 127.5
                corrected_frames.append(corrected[0].cpu().numpy())
            corrected_values = np.stack(corrected_frames)
            before = metrics(sequence["reference"], sequence["native"])
            after = metrics(sequence["reference"], corrected_values)
            before_temporal = temporal_error(sequence["reference"], sequence["native"])
            after_temporal = temporal_error(sequence["reference"], corrected_values)
            before_all.append(before)
            after_all.append(after)
            temporal_before.append(before_temporal)
            temporal_after.append(after_temporal)
            held_reports.append({
                "sequence": path.name,
                "before": before,
                "after": after,
                "maeReductionPercent": 100.0 * (1.0 - after["maeRgb"] / before["maeRgb"]),
                "p99ReductionPercent": 100.0 * (1.0 - after["p99AbsRgb"] / before["p99AbsRgb"]),
                "temporalBeforeRgb": before_temporal,
                "temporalAfterRgb": after_temporal,
            })

        timing_source = torch.from_numpy(held_sequences[0]["source"][0:1]).to("cuda:0")
        timing_native = torch.from_numpy(held_sequences[0]["native"][0:1]).to("cuda:0")
        for _ in range(20):
            model(timing_source, timing_native)
        torch.cuda.synchronize()
        timing_values = []
        for _ in range(200):
            started = time.perf_counter_ns()
            model(timing_source, timing_native)
            torch.cuda.synchronize()
            timing_values.append((time.perf_counter_ns() - started) / 1e6)

    checkpoint_hash = digest(checkpoint)
    minimum_mae_reduction = min(item["maeReductionPercent"] for item in held_reports)
    minimum_p99_reduction = min(item["p99ReductionPercent"] for item in held_reports)
    max_error_nonincrease = all(
        after["maxAbsRgb"] <= before["maxAbsRgb"] + 1e-9
        for before, after in zip(before_all, after_all)
    )
    temporal_nonincrease = all(
        after <= before + 1e-9
        for before, after in zip(temporal_before, temporal_after)
    )
    timing_p95 = percentile(timing_values, 95)
    feasibility_pass = (
        deterministic["cudaExact"]
        and deterministic["nativeExact"]
        and minimum_mae_reduction >= 50.0
        and minimum_p99_reduction >= 50.0
        and max_error_nonincrease
        and temporal_nonincrease
        and timing_p95 <= 0.25
    )
    report = {
        "schema": "pong-gpen512-calibrator-feasibility-v1",
        "status": "pass" if feasibility_pass else "fail",
        "seed": args.seed,
        "updates": args.updates,
        "trainSequences": [path.name for path in train_pair_paths],
        "heldSequences": [path.name for path in held_pair_paths],
        "acceptanceCorpusExcluded": True,
        "modelSha256": digest(args.model),
        "planSha256": digest(args.plan),
        "checkpoint": str(checkpoint),
        "checkpointSha256": checkpoint_hash,
        "determinism": deterministic,
        "trainingLoss": {
            "first": losses[0],
            "last": losses[-1],
            "medianLast100": statistics.median(losses[-100:]),
        },
        "heldOut": held_reports,
        "gates": {
            "minimumMaeReductionPercent": minimum_mae_reduction,
            "minimumP99ReductionPercent": minimum_p99_reduction,
            "maxErrorNonincrease": max_error_nonincrease,
            "temporalErrorNonincrease": temporal_nonincrease,
            "correctorP50Ms": percentile(timing_values, 50),
            "correctorP95Ms": timing_p95,
            "requiredReductionPercent": 50.0,
            "maximumCorrectorP95Ms": 0.25,
        },
    }
    report_path = args.output_dir / "calibrator-report.json"
    report_path.write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps({
        "status": report["status"],
        "minimumMaeReductionPercent": minimum_mae_reduction,
        "minimumP99ReductionPercent": minimum_p99_reduction,
        "maxErrorNonincrease": max_error_nonincrease,
        "temporalErrorNonincrease": temporal_nonincrease,
        "correctorP95Ms": timing_p95,
        "report": str(report_path),
    }, indent=2))


if __name__ == "__main__":
    main()
