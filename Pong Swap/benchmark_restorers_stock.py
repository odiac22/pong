from __future__ import annotations

import argparse
import json
import os
import shutil
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from benchmark_swappers_stock import (
    ASSET_ROOT,
    CUDA_DLL_ROOT,
    FACEFUSION,
    PYTHON,
    ROOT,
    VENDOR_ROOT,
    asset_snapshot,
    probe_video,
    read_events,
    run_hidden,
    timing_summary,
)


INPUT_VIDEO = (
    ROOT
    / "benchmarks"
    / "swapper-baseline"
    / "inswapper_128_fp16"
    / "swapped.mp4"
)
OUTPUT_ROOT = ROOT / "benchmarks" / "restorer-baseline"


@dataclass(frozen=True)
class RestorerSpec:
    name: str
    native_size: int
    vendor: str
    license: str
    role: str


RESTORER_SPECS = (
    RestorerSpec("gpen_bfr_512", 512, "yangxy", "Non-Commercial", "production-quality baseline"),
    RestorerSpec("gpen_bfr_256", 256, "yangxy", "Non-Commercial", "diagnostic only"),
    RestorerSpec("codeformer", 512, "sczhou", "S-Lab-1.0", "quality challenger"),
    RestorerSpec("gfpgan_1.2", 512, "TencentARC", "Apache-2.0", "quality challenger"),
    RestorerSpec("gfpgan_1.3", 512, "TencentARC", "Apache-2.0", "quality challenger"),
    RestorerSpec("gfpgan_1.4", 512, "TencentARC", "Apache-2.0", "quality challenger"),
    RestorerSpec("restoreformer_plus_plus", 512, "wzhouxiff", "Apache-2.0", "quality challenger"),
)


def facefusion_command(
    spec: RestorerSpec,
    output_path: Path,
    *,
    trim_end: int | None,
) -> list[str]:
    command = [
        str(PYTHON),
        str(FACEFUSION),
        "headless-run",
        "-t",
        str(INPUT_VIDEO),
        "-o",
        str(output_path),
        "--workflow-mode",
        "image-to-video",
        "--workflow-strategy",
        "memory",
        "--processors",
        "face_enhancer",
        "--face-enhancer-model",
        spec.name,
        "--face-enhancer-blend",
        "100",
        "--face-enhancer-weight",
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


def prune_model_file(spec: RestorerSpec) -> list[str]:
    removed = []
    model_path = ASSET_ROOT / f"{spec.name}.onnx"
    if model_path.is_file():
        model_path.unlink()
        removed.append(str(model_path))
    return removed


def save_report(report: dict) -> None:
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    (OUTPUT_ROOT / "restorer-baseline-report.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )


def run_restorer(spec: RestorerSpec, args: argparse.Namespace) -> dict:
    model_dir = OUTPUT_ROOT / spec.name
    model_dir.mkdir(parents=True, exist_ok=True)
    acquire_output = model_dir / "acquire-smoke.mp4"
    final_output = model_dir / "restored.mp4"
    event_path = model_dir / "timings.jsonl"
    acquire_event_path = model_dir / "acquire-timings.jsonl"
    for path in (acquire_output, final_output, event_path, acquire_event_path):
        path.unlink(missing_ok=True)

    before_assets = asset_snapshot()
    env = dict(os.environ)
    env["PATH"] = str(CUDA_DLL_ROOT) + os.pathsep + env.get("PATH", "")
    env["PONG_FACEFUSION_ENHANCER_BENCHMARK_LOG"] = str(acquire_event_path)
    acquisition = run_hidden(
        facefusion_command(spec, acquire_output, trim_end=1),
        cwd=VENDOR_ROOT,
        env=env,
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
            "restorer": asdict(spec),
            "status": "acquisition-failed",
            "acquisition": acquisition,
        }

    env["PONG_FACEFUSION_ENHANCER_BENCHMARK_LOG"] = str(event_path)
    benchmark = run_hidden(
        facefusion_command(spec, final_output, trim_end=args.trim_frame_end),
        cwd=VENDOR_ROOT,
        env=env,
        log_path=model_dir / "benchmark.log",
        timeout_seconds=args.benchmark_timeout,
    )
    events = read_events(event_path)
    inference = [
        event["durationMs"]
        for event in events
        if event.get("stage") == "modelInference"
    ]
    totals = [
        event["durationMs"]
        for event in events
        if event.get("stage") == "enhanceTotal"
    ]
    providers = sorted(
        {
            provider
            for event in events
            for provider in event.get("providers", [])
            if isinstance(provider, str)
        }
    )
    provider_ok = "CUDAExecutionProvider" in providers
    status = (
        "ok"
        if benchmark["returnCode"] == 0 and final_output.exists() and provider_ok
        else "provider-fallback"
        if benchmark["returnCode"] == 0 and final_output.exists()
        else "benchmark-failed"
    )
    result = {
        "restorer": asdict(spec),
        "status": status,
        "requestedProvider": "CUDAExecutionProvider",
        "actualProviders": providers,
        "input": str(INPUT_VIDEO),
        "audio": "disabled",
        "acquisition": acquisition,
        "benchmark": benchmark,
        "timing": {
            "modelInference": timing_summary(inference),
            "completeEnhanceCall": timing_summary(totals),
        },
        "output": str(final_output),
    }
    if final_output.exists():
        try:
            result["media"] = probe_video(final_output)
        except Exception as error:
            result["mediaProbeError"] = repr(error)
    if args.prune_models:
        result["prunedModelFiles"] = prune_model_file(spec)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Benchmark restorer models against one fixed stock-video swap."
    )
    parser.add_argument(
        "--models",
        nargs="+",
        default=[spec.name for spec in RESTORER_SPECS],
        choices=[spec.name for spec in RESTORER_SPECS],
    )
    parser.add_argument("--trim-frame-end", type=int, default=None)
    parser.add_argument("--acquire-timeout", type=int, default=1800)
    parser.add_argument("--benchmark-timeout", type=int, default=2700)
    parser.add_argument(
        "--prune-models",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()

    for required in (PYTHON, FACEFUSION, INPUT_VIDEO):
        if not required.exists():
            raise FileNotFoundError(required)
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise RuntimeError("ffmpeg and ffprobe must be on PATH")

    report_path = OUTPUT_ROOT / "restorer-baseline-report.json"
    completed: dict[str, dict] = {}
    if args.resume and report_path.exists():
        old_report = json.loads(report_path.read_text(encoding="utf-8"))
        completed = {
            item.get("restorer", {}).get("name"): item
            for item in old_report.get("results", [])
            if item.get("status") == "ok"
        }
    report = {
        "schemaVersion": 1,
        "createdAtEpoch": time.time(),
        "input": {
            "video": str(INPUT_VIDEO),
            "probe": probe_video(INPUT_VIDEO),
            "baseSwapper": "inswapper_128_fp16",
        },
        "method": {
            "sameInputForEveryRestorer": True,
            "provider": "CUDAExecutionProvider",
            "executionThreads": 1,
            "blendPercent": 100,
            "weight": 0.5,
            "audio": "disabled",
            "productionSettingsChanged": False,
            "gpen256Role": "diagnostic only; never an automatic production downgrade",
        },
        "results": [],
    }
    selected = [spec for spec in RESTORER_SPECS if spec.name in args.models]
    for index, spec in enumerate(selected, start=1):
        if spec.name in completed:
            result = completed[spec.name]
            print(f"[{index}/{len(selected)}] {spec.name}: reusing completed result", flush=True)
        else:
            print(f"[{index}/{len(selected)}] {spec.name}: acquiring and benchmarking", flush=True)
            result = run_restorer(spec, args)
            print(
                f"[{index}/{len(selected)}] {spec.name}: {result['status']} "
                f"wall={result.get('benchmark', {}).get('wallSeconds', 0)}s "
                f"warm={result.get('timing', {}).get('modelInference', {}).get('warmP50Ms', 0)}ms",
                flush=True,
            )
        report["results"].append(result)
        save_report(report)

    ok = [result for result in report["results"] if result.get("status") == "ok"]
    report["rankingByWarmInferenceP50"] = [
        item["restorer"]["name"]
        for item in sorted(
            ok,
            key=lambda item: item["timing"]["modelInference"]["warmP50Ms"],
        )
    ]
    report["finishedAtEpoch"] = time.time()
    save_report(report)
    print(json.dumps(report, indent=2), flush=True)
    if len(ok) != len(selected):
        raise SystemExit(2)


if __name__ == "__main__":
    main()
