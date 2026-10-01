from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import random
import re
import statistics
import subprocess
import time
from dataclasses import asdict
from pathlib import Path
from typing import Iterable

from benchmark_restorers_stock import RESTORER_SPECS, RestorerSpec
from benchmark_swappers_stock import CUDA_DLL_ROOT, MODEL_SPECS, PYTHON, VENDOR_ROOT, ModelSpec
from build_optimized_video_matrix import APPROVED, render_command


ROOT = Path(__file__).resolve().parent
REPORT_ROOT = ROOT / "benchmarks" / "onnx-runtime-profiles"
WORK_ROOT = ROOT / "work" / "onnx-runtime-profiles"
CURRENT_MODEL = next(spec for spec in MODEL_SPECS if spec.name == "inswapper_128_fp16")
PROFILE_NAMES = ("legacy", "current", "current_persistent")
NONDETERMINISTIC_THRESHOLDS = {
    "model:uniface_256": {"minimumPsnr": 47.0, "minimumSsim": 0.99},
}


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
    if not samples:
        return {"count": 0, "meanMs": 0.0, "p50Ms": 0.0, "p90Ms": 0.0, "p95Ms": 0.0}
    return {
        "count": len(samples),
        "meanMs": round(statistics.fmean(samples), 4),
        "p50Ms": round(percentile(samples, 0.50), 4),
        "p90Ms": round(percentile(samples, 0.90), 4),
        "p95Ms": round(percentile(samples, 0.95), 4),
    }


def read_events(path: Path) -> list[dict]:
    events = []
    if not path.is_file():
        return events
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            events.append(value)
    return events


def event_values(events: list[dict], stage: str) -> list[float]:
    values = [float(event["durationMs"]) for event in events if event.get("stage") == stage]
    return values[1:] or values


def atomic_write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    temporary.replace(path)


def decoded_frame_hash(path: Path) -> str:
    completed = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:v:0", "-f", "framemd5", "-"],
        check=True,
        capture_output=True,
        timeout=180,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    return hashlib.sha256(completed.stdout).hexdigest()


def decoded_similarity(reference: Path, candidate: Path) -> dict:
    completed = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "info",
            "-i",
            str(reference),
            "-i",
            str(candidate),
            "-lavfi",
            "[0:v][1:v]psnr;[0:v][1:v]ssim",
            "-f",
            "null",
            "NUL" if os.name == "nt" else "/dev/null",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=180,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    text = completed.stdout + "\n" + completed.stderr
    psnr_match = re.search(r"PSNR .*?average:([0-9.]+|inf)", text)
    ssim_match = re.search(r"SSIM .*?All:([0-9.]+)", text)
    if not psnr_match or not ssim_match:
        raise RuntimeError("Unable to parse decoded PSNR/SSIM")
    return {
        "psnr": float("inf") if psnr_match.group(1) == "inf" else float(psnr_match.group(1)),
        "ssim": float(ssim_match.group(1)),
    }


def profile_environment(profile: str, swap_log: Path, restorer_log: Path, diagnostic_log: Path) -> dict[str, str]:
    environment = dict(os.environ)
    environment["PATH"] = str(CUDA_DLL_ROOT) + os.pathsep + environment.get("PATH", "")
    environment["PONG_FACEFUSION_OPTIMIZED"] = "legacy" if profile == "legacy" else "current"
    environment["PONG_FACEFUSION_PERSISTENT_BINDING"] = "1" if profile == "current_persistent" else "0"
    environment["PONG_FACEFUSION_BENCHMARK_LOG"] = str(swap_log)
    environment["PONG_FACEFUSION_ENHANCER_BENCHMARK_LOG"] = str(restorer_log)
    environment["PONG_FACEFUSION_INFERENCE_DIAGNOSTIC_LOG"] = str(diagnostic_log)
    return environment


def candidate_name(model: ModelSpec, restorer: RestorerSpec | None) -> str:
    return f"restorer:{restorer.name}" if restorer is not None else f"model:{model.name}"


def run_profile(
    *,
    block_key: str,
    face_name: str,
    source: Path,
    model: ModelSpec,
    restorer: RestorerSpec | None,
    profile: str,
    frames: int,
    timeout_seconds: int,
) -> tuple[dict, Path]:
    safe_key = block_key.replace("|", "__").replace(":", "_")
    directory = WORK_ROOT / safe_key / profile
    directory.mkdir(parents=True, exist_ok=True)
    output = directory / "timing.mp4"
    swap_log = directory / "swapper.jsonl"
    restorer_log = directory / "restorer.jsonl"
    diagnostic_log = directory / "diagnostics.jsonl"
    process_log = directory / "process.log"
    for path in (output, swap_log, restorer_log, diagnostic_log, process_log):
        path.unlink(missing_ok=True)

    command = render_command(source, model, restorer, output, frames)
    started = time.perf_counter()
    with process_log.open("w", encoding="utf-8", errors="replace") as stream:
        completed = subprocess.run(
            command,
            cwd=str(VENDOR_ROOT),
            env=profile_environment(profile, swap_log, restorer_log, diagnostic_log),
            stdin=subprocess.DEVNULL,
            stdout=stream,
            stderr=subprocess.STDOUT,
            timeout=timeout_seconds,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    wall_seconds = time.perf_counter() - started
    if completed.returncode != 0 or not output.is_file():
        raise RuntimeError(f"Timing run failed: {block_key}/{profile}; see {process_log}")

    swap_events = read_events(swap_log)
    restorer_events = read_events(restorer_log)
    diagnostics = read_events(diagnostic_log)
    providers = sorted(
        {
            provider
            for event in swap_events + restorer_events
            for provider in event.get("providers", [])
            if isinstance(provider, str)
        }
    )
    if "CUDAExecutionProvider" not in providers:
        raise RuntimeError(f"CUDA provider missing: {block_key}/{profile}")
    blocking_diagnostics = [
        event
        for event in diagnostics
        if not (event.get("event") == "optimized-disabled" and event.get("phase") == "preflight")
    ]
    if blocking_diagnostics:
        raise RuntimeError(
            f"Unsafe optimized-path diagnostics were emitted: {block_key}/{profile}: {blocking_diagnostics}"
        )

    raw = {
        "swapperInferenceMs": event_values(swap_events, "modelInference"),
        "swapperCompleteMs": event_values(swap_events, "swapTotal"),
        "restorerInferenceMs": event_values(restorer_events, "modelInference"),
        "restorerCompleteMs": event_values(restorer_events, "enhanceTotal"),
    }
    result = {
        "profile": profile,
        "wallSeconds": round(wall_seconds, 4),
        "providers": providers,
        "diagnostics": diagnostics,
        "preflightOrdinaryRun": bool(diagnostics),
        "decodedFrameHash": decoded_frame_hash(output),
        "raw": raw,
        "summary": {name: timing_summary(values) for name, values in raw.items()},
        "processLog": str(process_log),
    }
    return result, output


def aggregate(report: dict) -> list[dict]:
    buckets: dict[tuple[str, str], dict] = {}
    for block in report.get("blocks", []):
        candidate = block["candidate"]
        for run in block.get("runs", []):
            key = (candidate, run["profile"])
            bucket = buckets.setdefault(
                key,
                {
                    "candidate": candidate,
                    "profile": run["profile"],
                    "wallSeconds": [],
                    "swapperInferenceMs": [],
                    "swapperCompleteMs": [],
                    "restorerInferenceMs": [],
                    "restorerCompleteMs": [],
                    "exactBlocks": [],
                    "equivalentBlocks": [],
                },
            )
            bucket["wallSeconds"].append(run["wallSeconds"])
            for name, values in run["raw"].items():
                bucket[name].extend(values)
            bucket["exactBlocks"].append(bool(block.get("decodedExact")))
            bucket["equivalentBlocks"].append(bool(block.get("decodedEquivalent", block.get("decodedExact"))))

    rows = []
    for bucket in buckets.values():
        rows.append(
            {
                "candidate": bucket["candidate"],
                "profile": bucket["profile"],
                "runCount": len(bucket["wallSeconds"]),
                "allDecodedExact": all(bucket["exactBlocks"]),
                "allDecodedEquivalent": all(bucket["equivalentBlocks"]),
                "wallSeconds": timing_summary(bucket["wallSeconds"]),
                "swapperInference": timing_summary(bucket["swapperInferenceMs"]),
                "swapperComplete": timing_summary(bucket["swapperCompleteMs"]),
                "restorerInference": timing_summary(bucket["restorerInferenceMs"]),
                "restorerComplete": timing_summary(bucket["restorerCompleteMs"]),
            }
        )
    return sorted(rows, key=lambda item: (item["candidate"], item["profile"]))


def write_csv(report: dict) -> None:
    rows = []
    for item in report.get("aggregate", []):
        stage = "restorerComplete" if item["candidate"].startswith("restorer:") else "swapperComplete"
        rows.append(
            {
                "candidate": item["candidate"],
                "profile": item["profile"],
                "runs": item["runCount"],
                "decodedExact": item["allDecodedExact"],
                "decodedEquivalent": item["allDecodedEquivalent"],
                "completeP50Ms": item[stage]["p50Ms"],
                "completeP90Ms": item[stage]["p90Ms"],
                "completeP95Ms": item[stage]["p95Ms"],
                "inferenceP50Ms": item[stage.replace("Complete", "Inference")]["p50Ms"],
                "wallP50Seconds": item["wallSeconds"]["p50Ms"],
            }
        )
    path = REPORT_ROOT / "results.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".csv.tmp")
    with temporary.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]) if rows else ["candidate"])
        writer.writeheader()
        writer.writerows(rows)
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Timing-only A/B for the ONNX runtime execution profiles.")
    parser.add_argument("--profiles", nargs="+", choices=PROFILE_NAMES, default=["legacy", "current"])
    parser.add_argument("--faces", nargs="+", choices=list(APPROVED), default=list(APPROVED))
    parser.add_argument("--models", nargs="+", choices=[spec.name for spec in MODEL_SPECS], default=[spec.name for spec in MODEL_SPECS])
    parser.add_argument("--restorers", nargs="+", choices=[spec.name for spec in RESTORER_SPECS], default=[spec.name for spec in RESTORER_SPECS])
    parser.add_argument("--rounds", type=int, default=2)
    parser.add_argument("--frames", type=int, default=36)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--seed", type=int, default=18742)
    parser.add_argument("--resume", action=argparse.BooleanOptionalAction, default=True)
    args = parser.parse_args()

    models = [spec for spec in MODEL_SPECS if spec.name in args.models]
    restorers = [spec for spec in RESTORER_SPECS if spec.name in args.restorers]
    candidates: list[tuple[ModelSpec, RestorerSpec | None]] = [(model, None) for model in models]
    candidates.extend((CURRENT_MODEL, restorer) for restorer in restorers)
    report_path = REPORT_ROOT / "results.json"
    previous = {}
    if args.resume and report_path.is_file():
        previous = json.loads(report_path.read_text(encoding="utf-8"))
    completed = {block["key"]: block for block in previous.get("blocks", []) if block.get("status") == "ok"}
    report = {
        "schemaVersion": 1,
        "createdAtEpoch": time.time(),
        "method": {
            "timingOnly": True,
            "finalComparisonVideosRegenerated": False,
            "temporaryVideosDeleted": True,
            "audio": "absent",
            "framesPerRun": args.frames,
            "rounds": args.rounds,
            "profiles": args.profiles,
            "randomSeed": args.seed,
            "firstFrameExcluded": True,
        },
        "models": [asdict(spec) for spec in models],
        "restorers": [asdict(spec) for spec in restorers],
        "blocks": [],
    }

    block_specs = []
    for round_index in range(args.rounds):
        for face_name in args.faces:
            for model, restorer in candidates:
                candidate = candidate_name(model, restorer)
                key = f"r{round_index + 1}|{face_name}|{candidate}|{'-'.join(args.profiles)}|f{args.frames}"
                block_specs.append((key, round_index + 1, face_name, model, restorer))
    random.Random(args.seed).shuffle(block_specs)

    total = len(block_specs)
    for index, (key, round_number, face_name, model, restorer) in enumerate(block_specs, start=1):
        if key in completed:
            block = completed[key]
            print(f"[{index}/{total}] resume {key}", flush=True)
        else:
            profile_order = list(args.profiles)
            random.Random(f"{args.seed}|{key}").shuffle(profile_order)
            print(f"[{index}/{total}] run {key} order={profile_order}", flush=True)
            outputs: list[tuple[str, Path]] = []
            runs = []
            try:
                for profile in profile_order:
                    result, output = run_profile(
                        block_key=key,
                        face_name=face_name,
                        source=APPROVED[face_name],
                        model=model,
                        restorer=restorer,
                        profile=profile,
                        frames=args.frames,
                        timeout_seconds=args.timeout,
                    )
                    runs.append(result)
                    outputs.append((profile, output))
                hashes = {run["decodedFrameHash"] for run in runs}
                exact = len(hashes) == 1
                comparisons = []
                if not exact:
                    reference_profile, reference_output = outputs[0]
                    for candidate_profile, candidate_output in outputs[1:]:
                        comparisons.append(
                            {
                                "reference": reference_profile,
                                "candidate": candidate_profile,
                                **decoded_similarity(reference_output, candidate_output),
                            }
                        )
                thresholds = NONDETERMINISTIC_THRESHOLDS.get(candidate_name(model, restorer))
                equivalent = exact or bool(
                    thresholds
                    and comparisons
                    and all(
                        item["psnr"] >= thresholds["minimumPsnr"]
                        and item["ssim"] >= thresholds["minimumSsim"]
                        for item in comparisons
                    )
                )
                block = {
                    "key": key,
                    "round": round_number,
                    "face": face_name,
                    "candidate": candidate_name(model, restorer),
                    "profileOrder": profile_order,
                    "runs": runs,
                    "decodedExact": exact,
                    "decodedEquivalent": equivalent,
                    "decodedComparisons": comparisons,
                    "equivalenceThreshold": thresholds,
                    "status": "ok" if equivalent else "output-mismatch",
                }
                if not block["decodedEquivalent"]:
                    raise RuntimeError(f"Decoded output mismatch: {key}")
            finally:
                for _, output in outputs:
                    output.unlink(missing_ok=True)
        report["blocks"].append(block)
        report["aggregate"] = aggregate(report)
        atomic_write_json(report_path, report)
        write_csv(report)

    report["finishedAtEpoch"] = time.time()
    report["status"] = "complete"
    report["aggregate"] = aggregate(report)
    atomic_write_json(report_path, report)
    write_csv(report)
    print(f"complete: {len(report['blocks'])} A/B blocks; report={report_path}", flush=True)


if __name__ == "__main__":
    main()
