from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import shutil
import statistics
import subprocess
import time
from dataclasses import asdict
from pathlib import Path
from typing import Iterable

from benchmark_restorers_stock import RESTORER_SPECS, RestorerSpec
from benchmark_swappers_stock import (
    CUDA_DLL_ROOT,
    FACEFUSION,
    MODEL_SPECS,
    PYTHON,
    ROOT,
    VENDOR_ROOT,
    ModelSpec,
)


TARGET = ROOT / "cache" / "benchmark" / "target-video.mp4"
OUTPUT_ROOT = ROOT / "benchmarks" / "optimized-comparison-3s"
WORK_ROOT = ROOT / "work" / "optimized-comparison-3s"
TRIM_FRAME_END = 72
EXPECTED_DURATION_SECONDS = 72 * 1001 / 24000
APPROVED = {
    "Approved 4": ROOT / "approved-faces" / "Approved 4" / "source.jpg",
    "Approved 8": ROOT / "approved-faces" / "Approved 8" / "source.jpg",
}
NO_RESTORER = "none"


def percentile(values: Iterable[float], q: float) -> float:
    samples = sorted(float(value) for value in values)
    if not samples:
        return 0.0
    position = (len(samples) - 1) * q
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return samples[low]
    return samples[low] * (high - position) + samples[high] * (position - low)


def timing_summary(values: Iterable[float]) -> dict:
    samples = [float(value) for value in values]
    warm = samples[1:] or samples
    if not warm:
        return {
            "count": 0,
            "firstMs": 0.0,
            "warmMeanMs": 0.0,
            "warmP50Ms": 0.0,
            "warmP90Ms": 0.0,
            "warmP95Ms": 0.0,
        }
    return {
        "count": len(samples),
        "firstMs": round(samples[0], 4),
        "warmMeanMs": round(statistics.fmean(warm), 4),
        "warmP50Ms": round(percentile(warm, 0.50), 4),
        "warmP90Ms": round(percentile(warm, 0.90), 4),
        "warmP95Ms": round(percentile(warm, 0.95), 4),
    }


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_events(path: Path) -> list[dict]:
    events: list[dict] = []
    if not path.is_file():
        return events
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def probe_video(path: Path) -> dict:
    completed = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames,duration",
            "-of",
            "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    return json.loads(completed.stdout)


def verify_video(path: Path) -> dict:
    probe = probe_video(path)
    streams = probe.get("streams", [])
    video_streams = [stream for stream in streams if stream.get("codec_type") == "video"]
    audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
    if len(video_streams) != 1:
        raise RuntimeError(f"Expected one video stream in {path}, found {len(video_streams)}")
    if audio_streams:
        raise RuntimeError(f"Comparison output unexpectedly contains audio: {path}")
    frame_count = int(video_streams[0].get("nb_frames") or 0)
    duration = float(probe.get("format", {}).get("duration") or video_streams[0].get("duration") or 0)
    if frame_count != TRIM_FRAME_END:
        raise RuntimeError(f"Expected {TRIM_FRAME_END} frames in {path}, found {frame_count}")
    if abs(duration - EXPECTED_DURATION_SECONDS) > 0.03:
        raise RuntimeError(
            f"Expected {EXPECTED_DURATION_SECONDS:.3f}s in {path}, found {duration:.3f}s"
        )
    decode = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "null", "NUL" if os.name == "nt" else "/dev/null"],
        capture_output=True,
        text=True,
        timeout=180,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if decode.returncode != 0:
        raise RuntimeError(f"Decode validation failed for {path}: {decode.stderr[-1200:]}")
    return probe


def common_command(output_path: Path, trim_frame_end: int) -> list[str]:
    return [
        str(PYTHON),
        str(FACEFUSION),
        "headless-run",
        "-t",
        str(TARGET),
        "-o",
        str(output_path),
        "--workflow-mode",
        "image-to-video",
        "--workflow-strategy",
        "memory",
        "--face-mask-types",
        "box",
        "--face-mask-blur",
        "0.3",
        "--face-selector-mode",
        "one",
        "--target-frame-amount",
        "1",
        "--execution-providers",
        "cuda",
        "--execution-thread-count",
        "1",
        "--video-memory-strategy",
        "tolerant",
        "--output-audio-volume",
        "0",
        "--output-video-encoder",
        "h264_nvenc",
        "--output-video-preset",
        "ultrafast",
        "--output-video-quality",
        "100",
        "--trim-frame-start",
        "0",
        "--trim-frame-end",
        str(trim_frame_end),
        "--log-level",
        "warn",
    ]


def render_command(
    source: Path,
    model: ModelSpec,
    restorer: RestorerSpec | None,
    output_path: Path,
    trim_frame_end: int,
) -> list[str]:
    command = common_command(output_path, trim_frame_end)
    target_index = command.index("-t")
    command[target_index:target_index] = ["-s", str(source)]
    processors = ["face_swapper"]
    if restorer is not None:
        processors.append("face_enhancer")
    command.extend(
        [
            "--processors",
            *processors,
            "--face-swapper-model",
            model.name,
            "--face-swapper-pixel-boost",
            f"{model.native_size}x{model.native_size}",
            "--face-swapper-weight",
            "0.5",
        ]
    )
    if restorer is not None:
        command.extend(
            [
                "--face-enhancer-model",
                restorer.name,
                "--face-enhancer-blend",
                "100",
                "--face-enhancer-weight",
                "0.5",
            ]
        )
    return command


def optimized_environment(swap_log: Path, enhancer_log: Path) -> dict[str, str]:
    environment = dict(os.environ)
    environment["PATH"] = str(CUDA_DLL_ROOT) + os.pathsep + environment.get("PATH", "")
    environment["PONG_FACEFUSION_OPTIMIZED"] = "1"
    environment["PONG_FACEFUSION_BENCHMARK_LOG"] = str(swap_log)
    environment["PONG_FACEFUSION_ENHANCER_BENCHMARK_LOG"] = str(enhancer_log)
    return environment


def run_render(
    command: list[str],
    *,
    swap_log: Path,
    enhancer_log: Path,
    process_log: Path,
    timeout_seconds: int,
) -> dict:
    for path in (swap_log, enhancer_log, process_log):
        path.unlink(missing_ok=True)
        path.parent.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    with process_log.open("w", encoding="utf-8", errors="replace") as log_stream:
        process = subprocess.run(
            command,
            cwd=str(VENDOR_ROOT),
            env=optimized_environment(swap_log, enhancer_log),
            stdin=subprocess.DEVNULL,
            stdout=log_stream,
            stderr=subprocess.STDOUT,
            timeout=timeout_seconds,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    return {
        "returnCode": process.returncode,
        "wallSeconds": round(time.perf_counter() - started, 4),
        "log": str(process_log),
    }


def collect_timing(swap_log: Path, enhancer_log: Path) -> dict:
    swap_events = read_events(swap_log)
    enhancer_events = read_events(enhancer_log)
    swap_inference = [event["durationMs"] for event in swap_events if event.get("stage") == "modelInference"]
    swap_total = [event["durationMs"] for event in swap_events if event.get("stage") == "swapTotal"]
    enhancer_inference = [event["durationMs"] for event in enhancer_events if event.get("stage") == "modelInference"]
    enhancer_total = [event["durationMs"] for event in enhancer_events if event.get("stage") == "enhanceTotal"]
    providers = sorted(
        {
            provider
            for event in swap_events + enhancer_events
            for provider in event.get("providers", [])
            if isinstance(provider, str)
        }
    )
    return {
        "providers": providers,
        "swapperInference": timing_summary(swap_inference),
        "swapperComplete": timing_summary(swap_total),
        "restorerInference": timing_summary(enhancer_inference),
        "restorerComplete": timing_summary(enhancer_total),
    }


def output_path(face_name: str, model_name: str, restorer_name: str) -> Path:
    file_name = "00_no_restorer.mp4" if restorer_name == NO_RESTORER else f"{restorer_name}.mp4"
    return OUTPUT_ROOT / face_name / model_name / file_name


def work_paths(face_name: str, model_name: str, restorer_name: str) -> tuple[Path, Path, Path]:
    directory = WORK_ROOT / "logs" / face_name / model_name
    return (
        directory / f"{restorer_name}-swapper.jsonl",
        directory / f"{restorer_name}-restorer.jsonl",
        directory / f"{restorer_name}.log",
    )


def atomic_write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    temporary.replace(path)


def write_csv(report: dict) -> None:
    path = OUTPUT_ROOT / "results.csv"
    rows = []
    for item in report.get("results", []):
        timing = item.get("timing", {})
        rows.append(
            {
                "face": item.get("face"),
                "model": item.get("model", {}).get("name"),
                "restorer": item.get("restorer", {}).get("name", NO_RESTORER),
                "status": item.get("status"),
                "fullWallSeconds": item.get("render", {}).get("wallSeconds"),
                "swapperP50Ms": timing.get("swapperComplete", {}).get("warmP50Ms"),
                "swapperP95Ms": timing.get("swapperComplete", {}).get("warmP95Ms"),
                "restorerP50Ms": timing.get("restorerComplete", {}).get("warmP50Ms"),
                "restorerP95Ms": timing.get("restorerComplete", {}).get("warmP95Ms"),
                "providers": ";".join(timing.get("providers", [])),
                "frames": item.get("frames"),
                "durationSeconds": item.get("durationSeconds"),
                "output": item.get("output"),
            }
        )
    temporary = path.with_suffix(".csv.tmp")
    with temporary.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0].keys()) if rows else ["status"])
        writer.writeheader()
        writer.writerows(rows)
    temporary.replace(path)


def result_key(face_name: str, model_name: str, restorer_name: str) -> str:
    return "|".join((face_name, model_name, restorer_name))


def acquire_assets(
    models: list[ModelSpec],
    restorers: list[RestorerSpec],
    timeout_seconds: int,
) -> None:
    source = APPROVED["Approved 4"]
    current_model = next(spec for spec in MODEL_SPECS if spec.name == "inswapper_128_fp16")
    print("[acquire] ensuring model assets are available", flush=True)
    for index, model in enumerate(models, start=1):
        directory = WORK_ROOT / "acquisition" / "models" / model.name
        output = directory / "smoke.mp4"
        swap_log = directory / "swapper.jsonl"
        enhancer_log = directory / "restorer.jsonl"
        process_log = directory / "process.log"
        directory.mkdir(parents=True, exist_ok=True)
        partial = directory / "smoke.partial.mp4"
        partial.unlink(missing_ok=True)
        command = render_command(source, model, None, partial, 1)
        outcome = run_render(
            command,
            swap_log=swap_log,
            enhancer_log=enhancer_log,
            process_log=process_log,
            timeout_seconds=timeout_seconds,
        )
        if outcome["returnCode"] != 0 or not partial.is_file():
            raise RuntimeError(f"Model acquisition failed for {model.name}; see {process_log}")
        partial.replace(output)
        print(f"[acquire model {index}/{len(models)}] {model.name}", flush=True)

    print("[acquire] ensuring restorer assets are available", flush=True)
    for index, restorer in enumerate(restorers, start=1):
        directory = WORK_ROOT / "acquisition" / "restorers" / restorer.name
        output = directory / "smoke.mp4"
        swap_log = directory / "swapper.jsonl"
        enhancer_log = directory / "restorer.jsonl"
        process_log = directory / "process.log"
        directory.mkdir(parents=True, exist_ok=True)
        partial = directory / "smoke.partial.mp4"
        partial.unlink(missing_ok=True)
        command = render_command(source, current_model, restorer, partial, 1)
        outcome = run_render(
            command,
            swap_log=swap_log,
            enhancer_log=enhancer_log,
            process_log=process_log,
            timeout_seconds=timeout_seconds,
        )
        if outcome["returnCode"] != 0 or not partial.is_file():
            raise RuntimeError(f"Restorer acquisition failed for {restorer.name}; see {process_log}")
        partial.replace(output)
        print(f"[acquire restorer {index}/{len(restorers)}] {restorer.name}", flush=True)


def render_one(
    face_name: str,
    source: Path,
    model: ModelSpec,
    restorer: RestorerSpec | None,
    timeout_seconds: int,
) -> dict:
    restorer_name = restorer.name if restorer is not None else NO_RESTORER
    destination = output_path(face_name, model.name, restorer_name)
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.stem + ".partial.mp4")
    partial.unlink(missing_ok=True)
    swap_log, enhancer_log, process_log = work_paths(face_name, model.name, restorer_name)
    command = render_command(source, model, restorer, partial, TRIM_FRAME_END)
    outcome = run_render(
        command,
        swap_log=swap_log,
        enhancer_log=enhancer_log,
        process_log=process_log,
        timeout_seconds=timeout_seconds,
    )
    if outcome["returnCode"] != 0 or not partial.is_file():
        raise RuntimeError(f"Render failed for {face_name}/{model.name}/{restorer_name}; see {process_log}")
    media = verify_video(partial)
    timing = collect_timing(swap_log, enhancer_log)
    if "CUDAExecutionProvider" not in timing["providers"]:
        raise RuntimeError(f"CUDA provider missing for {face_name}/{model.name}/{restorer_name}")
    partial.replace(destination)
    video_stream = next(stream for stream in media["streams"] if stream.get("codec_type") == "video")
    return {
        "key": result_key(face_name, model.name, restorer_name),
        "face": face_name,
        "sourceSha256": sha256(source),
        "model": asdict(model),
        "restorer": asdict(restorer) if restorer is not None else {"name": NO_RESTORER},
        "status": "ok",
        "optimizationProfile": "pong-parity-v1",
        "render": outcome,
        "timing": timing,
        "frames": int(video_stream.get("nb_frames") or 0),
        "durationSeconds": float(media["format"]["duration"]),
        "sizeBytes": int(media["format"]["size"]),
        "audio": "absent",
        "output": str(destination),
        "outputSha256": sha256(destination),
    }


def write_readme(report: dict) -> None:
    text = f"""# Optimized three-second comparison

This folder contains deterministic local comparison clips generated from the same
72-frame (3.003-second), 720x1280, 23.976 FPS target segment.

- Source identities: Approved 4 and Approved 8
- Swappers: {len(report['models'])}
- Restorers: {len(report['restorers'])}, plus one no-restorer control
- Expected outputs: {report['expectedOutputs']}
- Audio: absent
- Encoder: h264_nvenc, quality 100
- Execution: CUDA, one processing worker, persistent model session within each clip
- Optimization profile: pong-parity-v1
- Production Pong preset changed: no

`results.csv` is the compact timing table. `results.json` contains commands,
provider evidence, per-frame p50/p90/p95 timings, hashes and media validation.
"""
    (OUTPUT_ROOT / "README.md").write_text(text, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build Pong's optimized three-second model/restorer grading matrix.")
    parser.add_argument("--faces", nargs="+", choices=list(APPROVED), default=list(APPROVED))
    parser.add_argument("--models", nargs="+", choices=[spec.name for spec in MODEL_SPECS], default=[spec.name for spec in MODEL_SPECS])
    parser.add_argument("--restorers", nargs="+", choices=[spec.name for spec in RESTORER_SPECS], default=[spec.name for spec in RESTORER_SPECS])
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--skip-acquisition", action="store_true")
    parser.add_argument("--resume", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--limit", type=int, default=None, help="Smoke-test only: stop after this many matrix outputs.")
    args = parser.parse_args()

    for required in (PYTHON, FACEFUSION, TARGET, *APPROVED.values()):
        if not Path(required).is_file():
            raise FileNotFoundError(required)
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise RuntimeError("ffmpeg and ffprobe must be on PATH")

    models = [spec for spec in MODEL_SPECS if spec.name in args.models]
    restorers = [spec for spec in RESTORER_SPECS if spec.name in args.restorers]
    if not args.skip_acquisition:
        acquire_assets(models, restorers, args.timeout)

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    report_path = OUTPUT_ROOT / "results.json"
    completed: dict[str, dict] = {}
    if args.resume and report_path.is_file():
        previous = json.loads(report_path.read_text(encoding="utf-8"))
        completed = {
            item["key"]: item
            for item in previous.get("results", [])
            if item.get("status") == "ok" and Path(item.get("output", "")).is_file()
        }
    report = {
        "schemaVersion": 1,
        "createdAtEpoch": time.time(),
        "target": {
            "path": str(TARGET),
            "sha256": sha256(TARGET),
            "trimFrameStart": 0,
            "trimFrameEndExclusive": TRIM_FRAME_END,
            "durationSeconds": EXPECTED_DURATION_SECONDS,
        },
        "method": {
            "profile": "pong-parity-v1",
            "sameTargetForEveryOutput": True,
            "sameSettingsForEveryCompatibleModel": True,
            "provider": "CUDAExecutionProvider",
            "sessionReuseWithinClip": True,
            "reusableOutputBuffers": True,
            "fixedShapeWarmInference": True,
            "audio": "absent",
            "qualityReduction": False,
            "productionPresetChanged": False,
            "note": "Architecture-specific model graphs are unchanged; the same execution, allocation, provider and encoding policy is applied to every candidate.",
        },
        "faces": args.faces,
        "models": [asdict(spec) for spec in models],
        "restorers": [asdict(spec) for spec in restorers],
        "expectedOutputs": len(args.faces) * len(models) * (len(restorers) + 1),
        "results": [],
    }
    total = report["expectedOutputs"]
    current = 0
    for face_name in args.faces:
        source = APPROVED[face_name]
        for model in models:
            for restorer in [None, *restorers]:
                current += 1
                restorer_name = restorer.name if restorer is not None else NO_RESTORER
                key = result_key(face_name, model.name, restorer_name)
                if key in completed:
                    item = completed[key]
                    print(f"[{current}/{total}] resume {key}", flush=True)
                else:
                    print(f"[{current}/{total}] render {key}", flush=True)
                    item = render_one(face_name, source, model, restorer, args.timeout)
                    print(
                        f"[{current}/{total}] ok {key} wall={item['render']['wallSeconds']:.2f}s "
                        f"swap={item['timing']['swapperComplete']['warmP50Ms']:.2f}ms "
                        f"restore={item['timing']['restorerComplete']['warmP50Ms']:.2f}ms",
                        flush=True,
                    )
                report["results"].append(item)
                report["completedOutputs"] = len(report["results"])
                atomic_write_json(report_path, report)
                write_csv(report)
                write_readme(report)
                if args.limit is not None and len(report["results"]) >= args.limit:
                    print(f"smoke limit reached: {args.limit}", flush=True)
                    return
    report["finishedAtEpoch"] = time.time()
    report["status"] = "complete"
    atomic_write_json(report_path, report)
    write_csv(report)
    write_readme(report)
    print(f"complete: {len(report['results'])} outputs in {OUTPUT_ROOT}", flush=True)


if __name__ == "__main__":
    main()
