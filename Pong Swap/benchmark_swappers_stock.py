from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import statistics
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parent
VENDOR_ROOT = ROOT / "vendor" / "facefusion-benchmark"
PYTHON = ROOT / "runtime" / "venv" / "Scripts" / "python.exe"
FACEFUSION = VENDOR_ROOT / "facefusion.py"
SOURCE = ROOT / "cache" / "benchmark" / "source-face.jpg"
TARGET = ROOT / "cache" / "benchmark" / "target-video.mp4"
OUTPUT_ROOT = ROOT / "benchmarks" / "swapper-baseline"
ASSET_ROOT = VENDOR_ROOT / ".assets" / "models"
CUDA_DLL_ROOT = ROOT / "runtime" / "venv" / "Lib" / "site-packages" / "torch" / "lib"


@dataclass(frozen=True)
class ModelSpec:
    name: str
    native_size: int
    vendor: str
    license: str


MODEL_SPECS = (
    ModelSpec("inswapper_128_fp16", 128, "InsightFace", "Non-Commercial"),
    ModelSpec("inswapper_128", 128, "InsightFace", "Non-Commercial"),
    ModelSpec("alphaface_256", 256, "AlphaFace", "Non-Commercial"),
    ModelSpec("hyperswap_1a_256", 256, "FaceFusion", "ResearchRAIL"),
    ModelSpec("hyperswap_1b_256", 256, "FaceFusion", "ResearchRAIL"),
    ModelSpec("hyperswap_1c_256", 256, "FaceFusion", "ResearchRAIL"),
    ModelSpec("simswap_256", 256, "neuralchen", "Non-Commercial"),
    ModelSpec("simswap_unofficial_512", 512, "neuralchen", "Non-Commercial"),
    ModelSpec("ghost_1_256", 256, "ai-forever", "Apache-2.0"),
    ModelSpec("ghost_2_256", 256, "ai-forever", "Apache-2.0"),
    ModelSpec("ghost_3_256", 256, "ai-forever", "Apache-2.0"),
    ModelSpec("hififace_unofficial_256", 256, "GuijiAI", "Unknown"),
    ModelSpec("uniface_256", 256, "xc-csc101", "Unknown"),
    ModelSpec("blendswap_256", 256, "mapooon", "Non-Commercial"),
)


def percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * q
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return ordered[low]
    return ordered[low] * (high - position) + ordered[high] * (position - low)


def timing_summary(values: Iterable[float]) -> dict:
    samples = [float(value) for value in values]
    if not samples:
        return {
            "count": 0,
            "firstMs": 0.0,
            "warmMeanMs": 0.0,
            "warmP50Ms": 0.0,
            "warmP90Ms": 0.0,
            "warmP95Ms": 0.0,
            "warmP99Ms": 0.0,
            "warmFps": 0.0,
        }
    warm = samples[1:] or samples
    mean = statistics.fmean(warm)
    return {
        "count": len(samples),
        "firstMs": round(samples[0], 4),
        "warmMeanMs": round(mean, 4),
        "warmP50Ms": round(percentile(warm, 0.50), 4),
        "warmP90Ms": round(percentile(warm, 0.90), 4),
        "warmP95Ms": round(percentile(warm, 0.95), 4),
        "warmP99Ms": round(percentile(warm, 0.99), 4),
        "warmFps": round(1000.0 / mean, 4) if mean > 0 else 0.0,
    }


def gpu_memory_used_mib() -> int | None:
    try:
        completed = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=memory.used",
                "--format=csv,noheader,nounits",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        return int(completed.stdout.strip().splitlines()[0])
    except (OSError, ValueError, subprocess.SubprocessError, IndexError):
        return None


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
        timeout=30,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    return json.loads(completed.stdout)


def run_hidden(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    log_path: Path,
    timeout_seconds: int,
) -> dict:
    baseline_mib = gpu_memory_used_mib()
    samples: list[int] = []
    stop_sample = threading.Event()

    def sample_gpu() -> None:
        while not stop_sample.wait(0.20):
            value = gpu_memory_used_mib()
            if value is not None:
                samples.append(value)

    sampler = threading.Thread(target=sample_gpu, name="swapper-gpu-sampler", daemon=True)
    sampler.start()
    started = time.perf_counter()
    timed_out = False
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("w", encoding="utf-8", errors="replace") as log_file:
        process = subprocess.Popen(
            command,
            cwd=str(cwd),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        try:
            return_code = process.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            timed_out = True
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    capture_output=True,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
            else:
                process.kill()
            return_code = process.wait(timeout=30)
    elapsed = time.perf_counter() - started
    stop_sample.set()
    sampler.join(timeout=5)
    peak_mib = max(samples) if samples else baseline_mib
    return {
        "returnCode": return_code,
        "timedOut": timed_out,
        "wallSeconds": round(elapsed, 4),
        "gpuBaselineMiB": baseline_mib,
        "gpuPeakMiB": peak_mib,
        "gpuPeakDeltaMiB": (
            max(0, peak_mib - baseline_mib)
            if peak_mib is not None and baseline_mib is not None
            else None
        ),
        "log": str(log_path),
    }


def facefusion_command(
    spec: ModelSpec,
    output_path: Path,
    *,
    trim_end: int | None,
) -> list[str]:
    command = [
        str(PYTHON),
        str(FACEFUSION),
        "headless-run",
        "-s",
        str(SOURCE),
        "-t",
        str(TARGET),
        "-o",
        str(output_path),
        "--workflow-mode",
        "image-to-video",
        "--workflow-strategy",
        "memory",
        "--processors",
        "face_swapper",
        "--face-swapper-model",
        spec.name,
        "--face-swapper-pixel-boost",
        f"{spec.native_size}x{spec.native_size}",
        "--face-swapper-weight",
        "0.5",
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
        "90",
        "--log-level",
        "info",
    ]
    if trim_end is not None:
        command.extend(["--trim-frame-start", "0", "--trim-frame-end", str(trim_end)])
    return command


def read_events(path: Path) -> list[dict]:
    events = []
    if not path.exists():
        return events
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def asset_snapshot() -> dict[str, int]:
    if not ASSET_ROOT.exists():
        return {}
    return {
        str(path.relative_to(ASSET_ROOT)): path.stat().st_size
        for path in ASSET_ROOT.rglob("*")
        if path.is_file()
    }


def prune_model_file(spec: ModelSpec) -> list[str]:
    removed = []
    model_path = ASSET_ROOT / f"{spec.name}.onnx"
    if model_path.is_file():
        model_path.unlink()
        removed.append(str(model_path))
    return removed


def save_report(report: dict) -> None:
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    report_path = OUTPUT_ROOT / "swapper-baseline-report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")


def run_model(spec: ModelSpec, args: argparse.Namespace) -> dict:
    model_dir = OUTPUT_ROOT / spec.name
    model_dir.mkdir(parents=True, exist_ok=True)
    acquire_output = model_dir / "acquire-smoke.mp4"
    final_output = model_dir / "swapped.mp4"
    event_path = model_dir / "timings.jsonl"
    acquire_event_path = model_dir / "acquire-timings.jsonl"
    for path in (acquire_output, final_output, event_path, acquire_event_path):
        path.unlink(missing_ok=True)

    before_assets = asset_snapshot()
    acquire_env = dict(os.environ)
    acquire_env["PATH"] = str(CUDA_DLL_ROOT) + os.pathsep + acquire_env.get("PATH", "")
    acquire_env["PONG_FACEFUSION_BENCHMARK_LOG"] = str(acquire_event_path)
    acquisition = run_hidden(
        facefusion_command(spec, acquire_output, trim_end=1),
        cwd=VENDOR_ROOT,
        env=acquire_env,
        log_path=model_dir / "acquire.log",
        timeout_seconds=args.acquire_timeout,
    )
    after_assets = asset_snapshot()
    acquired_files = {
        name: size
        for name, size in after_assets.items()
        if before_assets.get(name) != size
    }
    acquisition["newAssetBytes"] = sum(acquired_files.values())
    acquisition["newAssets"] = acquired_files

    if acquisition["returnCode"] != 0 or not acquire_output.exists():
        return {
            "model": asdict(spec),
            "status": "acquisition-failed",
            "acquisition": acquisition,
        }

    benchmark_env = dict(os.environ)
    benchmark_env["PATH"] = str(CUDA_DLL_ROOT) + os.pathsep + benchmark_env.get("PATH", "")
    benchmark_env["PONG_FACEFUSION_BENCHMARK_LOG"] = str(event_path)
    benchmark = run_hidden(
        facefusion_command(spec, final_output, trim_end=args.trim_frame_end),
        cwd=VENDOR_ROOT,
        env=benchmark_env,
        log_path=model_dir / "benchmark.log",
        timeout_seconds=args.benchmark_timeout,
    )
    events = read_events(event_path)
    inference = [
        event["durationMs"]
        for event in events
        if event.get("stage") == "modelInference"
    ]
    swaps = [
        event["durationMs"]
        for event in events
        if event.get("stage") == "swapTotal"
    ]
    actual_providers = sorted(
        {
            provider
            for event in events
            for provider in event.get("providers", [])
            if isinstance(provider, str)
        }
    )
    provider_ok = "CUDAExecutionProvider" in actual_providers
    result = {
        "model": asdict(spec),
        "status": (
            "ok"
            if benchmark["returnCode"] == 0 and final_output.exists() and provider_ok
            else "provider-fallback"
            if benchmark["returnCode"] == 0 and final_output.exists()
            else "benchmark-failed"
        ),
        "requestedProvider": "CUDAExecutionProvider",
        "actualProviders": actual_providers,
        "pixelBoost": f"{spec.native_size}x{spec.native_size}",
        "restoration": "disabled",
        "audio": "disabled",
        "acquisition": acquisition,
        "benchmark": benchmark,
        "timing": {
            "modelInference": timing_summary(inference),
            "completeSwapCall": timing_summary(swaps),
        },
        "output": str(final_output),
    }
    if final_output.exists():
        try:
            result["media"] = probe_video(final_output)
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
            result["mediaProbeError"] = repr(error)
    if args.prune_models:
        result["prunedModelFiles"] = prune_model_file(spec)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Benchmark FaceFusion swapper models against Pong's licensed stock assets."
    )
    parser.add_argument(
        "--models",
        nargs="+",
        default=[spec.name for spec in MODEL_SPECS],
        choices=[spec.name for spec in MODEL_SPECS],
    )
    parser.add_argument(
        "--trim-frame-end",
        type=int,
        default=None,
        help="Optional exclusive end frame; omitted processes the complete video.",
    )
    parser.add_argument("--acquire-timeout", type=int, default=1800)
    parser.add_argument("--benchmark-timeout", type=int, default=2700)
    parser.add_argument(
        "--prune-models",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Remove only each downloaded candidate ONNX after its output and measurements are saved.",
    )
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()

    for required in (PYTHON, FACEFUSION, SOURCE, TARGET):
        if not required.exists():
            raise FileNotFoundError(required)
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise RuntimeError("ffmpeg and ffprobe must be on PATH")

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    report = {
        "schemaVersion": 1,
        "createdAtEpoch": time.time(),
        "assets": {
            "source": str(SOURCE),
            "target": str(TARGET),
            "sourceAttribution": "cottonbro studio / Pexels photo 7000122",
            "targetAttribution": "George Milton / Pexels video 7010283",
            "targetProbe": probe_video(TARGET),
        },
        "method": {
            "sameSourceAndTargetForEveryModel": True,
            "nativeModelResolutionOnly": True,
            "provider": "CUDAExecutionProvider",
            "executionThreads": 1,
            "restoration": "disabled",
            "audio": "disabled",
            "qualityNote": "Speed screening only; production integration and independent visual scoring follow for finalists.",
        },
        "results": [],
    }
    report_path = OUTPUT_ROOT / "swapper-baseline-report.json"
    completed: dict[str, dict] = {}
    if args.resume and report_path.exists():
        old_report = json.loads(report_path.read_text(encoding="utf-8"))
        completed = {
            item.get("model", {}).get("name"): item
            for item in old_report.get("results", [])
            if item.get("status") == "ok"
        }

    selected = [spec for spec in MODEL_SPECS if spec.name in args.models]
    for index, spec in enumerate(selected, start=1):
        if spec.name in completed:
            result = completed[spec.name]
            print(f"[{index}/{len(selected)}] {spec.name}: reusing completed result", flush=True)
        else:
            print(f"[{index}/{len(selected)}] {spec.name}: acquiring and benchmarking", flush=True)
            result = run_model(spec, args)
            print(
                f"[{index}/{len(selected)}] {spec.name}: {result['status']} "
                f"wall={result.get('benchmark', {}).get('wallSeconds', 0)}s "
                f"warm={result.get('timing', {}).get('modelInference', {}).get('warmP50Ms', 0)}ms",
                flush=True,
            )
        report["results"].append(result)
        save_report(report)

    ok_results = [item for item in report["results"] if item.get("status") == "ok"]
    report["rankingByWarmInferenceP50"] = [
        item["model"]["name"]
        for item in sorted(
            ok_results,
            key=lambda item: item["timing"]["modelInference"]["warmP50Ms"],
        )
    ]
    report["finishedAtEpoch"] = time.time()
    save_report(report)
    print(json.dumps(report, indent=2), flush=True)
    if len(ok_results) != len(selected):
        raise SystemExit(2)


if __name__ == "__main__":
    main()
