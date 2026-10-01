from __future__ import annotations

import json
import math
import os
import subprocess
import time
from pathlib import Path

import cv2
import numpy as np

from pong_swap_config import CACHE_DIR
from pong_swap_engine import PongSwapEngine


BENCHMARK_DIR = CACHE_DIR / "benchmark"
VIDEO_PATH = BENCHMARK_DIR / "target-video.mp4"
SOURCE_PATH = BENCHMARK_DIR / "source-face.jpg"
OUTPUT_PATH = BENCHMARK_DIR / "swapped-output.mp4"
REPORT_PATH = BENCHMARK_DIR / "report.json"


def _probe(path: Path) -> dict:
    completed = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-show_entries",
            "stream=index,codec_type,codec_name,width,height,r_frame_rate,nb_frames,duration",
            "-of",
            "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    return json.loads(completed.stdout)


def _duration(probe: dict) -> float:
    return float(probe.get("format", {}).get("duration") or 0.0)


def _similarity(engine: PongSwapEngine, left: np.ndarray, right: np.ndarray) -> float:
    return float(engine._vm.findCosineDistance(np.asarray(left), np.asarray(right)))


def _recognized_embedding(engine: PongSwapEngine, rgb) -> np.ndarray | None:
    if isinstance(rgb, engine._torch.Tensor):
        image = rgb.permute(2, 0, 1)
    else:
        image = engine._frame_tensor(rgb)
    detected = engine._detect(image, recognize=True)
    if not detected or detected[0][2] is None:
        return None
    return np.asarray(detected[0][2], dtype=np.float32)


def run() -> dict:
    if not VIDEO_PATH.exists() or not SOURCE_PATH.exists():
        raise FileNotFoundError("The licensed stock benchmark assets are missing")
    BENCHMARK_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.unlink(missing_ok=True)

    engine = PongSwapEngine()
    cold_started = time.perf_counter()
    warm = engine.warm()
    warm_seconds = time.perf_counter() - cold_started
    source_embedding = engine.embedding_from_images([SOURCE_PATH])

    capture = cv2.VideoCapture(str(VIDEO_PATH))
    if not capture.isOpened():
        raise RuntimeError("OpenCV could not open the stock benchmark video")
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    output_width, output_height = engine.output_dimensions(width, height)
    expected_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if fps <= 0 or width <= 0 or height <= 0:
        raise RuntimeError("The stock benchmark video metadata is invalid")

    ffmpeg = subprocess.Popen(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s:v",
            f"{output_width}x{output_height}",
            "-r",
            f"{fps:.12f}",
            "-i",
            "pipe:0",
            "-an",
            "-c:v",
            "h264_nvenc",
            "-preset",
            str(engine.config["runtime"].get("encoderPreset", "p1")),
            "-tune",
            "ll",
            "-rc",
            "vbr",
            "-cq",
            str(engine.config["runtime"].get("encoderCq", 23)),
            "-b:v",
            "0",
            "-movflags",
            "+faststart",
            str(OUTPUT_PATH),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )

    anchor = None
    tracking_state = {}
    frames = 0
    swapped_frames = 0
    sampled = []
    first_frame_seconds = None
    processing_started = time.perf_counter()
    identity_interval = max(
        1, int(engine.config["runtime"].get("identityCheckIntervalFrames", 12))
    )
    try:
        while True:
            ok, bgr = capture.read()
            if not ok:
                break
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            frame_started = time.perf_counter()
            swapped, anchor = engine.process_frame(
                rgb,
                source_embedding,
                anchor,
                verify_identity=(frames % identity_interval == 0),
                tracking_state=tracking_state,
            )
            if first_frame_seconds is None:
                first_frame_seconds = time.perf_counter() - frame_started
            swapped_cpu = swapped.cpu().numpy()
            ffmpeg.stdin.write(swapped_cpu.tobytes())

            comparison = swapped_cpu
            if comparison.shape[:2] != rgb.shape[:2]:
                comparison = cv2.resize(comparison, (width, height), interpolation=cv2.INTER_AREA)
            mean_pixel_delta = float(
                np.mean(np.abs(comparison.astype(np.int16) - rgb.astype(np.int16)))
            )
            if mean_pixel_delta > 0.25:
                swapped_frames += 1

            frames += 1
    finally:
        capture.release()
        if ffmpeg.stdin:
            ffmpeg.stdin.close()

    stderr = ffmpeg.stderr.read().decode("utf-8", errors="replace") if ffmpeg.stderr else ""
    return_code = ffmpeg.wait(timeout=60)
    if return_code != 0:
        raise RuntimeError(f"FFmpeg failed ({return_code}): {stderr[-1200:]}")

    processing_seconds = time.perf_counter() - processing_started

    # Identity QA runs after the timed encode.  It must prove the output is
    # a real swap without contaminating the live-throughput measurement.
    source_capture = cv2.VideoCapture(str(VIDEO_PATH))
    output_capture = cv2.VideoCapture(str(OUTPUT_PATH))
    sample_every = max(1, round(fps))
    sample_index = 0
    try:
        while True:
            ok_source, before_bgr = source_capture.read()
            ok_output, after_bgr = output_capture.read()
            if not ok_source or not ok_output:
                break
            if sample_index % sample_every == 0:
                before_rgb = cv2.cvtColor(before_bgr, cv2.COLOR_BGR2RGB)
                after_rgb = cv2.cvtColor(after_bgr, cv2.COLOR_BGR2RGB)
                before_embedding = _recognized_embedding(engine, before_rgb)
                after_embedding = _recognized_embedding(engine, after_rgb)
                if before_embedding is not None and after_embedding is not None:
                    sampled.append(
                        {
                            "frame": sample_index,
                            "sourceSimilarityBefore": round(
                                _similarity(engine, before_embedding, source_embedding), 3
                            ),
                            "sourceSimilarityAfter": round(
                                _similarity(engine, after_embedding, source_embedding), 3
                            ),
                            "targetSimilarityAfter": round(
                                _similarity(engine, after_embedding, before_embedding), 3
                            ),
                            "meanPixelDelta": round(
                                float(
                                    np.mean(
                                        np.abs(
                                            (cv2.resize(after_rgb, (width, height), interpolation=cv2.INTER_AREA)
                                             if after_rgb.shape[:2] != before_rgb.shape[:2] else after_rgb).astype(np.int16)
                                            - before_rgb.astype(np.int16)
                                        )
                                    )
                                ),
                                3,
                            ),
                        }
                    )
            sample_index += 1
    finally:
        source_capture.release()
        output_capture.release()
    input_probe = _probe(VIDEO_PATH)
    output_probe = _probe(OUTPUT_PATH)
    input_duration = _duration(input_probe)
    output_duration = _duration(output_probe)
    frame_time = 1.0 / fps
    duration_delta = abs(input_duration - output_duration)
    before_scores = [sample["sourceSimilarityBefore"] for sample in sampled]
    after_scores = [sample["sourceSimilarityAfter"] for sample in sampled]
    mean_before = float(np.mean(before_scores)) if before_scores else 0.0
    mean_after = float(np.mean(after_scores)) if after_scores else 0.0
    identity_gain = mean_after - mean_before
    processing_fps = frames / max(processing_seconds, 0.001)
    realtime_headroom = processing_fps / fps

    checks = {
        "sourceLongerThanTenSeconds": input_duration > 10.0,
        "allFramesDecoded": expected_frames <= 0 or frames == expected_frames,
        "durationWithinOneFrame": duration_delta <= frame_time + 0.005,
        "faceChangedOnMostFrames": frames > 0 and swapped_frames / frames >= 0.90,
        "identityMovedTowardSource": len(sampled) >= 5 and identity_gain >= 3.0,
        "realtimeHeadroom": realtime_headroom
        >= float(engine.config["runtime"].get("minimumHeadroom", 1.25)),
    }
    report = {
        "ok": all(checks.values()),
        "assets": {
            "video": str(VIDEO_PATH),
            "sourcePhoto": str(SOURCE_PATH),
            "output": str(OUTPUT_PATH),
            "videoAttribution": "George Milton / Pexels video 7010283",
            "photoAttribution": "cottonbro studio / Pexels photo 7000122",
        },
        "timing": {
            "coldWarmSeconds": round(warm_seconds, 3),
            "firstSwappedFrameSeconds": round(first_frame_seconds or math.inf, 3),
            "processingSeconds": round(processing_seconds, 3),
            "processingFps": round(processing_fps, 3),
            "sourceFps": round(fps, 3),
            "realtimeHeadroom": round(realtime_headroom, 3),
        },
        "media": {
            "width": width,
            "height": height,
            "outputWidth": output_width,
            "outputHeight": output_height,
            "expectedFrames": expected_frames,
            "processedFrames": frames,
            "inputDurationSeconds": input_duration,
            "outputDurationSeconds": output_duration,
            "durationDeltaSeconds": round(duration_delta, 6),
        },
        "identity": {
            "sampleCount": len(sampled),
            "meanSourceSimilarityBefore": round(mean_before, 3),
            "meanSourceSimilarityAfter": round(mean_after, 3),
            "meanIdentityGain": round(identity_gain, 3),
            "changedFrames": swapped_frames,
            "samples": sampled,
        },
        "checks": checks,
        "engine": warm,
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    if not report["ok"]:
        raise SystemExit(2)
    return report


if __name__ == "__main__":
    run()
