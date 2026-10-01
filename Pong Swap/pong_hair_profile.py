"""Baseline 1.6: continuous hair-colour matching for Multi Face.

Owner request: with several approved faces selected, pick the source whose
face looks most like the video person, with hair colour as a big factor.
Baseline 1.0 only used hair as a hard light/dark gate for six faces.

Hair colour is measured on ORIGINAL segmented hair pixels (same parser and
mask rules as pong_hair_policy) as the median CIELAB colour (L* lightness,
a*/b* hue). Each approved face gets a profile from its own reference photos
(``build_source_profiles``, stored in presets/hair-profiles.json keyed by the
approved number). The match is a distance in that colour space, so blonde vs
light brown vs dark brown vs red are graded, not just light/dark.
"""
from __future__ import annotations

import json
import math
import re
import threading
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
PROFILE_PATH = ROOT / "presets" / "hair-profiles.json"
# Multi Face score = identity resemblance (0..100) + HAIR_WEIGHT * match,
# match in [-1, 1]. Typical identity gaps between candidates are 5-20 points,
# so 25 lets a clear hair difference outweigh a moderate face difference.
HAIR_WEIGHT = 25.0
# CIELAB distance treated as "completely different hair" (blonde vs black ~50).
FULL_MISMATCH_DELTA_E = 40.0
MINIMUM_HAIR_PIXELS = 400

_profiles: dict[str, dict] | None = None
_profiles_mtime = 0.0
_lock = threading.Lock()


def approved_number(face_id: str) -> int | None:
    match = re.fullmatch(r"approved-(\d+)(?:-[0-9a-f]{12})?", str(face_id))
    return int(match.group(1)) if match else None


def hair_lab(crop_rgb: np.ndarray, hair_probability: np.ndarray, *, threshold: float = 0.80):
    """Median L*a*b* of confidently segmented hair, or None."""
    import cv2

    probability = np.asarray(hair_probability)
    if crop_rgb.shape[:2] != probability.shape or crop_rgb.ndim != 3:
        return None
    mask = np.isfinite(probability) & (probability >= threshold)
    h, w = mask.shape
    region = np.zeros_like(mask)
    region[int(h * .03):int(h * .97), int(w * .12):int(w * .88)] = True
    mask &= region
    mask = cv2.erode(mask.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=1).astype(bool)
    count = int(np.count_nonzero(mask))
    if count < MINIMUM_HAIR_PIXELS or np.max(crop_rgb) < 35:
        return None
    lab = cv2.cvtColor(crop_rgb, cv2.COLOR_RGB2LAB)[mask].astype(np.float32)
    # OpenCV 8-bit Lab: L*255/100, a+128, b+128.
    values = np.median(lab, axis=0)
    return {"L": float(values[0] * 100 / 255), "a": float(values[1] - 128), "b": float(values[2] - 128),
            "pixels": count, "confidence": float(np.mean(probability[mask]))}


class HairColor(str):
    """A hair category string ('dark'/'light'/'unknown') that also carries the
    measured colour. Behaves exactly like the category string for existing
    rules (equality, JSON, logging) so the frozen engine needs no change."""

    def __new__(cls, category: str, lab: dict | None = None):
        value = super().__new__(cls, category)
        value.lab = lab
        return value


def load_profiles() -> dict[str, dict]:
    global _profiles, _profiles_mtime
    with _lock:
        try:
            mtime = PROFILE_PATH.stat().st_mtime
        except OSError:
            _profiles, _profiles_mtime = {}, 0.0
            return _profiles
        if _profiles is None or mtime != _profiles_mtime:
            try:
                _profiles = json.loads(PROFILE_PATH.read_text(encoding="utf-8")).get("faces", {})
            except (OSError, ValueError):
                _profiles = {}
            _profiles_mtime = mtime
        return _profiles


def source_profile(face_id: str) -> dict | None:
    number = approved_number(face_id)
    return None if number is None else load_profiles().get(str(number))


def hair_match(target_color, face_id: str) -> float | None:
    """[-1, 1] colour agreement scaled by evidence, or None if unmeasured."""
    target = getattr(target_color, "lab", None)
    source = source_profile(face_id)
    if not target or not source:
        return None
    delta = math.sqrt((target["L"] - source["L"]) ** 2 + (target["a"] - source["a"]) ** 2
                      + (target["b"] - source["b"]) ** 2)
    agreement = 1.0 - 2.0 * min(delta, FULL_MISMATCH_DELTA_E) / FULL_MISMATCH_DELTA_E
    evidence = max(0.0, min(1.0, target.get("confidence", 0.0))) * max(0.0, min(1.0, source.get("confidence", 0.0)))
    return agreement * evidence


def has_profiles() -> bool:
    return bool(load_profiles())


# ---------------------------------------------------------------- offline build
def build_source_profiles(faces_root: Path, models_dir: Path, out_path: Path = PROFILE_PATH) -> dict:
    """Measure each approved face's hair from its reference photos (CPU)."""
    import cv2
    import onnxruntime as ort

    det = ort.InferenceSession(str(models_dir / "det_10g.onnx"), providers=["CPUExecutionProvider"])
    parser = ort.InferenceSession(str(models_dir / "faceparser_resnet34.onnx"), providers=["CPUExecutionProvider"])

    def detect(bgr):
        size = 640
        h, w = bgr.shape[:2]
        scale = size / max(h, w)
        canvas = np.zeros((size, size, 3), np.uint8)
        resized = cv2.resize(bgr, (int(w * scale), int(h * scale)))
        canvas[:resized.shape[0], :resized.shape[1]] = resized
        blob = cv2.dnn.blobFromImage(canvas, 1 / 128, (size, size), (127.5,) * 3, swapRB=True)
        outs = det.run(None, {det.get_inputs()[0].name: blob})
        best = None
        for i, stride in enumerate((8, 16, 32)):
            scores, kps = outs[i][:, 0], outs[i + 6] * stride
            grid = size // stride
            centers = np.stack(np.mgrid[:grid, :grid][::-1], axis=-1).reshape(-1, 2) * stride
            centers = np.repeat(centers, 2, axis=0).astype(np.float32)
            for j in np.where(scores > 0.5)[0]:
                points = (kps[j].reshape(5, 2) + centers[j]) / scale
                spread = float(np.linalg.norm(points[1] - points[0]))
                if best is None or spread > best[0]:
                    best = (spread, points)
        return None if best is None else best[1]

    def hair_from_photo(bgr):
        points = detect(bgr)
        if points is None:
            return None
        eyes = points[:2].mean(axis=0)
        distance = float(np.linalg.norm(points[1] - points[0]))
        side = distance * 6.5
        center = eyes + np.array([0.0, 1.25 * distance])
        x0, y0 = int(center[0] - side / 2), int(center[1] - side / 2)
        h, w = bgr.shape[:2]
        # Reference photos are often tight crops: use whatever head area exists.
        crop = bgr[max(0, y0):min(h, y0 + int(side)), max(0, x0):min(w, x0 + int(side))]
        if crop.size == 0 or min(crop.shape[:2]) < 64:
            return None
        rgb = cv2.cvtColor(cv2.resize(crop, (512, 512), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
        tensor = (rgb.astype(np.float32) / 255 - [.485, .456, .406]) / [.229, .224, .225]
        logits = parser.run(None, {parser.get_inputs()[0].name: tensor.transpose(2, 0, 1)[None].astype(np.float32)})[0][0]
        other = np.maximum(logits[:17].max(axis=0), logits[18])
        probability = 1 / (1 + np.exp(-(logits[17] - other)))
        return hair_lab(rgb, probability)

    faces = {}
    for folder in sorted(Path(faces_root).iterdir()):
        number = approved_number(folder.name.lower().replace(" ", "-"))
        if not folder.is_dir() or number is None:
            continue
        samples = []
        for path in sorted(folder.rglob("*")):
            if path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
                continue
            bgr = cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_COLOR)
            if bgr is not None:
                sample = hair_from_photo(bgr)
                if sample:
                    samples.append(sample)
        if not samples:
            continue
        weights = np.array([s["pixels"] for s in samples], dtype=np.float64)
        stack = lambda key: np.array([s[key] for s in samples])
        faces[str(number)] = {
            # Weighted median-ish: pixel-weighted mean of per-photo medians.
            "L": float(np.average(stack("L"), weights=weights)),
            "a": float(np.average(stack("a"), weights=weights)),
            "b": float(np.average(stack("b"), weights=weights)),
            "spreadL": float(np.std(stack("L"))),
            "photosWithHair": len(samples),
            "confidence": float(min(1.0, np.average(stack("confidence"), weights=weights)) * min(1.0, len(samples) / 2)),
        }
    out_path.write_text(json.dumps({"schema": 1, "faces": faces}, indent=1), encoding="utf-8")
    return faces


if __name__ == "__main__":
    import sys
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "approved-faces"
    print(json.dumps(build_source_profiles(root, ROOT / "runtime" / "models"), indent=1))
