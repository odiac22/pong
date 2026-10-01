from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
import time
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pong_swap_config import CACHE_DIR, LOG_DIR
from pong_swap_engine import PongSwapEngine


def percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * q
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] * (upper - position) + ordered[upper] * (position - lower)


def face_crop(rgb: np.ndarray, kps: np.ndarray, scale: float = 3.2) -> np.ndarray:
    points = np.asarray(kps, dtype=np.float32)
    height, width = rgb.shape[:2]
    center_x = float((points[:, 0].min() + points[:, 0].max()) * 0.5)
    center_y = float((points[:, 1].min() + points[:, 1].max()) * 0.5)
    span = max(float(np.ptp(points[:, 0])), float(np.ptp(points[:, 1])))
    side = max(48, int(round(span * scale)))
    left = max(0, min(width - 2, int(round(center_x - side * 0.5))))
    top = max(0, min(height - 2, int(round(center_y - side * 0.55))))
    right = max(left + 2, min(width, left + side))
    bottom = max(top + 2, min(height, top + side))
    return np.ascontiguousarray(rgb[top:bottom, left:right])


def detail_signals(crop: np.ndarray) -> dict[str, float]:
    if crop.size == 0:
        return {"laplacian": 0.0, "tenengrad": 0.0, "highFrequencyRatio": 0.0}
    gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)
    laplacian = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    gx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)
    tenengrad = float(np.mean(gx * gx + gy * gy))
    spectrum = np.abs(np.fft.fftshift(np.fft.fft2(gray.astype(np.float32)))) ** 2
    height, width = spectrum.shape
    yy, xx = np.ogrid[:height, :width]
    radius = np.sqrt((yy - height / 2.0) ** 2 + (xx - width / 2.0) ** 2)
    high = spectrum[radius >= 0.28 * min(height, width)].sum()
    total = spectrum.sum()
    return {
        "laplacian": laplacian,
        "tenengrad": tenengrad,
        "highFrequencyRatio": float(high / total) if total > 0 else 0.0,
    }


def recognized(engine: PongSwapEngine, rgb: np.ndarray):
    detected = engine._detect(engine._frame_tensor(rgb), recognize=True)
    engine._torch.cuda.synchronize()
    if not detected or detected[0][2] is None:
        return None, None
    return np.asarray(detected[0][2], dtype=np.float32), np.asarray(detected[0][1], dtype=np.float32)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True)
    parser.add_argument("--face-name", default="Test 1")
    parser.add_argument("--frames", type=int, default=240)
    parser.add_argument("--backend", choices=("current", "cuda", "trt"), default="current")
    parser.add_argument("--detector", choices=("current", "Retinaface", "SCRDF"), default="current")
    parser.add_argument("--detect-size", choices=("current", "320", "416", "480", "640"), default="current")
    parser.add_argument("--detect-interval", type=int)
    parser.add_argument("--identity-interval", type=int)
    parser.add_argument("--max-faces", type=int)
    parser.add_argument(
        "--swapper",
        choices=("current", "128", "AlphaFace", "256", "512"),
        default="current",
    )
    parser.add_argument("--restorer", choices=("current", "on", "off"), default="current")
    parser.add_argument("--enhancer", choices=("current", "realtime", "face", "full", "off"), default="current")
    parser.add_argument("--detail-transfer", type=int, help="Texture Preserve strength from 0 to 100")
    parser.add_argument("--save-contact-sheet", action="store_true")
    args = parser.parse_args()

    video_path = CACHE_DIR / "benchmark" / "target-video.mp4"
    if not video_path.exists():
        raise FileNotFoundError(f"Stock benchmark video is missing: {video_path}")

    engine = PongSwapEngine()
    if args.backend != "current":
        engine._config["runtime"]["backend"] = args.backend
    if args.detector != "current":
        engine._config["parameters"]["DetectTypeTextSel"] = args.detector
    if args.detect_size != "current":
        engine._config["parameters"]["DetectInputSizeTextSel"] = args.detect_size
    if args.detect_interval is not None:
        engine._config["runtime"]["targetDetectIntervalFrames"] = max(1, args.detect_interval)
    if args.identity_interval is not None:
        engine._config["runtime"]["identityCheckIntervalFrames"] = max(1, args.identity_interval)
    if args.max_faces is not None:
        engine._config["runtime"]["maximumFaces"] = max(1, args.max_faces)
    if args.swapper != "current":
        engine._config["parameters"]["SwapperTypeTextSel"] = args.swapper
    if args.restorer != "current":
        engine._config["parameters"]["RestorerSwitch"] = args.restorer == "on"
    if args.enhancer != "current":
        engine._config["runtime"]["frameEnhancerEnabled"] = args.enhancer != "off"
        if args.enhancer != "off":
            engine._config["runtime"]["frameEnhancerScope"] = args.enhancer
    if args.detail_transfer is not None:
        engine._config["parameters"]["DetailTransferSlider"] = max(0, min(100, args.detail_transfer))

    faces = engine.scan_faces()
    face = next((item for item in faces if item.name.casefold() == args.face_name.casefold()), None)
    if face is None:
        raise ValueError(f"Approved face not found: {args.face_name}")

    cold_started = time.perf_counter()
    warm_report = engine.warm()
    engine._torch.cuda.synchronize()
    cold_warm_seconds = time.perf_counter() - cold_started
    embedding_started = time.perf_counter()
    source_embedding = engine.embedding_for_face(face.id)
    engine._torch.cuda.synchronize()
    embedding_seconds = time.perf_counter() - embedding_started

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError("Could not open stock benchmark video")
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    expected = min(max(1, args.frames), int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or args.frames))

    process_ms: list[float] = []
    decode_ms: list[float] = []
    download_ms: list[float] = []
    samples: list[tuple[int, np.ndarray, np.ndarray]] = []
    anchor = None
    tracking_state: dict = {}
    stage_diagnostics: dict[str, list[float]] = {"_enableMaskSubstageTimings": True}
    changed = 0
    identity_interval = max(1, int(engine.config["runtime"].get("identityCheckIntervalFrames", 48)))
    loop_started = time.perf_counter()
    frames = 0
    while frames < expected:
        decode_started = time.perf_counter()
        ok, bgr = capture.read()
        if not ok:
            break
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        decode_ms.append((time.perf_counter() - decode_started) * 1000.0)

        engine._torch.cuda.synchronize()
        process_started = time.perf_counter()
        swapped, anchor = engine.process_frame(
            rgb,
            source_embedding,
            anchor,
            verify_identity=(frames % identity_interval == 0),
            tracking_state=tracking_state,
            diagnostics=stage_diagnostics,
        )
        engine._torch.cuda.synchronize()
        process_ms.append((time.perf_counter() - process_started) * 1000.0)

        download_started = time.perf_counter()
        result = swapped.cpu().numpy()
        download_ms.append((time.perf_counter() - download_started) * 1000.0)
        if float(np.mean(np.abs(result.astype(np.int16) - rgb.astype(np.int16)))) > 0.25:
            changed += 1
        if frames in {0, max(1, expected // 3), max(2, (expected * 2) // 3), expected - 1}:
            samples.append((frames, rgb.copy(), result.copy()))
        frames += 1
    engine._torch.cuda.synchronize()
    loop_seconds = time.perf_counter() - loop_started
    capture.release()

    quality_samples = []
    contact_rows = []
    for frame_index, before, after in samples:
        before_embedding, before_kps = recognized(engine, before)
        after_embedding, after_kps = recognized(engine, after)
        if before_kps is None or after_kps is None:
            continue
        before_crop = face_crop(before, before_kps)
        after_crop = face_crop(after, after_kps)
        identity_before = float(engine._vm.findCosineDistance(before_embedding, source_embedding)) if before_embedding is not None else 0.0
        identity_after = float(engine._vm.findCosineDistance(after_embedding, source_embedding)) if after_embedding is not None else 0.0
        quality_samples.append({
            "frame": frame_index,
            "identityBefore": identity_before,
            "identityAfter": identity_after,
            "identityGain": identity_after - identity_before,
            "beforeDetail": detail_signals(before_crop),
            "afterDetail": detail_signals(after_crop),
            "cropBefore": [int(before_crop.shape[1]), int(before_crop.shape[0])],
            "cropAfter": [int(after_crop.shape[1]), int(after_crop.shape[0])],
        })
        if args.save_contact_sheet:
            size = 320
            contact_rows.append(np.concatenate([
                cv2.resize(before_crop, (size, size), interpolation=cv2.INTER_LANCZOS4),
                cv2.resize(after_crop, (size, size), interpolation=cv2.INTER_LANCZOS4),
            ], axis=1))

    log_dir = LOG_DIR / "optimization-20260916"
    log_dir.mkdir(parents=True, exist_ok=True)
    contact_path = log_dir / f"{args.label}-private-contact-sheet.jpg"
    if contact_rows:
        cv2.imwrite(str(contact_path), cv2.cvtColor(np.concatenate(contact_rows, axis=0), cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 94])

    swapper_name = str(engine.config["parameters"].get("SwapperTypeTextSel", "128"))
    if swapper_name == "AlphaFace":
        swapper_uses_trt = getattr(engine._models, "_alphaface_uses_trt", False)
    elif swapper_name == "256-Native":
        swapper_uses_trt = getattr(engine._models, "_swapper_256_uses_trt", False)
    elif swapper_name == "512-Native":
        swapper_uses_trt = getattr(engine._models, "_swapper_512_uses_trt", False)
    else:
        swapper_uses_trt = getattr(engine._models, "_swapper_uses_trt", False)
    active_backends = {
        "swapper": "trt" if swapper_uses_trt else "cuda",
        "detector": "trt" if getattr(engine._models, "_retinaface_uses_trt", False) else "cuda",
        "recognition": "trt" if getattr(engine._models, "_recognition_uses_trt", False) else "cuda",
    }
    report = {
        "label": args.label,
        "face": {"id": face.id, "name": face.name},
        "requestedBackend": engine.config["runtime"].get("backend"),
        "activeBackends": active_backends,
        "profile": {
            "detector": engine.config["parameters"].get("DetectTypeTextSel"),
            "detectSize": engine.config["parameters"].get("DetectInputSizeTextSel"),
            "detectInterval": engine.config["runtime"].get("targetDetectIntervalFrames"),
            "identityInterval": engine.config["runtime"].get("identityCheckIntervalFrames"),
            "maximumFaces": engine.config["runtime"].get("maximumFaces"),
            "swapper": engine.config["parameters"].get("SwapperTypeTextSel"),
            "restorer": bool(engine.config["parameters"].get("RestorerSwitch")),
            "enhancer": engine.config["runtime"].get("frameEnhancerScope") if engine.config["runtime"].get("frameEnhancerEnabled") else "off",
            "detailTransfer": engine.config["parameters"].get("DetailTransferSlider", 0),
        },
        "video": {"width": width, "height": height, "fps": fps, "frames": frames},
        "timing": {
            "coldWarmSeconds": cold_warm_seconds,
            "embeddingSeconds": embedding_seconds,
            "loopSeconds": loop_seconds,
            "endToEndFps": frames / max(loop_seconds, 0.001),
            "realtimeHeadroom": (frames / max(loop_seconds, 0.001)) / max(fps, 0.001),
            "firstProcessMs": process_ms[0] if process_ms else 0.0,
            "processMedianMs": statistics.median(process_ms) if process_ms else 0.0,
            "processP90Ms": percentile(process_ms, 0.90),
            "processP95Ms": percentile(process_ms, 0.95),
            "decodeMedianMs": statistics.median(decode_ms) if decode_ms else 0.0,
            "downloadMedianMs": statistics.median(download_ms) if download_ms else 0.0,
            "stageMedianMs": {
                key: statistics.median(values)
                for key, values in sorted(stage_diagnostics.items())
                if not key.startswith("_") and isinstance(values, list) and values
            },
            "stageP90Ms": {
                key: percentile(values, 0.90)
                for key, values in sorted(stage_diagnostics.items())
                if not key.startswith("_") and isinstance(values, list) and values
            },
        },
        "quality": {
            "changedFrameRatio": changed / max(1, frames),
            "samples": quality_samples,
            "contactSheet": str(contact_path) if contact_rows else "",
        },
        "warm": warm_report,
    }
    output_path = log_dir / f"{args.label}.json"
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
