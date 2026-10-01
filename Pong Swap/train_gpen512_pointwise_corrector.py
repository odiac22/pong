"""Train and evaluate a tiny GPEN512 TensorRT-to-ORT residual corrector.

Analysis only: reads silent benchmark tensors, runs the immutable native plan
and CUDA-EP reference, and writes a state dict plus JSON metrics.  It neither
imports the Pong service nor changes runtime configuration.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import time

from benchmark_gpen512_calibration import (
    evaluate_variant,
    load_native_engine,
    make_ort_reference,
    sha256,
)
from benchmark_gpen_generated import bootstrap_libraries, query_gpu


ROOT = Path(__file__).resolve().parent
DEFAULT_MODEL = ROOT / "runtime" / "models" / "GPEN-BFR-512.onnx"
DEFAULT_PLAN = (
    ROOT
    / "runtime"
    / "models"
    / "ort_trt_cache_gpen512"
    / "native-fp32-tf32-v1"
    / "gpen512-f5b1b141086ab85ba280.plan"
)
DEFAULT_TRAIN = ROOT / "benchmarks" / "gpen512-calibrator-v1" / "capture"
DEFAULT_EXTERNAL = ROOT / "benchmarks" / "gpen512-calibration-inputs"
DEFAULT_OUTPUT = ROOT / "benchmarks" / "gpen512-pointwise-corrector-v1"
DEFAULT_PLAN_SHA256 = "b8c4ac5cd6e87b8bea24881b6204da953a95914ceb2092be73bb07b550906dd9"


def atomic_write_json(path: Path, payload) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--plan", type=Path, default=DEFAULT_PLAN)
    parser.add_argument("--train-dir", type=Path, default=DEFAULT_TRAIN)
    parser.add_argument("--external-dir", type=Path, default=DEFAULT_EXTERNAL)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--expected-plan-sha256", default=DEFAULT_PLAN_SHA256)
    parser.add_argument("--samples-per-frame", type=int, default=8192)
    parser.add_argument("--steps", type=int, default=1600)
    parser.add_argument("--batch-size", type=int, default=8192)
    parser.add_argument("--hidden", type=int, default=16)
    parser.add_argument("--target-scale", type=float, default=64.0)
    args = parser.parse_args()

    args.model = args.model.resolve()
    args.plan = args.plan.resolve()
    args.train_dir = args.train_dir.resolve()
    args.external_dir = args.external_dir.resolve()
    args.output_dir = args.output_dir.resolve()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    if sha256(args.plan) != args.expected_plan_sha256.lower():
        raise RuntimeError("Refusing an unqualified or changed TensorRT plan")

    np, torch, ort, dll_handles = bootstrap_libraries(enable_tensorrt=True)
    del dll_handles
    torch.cuda.set_device(0)
    import tensorrt as trt

    runtime, engine, context, tensors = load_native_engine(trt, args.plan)
    input_name = next(item["name"] for item in tensors if "INPUT" in item["mode"].upper())
    output_name = next(item["name"] for item in tensors if "OUTPUT" in item["mode"].upper())
    shape = (1, 3, 512, 512)
    stream = torch.cuda.Stream(device=0)
    stream_id = int(stream.cuda_stream)
    image = torch.empty(shape, dtype=torch.float32, device="cuda:0")
    native_output = torch.empty_like(image)
    reference_output = torch.empty_like(image)
    if not context.set_tensor_address(input_name, image.data_ptr()):
        raise RuntimeError("TensorRT rejected input address")
    if not context.set_tensor_address(output_name, native_output.data_ptr()):
        raise RuntimeError("TensorRT rejected output address")
    reference = make_ort_reference(ort, stream_id, args.model)
    binding = reference.io_binding()
    binding.bind_input(
        reference.get_inputs()[0].name,
        "cuda",
        0,
        np.float32,
        shape,
        image.data_ptr(),
    )
    binding.bind_output(
        reference.get_outputs()[0].name,
        "cuda",
        0,
        np.float32,
        shape,
        reference_output.data_ptr(),
    )

    def collect(paths):
        records = []
        for path in paths:
            captured = np.load(path, mmap_mode="r")
            if captured.ndim != 4 or tuple(captured.shape[1:]) != shape[1:]:
                raise RuntimeError(f"Unexpected captured tensor shape {captured.shape}: {path}")
            for index in range(captured.shape[0]):
                fixture = np.array(
                    captured[index : index + 1],
                    dtype=np.float32,
                    copy=True,
                    order="C",
                )
                with torch.cuda.stream(stream):
                    image.copy_(torch.from_numpy(fixture), non_blocking=False)
                    reference.run_with_iobinding(binding)
                    stream.synchronize()
                    ref_cpu = reference_output.detach().cpu().numpy().copy()
                    if not context.execute_async_v3(stream_id):
                        raise RuntimeError("TensorRT execute_async_v3 failed")
                    stream.synchronize()
                    native_cpu = native_output.detach().cpu().numpy().copy()
                records.append({
                    "clip": path.stem,
                    "index": index,
                    "input": fixture,
                    "reference": ref_cpu,
                    "native": native_cpu,
                })
        return records

    stock_paths = sorted(args.train_dir.glob("*gpen-inputs-f32.npy"))
    external_paths = sorted(args.external_dir.glob("*gpen-inputs-f32.npy"))
    if len(stock_paths) < 4 or not external_paths:
        raise FileNotFoundError("Insufficient captured training/external tensors")
    validation_paths = stock_paths[::4]
    training_paths = [path for path in stock_paths if path not in validation_paths]
    training_records = collect(training_paths)
    validation_records = collect(validation_paths)
    external_records = collect(external_paths)

    rng = np.random.default_rng(20260920)
    coordinate_axis = np.linspace(-1.0, 1.0, 512, dtype=np.float32)
    yy, xx = np.meshgrid(coordinate_axis, coordinate_axis, indexing="ij")
    coordinates = np.stack((xx, yy), axis=-1).reshape(-1, 2)
    feature_parts = []
    target_parts = []
    for record in training_records:
        pixel_count = 512 * 512
        chosen = rng.choice(
            pixel_count,
            size=min(args.samples_per_frame, pixel_count),
            replace=False,
        )
        native = record["native"][0].transpose(1, 2, 0).reshape(-1, 3)
        source = record["input"][0].transpose(1, 2, 0).reshape(-1, 3)
        reference_pixels = record["reference"][0].transpose(1, 2, 0).reshape(-1, 3)
        feature_parts.append(np.concatenate(
            (native[chosen], source[chosen], coordinates[chosen]),
            axis=1,
        ))
        target_parts.append(
            (reference_pixels[chosen] - native[chosen]) * float(args.target_scale)
        )
    features = torch.from_numpy(np.concatenate(feature_parts)).to("cuda:0")
    targets = torch.from_numpy(np.concatenate(target_parts)).to("cuda:0")

    model = torch.nn.Sequential(
        torch.nn.Linear(8, args.hidden),
        torch.nn.SiLU(),
        torch.nn.Linear(args.hidden, args.hidden),
        torch.nn.SiLU(),
        torch.nn.Linear(args.hidden, 3),
    ).to("cuda:0")
    torch.nn.init.zeros_(model[-1].weight)
    torch.nn.init.zeros_(model[-1].bias)
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-6)
    generator = torch.Generator(device="cuda:0").manual_seed(20260920)
    started = time.perf_counter()
    losses = []
    for step in range(args.steps):
        selection = torch.randint(
            0,
            features.shape[0],
            (args.batch_size,),
            device="cuda:0",
            generator=generator,
        )
        prediction = model(features[selection])
        loss = torch.nn.functional.smooth_l1_loss(
            prediction,
            targets[selection],
            beta=0.05,
        )
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
        if step % 100 == 0 or step + 1 == args.steps:
            losses.append({"step": step, "loss": float(loss.detach().item())})
    torch.cuda.synchronize()
    training_seconds = time.perf_counter() - started

    coords_gpu = torch.from_numpy(coordinates).to("cuda:0")

    def correct_record(record):
        with torch.no_grad():
            native = torch.from_numpy(record["native"]).to("cuda:0")
            source = torch.from_numpy(record["input"]).to("cuda:0")
            pixels = torch.cat((
                native[0].permute(1, 2, 0).reshape(-1, 3),
                source[0].permute(1, 2, 0).reshape(-1, 3),
                coords_gpu,
            ), dim=1)
            correction = model(pixels).div(float(args.target_scale))
            corrected = (
                native[0].permute(1, 2, 0).reshape(-1, 3) + correction
            ).clamp_(-1.0, 1.0)
            return corrected.reshape(512, 512, 3).permute(2, 0, 1).unsqueeze(0).cpu().numpy()

    evaluations = {}
    for name, records in (
        ("validation", validation_records),
        ("external", external_records),
    ):
        evaluations[name] = {
            "raw": evaluate_variant(np, records, lambda record: record["native"]),
            "corrected": evaluate_variant(np, records, correct_record),
        }

    timing_input = torch.from_numpy(external_records[0]["input"]).to("cuda:0")
    timing_native = torch.from_numpy(external_records[0]["native"]).to("cuda:0")
    timing_pixels = torch.cat((
        timing_native[0].permute(1, 2, 0).reshape(-1, 3),
        timing_input[0].permute(1, 2, 0).reshape(-1, 3),
        coords_gpu,
    ), dim=1)
    with torch.no_grad():
        for _ in range(20):
            model(timing_pixels)
        torch.cuda.synchronize()
        timing_ms = []
        for _ in range(100):
            begin = torch.cuda.Event(enable_timing=True)
            end = torch.cuda.Event(enable_timing=True)
            begin.record()
            model(timing_pixels)
            end.record()
            end.synchronize()
            timing_ms.append(float(begin.elapsed_time(end)))

    state_path = args.output_dir / "corrector.pt"
    torch.save({
        "stateDict": model.state_dict(),
        "hidden": int(args.hidden),
        "targetScale": float(args.target_scale),
        "featureSchema": "native-rgb,input-rgb,x,y-v1",
    }, state_path)
    report = {
        "schema": "pong-gpen512-pointwise-corrector-v1",
        "analysisOnly": True,
        "modelSha256": sha256(args.model),
        "planSha256": sha256(args.plan),
        "trainingClips": [path.name for path in training_paths],
        "validationClips": [path.name for path in validation_paths],
        "externalClips": [path.name for path in external_paths],
        "trainingRecords": len(training_records),
        "validationRecords": len(validation_records),
        "externalRecords": len(external_records),
        "trainingSeconds": training_seconds,
        "losses": losses,
        "evaluation": evaluations,
        "correctorTimingMs": {
            "mean": float(np.mean(timing_ms)),
            "p50": float(np.percentile(timing_ms, 50)),
            "p95": float(np.percentile(timing_ms, 95)),
        },
        "gpu": query_gpu(),
    }
    atomic_write_json(args.output_dir / "report.json", report)
    print(json.dumps({
        "report": str(args.output_dir / "report.json"),
        "trainingSeconds": training_seconds,
        "correctorP50Ms": report["correctorTimingMs"]["p50"],
        "validationRawMae": report["evaluation"]["validation"]["raw"]["mae"]["mean"],
        "validationCorrectedMae": report["evaluation"]["validation"]["corrected"]["mae"]["mean"],
        "externalRawMae": report["evaluation"]["external"]["raw"]["mae"]["mean"],
        "externalCorrectedMae": report["evaluation"]["external"]["corrected"]["mae"]["mean"],
    }, indent=2))
    del context, engine, runtime


if __name__ == "__main__":
    main()
