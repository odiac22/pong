from __future__ import annotations

import json
import math
import statistics
from pathlib import Path

import cv2
import numpy as np

from pong_swap_engine import ENGINE


ROOT = Path(__file__).resolve().parent
SOURCE_FACE = ROOT / "cache" / "benchmark" / "source-face.jpg"
SWAPPER_INPUT = ROOT / "cache" / "benchmark" / "target-video.mp4"
SWAPPER_ROOT = ROOT / "benchmarks" / "swapper-baseline"
RESTORER_ROOT = ROOT / "benchmarks" / "restorer-baseline"


def recognized(rgb: np.ndarray):
    detected = ENGINE._detect(ENGINE._frame_tensor(rgb), recognize=True)
    ENGINE._torch.cuda.synchronize()
    if not detected or detected[0][2] is None:
        return None, None
    return (
        np.asarray(detected[0][2], dtype=np.float32),
        np.asarray(detected[0][1], dtype=np.float32),
    )


def similarity(left: np.ndarray, right: np.ndarray) -> float:
    return float(ENGINE._vm.findCosineDistance(np.asarray(left), np.asarray(right)))


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
    spectrum = np.abs(np.fft.fftshift(np.fft.fft2(gray.astype(np.float32)))) ** 2
    height, width = spectrum.shape
    yy, xx = np.ogrid[:height, :width]
    radius = np.sqrt((yy - height / 2.0) ** 2 + (xx - width / 2.0) ** 2)
    high = spectrum[radius >= 0.28 * min(height, width)].sum()
    total = spectrum.sum()
    return {
        "laplacian": laplacian,
        "tenengrad": float(np.mean(gx * gx + gy * gy)),
        "highFrequencyRatio": float(high / total) if total > 0 else 0.0,
    }


def read_frame(path: Path, frame_index: int) -> np.ndarray | None:
    capture = cv2.VideoCapture(str(path))
    try:
        capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
        ok, bgr = capture.read()
        if not ok:
            return None
        return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    finally:
        capture.release()


def all_frame_change(input_path: Path, output_path: Path) -> dict:
    before_capture = cv2.VideoCapture(str(input_path))
    after_capture = cv2.VideoCapture(str(output_path))
    deltas = []
    changed = 0
    frames = 0
    try:
        while True:
            ok_before, before = before_capture.read()
            ok_after, after = after_capture.read()
            if not ok_before or not ok_after:
                break
            if after.shape[:2] != before.shape[:2]:
                after = cv2.resize(after, (before.shape[1], before.shape[0]), interpolation=cv2.INTER_AREA)
            delta = float(np.mean(np.abs(after.astype(np.int16) - before.astype(np.int16))))
            deltas.append(delta)
            changed += int(delta > 0.25)
            frames += 1
    finally:
        before_capture.release()
        after_capture.release()
    return {
        "framesCompared": frames,
        "changedFrameRatio": changed / max(1, frames),
        "meanPixelDelta": statistics.fmean(deltas) if deltas else 0.0,
        "p50PixelDelta": statistics.median(deltas) if deltas else 0.0,
    }


def summarize_samples(samples: list[dict]) -> dict:
    successful = [sample for sample in samples if sample.get("faceDetected")]
    if not successful:
        return {
            "sampleCount": len(samples),
            "recognizedCount": 0,
            "recognitionRate": 0.0,
        }
    identity_after = [sample["identityAfter"] for sample in successful]
    identity_gain = [sample["identityGain"] for sample in successful]
    alignment = [sample["normalizedLandmarkDrift"] for sample in successful]
    laplacian_ratio = [sample["laplacianRatio"] for sample in successful]
    return {
        "sampleCount": len(samples),
        "recognizedCount": len(successful),
        "recognitionRate": len(successful) / len(samples),
        "meanIdentityAfter": statistics.fmean(identity_after),
        "meanIdentityGain": statistics.fmean(identity_gain),
        "identityAfterStdDev": statistics.pstdev(identity_after) if len(identity_after) > 1 else 0.0,
        "meanNormalizedLandmarkDrift": statistics.fmean(alignment),
        "meanLaplacianRatio": statistics.fmean(laplacian_ratio),
    }


def analyze_output(
    input_path: Path,
    output_path: Path,
    source_embedding: np.ndarray,
    frame_indices: list[int],
) -> dict:
    samples = []
    for frame_index in frame_indices:
        before = read_frame(input_path, frame_index)
        after = read_frame(output_path, frame_index)
        if before is None or after is None:
            samples.append({"frame": frame_index, "faceDetected": False, "reason": "missing-frame"})
            continue
        before_embedding, before_kps = recognized(before)
        after_embedding, after_kps = recognized(after)
        if before_embedding is None or after_embedding is None or before_kps is None or after_kps is None:
            samples.append({"frame": frame_index, "faceDetected": False, "reason": "recognition-failed"})
            continue
        before_crop = face_crop(before, before_kps)
        after_crop = face_crop(after, after_kps)
        before_detail = detail_signals(before_crop)
        after_detail = detail_signals(after_crop)
        landmark_span = max(float(np.ptp(before_kps[:, 0])), float(np.ptp(before_kps[:, 1])), 1.0)
        identity_before = similarity(before_embedding, source_embedding)
        identity_after = similarity(after_embedding, source_embedding)
        samples.append(
            {
                "frame": frame_index,
                "faceDetected": True,
                "identityBefore": identity_before,
                "identityAfter": identity_after,
                "identityGain": identity_after - identity_before,
                "normalizedLandmarkDrift": float(
                    np.mean(np.linalg.norm(after_kps - before_kps, axis=1)) / landmark_span
                ),
                "laplacianRatio": after_detail["laplacian"] / max(before_detail["laplacian"], 1e-9),
                "beforeDetail": before_detail,
                "afterDetail": after_detail,
            }
        )
    return {
        "summary": summarize_samples(samples),
        "fullVideoChange": all_frame_change(input_path, output_path),
        "samples": samples,
    }


def analyze_report(report_path: Path, kind: str, source_embedding: np.ndarray) -> dict:
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if kind == "swapper":
        input_path = SWAPPER_INPUT
        items = report.get("results", [])
        name_key = "model"
    else:
        input_path = Path(report["input"]["video"])
        items = report.get("results", [])
        name_key = "restorer"
    frame_count = int(float(report.get("assets", {}).get("targetProbe", {}).get("streams", [{}])[0].get("nb_frames", 240))) if kind == "swapper" else 240
    frame_indices = sorted({min(frame_count - 1, round(index * (frame_count - 1) / 9)) for index in range(10)})
    results = []
    for index, item in enumerate(items, start=1):
        name = item[name_key]["name"]
        output_path = Path(item["output"])
        print(f"[{kind} {index}/{len(items)}] {name}", flush=True)
        results.append(
            {
                "name": name,
                "input": str(input_path),
                "output": str(output_path),
                "diagnostics": analyze_output(input_path, output_path, source_embedding, frame_indices),
            }
        )
    return {
        "kind": kind,
        "sourceFace": str(SOURCE_FACE),
        "frameIndices": frame_indices,
        "metricWarning": (
            "Identity is scored by Pong's installed recognizer and can favor related embedding-conditioned models. "
            "Sharpness and pixel change are diagnostics, not proof of visual superiority."
        ),
        "results": results,
    }


def main() -> None:
    source_embedding = ENGINE.embedding_from_images([SOURCE_FACE])
    ENGINE._torch.cuda.synchronize()
    swapper_report = SWAPPER_ROOT / "swapper-baseline-report.json"
    if swapper_report.exists():
        result = analyze_report(swapper_report, "swapper", source_embedding)
        (SWAPPER_ROOT / "swapper-quality-report.json").write_text(
            json.dumps(result, indent=2), encoding="utf-8"
        )
    restorer_report = RESTORER_ROOT / "restorer-baseline-report.json"
    if restorer_report.exists():
        result = analyze_report(restorer_report, "restorer", source_embedding)
        (RESTORER_ROOT / "restorer-quality-report.json").write_text(
            json.dumps(result, indent=2), encoding="utf-8"
        )


if __name__ == "__main__":
    main()
