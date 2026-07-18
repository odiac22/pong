"""Pong personal visual-preference service.

This service keeps large vision dependencies out of the browser-facing Node
gateway.  It trains compact, artist-level heads immediately after every user
choice while retaining the source images so features can be rebuilt later.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import numpy as np
import requests
import torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModel, AutoProcessor


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / ".pong-local-ai"
STORE_PATH = DATA_DIR / "preference-examples-v2.json"
LEGACY_STORE_PATH = DATA_DIR / "learned-examples.json"
IMAGE_DIR = DATA_DIR / "preference-images-v2"
STATUS_PATH = DATA_DIR / "preference-service-status.json"
HOST = os.environ.get("PONG_PREFERENCE_HOST", "127.0.0.1")
PORT = int(os.environ.get("PONG_PREFERENCE_PORT", "8791"))
LOCAL1_DINO = os.environ.get("PONG_LOCAL1_DINO_MODEL", "facebook/dinov2-base")
LOCAL2_DINO = os.environ.get("PONG_LOCAL2_DINO_MODEL", "facebook/dinov2-small")
SIGLIP_MODEL = os.environ.get("PONG_SIGLIP2_MODEL", "google/siglip2-base-patch16-224")
POSE_MODEL = os.environ.get("PONG_POSE_MODEL", "yolo11n-pose.pt")
MAX_RECORDS = int(os.environ.get("PONG_PREFERENCE_MAX_RECORDS", "2000"))
MAX_LEARN_IMAGES = int(os.environ.get("PONG_PREFERENCE_LEARN_IMAGES", "6"))
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32

SEMANTIC_PROMPTS = [
    "a clear photograph of an adult woman",
    "a clear photograph of an adult man or male-presenting person",
    "feet or a foot are the main subject of the photograph",
    "a logo, placeholder, blank graphic, advertisement, anime, or illustration",
    "a clear photograph containing a visible adult person",
    "an unclear, tiny, heavily cropped, or unusable image",
]
BODY_PROMPTS = [
    "a clear adult torso with a smooth midsection and no pronounced abdominal overhang",
    "a clear adult torso with ordinary softness but no pronounced abdominal overhang",
    "a clear adult torso with pronounced abdominal overhang, multiple visible abdominal folds, or an apron-like midsection",
    "the abdomen and midsection are hidden, cropped out, distorted by perspective, or impossible to judge",
]
BODY_HEAD_MIN = float(os.environ.get("PONG_BODY_REJECT_HEAD_MIN", "0.58"))
BODY_HEAD_IMAGE_MIN = float(os.environ.get("PONG_BODY_REJECT_IMAGE_MIN", "0.50"))
BODY_HEAD_STRONG_MIN = float(os.environ.get("PONG_BODY_REJECT_HEAD_STRONG_MIN", "0.68"))
BODY_CONSENSUS_MIN = max(2, int(os.environ.get("PONG_BODY_CONSENSUS_MIN", "2")))
BODY_PRONOUNCED_MIN = float(os.environ.get("PONG_BODY_PRONOUNCED_MIN", "0.42"))
BODY_PRONOUNCED_MARGIN = float(os.environ.get("PONG_BODY_PRONOUNCED_MARGIN", "0.12"))
BODY_STRONG_MIN = float(os.environ.get("PONG_BODY_STRONG_MIN", "0.58"))
BODY_STRONG_MARGIN = float(os.environ.get("PONG_BODY_STRONG_MARGIN", "0.18"))
BODY_STRONG_PREFERENCE = float(os.environ.get("PONG_BODY_STRONG_PREFERENCE", "0.62"))
FACE_HEAD_MIN_LOCAL1 = float(os.environ.get("PONG_FACE_REJECT_LOCAL1_MIN", "0.56"))
FACE_HEAD_MIN_LOCAL2 = float(os.environ.get("PONG_FACE_REJECT_LOCAL2_MIN", "0.55"))


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
    temp.replace(path)


def write_status(status: str, message: str, **extra: Any) -> None:
    atomic_json(STATUS_PATH, {"status": status, "message": message, "updatedAt": now_iso(), **extra})


def normalize_url(raw: str) -> str:
    try:
        parsed = urlparse(str(raw or ""))
        return raw if parsed.scheme in {"http", "https"} and parsed.netloc else ""
    except Exception:
        return ""


def unit(vector: np.ndarray) -> np.ndarray:
    vector = np.asarray(vector, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(vector))
    return vector / norm if norm > 1e-8 else vector


def rounded(vector: np.ndarray) -> list[float]:
    return np.round(np.asarray(vector, dtype=np.float32), 6).tolist()


def pooled_tensor(value: Any) -> torch.Tensor:
    if torch.is_tensor(value):
        return value
    for name in ("pooler_output", "image_embeds", "last_hidden_state"):
        candidate = getattr(value, name, None)
        if torch.is_tensor(candidate):
            return candidate[:, 0] if candidate.ndim == 3 else candidate
    raise TypeError(f"No pooled tensor in {type(value).__name__}")


def sigmoid(value: float) -> float:
    return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, value))))


class Store:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.value = self._load()

    def _load(self) -> dict[str, Any]:
        try:
            value = json.loads(STORE_PATH.read_text(encoding="utf-8"))
            if isinstance(value.get("records"), list):
                return value
        except Exception:
            pass
        return {"version": 2, "records": []}

    def records(self) -> list[dict[str, Any]]:
        with self.lock:
            return list(self.value.get("records", []))

    def upsert(self, record: dict[str, Any]) -> None:
        artist_url = record.get("artistUrl", "")
        with self.lock:
            records = [r for r in self.value.get("records", []) if r.get("artistUrl") != artist_url]
            records.insert(0, record)
            self.value = {"version": 2, "updatedAt": now_iso(), "records": records[:MAX_RECORDS]}
            atomic_json(STORE_PATH, self.value)


STORE = Store()


class VisionRuntime:
    def __init__(self) -> None:
        self.model_lock = threading.RLock()
        self.pose = None
        self.dino: dict[str, tuple[Any, Any]] = {}
        self.siglip: tuple[Any, Any] | None = None
        self.feature_cache: dict[str, dict[str, Any]] = {}
        self.cache_lock = threading.RLock()

    def _pose(self):
        with self.model_lock:
            if self.pose is None:
                from ultralytics import YOLO

                self.pose = YOLO(POSE_MODEL)
            return self.pose

    def _dino(self, variant: str):
        model_id = LOCAL1_DINO if variant == "local" else LOCAL2_DINO
        with self.model_lock:
            if model_id not in self.dino:
                processor = AutoImageProcessor.from_pretrained(model_id)
                model = AutoModel.from_pretrained(model_id, torch_dtype=DTYPE).to(DEVICE).eval()
                self.dino[model_id] = (processor, model)
            return self.dino[model_id]

    def _siglip(self):
        with self.model_lock:
            if self.siglip is None:
                processor = AutoProcessor.from_pretrained(SIGLIP_MODEL)
                model = AutoModel.from_pretrained(SIGLIP_MODEL, torch_dtype=DTYPE).to(DEVICE).eval()
                self.siglip = (processor, model)
            return self.siglip

    def detect_views(self, image: Image.Image) -> dict[str, Any]:
        full = image.convert("RGB")
        result = {"full": full, "face": None, "body": None, "people": 0}
        try:
            prediction = self._pose().predict(
                source=np.asarray(full), imgsz=384, conf=0.22,
                device=0 if DEVICE == "cuda" else "cpu", verbose=False,
            )[0]
            boxes = prediction.boxes.xyxy.detach().cpu().numpy() if prediction.boxes is not None else []
            if not len(boxes):
                return result
            result["people"] = int(len(boxes))
            areas = [(max(0, b[2] - b[0]) * max(0, b[3] - b[1]), i) for i, b in enumerate(boxes)]
            _, chosen = max(areas)
            x1, y1, x2, y2 = boxes[chosen]
            width, height = full.size
            pad_x = (x2 - x1) * 0.06
            pad_y = (y2 - y1) * 0.04
            body_box = (
                max(0, int(x1 - pad_x)), max(0, int(y1 - pad_y)),
                min(width, int(x2 + pad_x)), min(height, int(y2 + pad_y)),
            )
            if body_box[2] - body_box[0] >= 48 and body_box[3] - body_box[1] >= 80:
                result["body"] = full.crop(body_box)

            face_visible = False
            points: list[tuple[float, float]] = []
            if prediction.keypoints is not None and prediction.keypoints.xy is not None:
                xy = prediction.keypoints.xy[chosen].detach().cpu().numpy()
                conf = prediction.keypoints.conf[chosen].detach().cpu().numpy() if prediction.keypoints.conf is not None else np.ones(len(xy))
                for index in range(min(5, len(xy))):
                    if conf[index] >= 0.25 and xy[index][0] > 0 and xy[index][1] > 0:
                        points.append((float(xy[index][0]), float(xy[index][1])))
                face_visible = len(points) >= 2
            if face_visible:
                px = [p[0] for p in points]
                py = [p[1] for p in points]
                center_x = sum(px) / len(px)
                center_y = sum(py) / len(py)
                span = max(max(px) - min(px), max(py) - min(py), (x2 - x1) * 0.18, 36)
                face_box = (
                    max(0, int(center_x - span * 1.15)), max(0, int(center_y - span * 1.3)),
                    min(width, int(center_x + span * 1.15)), min(height, int(center_y + span * 1.45)),
                )
                if face_box[2] - face_box[0] >= 32 and face_box[3] - face_box[1] >= 32:
                    result["face"] = full.crop(face_box)
        except Exception:
            return result
        return result

    def dino_encode(self, images: list[Image.Image], variant: str) -> list[np.ndarray]:
        if not images:
            return []
        processor, model = self._dino(variant)
        values: list[np.ndarray] = []
        for start in range(0, len(images), 12):
            batch = images[start:start + 12]
            inputs = processor(images=batch, return_tensors="pt")
            inputs = {k: v.to(DEVICE) for k, v in inputs.items()}
            with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=DTYPE, enabled=DEVICE == "cuda"):
                output = model(**inputs)
                pooled = getattr(output, "pooler_output", None)
                if pooled is None:
                    pooled = output.last_hidden_state[:, 0]
                pooled = pooled_tensor(pooled)
            values.extend(unit(row) for row in pooled.float().cpu().numpy())
        return values

    def siglip_features(
        self, images: list[Image.Image], body_prompt_images: list[Image.Image] | None = None
    ) -> tuple[list[np.ndarray], np.ndarray, np.ndarray]:
        if not images:
            return [], np.zeros((0, len(SEMANTIC_PROMPTS)), dtype=np.float32), np.zeros((0, len(BODY_PROMPTS)), dtype=np.float32)
        processor, model = self._siglip()
        image_inputs = processor(images=images, return_tensors="pt")
        image_inputs = {k: v.to(DEVICE) for k, v in image_inputs.items()}
        with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=DTYPE, enabled=DEVICE == "cuda"):
            if hasattr(model, "get_image_features"):
                embeddings = pooled_tensor(model.get_image_features(**image_inputs))
            else:
                output = model(**image_inputs)
                embeddings = pooled_tensor(getattr(output, "image_embeds", output))
        embeddings_np = [unit(row) for row in embeddings.float().cpu().numpy()]

        def scores_for(prompts: list[str], score_images: list[Image.Image]) -> np.ndarray:
            inputs = processor(text=prompts, images=score_images, padding="max_length", return_tensors="pt")
            inputs = {k: v.to(DEVICE) for k, v in inputs.items()}
            with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=DTYPE, enabled=DEVICE == "cuda"):
                output = model(**inputs)
                logits = output.logits_per_image.float()
                return torch.softmax(logits, dim=-1).cpu().numpy().astype(np.float32)

        body_inputs = body_prompt_images if body_prompt_images and len(body_prompt_images) == len(images) else images
        return embeddings_np, scores_for(SEMANTIC_PROMPTS, images), scores_for(BODY_PROMPTS, body_inputs)

    def analyze(self, images: list[Image.Image], variant: str, include_semantics: bool) -> dict[str, Any]:
        views = [self.detect_views(image) for image in images]
        full_images = [v["full"] for v in views]
        body_prompt_images = [v["body"] if v["body"] is not None else v["full"] for v in views]
        body_images = [v["body"] for v in views if v["body"] is not None]
        face_images = [v["face"] for v in views if v["face"] is not None]
        all_crops = full_images + body_images + face_images
        encoded = self.dino_encode(all_crops, variant)
        cursor = 0
        full_vectors = encoded[cursor:cursor + len(full_images)]
        cursor += len(full_images)
        body_vectors = encoded[cursor:cursor + len(body_images)]
        cursor += len(body_images)
        face_vectors = encoded[cursor:cursor + len(face_images)]

        dimension = len(full_vectors[0]) if full_vectors else (768 if variant == "local" else 384)

        def mean_or_zero(items: list[np.ndarray]) -> np.ndarray:
            return unit(np.mean(items, axis=0)) if items else np.zeros(dimension, dtype=np.float32)

        full_feature = mean_or_zero(full_vectors)
        body_feature = mean_or_zero(body_vectors)
        face_feature = mean_or_zero(face_vectors)
        body_vector_iter = iter(body_vectors)
        body_features_by_image = [
            next(body_vector_iter) if view["body"] is not None else np.zeros(dimension, dtype=np.float32)
            for view in views
        ]
        feature_parts = [full_feature, body_feature, face_feature]
        semantic_scores = np.zeros((len(images), len(SEMANTIC_PROMPTS)), dtype=np.float32)
        body_scores = np.zeros((len(images), len(BODY_PROMPTS)), dtype=np.float32)
        siglip_vectors: list[np.ndarray] = []
        if include_semantics:
            siglip_vectors, semantic_scores, body_scores = self.siglip_features(full_images, body_prompt_images)
            siglip_dim = len(siglip_vectors[0]) if siglip_vectors else 768
            feature_parts.append(unit(np.mean(siglip_vectors, axis=0)) if siglip_vectors else np.zeros(siglip_dim, dtype=np.float32))
            feature_parts.append(np.mean(semantic_scores, axis=0) if len(semantic_scores) else np.zeros(len(SEMANTIC_PROMPTS), dtype=np.float32))
            feature_parts.append(np.mean(body_scores, axis=0) if len(body_scores) else np.zeros(len(BODY_PROMPTS), dtype=np.float32))
        feature_parts.append(np.asarray([1.0 if face_images else 0.0, 1.0 if body_images else 0.0], dtype=np.float32))
        return {
            "feature": np.concatenate(feature_parts).astype(np.float32),
            "bodyFeature": body_feature.astype(np.float32),
            "bodyFeaturesByImage": [vector.astype(np.float32) for vector in body_features_by_image],
            "faceFeature": face_feature.astype(np.float32),
            "faceAvailable": bool(face_images),
            "bodyAvailable": bool(body_images),
            "faceVisibleByImage": [view["face"] is not None for view in views],
            "bodyVisibleByImage": [view["body"] is not None for view in views],
            "bodyPromptImages": body_prompt_images,
            "people": max((int(v["people"]) for v in views), default=0),
            "semanticScores": semantic_scores,
            "bodyScores": body_scores,
        }


VISION = VisionRuntime()
INFERENCE_LIMIT = max(1, min(6, int(os.environ.get("PONG_PREFERENCE_AI_CONCURRENCY", "4"))))
INFERENCE_SEMAPHORE = threading.BoundedSemaphore(INFERENCE_LIMIT)
ACTIVE_CLASSIFY_LOCK = threading.Lock()
ACTIVE_CLASSIFY = 0


def fetch_image(url: str, timeout: tuple[int, int] = (5, 10)) -> Image.Image:
    response = requests.get(
        url, timeout=timeout,
        headers={"User-Agent": "Mozilla/5.0 PongPreferenceAI/2.0", "Referer": "https://coomerfans.com/"},
    )
    response.raise_for_status()
    return Image.open(io.BytesIO(response.content)).convert("RGB")


def load_candidate_images(urls: list[str]) -> tuple[list[Image.Image], list[str]]:
    normalized_urls = list(dict.fromkeys(normalize_url(url) for url in urls[:5] if normalize_url(url)))

    def load(url: str) -> tuple[Image.Image | None, str]:
        try:
            return fetch_image(url), url
        except Exception:
            return None, url

    if not normalized_urls:
        return [], []
    with ThreadPoolExecutor(max_workers=len(normalized_urls), thread_name_prefix="pong-image") as pool:
        loaded = list(pool.map(load, normalized_urls))
    images = [image for image, _ in loaded if image is not None]
    accepted_urls = [url for image, url in loaded if image is not None]
    return images, accepted_urls


def feature_records(variant: str, view: str = "all") -> tuple[list[np.ndarray], list[int], list[dict[str, Any]]]:
    features: list[np.ndarray] = []
    labels: list[int] = []
    records: list[dict[str, Any]] = []
    key = "local1" if variant == "local" else "local2"
    for record in STORE.records():
        raw = record.get("features", {}).get(key)
        if not isinstance(raw, list) or not raw:
            continue
        vector = np.asarray(raw, dtype=np.float32)
        dimension = 768 if variant == "local" else 384
        if view == "body":
            if len(vector) < dimension * 2:
                continue
            vector = unit(vector[dimension:dimension * 2])
            if not np.any(vector):
                continue
        elif view == "face":
            if len(vector) < dimension * 3:
                continue
            vector = unit(vector[dimension * 2:dimension * 3])
            if not np.any(vector):
                continue
        features.append(vector)
        labels.append(1 if record.get("label") == "accept" else 0)
        records.append(record)
    return features, labels, records


def prototype_probability(vector: np.ndarray, features: list[np.ndarray], labels: list[int]) -> float:
    positives = [unit(x) for x, y in zip(features, labels) if y == 1]
    negatives = [unit(x) for x, y in zip(features, labels) if y == 0]
    if not positives or not negatives:
        return 0.5
    candidate = unit(vector)
    pos = float(np.mean(sorted((float(np.dot(candidate, x)) for x in positives), reverse=True)[: min(5, len(positives))]))
    neg = float(np.mean(sorted((float(np.dot(candidate, x)) for x in negatives), reverse=True)[: min(7, len(negatives))]))
    return sigmoid((pos - neg) * 14.0)


def trained_probability(vector: np.ndarray, features: list[np.ndarray], labels: list[int]) -> float:
    if len(features) < 6 or len(set(labels)) < 2:
        return prototype_probability(vector, features, labels)
    matrix = np.stack(features).astype(np.float32)
    candidate = np.asarray(vector, dtype=np.float32)
    if matrix.shape[1] != candidate.shape[0]:
        return 0.5
    targets = np.asarray(labels, dtype=np.float32)
    positive_count = max(1, int(targets.sum()))
    negative_count = max(1, len(targets) - positive_count)
    sample_weights = np.where(targets > 0.5, len(targets) / (2 * positive_count), len(targets) / (2 * negative_count)).astype(np.float32)
    weights = np.zeros(matrix.shape[1], dtype=np.float32)
    bias = 0.0
    learning_rate = 0.18
    regularization = 0.22
    for _ in range(180):
        logits = np.clip(matrix @ weights + bias, -20, 20)
        predictions = 1.0 / (1.0 + np.exp(-logits))
        error = (predictions - targets) * sample_weights
        weights -= learning_rate * ((matrix.T @ error) / len(targets) + regularization * weights)
        bias -= learning_rate * float(np.mean(error))
    learned = sigmoid(float(candidate @ weights + bias))
    prototype = prototype_probability(candidate, features, labels)
    return learned * 0.72 + prototype * 0.28


def reason_probability(vector: np.ndarray, variant: str, pattern: str, view: str = "all") -> float | None:
    features, _, records = feature_records(variant, view=view)
    return reason_probability_from_records(vector, features, records, pattern)


def reason_probability_from_records(
    vector: np.ndarray, features: list[np.ndarray], records: list[dict[str, Any]], pattern: str
) -> float | None:
    if not features:
        return None
    labels = [1 if re.search(pattern, str(record.get("rejectReasonLabel", "")), re.I) else 0 for record in records]
    if sum(labels) < 3 or len(labels) - sum(labels) < 3:
        return None
    return trained_probability(vector, features, labels)


def hard_checks(analysis: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]], str]:
    semantic = analysis.get("semanticScores")
    body_scores = analysis.get("bodyScores")
    grades: list[dict[str, Any]] = []
    hard_reason = ""
    for index in range(len(semantic)):
        row = semantic[index]
        female, male, feet, logo, person, unclear = [float(x) for x in row]
        checks = {
            "photograph": bool(person >= logo and person >= unclear),
            "woman_prominent": bool(female > male),
            "male_only": bool(male > female + 0.12 and male > 0.38),
            "male_present": bool(male > female + 0.12 and male > 0.38),
            "female_presenting_adult": bool(female >= male and female > 0.20),
            "appears_over_50": None,
            "feet_dominant": bool(feet > 0.38 and feet > person),
            "logo_or_placeholder": bool(logo > 0.38 and logo > person),
            "visual_preference_match": None,
        }
        if checks["male_present"] and not hard_reason:
            hard_reason = "male-presenting person visible"
        if checks["feet_dominant"] and not hard_reason:
            hard_reason = "feet are the main subject"
        grades.append({
            "image_index": index + 1,
            "decision": "reject" if checks["male_present"] or checks["feet_dominant"] or checks["logo_or_placeholder"] else "unsure",
            "confidence": float(min(0.99, max(row))),
            "reason": hard_reason or "visual evidence checked",
            "checks": checks,
            "body_profile": {
                "smooth_midsection": float(body_scores[index][0]) if len(body_scores) > index else 0,
                "ordinary_softness": float(body_scores[index][1]) if len(body_scores) > index else 0,
                "pronounced_overhang": float(body_scores[index][2]) if len(body_scores) > index else 0,
                "unclear": float(body_scores[index][3]) if len(body_scores) > index else 0,
            },
            "body_visible": bool((analysis.get("bodyVisibleByImage") or [False] * len(semantic))[index]),
        })
    usable_person_evidence = bool(analysis.get("faceAvailable") or analysis.get("bodyAvailable"))
    all_logo = (
        bool(grades)
        and not usable_person_evidence
        and all(g["checks"]["logo_or_placeholder"] or g["checks"]["photograph"] is False for g in grades)
    )
    if all_logo and not hard_reason:
        hard_reason = "image set is logo, placeholder, artwork, or unclear"
    combined = {
        "photograph": not all_logo,
        "woman_prominent": any(g["checks"]["woman_prominent"] for g in grades),
        "male_only": any(g["checks"]["male_only"] for g in grades),
        "male_present": any(g["checks"]["male_present"] for g in grades),
        "female_presenting_adult": any(g["checks"]["female_presenting_adult"] for g in grades),
        "appears_over_50": None,
        "feet_dominant": any(g["checks"]["feet_dominant"] for g in grades),
        "logo_or_placeholder": all_logo,
    }
    return combined, grades, hard_reason


def body_preference_veto(
    image_grades: list[dict[str, Any]], body_head: float | None,
    body_heads_by_image: list[float | None], preference: float
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    supporters: list[dict[str, Any]] = []
    strong_supporters: list[dict[str, Any]] = []
    acceptable = 0
    clear = 0
    for index, grade in enumerate(image_grades):
        profile = grade.get("body_profile") or {}
        if not grade.get("body_visible"):
            continue
        image_head = body_heads_by_image[index] if index < len(body_heads_by_image) else None
        smooth = float(profile.get("smooth_midsection") or 0)
        soft = float(profile.get("ordinary_softness") or 0)
        pronounced = float(profile.get("pronounced_overhang") or 0)
        unclear = float(profile.get("unclear") or 0)
        semantic_available = smooth + soft + pronounced + unclear > 0.001
        if semantic_available and unclear >= 0.45 and not (image_head is not None and image_head >= BODY_HEAD_IMAGE_MIN):
            continue
        clear += 1
        normal = max(smooth, soft)
        margin = pronounced - normal
        if normal >= pronounced + 0.04 or (image_head is not None and image_head <= 0.46):
            acceptable += 1
        strong_visual = (
            pronounced >= BODY_STRONG_MIN and margin >= BODY_STRONG_MARGIN
        ) or (image_head is not None and image_head >= BODY_HEAD_STRONG_MIN)
        learned_visual = (
            image_head is not None and image_head >= BODY_HEAD_IMAGE_MIN
        ) or (
            body_head is not None and body_head >= BODY_HEAD_MIN and
            pronounced >= BODY_PRONOUNCED_MIN and margin >= BODY_PRONOUNCED_MARGIN
        )
        if strong_visual or learned_visual:
            supporters.append(grade)
        if strong_visual:
            strong_supporters.append(grade)

    learned_consensus = len(supporters) >= BODY_CONSENSUS_MIN and len(supporters) > acceptable
    strong_consensus = len(strong_supporters) >= BODY_CONSENSUS_MIN and len(strong_supporters) > acceptable
    preference_override = preference >= BODY_STRONG_PREFERENCE and not strong_consensus
    veto = strong_consensus or (learned_consensus and not preference_override)
    details = {
        "clear_body_images": clear,
        "supporting_images": len(supporters),
        "strong_supporting_images": len(strong_supporters),
        "acceptable_images": acceptable,
        "required_supporting_images": BODY_CONSENSUS_MIN,
        "body_head": body_head,
        "body_heads_by_image": body_heads_by_image,
        "overall_preference": preference,
        "preference_override": preference_override,
        "veto": veto,
    }
    return (supporters[0] if veto and supporters else None), details


def classify(payload: dict[str, Any]) -> dict[str, Any]:
    variant = "local" if str(payload.get("localVariant", "local")).lower() == "local" else "local2"
    urls = list(dict.fromkeys(normalize_url(x) for x in payload.get("candidateImageUrls", []) if normalize_url(x)))[:5]
    images, used_urls = load_candidate_images(urls)
    if not images:
        raise ValueError("No usable candidate images")

    hard_only = bool(payload.get("hardCheckOnly"))
    include_semantics = variant == "local" or hard_only
    with INFERENCE_SEMAPHORE:
        fast_analysis = VISION.analyze(images, variant, include_semantics=include_semantics)
    features, labels, records = feature_records(variant)
    preference = trained_probability(fast_analysis["feature"], features, labels)

    if variant == "local2" and not include_semantics and (preference >= 0.48 or hard_only):
        with INFERENCE_SEMAPHORE:
            _, semantic_scores, body_scores = VISION.siglip_features(images, fast_analysis.get("bodyPromptImages"))
        semantic_analysis = {
            **fast_analysis,
            "semanticScores": semantic_scores,
            "bodyScores": body_scores,
        }
        # Keep the fast Local2 DINO preference vector; run only SigLIP2 for hard checks.
    else:
        semantic_analysis = fast_analysis

    if semantic_analysis.get("semanticScores") is not None and len(semantic_analysis.get("semanticScores")):
        checks, image_grades, hard_reason = hard_checks(semantic_analysis)
    else:
        checks = {
            "photograph": True, "woman_prominent": None, "male_only": False,
            "male_present": False, "female_presenting_adult": None,
            "appears_over_50": None, "feet_dominant": False, "logo_or_placeholder": False,
        }
        image_grades = []
        hard_reason = ""

    body_reason_features, _, body_reason_records = feature_records(variant, view="body")
    body_head = reason_probability_from_records(
        fast_analysis["bodyFeature"], body_reason_features, body_reason_records,
        r"fat|body|weight|midsection"
    )
    body_heads_by_image = [
        reason_probability_from_records(vector, body_reason_features, body_reason_records, r"fat|body|weight|midsection")
        if np.any(vector) else None
        for vector in fast_analysis.get("bodyFeaturesByImage", [])
    ]
    reason_heads = {
        "face_reject": reason_probability(fast_analysis["feature"], variant, r"ugly|face"),
        "body_reject": body_head,
        "body_reject_by_image": body_heads_by_image,
        "male_reject": reason_probability(fast_analysis["feature"], variant, r"male"),
        "feet_reject": reason_probability(fast_analysis["feature"], variant, r"feet|foot"),
    }
    body_veto_grade, body_consensus = body_preference_veto(
        image_grades, body_head, body_heads_by_image, preference
    )
    face_threshold = FACE_HEAD_MIN_LOCAL1 if variant == "local" else FACE_HEAD_MIN_LOCAL2
    face_veto = bool(
        fast_analysis["faceAvailable"] and
        reason_heads["face_reject"] is not None and
        reason_heads["face_reject"] >= face_threshold
    )
    if reason_heads["male_reject"] is not None and reason_heads["male_reject"] >= 0.82:
        hard_reason = hard_reason or "learned male-presenting hard-filter match"
        checks["male_present"] = True
    if reason_heads["feet_reject"] is not None and reason_heads["feet_reject"] >= 0.82:
        hard_reason = hard_reason or "learned feet hard-filter match"
        checks["feet_dominant"] = True

    evidence_available = fast_analysis["faceAvailable"] or fast_analysis["bodyAvailable"]
    # Keep the personal cutoff separate from the immutable hard checks.  The
    # compact head is well separated around this point on the migrated labels;
    # higher fixed cutoffs made the speed mode reject known positive examples.
    threshold = 0.52
    if hard_reason:
        decision = "reject"
        confidence = max(0.94, preference)
        reason = hard_reason
    elif not evidence_available:
        decision = "reject"
        confidence = 0.90
        reason = "no usable face or body evidence"
    elif hard_only:
        decision = "accept"
        confidence = 0.96
        reason = "visual hard checks passed"
    elif not fast_analysis["bodyAvailable"]:
        decision = "reject"
        confidence = 0.90
        reason = "no usable body evidence for personal body preference"
    elif body_veto_grade is not None:
        decision = "reject"
        confidence = 0.94
        reason = "body-shape visual preference mismatch"
    elif face_veto:
        decision = "reject"
        confidence = 0.92
        reason = "face visual preference mismatch"
    elif preference >= threshold:
        decision = "accept"
        confidence = min(0.99, 0.55 + abs(preference - 0.5) * 1.7)
        reason = f"personal preference {round(preference * 100)}%"
    else:
        decision = "reject"
        confidence = min(0.99, 0.55 + abs(preference - 0.5) * 1.7)
        reason = f"personal preference {round(preference * 100)}% below {round(threshold * 100)}%"

    for grade in image_grades:
        is_body_veto = grade is body_veto_grade
        grade["checks"]["visual_preference_match"] = bool(
            preference >= threshold and not is_body_veto and not face_veto
        )
        if is_body_veto:
            grade["decision"] = "reject"
            grade["confidence"] = 0.94
            grade["reason"] = "body-shape visual preference mismatch"
            continue
        if grade["decision"] == "unsure":
            grade["decision"] = "accept" if decision == "accept" else "reject"
            grade["confidence"] = confidence
            grade["reason"] = reason
    while len(image_grades) < len(images):
        image_grades.append({
            "image_index": len(image_grades) + 1,
            "decision": decision,
            "confidence": confidence,
            "reason": reason,
            "checks": {**checks, "visual_preference_match": bool(preference >= threshold)},
        })

    hard_review_required = bool(
        variant == "local" and decision == "accept" and (
            reason_heads["body_reject"] is not None and
            reason_heads["body_reject"] >= BODY_HEAD_MIN
        )
    )

    return {
        "decision": decision,
        "confidence": confidence,
        "preference_probability": preference,
        "reason": reason,
        "source": "personal_preference_v2",
        "vision_source": "personal_preference_v2",
        "model": f"{LOCAL1_DINO} + {SIGLIP_MODEL}" if variant == "local" else f"{LOCAL2_DINO} fast personal head",
        "variant": variant,
        "hard_verified": decision == "accept" and not bool(hard_reason) and bool(image_grades) and not hard_review_required,
        "hard_review_required": hard_review_required,
        "checks": checks,
        "image_grades": image_grades,
        "evidence": {
            "face_available": fast_analysis["faceAvailable"],
            "body_available": fast_analysis["bodyAvailable"],
            "people": fast_analysis["people"],
            "images": len(images),
        },
        "reason_heads": reason_heads,
        "body_consensus": body_consensus,
        "training": {
            "artists": len(records),
            "accepts": sum(labels),
            "rejects": len(labels) - sum(labels),
        },
        "candidateImageUrls": used_urls,
    }


def persist_images(artist_url: str, urls: list[str]) -> tuple[list[Image.Image], list[dict[str, str]]]:
    artist_key = hashlib.sha256(artist_url.encode("utf-8")).hexdigest()[:20]
    folder = IMAGE_DIR / artist_key
    folder.mkdir(parents=True, exist_ok=True)
    images: list[Image.Image] = []
    saved: list[dict[str, str]] = []
    for url in urls[:MAX_LEARN_IMAGES]:
        try:
            image = fetch_image(url)
            image_key = hashlib.sha256(url.encode("utf-8")).hexdigest()[:20]
            path = folder / f"{image_key}.jpg"
            if not path.exists():
                copy = image.copy()
                copy.thumbnail((1280, 1280))
                copy.save(path, "JPEG", quality=88, optimize=True)
            images.append(image)
            saved.append({"url": url, "path": str(path.relative_to(DATA_DIR)).replace("\\", "/")})
        except Exception:
            continue
    return images, saved


def learn(payload: dict[str, Any]) -> dict[str, Any]:
    label = "accept" if str(payload.get("label", "")).lower() == "accept" else "reject"
    artist = payload.get("artist") or {}
    artist_url = normalize_url(artist.get("artistUrl", ""))
    if not artist_url:
        raise ValueError("artistUrl is required")
    urls = list(dict.fromkeys(normalize_url(x) for x in payload.get("imageUrls", []) if normalize_url(x)))
    images, saved_images = persist_images(artist_url, urls)
    if not images:
        raise ValueError("No learning images could be saved")
    with INFERENCE_SEMAPHORE:
        local1 = VISION.analyze(images, "local", include_semantics=True)
        local2 = VISION.analyze(images, "local2", include_semantics=False)
    record = {
        "artistUrl": artist_url,
        "artistName": str(artist.get("artistName", ""))[:120],
        "label": label,
        "rejectReason": str(payload.get("rejectReason", ""))[:40],
        "rejectReasonLabel": str(payload.get("rejectReasonLabel", ""))[:80],
        "learnedAt": now_iso(),
        "images": saved_images,
        "evidence": {
            "faceAvailable": local1["faceAvailable"],
            "bodyAvailable": local1["bodyAvailable"],
        },
        "features": {
            "local1": rounded(local1["feature"]),
            "local2": rounded(local2["feature"]),
        },
        "models": {"local1": LOCAL1_DINO, "local2": LOCAL2_DINO, "semantic": SIGLIP_MODEL},
    }
    STORE.upsert(record)
    return {
        "ok": True,
        "saved": True,
        "label": label,
        "artistUrl": artist_url,
        "images": len(saved_images),
        "records": len(STORE.records()),
        "evidence": record["evidence"],
        "retrained": True,
    }


def examples() -> dict[str, Any]:
    records = [
        {
            "artistUrl": r.get("artistUrl", ""),
            "artistName": r.get("artistName", ""),
            "label": r.get("label", ""),
            "rejectReason": r.get("rejectReason", ""),
            "rejectReasonLabel": r.get("rejectReasonLabel", ""),
            "learnedAt": r.get("learnedAt", ""),
            "imageUrls": [x.get("url", "") for x in r.get("images", []) if x.get("url")],
        }
        for r in STORE.records()
    ]
    return {
        "ok": True,
        "records": records,
        "accepted": [r for r in records if r.get("label") == "accept"],
        "rejected": [r for r in records if r.get("label") == "reject"],
    }


BOOTSTRAP_STATE = {"running": False, "complete": STORE_PATH.exists(), "imported": 0, "error": ""}


def bootstrap_legacy() -> None:
    if STORE.records() or not LEGACY_STORE_PATH.exists():
        BOOTSTRAP_STATE["complete"] = True
        return
    BOOTSTRAP_STATE["running"] = True
    write_status("bootstrapping", "Importing legacy preference examples into compact v2 features.")
    try:
        legacy = json.loads(LEGACY_STORE_PATH.read_text(encoding="utf-8"))
        for old in reversed(legacy.get("records", [])):
            urls = [x.get("url", "") for x in old.get("embeddings", []) if x.get("url")][:MAX_LEARN_IMAGES]
            if not urls:
                continue
            try:
                learn({
                    "label": old.get("label", "reject"),
                    "rejectReason": old.get("rejectReason", ""),
                    "rejectReasonLabel": old.get("rejectReasonLabel", ""),
                    "artist": {"artistUrl": old.get("artistUrl", ""), "artistName": old.get("artistName", "")},
                    "imageUrls": urls,
                })
                BOOTSTRAP_STATE["imported"] += 1
            except Exception:
                continue
        BOOTSTRAP_STATE["complete"] = True
        write_status("ready", f"Imported {BOOTSTRAP_STATE['imported']} legacy preference artists.")
    except Exception as exc:
        BOOTSTRAP_STATE["error"] = str(exc)
        write_status("warning", f"Legacy preference import failed: {exc}")
    finally:
        BOOTSTRAP_STATE["running"] = False


class Handler(BaseHTTPRequestHandler):
    server_version = "PongPreferenceAI/2.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}", flush=True)

    def send_json(self, status: int, value: Any) -> None:
        payload = json.dumps(
            value,
            separators=(",", ":"),
            default=lambda item: item.item() if isinstance(item, np.generic) else str(item),
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()
        self.wfile.write(payload)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 10 * 1024 * 1024:
            raise ValueError("request body too large")
        return json.loads(self.rfile.read(length).decode("utf-8")) if length else {}

    def do_OPTIONS(self) -> None:
        self.send_json(204, {})

    def do_GET(self) -> None:
        try:
            if self.path.split("?", 1)[0] == "/health":
                records = STORE.records()
                with ACTIVE_CLASSIFY_LOCK:
                    active_classify = ACTIVE_CLASSIFY
                self.send_json(200, {
                    "ok": True,
                    "app": "pong-preference-ai",
                    "ready": True,
                    "device": DEVICE,
                    "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "",
                    "local1_model": LOCAL1_DINO,
                    "local2_model": LOCAL2_DINO,
                    "semantic_model": SIGLIP_MODEL,
                    "pose_model": POSE_MODEL,
                    "records": len(records),
                    "accepts": sum(1 for r in records if r.get("label") == "accept"),
                    "rejects": sum(1 for r in records if r.get("label") == "reject"),
                    "active_classify": active_classify,
                    "bootstrap": BOOTSTRAP_STATE,
                })
                return
            if self.path.split("?", 1)[0] == "/examples":
                self.send_json(200, examples())
                return
            self.send_json(404, {"ok": False, "error": "not found"})
        except Exception as exc:
            self.send_json(500, {"ok": False, "error": str(exc)})

    def do_POST(self) -> None:
        try:
            payload = self.read_json()
            path = self.path.split("?", 1)[0]
            if path == "/classify":
                global ACTIVE_CLASSIFY
                with ACTIVE_CLASSIFY_LOCK:
                    ACTIVE_CLASSIFY += 1
                try:
                    result = classify(payload)
                finally:
                    with ACTIVE_CLASSIFY_LOCK:
                        ACTIVE_CLASSIFY = max(0, ACTIVE_CLASSIFY - 1)
                self.send_json(200, result)
                return
            if path == "/learn":
                self.send_json(200, learn(payload))
                return
            self.send_json(404, {"ok": False, "error": "not found"})
        except Exception as exc:
            self.send_json(500, {"ok": False, "error": str(exc)})


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    write_status("ready", f"Preference service listening on {HOST}:{PORT}.")
    if not STORE.records() and LEGACY_STORE_PATH.exists():
        threading.Timer(3.0, bootstrap_legacy).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Pong preference AI listening at http://{HOST}:{PORT} ({DEVICE})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
