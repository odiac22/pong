from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import av
import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pong_swap_config import CACHE_DIR
from pong_swap_engine import PongSwapEngine


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--seconds", type=float, default=10.0)
    parser.add_argument("--label", default="album")
    parser.add_argument("--restorer", choices=("on", "off"), default="off")
    parser.add_argument("--restorer-blend", type=int, default=80)
    parser.add_argument("--enhancer", choices=("realtime", "face", "off"), default="realtime")
    parser.add_argument("--swapper", choices=("128", "256", "512"), default="128")
    parser.add_argument("--detect-size", choices=("320", "416", "480", "640"), default="640")
    parser.add_argument("--detector", choices=("Retinaface", "SCRDF"), default="Retinaface")
    parser.add_argument("--detect-interval", type=int, default=4)
    parser.add_argument("--identity-interval", type=int, default=24)
    parser.add_argument("--max-faces", type=int, default=20)
    args = parser.parse_args()

    engine = PongSwapEngine()
    engine._config["parameters"]["RestorerSwitch"] = args.restorer == "on"
    engine._config["parameters"]["RestorerTypeTextSel"] = "GPEN256"
    engine._config["parameters"]["RestorerDetTypeTextSel"] = "Blend"
    engine._config["parameters"]["RestorerSlider"] = max(0, min(100, args.restorer_blend))
    engine._config["parameters"]["SwapperTypeTextSel"] = args.swapper
    engine._config["parameters"]["DetectInputSizeTextSel"] = args.detect_size
    engine._config["parameters"]["DetectTypeTextSel"] = args.detector
    engine._config["runtime"]["frameEnhancerEnabled"] = args.enhancer != "off"
    engine._config["runtime"]["frameEnhancerScope"] = "face" if args.enhancer == "face" else "realtime"
    engine._config["runtime"]["frameEnhancerDownscale"] = True
    engine._config["runtime"]["targetDetectIntervalFrames"] = max(1, args.detect_interval)
    engine._config["runtime"]["identityCheckIntervalFrames"] = max(1, args.identity_interval)
    engine._config["runtime"]["maximumFaces"] = max(1, args.max_faces)

    faces = engine.scan_faces()
    if not faces:
        raise RuntimeError("No approved benchmark face is installed")
    warm_started = time.perf_counter()
    engine.warm()
    source_embedding = engine.embedding_for_face(faces[0].id)
    warm_seconds = time.perf_counter() - warm_started

    container = av.open(args.url)
    stream = next(item for item in container.streams if item.type == "video")
    fps = float(stream.average_rate or stream.base_rate or 24.0)
    width = int(stream.codec_context.width)
    height = int(stream.codec_context.height)
    max_frames = max(1, round(args.seconds * fps))

    output_dir = CACHE_DIR / "album-benchmark"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{args.label}.mp4"
    report_path = output_dir / f"{args.label}.json"
    output_path.unlink(missing_ok=True)

    ffmpeg = subprocess.Popen(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s:v", f"{width}x{height}",
            "-r", f"{fps:.6f}", "-i", "pipe:0", "-an", "-c:v", "h264_nvenc",
            "-preset", str(engine.config["runtime"].get("encoderPreset", "p1")),
            "-tune", "ll", "-rc", "vbr", "-cq", str(engine.config["runtime"].get("encoderCq", 18)),
            "-b:v", "0", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output_path),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )

    frames = 0
    changed = 0
    sharpness_before: list[float] = []
    sharpness_after: list[float] = []
    anchor = None
    tracking_state: dict = {}
    first_frame_seconds = 0.0
    identity_interval = max(1, int(engine.config["runtime"].get("identityCheckIntervalFrames", 24)))
    started = time.perf_counter()
    try:
        for decoded in container.decode(stream):
            if frames >= max_frames:
                break
            rgb = decoded.to_ndarray(format="rgb24")
            frame_started = time.perf_counter()
            swapped, anchor = engine.process_frame(
                rgb,
                source_embedding,
                anchor,
                verify_identity=(frames % identity_interval == 0),
                tracking_state=tracking_state,
            )
            if frames == 0:
                first_frame_seconds = time.perf_counter() - frame_started
            result = swapped.cpu().numpy()
            ffmpeg.stdin.write(result.tobytes())
            delta = float(np.mean(np.abs(result.astype(np.int16) - rgb.astype(np.int16))))
            if delta > 0.25:
                changed += 1
            if frames % max(1, round(fps)) == 0:
                sharpness_before.append(float(cv2.Laplacian(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), cv2.CV_64F).var()))
                sharpness_after.append(float(cv2.Laplacian(cv2.cvtColor(result, cv2.COLOR_RGB2GRAY), cv2.CV_64F).var()))
            frames += 1
    finally:
        container.close()
        if ffmpeg.stdin:
            ffmpeg.stdin.close()
    process_seconds = time.perf_counter() - started
    stderr = ffmpeg.stderr.read().decode("utf-8", errors="replace") if ffmpeg.stderr else ""
    if ffmpeg.wait(timeout=60):
        raise RuntimeError(stderr[-2000:])

    processing_fps = frames / max(0.001, process_seconds)
    report = {
        "label": args.label,
        "url": args.url,
        "profile": {
            "restorer": args.restorer,
            "restorerBlend": args.restorer_blend,
            "enhancer": args.enhancer,
            "swapper": args.swapper,
            "detectSize": args.detect_size,
            "detector": args.detector,
            "detectInterval": args.detect_interval,
            "identityInterval": args.identity_interval,
            "maximumFaces": args.max_faces,
        },
        "video": {"width": width, "height": height, "fps": fps, "frames": frames},
        "timing": {
            "warmSeconds": round(warm_seconds, 3),
            "firstFrameSeconds": round(first_frame_seconds, 3),
            "processingSeconds": round(process_seconds, 3),
            "processingFps": round(processing_fps, 3),
            "realtimeHeadroom": round(processing_fps / fps, 3),
        },
        "qualitySignals": {
            "changedFrameRatio": round(changed / max(1, frames), 4),
            "meanSharpnessBefore": round(float(np.mean(sharpness_before)), 3) if sharpness_before else 0.0,
            "meanSharpnessAfter": round(float(np.mean(sharpness_after)), 3) if sharpness_after else 0.0,
        },
        "output": str(output_path),
    }
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
