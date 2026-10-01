"""Train and qualify a tiny spatial native-to-reference GPEN512 student.

The three temporal acceptance fixtures are deliberately outside this corpus.
Clips 01-18 train, 19-22 select a checkpoint, and 23-24 are a sealed test.
The model predicts only the sub-pixel numerical residual between Pong's fast
native TensorRT GPEN512 result and the frozen CUDA/ORT reference result.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import statistics
import time
from pathlib import Path

import numpy as np

from benchmark_gpen_generated import bootstrap_libraries
from benchmark_gpen512_native_trt import load_native_engine, make_ort_reference


ROOT = Path(__file__).resolve().parent
DEFAULT_CAPTURE = ROOT / "benchmarks" / "gpen512-spatial-student-v2" / "capture"
DEFAULT_OUTPUT = ROOT / "benchmarks" / "gpen512-spatial-student-v2"
DEFAULT_MODEL = ROOT / "runtime" / "models" / "GPEN-BFR-512.onnx"
DEFAULT_PLAN = (
    ROOT / "runtime" / "models" / "ort_trt_cache_gpen512"
    / "native-fp32-tf32-v1" / "gpen512-f5b1b141086ab85ba280.plan"
)


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def percentile(values, percent):
    ordered = sorted(float(value) for value in values)
    if not ordered:
        return 0.0
    position = (len(ordered) - 1) * float(percent) / 100.0
    lower, upper = math.floor(position), math.ceil(position)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def clip_number(path: Path) -> int:
    return int(path.stem.split("-")[1])


def residual_metrics(reference: np.ndarray, candidate: np.ndarray) -> dict:
    delta = np.abs((candidate.astype(np.float64) - reference.astype(np.float64)) * 127.5)
    return {
        "maeRgbLevels": float(delta.mean()),
        "p95AbsRgbLevels": float(np.percentile(delta, 95)),
        "p99AbsRgbLevels": float(np.percentile(delta, 99)),
        "maxAbsRgbLevels": float(delta.max()),
    }


def temporal_error(reference: np.ndarray, candidate: np.ndarray) -> float:
    if len(reference) < 2:
        return 0.0
    reference_delta = np.diff(reference.astype(np.float64), axis=0)
    candidate_delta = np.diff(candidate.astype(np.float64), axis=0)
    return float(np.abs((candidate_delta - reference_delta) * 127.5).mean())


def build_student(torch, channels: int = 20):
    class SpatialResidualStudent(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.stem = torch.nn.Conv2d(9, channels, 3, padding=1)
            self.depthwise = torch.nn.ModuleList([
                torch.nn.Conv2d(
                    channels,
                    channels,
                    3,
                    padding=dilation,
                    dilation=dilation,
                    groups=channels,
                )
                for dilation in (1, 2, 3)
            ])
            self.pointwise = torch.nn.ModuleList([
                torch.nn.Conv2d(channels, channels, 1)
                for _ in range(3)
            ])
            self.output = torch.nn.Conv2d(channels, 3, 3, padding=1)
            torch.nn.init.zeros_(self.output.weight)
            torch.nn.init.zeros_(self.output.bias)

        def forward(self, source, native):
            inputs = torch.cat((source, native, native - source), dim=1)
            hidden = torch.nn.functional.silu(self.stem(inputs))
            for depthwise, pointwise in zip(self.depthwise, self.pointwise):
                update = pointwise(torch.nn.functional.silu(depthwise(hidden)))
                hidden = hidden + 0.25 * update
            # The measured native/reference error is sub-pixel (p99 < 0.04
            # RGB levels).  A tight bound prevents the student from inventing
            # visible texture while leaving enough room for rare tails.
            return 0.5 * torch.tanh(self.output(hidden))

    return SpatialResidualStudent()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--capture-dir", type=Path, default=DEFAULT_CAPTURE)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--plan", type=Path, default=DEFAULT_PLAN)
    parser.add_argument("--updates", type=int, default=8000)
    parser.add_argument("--patch-size", type=int, default=128)
    parser.add_argument("--batch-pairs", type=int, default=2)
    parser.add_argument("--seed", type=int, default=20260920)
    parser.add_argument("--gradient-weight", type=float, default=0.08)
    parser.add_argument("--temporal-weight", type=float, default=0.20)
    parser.add_argument("--tail-weight", type=float, default=0.0)
    parser.add_argument("--validation-tail-weight", type=float, default=0.0)
    parser.add_argument("--validation-temporal-weight", type=float, default=0.0)
    args = parser.parse_args()
    for path in (args.capture_dir, args.model, args.plan):
        if not path.exists():
            raise FileNotFoundError(path)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    pairs_dir = args.output_dir / "pairs"
    pairs_dir.mkdir(parents=True, exist_ok=True)

    random.seed(args.seed)
    np.random.seed(args.seed)
    _np, torch, ort, _dll_handles = bootstrap_libraries(enable_tensorrt=True)
    del _np, _dll_handles
    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    torch.cuda.set_device(0)
    import tensorrt as trt

    capture_paths = sorted(args.capture_dir.glob("clip-*-gpen-inputs-f32.npy"))
    if len(capture_paths) < 20:
        raise RuntimeError("At least 20 independently captured stock sequences are required")

    runtime, engine, context, tensors = load_native_engine(trt, args.plan)
    input_name = next(item["name"] for item in tensors if "INPUT" in item["mode"].upper())
    output_name = next(item["name"] for item in tensors if "OUTPUT" in item["mode"].upper())
    shape = (1, 3, 512, 512)
    stream = torch.cuda.Stream(device=0)
    stream_id = int(stream.cuda_stream)
    input_tensor = torch.empty(shape, dtype=torch.float32, device="cuda:0")
    native_tensor = torch.empty_like(input_tensor)
    reference_tensor = torch.empty_like(input_tensor)
    if not context.set_tensor_address(input_name, input_tensor.data_ptr()):
        raise RuntimeError("TensorRT rejected student input")
    if not context.set_tensor_address(output_name, native_tensor.data_ptr()):
        raise RuntimeError("TensorRT rejected student output")
    reference = make_ort_reference(ort, stream_id, args.model)
    binding = reference.io_binding()
    binding.bind_input("input", "cuda", 0, np.float32, shape, input_tensor.data_ptr())
    binding.bind_output("output", "cuda", 0, np.float32, shape, reference_tensor.data_ptr())

    pair_paths: list[Path] = []
    with torch.cuda.stream(stream), torch.inference_mode():
        for capture_path in capture_paths:
            pair_path = pairs_dir / f"{capture_path.stem.replace('inputs', 'pairs')}.npz"
            pair_paths.append(pair_path)
            source_values = np.load(capture_path, allow_pickle=False)
            source_hash = digest(capture_path)
            if pair_path.is_file():
                with np.load(pair_path, allow_pickle=False) as cached:
                    cached_hash = str(cached["sourceSha256"].item()) if "sourceSha256" in cached else ""
                if cached_hash == source_hash:
                    continue
            native_values = np.empty_like(source_values, dtype=np.float32)
            reference_values = np.empty_like(source_values, dtype=np.float32)
            for index, source in enumerate(source_values):
                input_tensor.copy_(torch.from_numpy(source).to(device="cuda:0"))
                reference.run_with_iobinding(binding)
                stream.synchronize()
                reference_values[index] = reference_tensor[0].cpu().numpy()
                if not context.execute_async_v3(stream_id):
                    raise RuntimeError("TensorRT execution failed")
                stream.synchronize()
                native_values[index] = native_tensor[0].cpu().numpy()
            np.savez(
                pair_path,
                source=source_values.astype(np.float32, copy=False),
                native=native_values,
                reference=reference_values,
                sourceSha256=np.asarray(source_hash),
            )

    del reference, binding, context, engine, runtime
    torch.cuda.empty_cache()

    train_paths = [path for path in pair_paths if clip_number(path) <= 18]
    validation_paths = [path for path in pair_paths if 19 <= clip_number(path) <= 22]
    test_paths = [path for path in pair_paths if clip_number(path) >= 23]
    if len(train_paths) < 14 or len(validation_paths) < 4 or len(test_paths) < 2:
        raise RuntimeError("Sequence-level train/validation/test split is too small")

    def load_sequences(paths):
        return [dict(np.load(path, allow_pickle=False)) for path in paths]

    train_sequences = load_sequences(train_paths)
    validation_sequences = load_sequences(validation_paths)
    test_sequences = load_sequences(test_paths)
    model = build_student(torch).to("cuda:0").train()
    optimizer = torch.optim.AdamW(model.parameters(), lr=8e-4, weight_decay=1e-6)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.updates, eta_min=8e-5)
    patch = int(args.patch_size)
    pair_batch = int(args.batch_pairs)
    if not 64 <= patch <= 256 or not 1 <= pair_batch <= 4:
        raise ValueError("Invalid patch or pair batch")

    losses: list[float] = []
    best_validation = math.inf
    best_validation_metrics: dict[str, float] | None = None
    best_state = None

    def tensor_batch(sequence, name, indices, top, left):
        value = np.ascontiguousarray(
            sequence[name][indices, :, top:top + patch, left:left + patch]
        )
        return torch.from_numpy(value).to(device="cuda:0", dtype=torch.float32)

    def validation_score() -> tuple[float, dict[str, float]]:
        absolute_values = []
        temporal_values = []
        model.eval()
        with torch.inference_mode():
            for sequence in validation_sequences:
                sequence_corrected = []
                for start in range(0, len(sequence["source"]), 2):
                    stop = min(start + 2, len(sequence["source"]))
                    source = torch.from_numpy(sequence["source"][start:stop]).to("cuda:0")
                    native = torch.from_numpy(sequence["native"][start:stop]).to("cuda:0")
                    reference_value = torch.from_numpy(sequence["reference"][start:stop]).to("cuda:0")
                    corrected = native + model(source, native) / 127.5
                    absolute_values.append(
                        torch.abs((corrected - reference_value) * 127.5).flatten().cpu()
                    )
                    sequence_corrected.append(corrected.cpu())
                corrected_sequence = torch.cat(sequence_corrected, dim=0)
                reference_sequence = torch.from_numpy(sequence["reference"])
                if len(corrected_sequence) > 1:
                    temporal_values.append(
                        torch.abs(
                            (
                                torch.diff(corrected_sequence, dim=0)
                                - torch.diff(reference_sequence, dim=0)
                            )
                            * 127.5
                        ).flatten()
                    )
        absolute = torch.cat(absolute_values)
        temporal = torch.cat(temporal_values)
        p99_index = max(1, min(absolute.numel(), int(0.99 * absolute.numel())))
        metrics = {
            "maeRgbLevels": float(absolute.mean().item()),
            "p99RgbLevels": float(torch.kthvalue(absolute, p99_index).values.item()),
            "temporalRgbLevels": float(temporal.mean().item()),
        }
        score = (
            metrics["maeRgbLevels"]
            + float(args.validation_tail_weight) * metrics["p99RgbLevels"]
            + float(args.validation_temporal_weight) * metrics["temporalRgbLevels"]
        )
        model.train()
        return score, metrics

    for update in range(args.updates):
        sequence = train_sequences[random.randrange(len(train_sequences))]
        count = len(sequence["source"])
        first_index = random.randrange(max(1, count - 1))
        indices = []
        for pair_index in range(pair_batch):
            index = min(first_index + pair_index, count - 1)
            indices.extend((index, min(index + 1, count - 1)))
        top = random.randrange(0, 512 - patch + 1)
        left = random.randrange(0, 512 - patch + 1)
        source = tensor_batch(sequence, "source", indices, top, left)
        native = tensor_batch(sequence, "native", indices, top, left)
        target = (tensor_batch(sequence, "reference", indices, top, left) - native) * 127.5
        predicted = model(source, native)
        absolute_loss = torch.nn.functional.smooth_l1_loss(predicted, target, beta=0.002)
        pred_dx = predicted[:, :, :, 1:] - predicted[:, :, :, :-1]
        target_dx = target[:, :, :, 1:] - target[:, :, :, :-1]
        pred_dy = predicted[:, :, 1:, :] - predicted[:, :, :-1, :]
        target_dy = target[:, :, 1:, :] - target[:, :, :-1, :]
        gradient_loss = (
            torch.nn.functional.l1_loss(pred_dx, target_dx)
            + torch.nn.functional.l1_loss(pred_dy, target_dy)
        ) * 0.5
        absolute_error = torch.abs(predicted - target)
        tail_count = max(1, absolute_error[0].numel() // 100)
        tail_loss = torch.topk(
            absolute_error.flatten(1), tail_count, dim=1, sorted=False
        ).values.mean()
        temporal_losses = []
        for index in range(0, len(indices), 2):
            temporal_losses.append(torch.nn.functional.smooth_l1_loss(
                predicted[index + 1] - predicted[index],
                target[index + 1] - target[index],
                beta=0.002,
            ))
        temporal_loss = torch.stack(temporal_losses).mean()
        loss = (
            absolute_loss
            + float(args.gradient_weight) * gradient_loss
            + float(args.temporal_weight) * temporal_loss
            + float(args.tail_weight) * tail_loss
        )
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        scheduler.step()
        losses.append(float(loss.detach().item()))
        if (update + 1) % 500 == 0 or update + 1 == args.updates:
            score, validation_metrics = validation_score()
            if score < best_validation:
                best_validation = score
                best_validation_metrics = validation_metrics
                best_state = {
                    name: value.detach().cpu().clone()
                    for name, value in model.state_dict().items()
                }

    if best_state is None:
        raise RuntimeError("No validation checkpoint was produced")
    model.load_state_dict(best_state)
    model.eval()
    checkpoint = args.output_dir / "gpen512-native-cuda-spatial-student-v2.pt"
    torch.save({
        "schema": "pong-gpen512-spatial-student-v2",
        "seed": args.seed,
        "stateDict": model.state_dict(),
        "channels": 20,
        "modelSha256": digest(args.model),
        "planSha256": digest(args.plan),
    }, checkpoint)

    def evaluate(paths, sequences):
        reports = []
        with torch.inference_mode():
            for path, sequence in zip(paths, sequences):
                corrected_frames = []
                for start in range(0, len(sequence["source"]), 2):
                    stop = min(start + 2, len(sequence["source"]))
                    source = torch.from_numpy(sequence["source"][start:stop]).to("cuda:0")
                    native = torch.from_numpy(sequence["native"][start:stop]).to("cuda:0")
                    corrected = native + model(source, native) / 127.5
                    corrected_frames.append(corrected.cpu().numpy())
                corrected_values = np.concatenate(corrected_frames, axis=0)
                before = residual_metrics(sequence["reference"], sequence["native"])
                after = residual_metrics(sequence["reference"], corrected_values)
                temporal_before = temporal_error(sequence["reference"], sequence["native"])
                temporal_after = temporal_error(sequence["reference"], corrected_values)
                reports.append({
                    "sequence": path.name,
                    "before": before,
                    "after": after,
                    "maeReductionPercent": 100.0 * (1.0 - after["maeRgbLevels"] / before["maeRgbLevels"]),
                    "p99ReductionPercent": 100.0 * (1.0 - after["p99AbsRgbLevels"] / before["p99AbsRgbLevels"]),
                    "temporalBeforeRgbLevels": temporal_before,
                    "temporalAfterRgbLevels": temporal_after,
                })
        return reports

    validation_reports = evaluate(validation_paths, validation_sequences)
    test_reports = evaluate(test_paths, test_sequences)
    timing_source = torch.from_numpy(test_sequences[0]["source"][0:1]).to("cuda:0")
    timing_native = torch.from_numpy(test_sequences[0]["native"][0:1]).to("cuda:0")
    with torch.inference_mode():
        for _ in range(30):
            model(timing_source, timing_native)
        torch.cuda.synchronize()
        timing_values = []
        for _ in range(200):
            started = time.perf_counter_ns()
            model(timing_source, timing_native)
            torch.cuda.synchronize()
            timing_values.append((time.perf_counter_ns() - started) / 1e6)

    test_min_mae = min(item["maeReductionPercent"] for item in test_reports)
    test_min_p99 = min(item["p99ReductionPercent"] for item in test_reports)
    test_temporal_nonincrease = all(
        item["temporalAfterRgbLevels"] <= item["temporalBeforeRgbLevels"]
        for item in test_reports
    )
    timing_p95 = percentile(timing_values, 95)
    passed = bool(
        test_min_mae > 0.0
        and test_min_p99 >= 0.0
        and test_temporal_nonincrease
        and timing_p95 <= 3.0
    )
    report = {
        "schema": "pong-gpen512-spatial-student-v2",
        "status": "pass" if passed else "fail",
        "acceptanceCorpusExcluded": True,
        "split": {
            "train": [path.name for path in train_paths],
            "validation": [path.name for path in validation_paths],
            "sealedTest": [path.name for path in test_paths],
        },
        "modelSha256": digest(args.model),
        "planSha256": digest(args.plan),
        "checkpoint": str(checkpoint),
        "checkpointSha256": digest(checkpoint),
        "updates": args.updates,
        "trainingWeights": {
            "gradient": float(args.gradient_weight),
            "temporal": float(args.temporal_weight),
            "tail": float(args.tail_weight),
            "validationTail": float(args.validation_tail_weight),
            "validationTemporal": float(args.validation_temporal_weight),
        },
        "trainingLoss": {
            "first": losses[0],
            "last": losses[-1],
            "medianLast100": statistics.median(losses[-100:]),
            "bestValidationMaeNormalized": best_validation,
            "bestValidationMetrics": best_validation_metrics,
        },
        "validation": validation_reports,
        "sealedTest": test_reports,
        "gates": {
            "testMinimumMaeReductionPercent": test_min_mae,
            "testMinimumP99ReductionPercent": test_min_p99,
            "testTemporalNonincrease": test_temporal_nonincrease,
            "studentP50Ms": percentile(timing_values, 50),
            "studentP95Ms": timing_p95,
        },
    }
    report_path = args.output_dir / "report.json"
    report_path.write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps({"report": str(report_path), **report["gates"], "status": report["status"]}, indent=2))


if __name__ == "__main__":
    main()
