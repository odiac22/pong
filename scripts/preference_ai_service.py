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
import shutil
import sqlite3
import threading
import time
from collections import OrderedDict
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
STORE_DB_PATH = DATA_DIR / "preference-examples-v3.sqlite3"
LEGACY_STORE_PATH = DATA_DIR / "learned-examples.json"
IMAGE_DIR = DATA_DIR / "preference-images-v2"
STATUS_PATH = DATA_DIR / "preference-service-status.json"
MIGRATION_BACKUP_PATH = DATA_DIR / "preference-examples-v2.pre-feature-v3.json"
HOST = os.environ.get("PONG_PREFERENCE_HOST", "127.0.0.1")
PORT = int(os.environ.get("PONG_PREFERENCE_PORT", "8791"))
LOCAL1_DINO = os.environ.get("PONG_LOCAL1_DINO_MODEL", "facebook/dinov2-base")
LOCAL2_DINO = os.environ.get("PONG_LOCAL2_DINO_MODEL", "facebook/dinov2-small")
SIGLIP_MODEL = os.environ.get("PONG_SIGLIP2_MODEL", "google/siglip2-base-patch16-224")
POSE_MODEL = os.environ.get("PONG_POSE_MODEL", "yolo11n-pose.pt")
MAX_RECORDS = int(os.environ.get("PONG_PREFERENCE_MAX_RECORDS", "2000"))
MAX_LEARN_IMAGES = int(os.environ.get("PONG_PREFERENCE_LEARN_IMAGES", "6"))
FEATURE_SCHEMA_VERSION = 3
STORE_VERSION = 3
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
DTYPE = torch.float16 if DEVICE == "cuda" else torch.float32
SERVICE_INSTANCE_ID = hashlib.sha256(
    f"{os.getpid()}:{time.time_ns()}:{os.urandom(16).hex()}".encode("utf-8")
).hexdigest()[:16]

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
ANATOMY_PROMPTS = [
    "visible penis or testicles physically attached to the photographed adult person's body",
    "a dildo, sex toy, strap-on, prosthetic, or artificial object rather than attached anatomy",
    "the explicit intimate area or object is cropped, obscured, ambiguous, or impossible to identify",
    "no penis, testicles, dildo, strap-on, or explicit intimate object is visible",
]
AGE_PROMPTS = [
    "the visible face clearly appears to be an adult approximately 18 to 35 years old",
    "the visible face clearly appears to be an adult approximately 36 to 49 years old",
    "the visible face clearly appears to be age 50 or older",
    "the visible face appears under 18 or could be a minor",
    "age cannot be judged because the face is absent, hidden, cropped, or unclear",
]
BODY_REASON_PATTERN = r"fat|body|weight|midsection|obese|overweight|chubby|belly|stomach"
FACE_REASON_PATTERN = r"ugly|face|unattractive"
CATEGORICAL_HARD_REASON_PATTERN = re.compile(
    r"\b(?:male|man|men|trans|transgender|feet|foot|logo|placeholder|blank|anime|"
    r"illustration|advertisement|underage|minor|too\s+young|over\s*50|too\s+old|"
    r"penis|testicles|attached\s+anatomy|anatomy\s+conflict|spam|non[- ]?photo)\b",
    re.I,
)
BODY_HEAD_MIN = float(os.environ.get("PONG_BODY_REJECT_HEAD_MIN", "0.50"))
BODY_HEAD_IMAGE_MIN = float(os.environ.get("PONG_BODY_REJECT_IMAGE_MIN", "0.48"))
BODY_HEAD_STRONG_MIN = float(os.environ.get("PONG_BODY_REJECT_HEAD_STRONG_MIN", "0.68"))
BODY_CONSENSUS_MIN = max(2, int(os.environ.get("PONG_BODY_CONSENSUS_MIN", "2")))
BODY_PRONOUNCED_MIN = float(os.environ.get("PONG_BODY_PRONOUNCED_MIN", "0.42"))
BODY_PRONOUNCED_MARGIN = float(os.environ.get("PONG_BODY_PRONOUNCED_MARGIN", "0.12"))
BODY_STRONG_MIN = float(os.environ.get("PONG_BODY_STRONG_MIN", "0.58"))
BODY_STRONG_MARGIN = float(os.environ.get("PONG_BODY_STRONG_MARGIN", "0.18"))
BODY_STRONG_PREFERENCE = float(os.environ.get("PONG_BODY_STRONG_PREFERENCE", "0.62"))
BODY_CLEAR_UNCLEAR_MAX = float(os.environ.get("PONG_BODY_CLEAR_UNCLEAR_MAX", "0.45"))
BODY_PREFERRED_MIN = float(os.environ.get("PONG_BODY_PREFERRED_MIN", "0.56"))
BODY_POSITIVE_STRONG_MIN = float(os.environ.get("PONG_BODY_POSITIVE_STRONG_MIN", "0.62"))
FACE_ONLY_ACCEPT_MIN = float(os.environ.get("PONG_FACE_ONLY_ACCEPT_MIN", "0.72"))
FACE_HEAD_MIN_LOCAL1 = float(os.environ.get("PONG_FACE_REJECT_LOCAL1_MIN", "0.56"))
FACE_HEAD_MIN_LOCAL2 = float(os.environ.get("PONG_FACE_REJECT_LOCAL2_MIN", "0.55"))
ANATOMY_ATTACHED_MIN = float(os.environ.get("PONG_ANATOMY_ATTACHED_MIN", "0.78"))
ANATOMY_ATTACHED_MARGIN = float(os.environ.get("PONG_ANATOMY_ATTACHED_MARGIN", "0.28"))
ANATOMY_AMBIGUOUS_MIN = float(os.environ.get("PONG_ANATOMY_AMBIGUOUS_MIN", "0.50"))
AGE_OVER_50_MIN = float(os.environ.get("PONG_AGE_OVER_50_MIN", "0.66"))
AGE_UNDERAGE_MIN = float(os.environ.get("PONG_AGE_UNDERAGE_MIN", "0.72"))
IMAGE_CACHE_MAX_ITEMS = max(8, int(os.environ.get("PONG_IMAGE_CACHE_MAX_ITEMS", "160")))
IMAGE_CACHE_MAX_BYTES = max(16 * 1024 * 1024, int(os.environ.get("PONG_IMAGE_CACHE_MAX_BYTES", str(256 * 1024 * 1024))))
IMAGE_DOWNLOAD_WORKERS = max(4, min(16, int(os.environ.get("PONG_IMAGE_DOWNLOAD_WORKERS", "12"))))
CLASSIFY_ADMISSION_LIMIT = max(6, min(8, int(os.environ.get("PONG_CLASSIFY_ADMISSION_LIMIT", "8"))))
FEATURE_CACHE_MAX_ITEMS = max(16, int(os.environ.get("PONG_FEATURE_CACHE_MAX_ITEMS", "128")))
FEATURE_CACHE_MAX_BYTES = max(
    32 * 1024 * 1024,
    int(os.environ.get("PONG_FEATURE_CACHE_MAX_BYTES", str(192 * 1024 * 1024))),
)
IMAGE_SESSION = requests.Session()
IMAGE_ADAPTER = requests.adapters.HTTPAdapter(pool_connections=32, pool_maxsize=32, max_retries=0, pool_block=False)
IMAGE_SESSION.mount("https://", IMAGE_ADAPTER)
IMAGE_SESSION.mount("http://", IMAGE_ADAPTER)
IMAGE_DOWNLOAD_EXECUTOR = ThreadPoolExecutor(
    max_workers=IMAGE_DOWNLOAD_WORKERS,
    thread_name_prefix="pong-image",
)
IMAGE_DOWNLOAD_CACHE: OrderedDict[str, bytes] = OrderedDict()
IMAGE_DOWNLOAD_CACHE_BYTES = 0
IMAGE_DOWNLOAD_CACHE_LOCK = threading.RLock()


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
        hostname = str(parsed.hostname or "").lower().rstrip(".")
        allowed_roots = tuple(
            value.strip().lower().lstrip(".")
            for value in os.environ.get(
                "PONG_PREFERENCE_IMAGE_HOSTS",
                "coomerfans.com,onlyfaphouse.com",
            ).split(",")
            if value.strip()
        )
        allowed = any(hostname == root or hostname.endswith(f".{root}") for root in allowed_roots)
        return raw if parsed.scheme == "https" and parsed.netloc and allowed else ""
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


def current_feature_schema() -> dict[str, Any]:
    return {
        "version": FEATURE_SCHEMA_VERSION,
        "local1Model": LOCAL1_DINO,
        "local2Model": LOCAL2_DINO,
        "semanticModel": SIGLIP_MODEL,
        "poseModel": POSE_MODEL,
        "crop": "yolo-shoulder-hip-torso-v1",
        "views": "per-image-clear-body-face-v1",
    }


def inference_schema_token() -> str:
    """Identify every input that can change a cached visual representation."""
    value = {
        "feature": current_feature_schema(),
        "semanticPrompts": SEMANTIC_PROMPTS,
        "bodyPrompts": BODY_PROMPTS,
        "anatomyPrompts": ANATOMY_PROMPTS,
        "agePrompts": AGE_PROMPTS,
    }
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:24]


def frozen_cache_value(value: Any) -> Any:
    """Copy inference output into a representation callers cannot mutate."""
    if isinstance(value, np.ndarray):
        copied = np.asarray(value).copy()
        copied.setflags(write=False)
        return copied
    if isinstance(value, dict):
        return {key: frozen_cache_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return tuple(frozen_cache_value(item) for item in value)
    return value


def artist_identity(raw: str) -> str:
    """Return the cross-mirror creator key used by Pong's browser/server."""
    try:
        parsed = urlparse(str(raw or ""))
        parts = [part for part in parsed.path.split("/") if part]
        marker = next((index for index, part in enumerate(parts) if part.lower() in {"u", "c"}), -1)
        service = parts[marker + 1] if marker >= 0 and len(parts) > marker + 1 else ""
        account = parts[marker + 2] if marker >= 0 and len(parts) > marker + 2 else ""
        if service and account:
            return f"{service.lower()}:{account.lower()}"
        return parsed.path.rstrip("/").lower()
    except Exception:
        return ""


def thawed_cache_value(value: Any) -> Any:
    """Return an isolated mutable copy of a cached inference result."""
    if isinstance(value, np.ndarray):
        return value.copy()
    if isinstance(value, dict):
        return {key: thawed_cache_value(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [thawed_cache_value(item) for item in value]
    return value


def cache_value_bytes(value: Any) -> int:
    if isinstance(value, np.ndarray):
        return int(value.nbytes)
    if isinstance(value, dict):
        return sum(cache_value_bytes(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return sum(cache_value_bytes(item) for item in value)
    if isinstance(value, (str, bytes)):
        return len(value)
    return 16


def record_schema_compatible(record: dict[str, Any]) -> bool:
    schema = record.get("featureSchema") or {}
    expected = current_feature_schema()
    if any(schema.get(key) != value for key, value in expected.items()):
        return False
    features = record.get("features") or {}
    if not isinstance(features.get("local1"), list) or not features.get("local1"):
        return False
    if not isinstance(features.get("local2"), list) or not features.get("local2"):
        return False
    views = record.get("viewFeatures") or {}
    for variant in ("local1", "local2"):
        value = views.get(variant) or {}
        if not isinstance(value.get("bodyByImage"), list) or not isinstance(value.get("faceByImage"), list):
            return False
    return True


class Store:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(STORE_DB_PATH, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS preference_records ("
            "artist_url TEXT PRIMARY KEY, updated_at REAL NOT NULL, record_json TEXT NOT NULL)"
        )
        self.db.commit()
        self.value = self._load()
        self.revision = 0

    def _load(self) -> dict[str, Any]:
        rows = self.db.execute(
            "SELECT record_json FROM preference_records ORDER BY updated_at DESC LIMIT ?",
            (MAX_RECORDS,),
        ).fetchall()
        if rows:
            records: list[dict[str, Any]] = []
            seen_identities: set[str] = set()
            for (raw,) in rows:
                try:
                    parsed = json.loads(raw)
                    identity = artist_identity(parsed.get("artistUrl", "")) if isinstance(parsed, dict) else ""
                    if isinstance(parsed, dict) and identity and identity not in seen_identities:
                        seen_identities.add(identity)
                        records.append(parsed)
                except Exception:
                    continue
            return {
                "version": STORE_VERSION,
                "featureSchema": current_feature_schema(),
                "records": records,
            }
        try:
            value = json.loads(STORE_PATH.read_text(encoding="utf-8"))
            if isinstance(value.get("records"), list):
                records = []
                seen_identities: set[str] = set()
                for record in value.get("records", []):
                    identity = artist_identity(record.get("artistUrl", "")) if isinstance(record, dict) else ""
                    if not identity or identity in seen_identities:
                        continue
                    seen_identities.add(identity)
                    records.append(record)
                    if len(records) >= MAX_RECORDS:
                        break
                now = time.time()
                self.db.executemany(
                    "INSERT OR REPLACE INTO preference_records (artist_url, updated_at, record_json) VALUES (?, ?, ?)",
                    [
                        (
                            str(record.get("artistUrl", "")),
                            now - index * 0.001,
                            json.dumps(record, ensure_ascii=False, separators=(",", ":")),
                        )
                        for index, record in enumerate(records)
                        if record.get("artistUrl")
                    ],
                )
                self.db.commit()
                return {
                    **value,
                    "version": STORE_VERSION,
                    "featureSchema": current_feature_schema(),
                    "records": records,
                }
        except Exception:
            pass
        return {"version": STORE_VERSION, "featureSchema": current_feature_schema(), "records": []}

    def records(self) -> list[dict[str, Any]]:
        with self.lock:
            return list(self.value.get("records", []))

    def upsert(self, record: dict[str, Any]) -> None:
        artist_url = record.get("artistUrl", "")
        identity = artist_identity(artist_url)
        with self.lock:
            replaced_urls = [
                str(r.get("artistUrl", ""))
                for r in self.value.get("records", [])
                if artist_identity(r.get("artistUrl", "")) == identity
            ]
            records = [
                r for r in self.value.get("records", [])
                if artist_identity(r.get("artistUrl", "")) != identity
            ]
            records.insert(0, record)
            self.value = {
                **self.value,
                "version": STORE_VERSION,
                "featureSchema": current_feature_schema(),
                "updatedAt": now_iso(),
                "records": records[:MAX_RECORDS],
            }
            if replaced_urls:
                self.db.executemany(
                    "DELETE FROM preference_records WHERE artist_url = ?",
                    [(value,) for value in replaced_urls if value and value != artist_url],
                )
            self.db.execute(
                "INSERT OR REPLACE INTO preference_records (artist_url, updated_at, record_json) VALUES (?, ?, ?)",
                (
                    str(artist_url),
                    time.time(),
                    json.dumps(record, ensure_ascii=False, separators=(",", ":")),
                ),
            )
            self.db.execute(
                "DELETE FROM preference_records WHERE artist_url NOT IN ("
                "SELECT artist_url FROM preference_records ORDER BY updated_at DESC LIMIT ?)",
                (MAX_RECORDS,),
            )
            self.db.commit()
            self.revision += 1
        invalidate_model_cache()

    def replace_records(self, replacements: dict[str, dict[str, Any]]) -> None:
        if not replacements:
            return
        with self.lock:
            records = [
                replacements.get(str(record.get("artistUrl", "")), record)
                for record in self.value.get("records", [])
            ]
            self.value = {
                **self.value,
                "version": STORE_VERSION,
                "featureSchema": current_feature_schema(),
                "updatedAt": now_iso(),
                "records": records[:MAX_RECORDS],
            }
            now = time.time()
            self.db.executemany(
                "INSERT OR REPLACE INTO preference_records (artist_url, updated_at, record_json) VALUES (?, ?, ?)",
                [
                    (
                        str(artist_url),
                        now - index * 0.000001,
                        json.dumps(record, ensure_ascii=False, separators=(",", ":")),
                    )
                    for index, (artist_url, record) in enumerate(replacements.items())
                    if artist_url
                ],
            )
            self.db.commit()
            self.revision += 1
        invalidate_model_cache()


STORE = Store()


class VisionRuntime:
    def __init__(self) -> None:
        self.model_lock = threading.RLock()
        self.pose = None
        self.dino: dict[str, tuple[Any, Any]] = {}
        self.siglip: tuple[Any, Any] | None = None
        self.feature_cache: OrderedDict[tuple[Any, ...], tuple[Any, int]] = OrderedDict()
        self.feature_cache_bytes = 0
        self.cache_lock = threading.RLock()

    def cache_get(self, key: tuple[Any, ...] | None) -> Any | None:
        if key is None:
            return None
        with self.cache_lock:
            cached = self.feature_cache.get(key)
            if cached is None:
                return None
            self.feature_cache.move_to_end(key)
            return thawed_cache_value(cached[0])

    def cache_put(self, key: tuple[Any, ...] | None, value: Any) -> None:
        if key is None:
            return
        frozen = frozen_cache_value(value)
        size = cache_value_bytes(frozen)
        if size > FEATURE_CACHE_MAX_BYTES:
            return
        with self.cache_lock:
            previous = self.feature_cache.pop(key, None)
            if previous is not None:
                self.feature_cache_bytes -= previous[1]
            self.feature_cache[key] = (frozen, size)
            self.feature_cache_bytes += size
            while (
                len(self.feature_cache) > FEATURE_CACHE_MAX_ITEMS
                or self.feature_cache_bytes > FEATURE_CACHE_MAX_BYTES
            ):
                _, (_, removed_size) = self.feature_cache.popitem(last=False)
                self.feature_cache_bytes -= removed_size

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

    def _views_from_prediction(self, full: Image.Image, prediction: Any) -> dict[str, Any]:
        result = {
            "full": full, "face": None, "body": None, "people": 0,
            "faceBox": None, "bodyBox": None,
        }
        try:
            boxes = prediction.boxes.xyxy.detach().cpu().numpy() if prediction.boxes is not None else []
            if not len(boxes):
                return result
            result["people"] = int(len(boxes))
            areas = [(max(0, b[2] - b[0]) * max(0, b[3] - b[1]), i) for i, b in enumerate(boxes)]
            _, chosen = max(areas)
            x1, y1, x2, y2 = boxes[chosen]
            width, height = full.size
            box_width = max(1.0, x2 - x1)
            box_height = max(1.0, y2 - y1)
            xy = None
            conf = None
            if prediction.keypoints is not None and prediction.keypoints.xy is not None:
                xy = prediction.keypoints.xy[chosen].detach().cpu().numpy()
                conf = prediction.keypoints.conf[chosen].detach().cpu().numpy() if prediction.keypoints.conf is not None else np.ones(len(xy))

            def keypoint(index: int, minimum: float = 0.25) -> tuple[float, float] | None:
                if xy is None or conf is None or index >= len(xy) or conf[index] < minimum:
                    return None
                px, py = float(xy[index][0]), float(xy[index][1])
                return (px, py) if px > 0 and py > 0 else None

            # Prefer an actual shoulder-to-hip torso/midsection crop. It removes
            # face/background and lower legs that previously polluted body taste.
            shoulder_hips = [keypoint(index, 0.22) for index in (5, 6, 11, 12)]
            valid_torso_points = [point for point in shoulder_hips if point is not None]
            shoulders = [point for point in shoulder_hips[:2] if point is not None]
            hips = [point for point in shoulder_hips[2:] if point is not None]
            if len(valid_torso_points) >= 3 and shoulders and hips:
                torso_x = [point[0] for point in valid_torso_points]
                shoulder_y = float(np.mean([point[1] for point in shoulders]))
                hip_y = float(np.mean([point[1] for point in hips]))
                torso_height = max(48.0, hip_y - shoulder_y)
                torso_width = max(max(torso_x) - min(torso_x), box_width * 0.36)
                center_x = (min(torso_x) + max(torso_x)) / 2.0
                body_box = (
                    max(0, int(center_x - torso_width * 0.72)),
                    max(0, int(shoulder_y - torso_height * 0.12)),
                    min(width, int(center_x + torso_width * 0.72)),
                    min(height, int(hip_y + torso_height * 0.22)),
                )
            else:
                # Safe person-box fallback: deliberately remove the head and the
                # lower 27% containing knees/feet while retaining torso and hips.
                body_box = (
                    max(0, int(x1 + box_width * 0.05)),
                    max(0, int(y1 + box_height * 0.17)),
                    min(width, int(x2 - box_width * 0.05)),
                    min(height, int(y1 + box_height * 0.73)),
                )
            if body_box[2] - body_box[0] >= 48 and body_box[3] - body_box[1] >= 64:
                result["bodyBox"] = tuple(int(value) for value in body_box)
                result["body"] = full.crop(body_box)

            face_visible = False
            points: list[tuple[float, float]] = []
            if xy is not None and conf is not None:
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
                    result["faceBox"] = tuple(int(value) for value in face_box)
                    result["face"] = full.crop(face_box)
        except Exception:
            return result
        return result

    def detect_views_batch(
        self, images: list[Image.Image], image_urls: tuple[str, ...] | None = None
    ) -> list[dict[str, Any]]:
        full_images = [image.convert("RGB") for image in images]
        if not full_images:
            return []
        cache_key = None
        if image_urls and len(image_urls) == len(full_images):
            cache_key = ("views", inference_schema_token(), tuple(image_urls))
        cached_descriptors = self.cache_get(cache_key)
        if cached_descriptors is not None and len(cached_descriptors) == len(full_images):
            restored: list[dict[str, Any]] = []
            for full, descriptor in zip(full_images, cached_descriptors):
                body_box = descriptor.get("bodyBox")
                face_box = descriptor.get("faceBox")
                restored.append({
                    "full": full,
                    "body": full.crop(tuple(body_box)) if body_box else None,
                    "face": full.crop(tuple(face_box)) if face_box else None,
                    "people": int(descriptor.get("people", 0)),
                    "bodyBox": tuple(body_box) if body_box else None,
                    "faceBox": tuple(face_box) if face_box else None,
                })
            return restored
        empty = [
            {
                "full": image, "face": None, "body": None, "people": 0,
                "faceBox": None, "bodyBox": None,
            }
            for image in full_images
        ]
        try:
            predictions = self._pose().predict(
                source=[np.asarray(image) for image in full_images], imgsz=384, conf=0.22,
                device=0 if DEVICE == "cuda" else "cpu", verbose=False,
            )
            if len(predictions) != len(full_images):
                return empty
            views = [
                self._views_from_prediction(image, prediction)
                for image, prediction in zip(full_images, predictions)
            ]
            self.cache_put(cache_key, [
                {
                    "people": int(view["people"]),
                    "bodyBox": view.get("bodyBox"),
                    "faceBox": view.get("faceBox"),
                }
                for view in views
            ])
            return views
        except Exception:
            return empty

    def detect_views(self, image: Image.Image) -> dict[str, Any]:
        return self.detect_views_batch([image])[0]

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
        self,
        images: list[Image.Image],
        body_prompt_images: list[Image.Image] | None = None,
        age_evidence_mask: list[bool] | None = None,
        image_urls: tuple[str, ...] | None = None,
    ) -> tuple[list[np.ndarray], np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        if not images:
            return (
                [],
                np.zeros((0, len(SEMANTIC_PROMPTS)), dtype=np.float32),
                np.zeros((0, len(BODY_PROMPTS)), dtype=np.float32),
                np.zeros((0, len(ANATOMY_PROMPTS)), dtype=np.float32),
                np.zeros((0, len(AGE_PROMPTS)), dtype=np.float32),
            )
        cache_key = None
        if image_urls and len(image_urls) == len(images):
            cache_key = (
                "siglip",
                inference_schema_token(),
                tuple(image_urls),
                tuple(bool(value) for value in age_evidence_mask) if age_evidence_mask is not None else None,
            )
        cached = self.cache_get(cache_key)
        if cached is not None:
            return (
                list(cached[0]),
                np.asarray(cached[1], dtype=np.float32),
                np.asarray(cached[2], dtype=np.float32),
                np.asarray(cached[3], dtype=np.float32),
                np.asarray(cached[4], dtype=np.float32),
            )
        processor, model = self._siglip()

        # Compute the full-image embedding and generic semantic logits together.
        # Anatomy shares the existing body-crop forward pass below, so adding the
        # visible-content labels does not add a third SigLIP model invocation.
        semantic_inputs = processor(
            text=SEMANTIC_PROMPTS, images=images, padding="max_length", return_tensors="pt"
        )
        semantic_inputs = {k: v.to(DEVICE) for k, v in semantic_inputs.items()}
        with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=DTYPE, enabled=DEVICE == "cuda"):
            semantic_output = model(**semantic_inputs)
            embeddings = pooled_tensor(getattr(semantic_output, "image_embeds", semantic_output))
            semantic_logits = semantic_output.logits_per_image.float()
        embeddings_np = [unit(row) for row in embeddings.float().cpu().numpy()]
        body_inputs = body_prompt_images if body_prompt_images and len(body_prompt_images) == len(images) else images
        body_anatomy_age_prompts = BODY_PROMPTS + ANATOMY_PROMPTS + AGE_PROMPTS
        age_indices = [
            index for index in range(len(images))
            if age_evidence_mask is None or (
                index < len(age_evidence_mask) and age_evidence_mask[index]
            )
        ]
        combined_view_images = body_inputs + [images[index] for index in age_indices]
        body_inputs_encoded = processor(
            text=body_anatomy_age_prompts,
            images=combined_view_images,
            padding="max_length",
            return_tensors="pt",
        )
        body_inputs_encoded = {k: v.to(DEVICE) for k, v in body_inputs_encoded.items()}
        with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=DTYPE, enabled=DEVICE == "cuda"):
            body_output = model(**body_inputs_encoded)
            combined_logits = body_output.logits_per_image.float()

        body_end = len(BODY_PROMPTS)
        anatomy_end = body_end + len(ANATOMY_PROMPTS)
        age_end = anatomy_end + len(AGE_PROMPTS)
        image_count = len(images)
        body_logits = combined_logits[:image_count, :body_end]
        anatomy_logits = combined_logits[:image_count, body_end:anatomy_end]
        age_logits = combined_logits[image_count:, anatomy_end:age_end]
        age_scores = np.zeros((image_count, len(AGE_PROMPTS)), dtype=np.float32)
        if age_indices:
            scored_age = torch.softmax(age_logits, dim=-1).cpu().numpy().astype(np.float32)
            for row_index, image_index in enumerate(age_indices):
                age_scores[image_index] = scored_age[row_index]
        result = (
            embeddings_np,
            torch.softmax(semantic_logits, dim=-1).cpu().numpy().astype(np.float32),
            torch.softmax(body_logits, dim=-1).cpu().numpy().astype(np.float32),
            torch.softmax(anatomy_logits, dim=-1).cpu().numpy().astype(np.float32),
            age_scores,
        )
        self.cache_put(cache_key, result)
        return result

    def analyze(
        self,
        images: list[Image.Image],
        variant: str,
        include_semantics: bool,
        clear_body_mask: list[bool] | None = None,
        clear_face_mask: list[bool] | None = None,
        image_urls: tuple[str, ...] | None = None,
    ) -> dict[str, Any]:
        cache_key = None
        if image_urls and len(image_urls) == len(images):
            cache_key = (
                "analysis",
                inference_schema_token(),
                variant,
                bool(include_semantics),
                tuple(image_urls),
                tuple(bool(value) for value in clear_body_mask) if clear_body_mask is not None else None,
                tuple(bool(value) for value in clear_face_mask) if clear_face_mask is not None else None,
            )
        cached = self.cache_get(cache_key)
        if cached is not None:
            views = self.detect_views_batch(images, image_urls=image_urls)
            cached["bodyPromptImages"] = [
                view["body"] if view["body"] is not None else view["full"] for view in views
            ]
            return cached
        # Ultralytics has substantial per-call setup overhead. Send the complete
        # five-image artist set through one pose batch so crops and evidence stay
        # identical while avoiding five serial GPU launches.
        views = self.detect_views_batch(images, image_urls=image_urls)
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
        face_vector_iter = iter(face_vectors)
        face_features_by_image = [
            next(face_vector_iter) if view["face"] is not None else np.zeros(dimension, dtype=np.float32)
            for view in views
        ]
        semantic_scores = np.zeros((len(images), len(SEMANTIC_PROMPTS)), dtype=np.float32)
        body_scores = np.zeros((len(images), len(BODY_PROMPTS)), dtype=np.float32)
        anatomy_scores = np.zeros((len(images), len(ANATOMY_PROMPTS)), dtype=np.float32)
        age_scores = np.zeros((len(images), len(AGE_PROMPTS)), dtype=np.float32)
        siglip_vectors: list[np.ndarray] = []
        if include_semantics:
            siglip_vectors, semantic_scores, body_scores, anatomy_scores, age_scores = self.siglip_features(
                full_images,
                body_prompt_images,
                [view["face"] is not None for view in views],
                image_urls=image_urls,
            )
        body_visible_by_image = [view["body"] is not None for view in views]
        if include_semantics:
            clear_body_by_image = [
                bool(
                    body_visible_by_image[index]
                    and len(body_scores) > index
                    and float(body_scores[index][3]) < BODY_CLEAR_UNCLEAR_MAX
                )
                for index in range(len(images))
            ]
        elif clear_body_mask is not None and len(clear_body_mask) == len(images):
            clear_body_by_image = [
                bool(body_visible_by_image[index] and clear_body_mask[index])
                for index in range(len(images))
            ]
        else:
            clear_body_by_image = list(body_visible_by_image)
        clear_body_vectors = [
            body_features_by_image[index]
            for index, is_clear in enumerate(clear_body_by_image)
            if is_clear and np.any(body_features_by_image[index])
        ]
        if include_semantics or clear_body_mask is not None:
            # Do not let hidden/cropped bodies contaminate the learned body view.
            body_feature = mean_or_zero(clear_body_vectors)

        face_visible_by_image = [view["face"] is not None for view in views]
        if include_semantics:
            clear_face_by_image = [
                bool(
                    face_visible_by_image[index]
                    and len(semantic_scores) > index
                    and float(semantic_scores[index][4]) >= float(semantic_scores[index][5])
                    and float(semantic_scores[index][4]) >= float(semantic_scores[index][3])
                )
                for index in range(len(images))
            ]
        elif clear_face_mask is not None and len(clear_face_mask) == len(images):
            clear_face_by_image = [
                bool(face_visible_by_image[index] and clear_face_mask[index])
                for index in range(len(images))
            ]
        else:
            clear_face_by_image = list(face_visible_by_image)
        clear_face_vectors = [
            face_features_by_image[index]
            for index, is_clear in enumerate(clear_face_by_image)
            if is_clear and np.any(face_features_by_image[index])
        ]
        if include_semantics or clear_face_mask is not None:
            face_feature = mean_or_zero(clear_face_vectors)

        feature_parts = [full_feature, body_feature, face_feature]
        if include_semantics:
            siglip_dim = len(siglip_vectors[0]) if siglip_vectors else 768
            feature_parts.append(unit(np.mean(siglip_vectors, axis=0)) if siglip_vectors else np.zeros(siglip_dim, dtype=np.float32))
            feature_parts.append(np.mean(semantic_scores, axis=0) if len(semantic_scores) else np.zeros(len(SEMANTIC_PROMPTS), dtype=np.float32))
            feature_parts.append(np.mean(body_scores, axis=0) if len(body_scores) else np.zeros(len(BODY_PROMPTS), dtype=np.float32))
        feature_parts.append(np.asarray([1.0 if face_images else 0.0, 1.0 if body_images else 0.0], dtype=np.float32))
        result = {
            "feature": np.concatenate(feature_parts).astype(np.float32),
            "bodyFeature": body_feature.astype(np.float32),
            "bodyFeaturesByImage": [vector.astype(np.float32) for vector in body_features_by_image],
            "faceFeature": face_feature.astype(np.float32),
            "faceFeaturesByImage": [vector.astype(np.float32) for vector in face_features_by_image],
            "faceAvailable": bool(face_images),
            "bodyAvailable": bool(body_images),
            "clearBodyAvailable": bool(clear_body_vectors),
            "clearBodyImages": int(sum(clear_body_by_image)),
            "faceVisibleByImage": face_visible_by_image,
            "clearFaceByImage": clear_face_by_image,
            "bodyVisibleByImage": body_visible_by_image,
            "clearBodyByImage": clear_body_by_image,
            "bodyPromptImages": body_prompt_images,
            "people": max((int(v["people"]) for v in views), default=0),
            "semanticScores": semantic_scores,
            "bodyScores": body_scores,
            "anatomyScores": anatomy_scores,
            "ageScores": age_scores,
        }
        self.cache_put(
            cache_key,
            {key: value for key, value in result.items() if key != "bodyPromptImages"},
        )
        return result


VISION = VisionRuntime()
INFERENCE_LIMIT = max(1, min(6, int(os.environ.get("PONG_PREFERENCE_AI_CONCURRENCY", "4"))))
INFERENCE_SEMAPHORE = threading.BoundedSemaphore(INFERENCE_LIMIT)
CLASSIFY_ADMISSION_SEMAPHORE = threading.BoundedSemaphore(CLASSIFY_ADMISSION_LIMIT)
ACTIVE_CLASSIFY_LOCK = threading.Lock()
ACTIVE_CLASSIFY = 0
MODEL_CACHE_LOCK = threading.RLock()
MODEL_CACHE: dict[tuple[Any, ...], Any] = {}


def invalidate_model_cache() -> None:
    with MODEL_CACHE_LOCK:
        MODEL_CACHE.clear()


def store_revision() -> int:
    with STORE.lock:
        return STORE.revision


def model_revision() -> str:
    """Identify the exact in-memory preference-head generation.

    The process token makes a Python-service restart invalidate Node's RAM-only
    verdict pool even when the record count happens to be unchanged.  The store
    revision changes immediately after every successful Save/Red-X/Train AI
    upsert, while the schema token protects against an in-place model upgrade.
    """
    schema_token = hashlib.sha256(
        json.dumps(current_feature_schema(), sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:12]
    return f"{SERVICE_INSTANCE_ID}:{store_revision()}:{schema_token}"


def fetch_image(url: str, timeout: tuple[int, int] = (5, 10)) -> Image.Image:
    global IMAGE_DOWNLOAD_CACHE_BYTES
    with IMAGE_DOWNLOAD_CACHE_LOCK:
        content = IMAGE_DOWNLOAD_CACHE.get(url)
        if content is not None:
            IMAGE_DOWNLOAD_CACHE.move_to_end(url)
    if content is None:
        response = IMAGE_SESSION.get(
            url, timeout=timeout,
            headers={"User-Agent": "Mozilla/5.0 PongPreferenceAI/2.0", "Referer": "https://coomerfans.com/"},
        )
        response.raise_for_status()
        content = bytes(response.content)
        if len(content) <= IMAGE_CACHE_MAX_BYTES:
            with IMAGE_DOWNLOAD_CACHE_LOCK:
                previous = IMAGE_DOWNLOAD_CACHE.pop(url, None)
                if previous is not None:
                    IMAGE_DOWNLOAD_CACHE_BYTES -= len(previous)
                IMAGE_DOWNLOAD_CACHE[url] = content
                IMAGE_DOWNLOAD_CACHE_BYTES += len(content)
                while (
                    len(IMAGE_DOWNLOAD_CACHE) > IMAGE_CACHE_MAX_ITEMS
                    or IMAGE_DOWNLOAD_CACHE_BYTES > IMAGE_CACHE_MAX_BYTES
                ):
                    _, removed = IMAGE_DOWNLOAD_CACHE.popitem(last=False)
                    IMAGE_DOWNLOAD_CACHE_BYTES -= len(removed)
    return Image.open(io.BytesIO(content)).convert("RGB")


def perceptual_image_hash(image: Image.Image) -> int:
    """Small dHash used only to prevent one photo from voting twice."""
    grayscale = image.convert("L").resize((9, 8), Image.Resampling.LANCZOS)
    pixels = np.asarray(grayscale, dtype=np.int16)
    bits = (pixels[:, 1:] > pixels[:, :-1]).reshape(-1)
    value = 0
    for bit in bits:
        value = (value << 1) | int(bool(bit))
    return value


def deduplicate_candidate_images(
    images: list[Image.Image], urls: list[str], maximum_distance: int = 3
) -> tuple[list[Image.Image], list[str]]:
    unique_images: list[Image.Image] = []
    unique_urls: list[str] = []
    fingerprints: list[int] = []
    for image, url in zip(images, urls):
        fingerprint = perceptual_image_hash(image)
        if any((fingerprint ^ prior).bit_count() <= maximum_distance for prior in fingerprints):
            continue
        fingerprints.append(fingerprint)
        unique_images.append(image)
        unique_urls.append(url)
    return unique_images, unique_urls


def load_candidate_images(urls: list[str], max_images: int = 3) -> tuple[list[Image.Image], list[str]]:
    normalized_urls = list(dict.fromkeys(
        normalize_url(url) for url in urls[:max(1, max_images)] if normalize_url(url)
    ))

    def load(url: str) -> tuple[Image.Image | None, str]:
        try:
            return fetch_image(url), url
        except Exception:
            return None, url

    if not normalized_urls:
        return [], []
    # One process-wide pool bounds sockets and threads even when all admitted
    # classifications request multiple images simultaneously. `load` never submits
    # nested work, so waiting for these futures cannot deadlock the executor.
    futures = [IMAGE_DOWNLOAD_EXECUTOR.submit(load, url) for url in normalized_urls]
    loaded = [future.result() for future in futures]
    images = [image for image, _ in loaded if image is not None]
    accepted_urls = [url for image, url in loaded if image is not None]
    return deduplicate_candidate_images(images, accepted_urls)


def body_triage(payload: dict[str, Any]) -> dict[str, Any]:
    """Select body-bearing thumbnails without making an artist verdict."""
    with CLASSIFY_ADMISSION_SEMAPHORE:
        urls = [str(value or "") for value in payload.get("candidateImageUrls", [])]
        images, used_urls = load_candidate_images(urls, max_images=32)
        if not images:
            return {"ok": True, "images": [], "body_images": 0, "face_images": 0}
        with INFERENCE_SEMAPHORE:
            views = VISION.detect_views_batch(images, image_urls=tuple(used_urls))
        items: list[dict[str, Any]] = []
        for image, url, view in zip(images, used_urls, views):
            width, height = image.size
            body_box = view.get("bodyBox")
            face_box = view.get("faceBox")
            body_area = 0.0
            body_height = 0.0
            if body_box and width > 0 and height > 0:
                body_area = max(0.0, float(body_box[2] - body_box[0])) * max(0.0, float(body_box[3] - body_box[1])) / float(width * height)
                body_height = max(0.0, float(body_box[3] - body_box[1])) / float(height)
            items.append({
                "url": url,
                "people": int(view.get("people", 0)),
                "body_visible": body_box is not None,
                "face_visible": face_box is not None,
                "body_area": round(body_area, 6),
                "body_height": round(body_height, 6),
                "body_score": round((100.0 if body_box is not None else 0.0) + body_area * 30.0 + body_height * 20.0, 6),
            })
        return {
            "ok": True,
            "images": items,
            "body_images": sum(1 for item in items if item["body_visible"]),
            "face_images": sum(1 for item in items if item["face_visible"]),
        }


def feature_records(variant: str, view: str = "all") -> tuple[list[np.ndarray], list[int], list[dict[str, Any]]]:
    cache_key = ("records", store_revision(), variant, view)
    with MODEL_CACHE_LOCK:
        cached = MODEL_CACHE.get(cache_key)
    if cached is not None:
        return cached
    features: list[np.ndarray] = []
    labels: list[int] = []
    records: list[dict[str, Any]] = []
    key = "local1" if variant == "local" else "local2"
    for record in STORE.records():
        # Never mix old artist-average/crop features into a newer head. Startup
        # migration re-embeds retained images and preserves the original record.
        if not record_schema_compatible(record):
            continue
        if view == "all":
            raw = record.get("features", {}).get(key)
            if not isinstance(raw, list) or not raw:
                continue
            vectors = [np.asarray(raw, dtype=np.float32)]
        else:
            field = "bodyByImage" if view == "body" else "faceByImage"
            raw_vectors = (record.get("viewFeatures", {}).get(key) or {}).get(field, [])
            if not isinstance(raw_vectors, list):
                continue
            vectors = [
                unit(np.asarray(raw, dtype=np.float32))
                for raw in raw_vectors
                if isinstance(raw, list) and raw
            ]
        for vector in vectors:
            if not np.any(vector):
                continue
            features.append(vector)
            labels.append(1 if record.get("label") == "accept" else 0)
            records.append(record)
    result = (features, labels, records)
    with MODEL_CACHE_LOCK:
        MODEL_CACHE[cache_key] = result
    return result


def prototype_probability(vector: np.ndarray, features: list[np.ndarray], labels: list[int]) -> float:
    positives = [unit(x) for x, y in zip(features, labels) if y == 1]
    negatives = [unit(x) for x, y in zip(features, labels) if y == 0]
    if not positives or not negatives:
        return 0.5
    candidate = unit(vector)
    pos = float(np.mean(sorted((float(np.dot(candidate, x)) for x in positives), reverse=True)[: min(5, len(positives))]))
    neg = float(np.mean(sorted((float(np.dot(candidate, x)) for x in negatives), reverse=True)[: min(7, len(negatives))]))
    return sigmoid((pos - neg) * 14.0)


def build_trained_head(features: list[np.ndarray], labels: list[int]) -> dict[str, Any]:
    head: dict[str, Any] = {"features": features, "labels": labels, "trained": False}
    if len(features) < 6 or len(set(labels)) < 2:
        return head
    matrix = np.stack(features).astype(np.float32)
    targets = np.asarray(labels, dtype=np.float32)
    positive_count = max(1, int(targets.sum()))
    negative_count = max(1, len(targets) - positive_count)
    sample_weights = np.where(
        targets > 0.5,
        len(targets) / (2 * positive_count),
        len(targets) / (2 * negative_count),
    ).astype(np.float32)
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
    head.update({"trained": True, "dimension": matrix.shape[1], "weights": weights, "bias": bias})
    return head


def score_trained_head(vector: np.ndarray, head: dict[str, Any]) -> float:
    candidate = np.asarray(vector, dtype=np.float32)
    features = head["features"]
    labels = head["labels"]
    if not head.get("trained"):
        return prototype_probability(candidate, features, labels)
    if int(head["dimension"]) != candidate.shape[0]:
        return 0.5
    learned = sigmoid(float(candidate @ head["weights"] + head["bias"]))
    prototype = prototype_probability(candidate, features, labels)
    return learned * 0.72 + prototype * 0.28


def cached_head(variant: str, view: str = "all", pattern: str = "") -> dict[str, Any] | None:
    cache_key = ("head", store_revision(), variant, view, pattern)
    with MODEL_CACHE_LOCK:
        if cache_key in MODEL_CACHE:
            return MODEL_CACHE[cache_key]
        # Keep the lock through the small CPU head build. After a swipe, several
        # GPU workers can arrive together; only one should rebuild each head.
        features, preference_labels, records = feature_records(variant, view=view)
        if not pattern:
            # A categorical hard-filter click is evidence for its dedicated hard
            # head, not a statement that the person's face/body is unattractive.
            # Keep normal "not my taste", face and body rejects in this head.
            taste_rows = [
                (feature, label, record)
                for feature, label, record in zip(features, preference_labels, records)
                if not is_categorical_hard_reject(record)
            ]
            features = [row[0] for row in taste_rows]
            preference_labels = [row[1] for row in taste_rows]
            records = [row[2] for row in taste_rows]
        labels = preference_labels if not pattern else [
            1 if re.search(
                pattern,
                f"{record.get('rejectReason', '')} {record.get('rejectReasonLabel', '')}",
                re.I,
            ) else 0
            for record in records
        ]
        if pattern and (sum(labels) < 3 or len(labels) - sum(labels) < 3):
            head = None
        else:
            head = build_trained_head(features, labels)
        MODEL_CACHE[cache_key] = head
        return head


def cached_probability(vector: np.ndarray, variant: str, view: str = "all", pattern: str = "") -> float | None:
    head = cached_head(variant, view, pattern)
    return score_trained_head(vector, head) if head is not None else None


def reason_probability(vector: np.ndarray, variant: str, pattern: str, view: str = "all") -> float | None:
    return cached_probability(vector, variant, view, pattern)


def record_reason_text(record: dict[str, Any]) -> str:
    return f"{record.get('rejectReason', '')} {record.get('rejectReasonLabel', '')}".strip()


def is_categorical_hard_reject(record: dict[str, Any]) -> bool:
    return bool(
        record.get("label") == "reject"
        and CATEGORICAL_HARD_REASON_PATTERN.search(record_reason_text(record))
    )


def cached_preference_view_head(variant: str, view: str, negative_pattern: str) -> dict[str, Any] | None:
    """Train a view-specific taste head without poisoning it with unrelated rejects.

    Saved artists are positive references. A rejected artist is a negative body or
    face reference only when the user explicitly chose the corresponding reason.
    This keeps backgrounds, pose, hair, and unrelated hard-filter feedback out of
    the body/face heads while still rebuilding immediately after every upsert.
    """
    cache_key = ("preference-view-head", store_revision(), variant, view, negative_pattern)
    with MODEL_CACHE_LOCK:
        if cache_key in MODEL_CACHE:
            return MODEL_CACHE[cache_key]
        features, _, records = feature_records(variant, view=view)
        selected_features: list[np.ndarray] = []
        selected_labels: list[int] = []
        for feature, record in zip(features, records):
            if record.get("label") == "accept":
                selected_features.append(feature)
                selected_labels.append(1)
            elif re.search(negative_pattern, record_reason_text(record), re.I):
                selected_features.append(feature)
                selected_labels.append(0)
        if sum(selected_labels) < 2 or len(selected_labels) - sum(selected_labels) < 2:
            head = None
        else:
            head = build_trained_head(selected_features, selected_labels)
        MODEL_CACHE[cache_key] = head
        return head


def preference_view_probability(
    vector: np.ndarray, variant: str, view: str, negative_pattern: str
) -> float | None:
    if not np.any(vector):
        return None
    head = cached_preference_view_head(variant, view, negative_pattern)
    return score_trained_head(vector, head) if head is not None else None


def anatomy_assessment(analysis: dict[str, Any]) -> dict[str, Any]:
    """Describe visible content without making a gender-identity inference."""
    anatomy = analysis.get("anatomyScores")
    semantic = analysis.get("semanticScores")
    per_image: list[dict[str, Any]] = []
    attached_evidence: list[int] = []
    toy_evidence: list[int] = []
    ambiguous_evidence: list[int] = []
    attached_score = 0.0
    toy_score = 0.0

    if anatomy is None:
        anatomy = np.zeros((0, len(ANATOMY_PROMPTS)), dtype=np.float32)
    artist_female_context = bool(
        semantic is not None and any(
            float(row[0]) >= float(row[1]) and float(row[0]) >= 0.20
            for row in semantic
        )
    )
    for index in range(len(anatomy)):
        attached, toy, unclear, none_visible = [float(value) for value in anatomy[index]]
        attached_score = max(attached_score, attached)
        toy_score = max(toy_score, toy)
        female_context = artist_female_context
        if semantic is not None and len(semantic) > index:
            female = float(semantic[index][0])
            male = float(semantic[index][1])
            female_context = female_context or (female >= male and female >= 0.20)
        body_visible = bool(
            index < len(analysis.get("bodyVisibleByImage") or [])
            and analysis["bodyVisibleByImage"][index]
        )

        clear_attached = bool(
            female_context
            and body_visible
            and attached >= ANATOMY_ATTACHED_MIN
            and attached >= toy + ANATOMY_ATTACHED_MARGIN
            and attached >= unclear + 0.22
            and attached >= none_visible + 0.25
        )
        clear_toy = bool(
            body_visible
            and toy >= 0.48
            and toy >= attached + 0.15
            and toy >= unclear + 0.08
        )
        # Do not leave a silent gap when attached-anatomy and toy evidence are
        # close, or when the explicit region is partly obscured. A confident
        # attached result rejects and a confident toy result passes; all material
        # evidence between those two outcomes is explicitly reviewed by Qwen.
        possible_explicit_content = bool(
            none_visible < 0.55
            and attached >= min(ANATOMY_AMBIGUOUS_MIN, 0.32)
            and (attached >= toy - 0.18 or attached >= 0.44)
        )
        is_ambiguous = bool(
            female_context
            and body_visible
            and not clear_attached
            and not clear_toy
            and possible_explicit_content
        )
        image_number = index + 1
        if clear_attached:
            attached_evidence.append(image_number)
        if clear_toy:
            toy_evidence.append(image_number)
        if is_ambiguous:
            ambiguous_evidence.append(image_number)
        per_image.append({
            "image_index": image_number,
            "attached_score": attached,
            "toy_score": toy,
            "ambiguous_score": unclear,
            "none_visible_score": none_visible,
            "female_presenting_context": female_context,
            "body_evidence_present": body_visible,
            "attached_male_anatomy": clear_attached,
            "toy_or_dildo": clear_toy,
            "ambiguous": is_ambiguous,
        })

    evidence_images = sorted(set(attached_evidence + toy_evidence + ambiguous_evidence))
    if attached_evidence:
        attached_flag: bool | None = True
    elif ambiguous_evidence:
        attached_flag = None
    else:
        attached_flag = False
    if toy_evidence:
        toy_flag: bool | None = True
    elif ambiguous_evidence:
        toy_flag = None
    else:
        toy_flag = False
    return {
        "attached_male_anatomy": attached_flag,
        "toy_or_dildo": toy_flag,
        "ambiguous": bool(ambiguous_evidence),
        "attached_score": attached_score,
        "toy_score": toy_score,
        "evidence_images": evidence_images,
        "per_image": per_image,
        "classification_scope": "visible content only; no gender-identity inference",
    }


def age_assessment(analysis: dict[str, Any]) -> dict[str, Any]:
    """Conservative visible-age gate; absent faces produce no veto or review."""
    scores = analysis.get("ageScores")
    clear_faces = analysis.get("clearFaceByImage") or []
    if scores is None:
        scores = np.zeros((0, len(AGE_PROMPTS)), dtype=np.float32)
    per_image: list[dict[str, Any]] = []
    over_evidence: list[int] = []
    underage_evidence: list[int] = []
    ambiguous_evidence: list[int] = []
    over_score = 0.0
    underage_score = 0.0
    for index in range(len(scores)):
        young_adult, middle_adult, over_50, underage, unclear = [float(value) for value in scores[index]]
        face_clear = bool(index < len(clear_faces) and clear_faces[index])
        over_score = max(over_score, over_50 if face_clear else 0.0)
        underage_score = max(underage_score, underage if face_clear else 0.0)
        adult_peak = max(young_adult, middle_adult)
        clear_over = bool(
            face_clear
            and over_50 >= AGE_OVER_50_MIN
            and over_50 >= adult_peak + 0.18
            and over_50 >= unclear + 0.15
        )
        clear_underage = bool(
            face_clear
            and underage >= AGE_UNDERAGE_MIN
            and underage >= adult_peak + 0.24
            and underage >= unclear + 0.18
        )
        ambiguous = bool(
            face_clear
            and not clear_over
            and not clear_underage
            and unclear < 0.55
            and (
                (over_50 >= 0.40 and over_50 >= adult_peak - 0.06)
                or (underage >= 0.44 and underage >= adult_peak - 0.06)
            )
        )
        image_number = index + 1
        if clear_over:
            over_evidence.append(image_number)
        if clear_underage:
            underage_evidence.append(image_number)
        if ambiguous:
            ambiguous_evidence.append(image_number)
        per_image.append({
            "image_index": image_number,
            "face_evidence_clear": face_clear,
            "adult_18_35_score": young_adult,
            "adult_36_49_score": middle_adult,
            "over_50_score": over_50,
            "underage_score": underage,
            "unclear_score": unclear,
            "appears_over_50": clear_over,
            "appears_underage": clear_underage,
            "ambiguous": ambiguous,
        })
    return {
        "appears_over_50": True if over_evidence else (None if ambiguous_evidence else False),
        "appears_underage": True if underage_evidence else (None if ambiguous_evidence else False),
        "ambiguous": bool(ambiguous_evidence),
        "over_50_score": over_score,
        "underage_score": underage_score,
        "evidence_images": sorted(set(over_evidence + underage_evidence + ambiguous_evidence)),
        "per_image": per_image,
        "no_face_allowed": not any(clear_faces),
    }


def hard_checks(
    analysis: dict[str, Any]
) -> tuple[dict[str, Any], list[dict[str, Any]], str, dict[str, Any], dict[str, Any]]:
    semantic = analysis.get("semanticScores")
    body_scores = analysis.get("bodyScores")
    anatomy = anatomy_assessment(analysis)
    age = age_assessment(analysis)
    anatomy_by_image = {
        int(item.get("image_index", 0)): item for item in anatomy.get("per_image", [])
    }
    age_by_image = {
        int(item.get("image_index", 0)): item for item in age.get("per_image", [])
    }
    grades: list[dict[str, Any]] = []
    hard_reason = ""
    for index in range(len(semantic)):
        row = semantic[index]
        female, male, feet, logo, person, unclear = [float(x) for x in row]
        visible_anatomy = anatomy_by_image.get(index + 1, {})
        visible_age = age_by_image.get(index + 1, {})
        clear_body = bool(
            index < len(analysis.get("clearBodyByImage") or [])
            and analysis["clearBodyByImage"][index]
        )
        person_photo = bool(person >= logo and person >= unclear and person >= 0.20)
        # SigLIP's woman/man values share a softmax with overlapping person,
        # feet, logo, and unclear prompts. A modest single-image margin is not
        # calibrated strongly enough for an irreversible artist-wide veto.
        # Keep truly strong evidence as a direct hard reject and route material
        # but weaker male evidence to the narrow Qwen verifier.
        clear_male_presentation = bool(
            (clear_body or person_photo) and male > female + 0.20 and male > 0.52
        )
        female_presentation_clear = bool(female >= male + 0.04 and female > 0.20)
        material_male_ambiguity = bool(
            (clear_body or person_photo)
            and not clear_male_presentation
            and male >= 0.28
            and male > female + 0.06
        )
        gender_presentation_ambiguous = bool(
            (clear_body or person_photo)
            and not clear_male_presentation
            and not female_presentation_clear
            and max(female, male) >= 0.20
        )
        checks = {
            "photograph": bool(person >= logo and person >= unclear),
            "woman_prominent": bool(female > male),
            "male_only": clear_male_presentation,
            "male_present": clear_male_presentation,
            "gender_presentation_ambiguous": gender_presentation_ambiguous,
            "gender_presentation_material_male": material_male_ambiguity,
            "female_presenting_adult": female_presentation_clear,
            "appears_over_50": visible_age.get("appears_over_50", False),
            "appears_underage": visible_age.get("appears_underage", False),
            "underage_looking": visible_age.get("appears_underage", False),
            "age_ambiguous": visible_age.get("ambiguous", False),
            "feet_dominant": bool(feet > 0.38 and feet > person),
            "logo_or_placeholder": bool(logo > 0.38 and logo > person),
            "attached_male_anatomy": visible_anatomy.get("attached_male_anatomy", False),
            "toy_or_dildo": visible_anatomy.get("toy_or_dildo", False),
            "anatomy_ambiguous": visible_anatomy.get("ambiguous", False),
            "visual_preference_match": None,
        }
        grade_reasons: list[str] = []
        if checks["male_present"]:
            grade_reasons.append("male-presenting person visible")
        if checks["feet_dominant"]:
            grade_reasons.append("feet are the main subject")
        if checks["attached_male_anatomy"]:
            grade_reasons.append("visible attached anatomy conflicts with the requested visual filter")
        if checks["appears_underage"]:
            grade_reasons.append("visible person appears underage")
        if checks["appears_over_50"]:
            grade_reasons.append("visible person clearly appears over the age limit")
        grade_reason = "; ".join(grade_reasons)
        if grade_reason and not hard_reason:
            hard_reason = grade_reason
        grades.append({
            "image_index": index + 1,
            "decision": "reject" if checks["male_present"] or checks["feet_dominant"] or checks["logo_or_placeholder"] or checks["attached_male_anatomy"] or checks["appears_underage"] or checks["appears_over_50"] else "unsure",
            "confidence": float(min(0.99, max(row))),
            "reason": grade_reason or "visual evidence checked",
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
        "gender_presentation_ambiguous": any(
            g["checks"].get("gender_presentation_material_male") for g in grades
        ) or (
            not any(g["checks"]["female_presenting_adult"] for g in grades)
            and any(g["checks"]["gender_presentation_ambiguous"] for g in grades)
        ),
        "gender_presentation_ambiguous_images": [
            int(g["image_index"])
            for g in grades
            if g["checks"].get("gender_presentation_material_male") or (
                not any(item["checks"]["female_presenting_adult"] for item in grades)
                and g["checks"]["gender_presentation_ambiguous"]
            )
        ],
        "female_presenting_adult": any(g["checks"]["female_presenting_adult"] for g in grades),
        "appears_over_50": age["appears_over_50"],
        "appears_underage": age["appears_underage"],
        "underage_looking": age["appears_underage"],
        "age_ambiguous": age["ambiguous"],
        "feet_dominant": any(g["checks"]["feet_dominant"] for g in grades),
        "logo_or_placeholder": all_logo,
        "attached_male_anatomy": anatomy["attached_male_anatomy"],
        "toy_or_dildo": anatomy["toy_or_dildo"],
        "anatomy_ambiguous": anatomy["ambiguous"],
    }
    return combined, grades, hard_reason, anatomy, age


def body_preference_veto(
    image_grades: list[dict[str, Any]], body_head: float | None,
    body_heads_by_image: list[float | None], preference: float
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    supporters: list[dict[str, Any]] = []
    strong_supporters: list[dict[str, Any]] = []
    acceptable = 0
    clear = 0
    clear_image_indices: list[int] = []
    acceptable_image_indices: list[int] = []
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
        # Never score or veto from a body crop that the semantic pass considers
        # hidden/cropped/unclear, even if a learned head happens to fire on it.
        if not semantic_available or unclear >= BODY_CLEAR_UNCLEAR_MAX:
            continue
        clear += 1
        clear_image_indices.append(int(grade.get("image_index", index + 1)))
        normal = max(smooth, soft)
        margin = pronounced - normal
        # A direct strong semantic mismatch cannot simultaneously be counted as
        # acceptable merely because an embedding-neighbour head disagrees.
        strong_semantic_mismatch = pronounced >= BODY_STRONG_MIN and margin >= BODY_STRONG_MARGIN
        if normal >= pronounced + 0.04 or (
            image_head is not None and image_head <= 0.46 and not strong_semantic_mismatch
        ):
            acceptable += 1
            acceptable_image_indices.append(int(grade.get("image_index", index + 1)))
        strong_visual = strong_semantic_mismatch or (image_head is not None and image_head >= BODY_HEAD_STRONG_MIN)
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

    learned_consensus = (
        len(supporters) >= BODY_CONSENSUS_MIN
        and body_head is not None
        and body_head >= BODY_HEAD_MIN
    )
    strong_consensus = len(strong_supporters) >= BODY_CONSENSUS_MIN
    # Two agreeing clear body images are stronger evidence than a generic
    # full-image preference score. One suspicious image can never veto.
    preference_override = False
    veto = strong_consensus or learned_consensus
    details = {
        "clear_body_images": clear,
        "clear_body_image_indices": clear_image_indices,
        "supporting_images": len(supporters),
        "strong_supporting_images": len(strong_supporters),
        "acceptable_images": acceptable,
        "acceptable_image_indices": acceptable_image_indices,
        "required_supporting_images": BODY_CONSENSUS_MIN,
        "body_head": body_head,
        "body_heads_by_image": body_heads_by_image,
        "overall_preference": preference,
        "preference_override": preference_override,
        "veto": veto,
    }
    return (supporters[0] if veto and supporters else None), details


def positive_body_preference(
    image_grades: list[dict[str, Any]], body_features_by_image: list[np.ndarray], variant: str
) -> dict[str, Any]:
    """Score only clear body crops using saved positives and body-labelled rejects."""
    scored: list[dict[str, Any]] = []
    for index, grade in enumerate(image_grades):
        profile = grade.get("body_profile") or {}
        if not grade.get("body_visible"):
            continue
        smooth = float(profile.get("smooth_midsection") or 0)
        soft = float(profile.get("ordinary_softness") or 0)
        pronounced = float(profile.get("pronounced_overhang") or 0)
        unclear = float(profile.get("unclear") or 0)
        if smooth + soft + pronounced + unclear <= 0.001 or unclear >= BODY_CLEAR_UNCLEAR_MAX:
            continue
        vector = body_features_by_image[index] if index < len(body_features_by_image) else None
        learned = (
            preference_view_probability(vector, variant, "body", BODY_REASON_PATTERN)
            if vector is not None and np.any(vector) else None
        )
        normal = smooth + soft
        semantic = normal / max(1e-6, normal + pronounced)
        # References lead the decision once sufficient body-labelled examples
        # exist; the semantic score supplies a stable prior and recognizes both
        # smooth and ordinarily soft acceptable bodies.
        score = semantic if learned is None else learned * 0.62 + semantic * 0.38
        scored.append({
            "image_index": int(grade.get("image_index", index + 1)),
            "score": float(max(0.0, min(1.0, score))),
            "learned_score": learned,
            "semantic_score": float(semantic),
        })

    ranked = sorted(scored, key=lambda item: item["score"], reverse=True)
    preferred = [item for item in ranked if item["score"] >= BODY_PREFERRED_MIN]
    # Positive evidence and negative consensus are intentionally asymmetric:
    # one clearly preferred body can establish a match, while rejection still
    # requires two agreeing clear body images. A single odd crop must not drag an
    # excellent body below threshold by being averaged into its positive score.
    representative = (preferred or ranked)[: min(2, len(preferred or ranked))]
    score = float(np.mean([item["score"] for item in representative])) if representative else None
    return {
        "score": score,
        "clear_body_images": len(scored),
        "preferred_body_images": len(preferred),
        "preferred_body_image_indices": [item["image_index"] for item in preferred],
        "representative_image_indices": [item["image_index"] for item in representative],
        "per_image": scored,
        "training_head_available": any(item["learned_score"] is not None for item in scored),
        "needs_more_body_evidence": len(scored) < BODY_CONSENSUS_MIN,
    }


def per_image_face_preference(analysis: dict[str, Any], variant: str) -> dict[str, Any]:
    vectors = analysis.get("faceFeaturesByImage") or []
    clear_mask = analysis.get("clearFaceByImage") or []
    scored: list[dict[str, Any]] = []
    for index, vector in enumerate(vectors):
        if index >= len(clear_mask) or not clear_mask[index] or not np.any(vector):
            continue
        score = preference_view_probability(vector, variant, "face", FACE_REASON_PATTERN)
        scored.append({
            "image_index": index + 1,
            "score": score,
            "match": None if score is None else bool(score >= 0.56),
        })
    usable = [item["score"] for item in scored if item["score"] is not None]
    return {
        "score": float(np.mean(sorted(usable, reverse=True)[:2])) if usable else None,
        "clear_face_images": len(scored),
        "per_image": scored,
    }


def classify(payload: dict[str, Any]) -> dict[str, Any]:
    # Admission happens before any image download. ThreadingHTTPServer may accept
    # a large burst, but only this bounded set can occupy download/cache/inference
    # resources at once; the smaller GPU semaphore still governs model execution.
    with CLASSIFY_ADMISSION_SEMAPHORE:
        return classify_admitted(payload)


def classify_admitted(payload: dict[str, Any]) -> dict[str, Any]:
    variant = "local" if str(payload.get("localVariant", "local")).lower() == "local" else "local2"
    urls = list(dict.fromkeys(normalize_url(x) for x in payload.get("candidateImageUrls", []) if normalize_url(x)))[:3]
    images, used_urls = load_candidate_images(urls)
    if not images:
        raise ValueError("No usable candidate images")

    hard_only = bool(payload.get("hardCheckOnly"))
    include_semantics = variant == "local" or hard_only
    with INFERENCE_SEMAPHORE:
        fast_analysis = VISION.analyze(
            images,
            variant,
            include_semantics=include_semantics,
            image_urls=tuple(used_urls),
        )
    if variant == "local2" and hard_only:
        # Local2's trained head is fitted on DINO-only [full, body, face, flags]
        # vectors. Keep the semantic tensors for hard checks, but score taste on
        # the exact same feature shape used by ordinary Local2 inference.
        dimension = len(fast_analysis["bodyFeature"])
        expanded_feature = np.asarray(fast_analysis["feature"], dtype=np.float32)
        fast_analysis = {
            **fast_analysis,
            "feature": np.concatenate([
                expanded_feature[:dimension],
                np.asarray(fast_analysis["bodyFeature"], dtype=np.float32),
                np.asarray(fast_analysis["faceFeature"], dtype=np.float32),
                expanded_feature[-2:],
            ]).astype(np.float32),
        }
    features, labels, records = feature_records(variant)
    overall_preference = cached_probability(fast_analysis["feature"], variant)
    overall_preference = 0.5 if overall_preference is None else overall_preference

    if variant == "local2" and not include_semantics:
        with INFERENCE_SEMAPHORE:
            _, semantic_scores, body_scores, anatomy_scores, age_scores = VISION.siglip_features(
                images,
                fast_analysis.get("bodyPromptImages"),
                fast_analysis.get("faceVisibleByImage"),
                image_urls=tuple(used_urls),
            )
        body_visible = fast_analysis.get("bodyVisibleByImage") or [False] * len(images)
        clear_body = [
            bool(
                index < len(body_visible)
                and body_visible[index]
                and len(body_scores) > index
                and float(body_scores[index][3]) < BODY_CLEAR_UNCLEAR_MAX
            )
            for index in range(len(images))
        ]
        face_visible = fast_analysis.get("faceVisibleByImage") or [False] * len(images)
        clear_face = [
            bool(
                index < len(face_visible)
                and face_visible[index]
                and len(semantic_scores) > index
                and float(semantic_scores[index][4]) >= float(semantic_scores[index][5])
                and float(semantic_scores[index][4]) >= float(semantic_scores[index][3])
            )
            for index in range(len(images))
        ]
        dimension = len(fast_analysis["bodyFeature"])

        def clear_mean(vectors: list[np.ndarray], mask: list[bool]) -> np.ndarray:
            selected = [vector for vector, keep in zip(vectors, mask) if keep and np.any(vector)]
            return unit(np.mean(selected, axis=0)) if selected else np.zeros(dimension, dtype=np.float32)

        clear_body_feature = clear_mean(fast_analysis.get("bodyFeaturesByImage", []), clear_body)
        clear_face_feature = clear_mean(fast_analysis.get("faceFeaturesByImage", []), clear_face)
        corrected_feature = np.asarray(fast_analysis["feature"], dtype=np.float32).copy()
        corrected_feature[dimension:dimension * 2] = clear_body_feature
        corrected_feature[dimension * 2:dimension * 3] = clear_face_feature
        fast_analysis = {
            **fast_analysis,
            "feature": corrected_feature,
            "bodyFeature": clear_body_feature,
            "faceFeature": clear_face_feature,
        }
        corrected_preference = cached_probability(corrected_feature, variant)
        overall_preference = 0.5 if corrected_preference is None else corrected_preference
        semantic_analysis = {
            **fast_analysis,
            "semanticScores": semantic_scores,
            "bodyScores": body_scores,
            "anatomyScores": anatomy_scores,
            "ageScores": age_scores,
            "clearBodyByImage": clear_body,
            "clearBodyImages": int(sum(clear_body)),
            "clearBodyAvailable": any(clear_body),
            "clearFaceByImage": clear_face,
        }
        # Keep the fast Local2 DINO preference vector; run only SigLIP2 for hard checks.
    else:
        semantic_analysis = fast_analysis

    if semantic_analysis.get("semanticScores") is not None and len(semantic_analysis.get("semanticScores")):
        checks, image_grades, hard_reason, anatomy, age = hard_checks(semantic_analysis)
    else:
        checks = {
            "photograph": True, "woman_prominent": None, "male_only": False,
            "male_present": False, "gender_presentation_ambiguous": False,
            "gender_presentation_ambiguous_images": [], "female_presenting_adult": None,
            "appears_over_50": None, "appears_underage": None, "underage_looking": None, "age_ambiguous": False,
            "feet_dominant": False, "logo_or_placeholder": False,
            "attached_male_anatomy": None, "toy_or_dildo": None, "anatomy_ambiguous": False,
        }
        image_grades = []
        hard_reason = ""
        anatomy = {
            "attached_male_anatomy": None,
            "toy_or_dildo": None,
            "ambiguous": False,
            "attached_score": 0.0,
            "toy_score": 0.0,
            "evidence_images": [],
            "per_image": [],
            "classification_scope": "visible content only; no gender-identity inference",
        }
        age = {
            "appears_over_50": None,
            "appears_underage": None,
            "ambiguous": False,
            "over_50_score": 0.0,
            "underage_score": 0.0,
            "evidence_images": [],
            "per_image": [],
            "no_face_allowed": True,
        }

    clear_face_available = any(bool(value) for value in (semantic_analysis.get("clearFaceByImage") or []))
    body_head = cached_probability(fast_analysis["bodyFeature"], variant, "body", BODY_REASON_PATTERN)
    body_heads_by_image = [
        cached_probability(vector, variant, "body", BODY_REASON_PATTERN)
        if np.any(vector) else None
        for vector in fast_analysis.get("bodyFeaturesByImage", [])
    ]
    reason_heads = {
        "face_reject": reason_probability(fast_analysis["faceFeature"], variant, FACE_REASON_PATTERN, "face")
        if clear_face_available else None,
        "body_reject": body_head,
        "body_reject_by_image": body_heads_by_image,
        "male_reject": reason_probability(fast_analysis["feature"], variant, r"male|\bman\b|trans"),
        "feet_reject": reason_probability(fast_analysis["feature"], variant, r"feet|foot"),
        "logo_reject": reason_probability(
            fast_analysis["feature"], variant, r"logo|placeholder|blank|anime|illustration|non[- ]?photo"
        ),
        "age_reject": reason_probability(
            fast_analysis["feature"], variant, r"underage|minor|too\s+young|over\s*50|too\s+old"
        ),
        "anatomy_reject": reason_probability(
            fast_analysis["feature"], variant, r"penis|testicles|attached\s+anatomy|anatomy\s+conflict"
        ),
    }
    body_veto_grade, body_consensus = body_preference_veto(
        image_grades, body_head, body_heads_by_image, overall_preference
    )
    body_preference = positive_body_preference(
        image_grades, fast_analysis.get("bodyFeaturesByImage", []), variant
    )
    body_consensus["positive_preference"] = body_preference
    body_score = body_preference["score"]
    face_preference_details = per_image_face_preference(semantic_analysis, variant)
    face_preference = face_preference_details["score"]
    if face_preference is None and clear_face_available:
        face_preference = preference_view_probability(
            fast_analysis["faceFeature"], variant, "face", FACE_REASON_PATTERN
        )
    body_by_image = {item["image_index"]: item for item in body_preference["per_image"]}
    face_by_image = {item["image_index"]: item for item in face_preference_details["per_image"]}
    for grade in image_grades:
        image_index = int(grade.get("image_index", 0))
        body_item = body_by_image.get(image_index)
        face_item = face_by_image.get(image_index)
        grade["body_evidence_clear"] = body_item is not None
        grade["body_preference_match"] = (
            None if body_item is None else bool(body_item["score"] >= BODY_PREFERRED_MIN)
        )
        grade["face_evidence_clear"] = face_item is not None
        grade["face_preference_match"] = None if face_item is None else face_item["match"]
        grade_checks = grade.setdefault("checks", {})
        grade_checks["body_evidence_clear"] = grade["body_evidence_clear"]
        grade_checks["body_preference_match"] = grade["body_preference_match"]
        grade_checks["face_evidence_clear"] = grade["face_evidence_clear"]
        grade_checks["face_preference_match"] = grade["face_preference_match"]
    face_threshold = FACE_HEAD_MIN_LOCAL1 if variant == "local" else FACE_HEAD_MIN_LOCAL2
    strong_preferred_body = bool(
        body_score is not None
        and body_score >= BODY_POSITIVE_STRONG_MIN
        and body_preference["preferred_body_images"] >= 1
    )
    face_veto = bool(
        clear_face_available and
        reason_heads["face_reject"] is not None and
        reason_heads["face_reject"] >= face_threshold and
        not strong_preferred_body
    )
    # Learned reason heads are diagnostic/personalization signals only. Male and
    # feet hard rejects require direct SigLIP2 per-image corroboration above;
    # embedding similarity alone must not turn an ordinary body/pose into a veto.

    evidence_available = clear_face_available or body_score is not None
    clear_body_count = int(body_preference["clear_body_images"])
    face_component = face_preference if face_preference is not None else overall_preference
    if body_score is not None:
        if clear_face_available:
            if clear_body_count >= BODY_CONSENSUS_MIN:
                preference = body_score * 0.75 + face_component * 0.15 + overall_preference * 0.10
                preference_weights = {"body": 0.75, "face": 0.15, "overall": 0.10}
            else:
                preference = body_score * 0.68 + face_component * 0.12 + overall_preference * 0.20
                preference_weights = {"body": 0.68, "face": 0.12, "overall": 0.20}
        elif clear_body_count >= BODY_CONSENSUS_MIN:
            preference = body_score * 0.85 + overall_preference * 0.15
            preference_weights = {"body": 0.85, "face": 0.0, "overall": 0.15}
        else:
            preference = body_score * 0.80 + overall_preference * 0.20
            preference_weights = {"body": 0.80, "face": 0.0, "overall": 0.20}
        threshold = 0.50
        preference_basis = "body-dominant"
    else:
        # A face-only or unclear-body profile is allowed, but only when its
        # learned match is substantially stronger than the ordinary cutoff.
        preference = overall_preference * 0.65 + face_component * 0.35
        preference_weights = {"body": 0.0, "face": 0.35 if clear_face_available else 0.0, "overall": 0.65 if clear_face_available else 1.0}
        if not clear_face_available:
            preference = overall_preference
        threshold = FACE_ONLY_ACCEPT_MIN
        preference_basis = "high-confidence no-clear-body"

    if hard_reason:
        personalized_decision = "reject"
        personalized_confidence = max(0.94, preference)
        personalized_reason = hard_reason
    elif not evidence_available:
        personalized_decision = "reject"
        personalized_confidence = 0.90
        personalized_reason = "no usable face or body evidence"
    elif body_veto_grade is not None:
        personalized_decision = "reject"
        personalized_confidence = 0.94
        personalized_reason = "body-shape visual preference mismatch"
    elif face_veto:
        personalized_decision = "reject"
        personalized_confidence = 0.92
        personalized_reason = "face visual preference mismatch"
    elif preference >= threshold:
        personalized_decision = "accept"
        personalized_confidence = min(0.99, 0.58 + abs(preference - threshold) * 1.7)
        if body_score is not None:
            personalized_reason = f"body preference {round(body_score * 100)}%; combined preference {round(preference * 100)}%"
        else:
            personalized_reason = f"high-confidence preference {round(preference * 100)}% without clear body evidence"
    else:
        personalized_decision = "reject"
        personalized_confidence = min(0.99, 0.58 + abs(preference - threshold) * 1.7)
        personalized_reason = f"combined preference {round(preference * 100)}% below {round(threshold * 100)}%"

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
    else:
        decision = personalized_decision
        confidence = personalized_confidence
        reason = personalized_reason

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
        image_index = len(image_grades) + 1
        body_item = body_by_image.get(image_index)
        face_item = face_by_image.get(image_index)
        image_grades.append({
            "image_index": image_index,
            "decision": decision,
            "confidence": confidence,
            "reason": reason,
            "checks": {
                **checks,
                "visual_preference_match": bool(preference >= threshold),
                "body_evidence_clear": body_item is not None,
                "body_preference_match": None if body_item is None else bool(body_item["score"] >= BODY_PREFERRED_MIN),
                "face_evidence_clear": face_item is not None,
                "face_preference_match": None if face_item is None else face_item["match"],
            },
            "body_evidence_clear": body_item is not None,
            "body_preference_match": None if body_item is None else bool(body_item["score"] >= BODY_PREFERRED_MIN),
            "face_evidence_clear": face_item is not None,
            "face_preference_match": None if face_item is None else face_item["match"],
        })

    qwen_review_reasons: list[str] = []
    qwen_review_codes: list[str] = []
    if decision == "accept" and anatomy.get("ambiguous"):
        qwen_review_codes.append("anatomy")
        qwen_review_reasons.append("ambiguous visible attached anatomy versus toy or obscured content")
    if decision == "accept" and checks.get("gender_presentation_ambiguous"):
        qwen_review_codes.append("gender-presentation")
        qwen_review_reasons.append("gender presentation is unclear on otherwise usable visual evidence")
    preferred_body_without_confirmed_presentation = bool(
        decision == "accept"
        and int(body_preference.get("preferred_body_images") or 0) >= 1
        and checks.get("female_presenting_adult") is not True
        and checks.get("male_present") is False
        and checks.get("male_only") is False
    )
    if preferred_body_without_confirmed_presentation and "gender-presentation" not in qwen_review_codes:
        # A covered face is allowed and a preferred body remains strong taste
        # evidence, but it must not bypass the female-presenting hard filter.
        # Resolve only that narrow uncertainty with Qwen instead of silently
        # dropping an otherwise excellent personalized match.
        qwen_review_codes.append("gender-presentation")
        qwen_review_reasons.append("female presentation is not yet explicit on a preferred-body match")
    if decision == "accept" and age.get("ambiguous"):
        qwen_review_codes.append("age")
        qwen_review_reasons.append("ambiguous visible age near a hard-filter boundary")
    requires_qwen_review = bool(qwen_review_reasons)
    # Backward-compatible alias while the browser/server migrate to the more
    # precise standardized field.
    hard_review_required = requires_qwen_review

    # Qwen is a verifier, not the personal taste model. Give it the same three
    # body-prioritized images used by DINO/SigLIP/YOLO.
    semantic_rows = semantic_analysis.get("semanticScores")
    gender_evidence_images = set(
        int(value) for value in checks.get("gender_presentation_ambiguous_images", [])
        if isinstance(value, (int, float))
    )
    ranked_hard_images: list[tuple[float, int, str]] = []
    for index, url in enumerate(used_urls):
        body_visible = bool((semantic_analysis.get("bodyVisibleByImage") or [False] * len(used_urls))[index])
        clear_body = bool((semantic_analysis.get("clearBodyByImage") or [False] * len(used_urls))[index])
        face_visible = bool((fast_analysis.get("faceVisibleByImage") or [False] * len(used_urls))[index])
        person_score = 0.0
        clarity_penalty = 0.0
        if semantic_rows is not None and len(semantic_rows) > index:
            person_score = float(semantic_rows[index][4])
            clarity_penalty = float(semantic_rows[index][3]) + float(semantic_rows[index][5])
        anatomy_evidence = index + 1 in anatomy.get("evidence_images", [])
        age_evidence = index + 1 in age.get("evidence_images", [])
        gender_evidence = index + 1 in gender_evidence_images
        evidence_score = (125.0 if clear_body else (45.0 if body_visible else 0.0)) + (35.0 if face_visible else 0.0)
        evidence_score += 180.0 if anatomy_evidence else 0.0
        evidence_score += 160.0 if age_evidence else 0.0
        evidence_score += 170.0 if gender_evidence else 0.0
        evidence_score += person_score * 10.0 - clarity_penalty * 4.0 - index * 0.001
        ranked_hard_images.append((evidence_score, index, url))
    ranked_hard_images.sort(reverse=True)
    hard_check_image_urls = [item[2] for item in ranked_hard_images[:3]]

    return {
        "decision": decision,
        "confidence": confidence,
        "preference_probability": preference,
        "overall_preference_probability": overall_preference,
        "body_preference_probability": body_score,
        "face_preference_probability": face_preference,
        "preference_threshold": threshold,
        "preference_basis": preference_basis,
        "preference_weights": preference_weights,
        "reason": reason,
        # The hard-only route deliberately answers whether the candidate is safe
        # enough to display. Train AI can reuse the same expensive feature pass
        # for Local2's taste verdict without confusing that gate with an accept.
        "personalized_prediction": {
            "decision": personalized_decision,
            "confidence": personalized_confidence,
            "reason": personalized_reason,
            "preference_probability": preference,
            "overall_preference_probability": overall_preference,
            "body_preference_probability": body_score,
            "face_preference_probability": face_preference,
            "preference_threshold": threshold,
            "preference_basis": preference_basis,
            "preference_weights": preference_weights,
            "source": "personal_preference_v3",
            "vision_source": "personal_preference_v3",
        },
        "source": "personal_preference_v3",
        "vision_source": "personal_preference_v3",
        "model": f"{LOCAL1_DINO} + {SIGLIP_MODEL}" if variant == "local" else f"{LOCAL2_DINO} fast personal head",
        "variant": variant,
        "hard_verified": decision == "accept" and not bool(hard_reason) and bool(image_grades) and not requires_qwen_review,
        "hard_review_required": hard_review_required,
        "requires_qwen_review": requires_qwen_review,
        "qwen_review_codes": qwen_review_codes,
        "qwen_review_reasons": qwen_review_reasons,
        "anatomy_assessment": anatomy,
        "age_assessment": age,
        "checks": checks,
        "image_grades": image_grades,
        "evidence": {
            "face_available": clear_face_available,
            "pose_face_detected": fast_analysis["faceAvailable"],
            "body_available": fast_analysis["bodyAvailable"],
            "clear_body_available": bool(body_score is not None),
            "clear_body_images": clear_body_count,
            "preferred_body_images": int(body_preference["preferred_body_images"]),
            "people": fast_analysis["people"],
            "images": len(images),
        },
        "reason_heads": reason_heads,
        "body_consensus": body_consensus,
        "face_preference": face_preference_details,
        "training": {
            "artists": len(records),
            "accepts": sum(labels),
            "rejects": len(labels) - sum(labels),
        },
        "candidateImageUrls": used_urls,
        "hard_check_image_urls": hard_check_image_urls,
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


def prune_persisted_images(artist_url: str, saved: list[dict[str, str]]) -> None:
    if not saved:
        return
    artist_key = hashlib.sha256(artist_url.encode("utf-8")).hexdigest()[:20]
    folder = IMAGE_DIR / artist_key
    retained = {Path(item["path"]).name for item in saved}
    for old_path in folder.glob("*.jpg"):
        if old_path.name not in retained:
            try:
                old_path.unlink()
            except OSError:
                pass


def serialized_view_features(analysis: dict[str, Any]) -> dict[str, Any]:
    body_mask = analysis.get("clearBodyByImage") or []
    face_mask = analysis.get("clearFaceByImage") or []
    body_vectors = analysis.get("bodyFeaturesByImage") or []
    face_vectors = analysis.get("faceFeaturesByImage") or []
    body_indices = [
        index + 1 for index, (vector, keep) in enumerate(zip(body_vectors, body_mask))
        if keep and np.any(vector)
    ]
    face_indices = [
        index + 1 for index, (vector, keep) in enumerate(zip(face_vectors, face_mask))
        if keep and np.any(vector)
    ]
    return {
        "bodyByImage": [rounded(body_vectors[index - 1]) for index in body_indices],
        "bodyImageIndices": body_indices,
        "faceByImage": [rounded(face_vectors[index - 1]) for index in face_indices],
        "faceImageIndices": face_indices,
    }


def apply_clear_view_masks(
    analysis: dict[str, Any], clear_body: list[bool], clear_face: list[bool]
) -> dict[str, Any]:
    """Apply semantic clarity masks without rerunning the cached DINO pass."""
    dimension = len(analysis["bodyFeature"])

    def clear_mean(vectors: list[np.ndarray], mask: list[bool]) -> np.ndarray:
        selected = [vector for vector, keep in zip(vectors, mask) if keep and np.any(vector)]
        return unit(np.mean(selected, axis=0)) if selected else np.zeros(dimension, dtype=np.float32)

    clear_body_feature = clear_mean(analysis.get("bodyFeaturesByImage", []), clear_body)
    clear_face_feature = clear_mean(analysis.get("faceFeaturesByImage", []), clear_face)
    corrected_feature = np.asarray(analysis["feature"], dtype=np.float32).copy()
    corrected_feature[dimension:dimension * 2] = clear_body_feature
    corrected_feature[dimension * 2:dimension * 3] = clear_face_feature
    return {
        **analysis,
        "feature": corrected_feature,
        "bodyFeature": clear_body_feature,
        "faceFeature": clear_face_feature,
        "clearBodyByImage": list(clear_body),
        "clearBodyImages": int(sum(clear_body)),
        "clearBodyAvailable": any(clear_body),
        "clearFaceByImage": list(clear_face),
    }


def analyze_learning_images(
    images: list[Image.Image], image_urls: list[str] | tuple[str, ...] | None = None
) -> tuple[dict[str, Any], dict[str, Any]]:
    cache_urls = tuple(image_urls or ())
    if len(cache_urls) != len(images):
        cache_urls = ()
    with INFERENCE_SEMAPHORE:
        local1 = VISION.analyze(
            images,
            "local",
            include_semantics=True,
            image_urls=cache_urls or None,
        )
        local2 = VISION.analyze(
            images,
            "local2",
            include_semantics=False,
            image_urls=cache_urls or None,
        )
        local2 = apply_clear_view_masks(
            local2,
            list(local1.get("clearBodyByImage") or []),
            list(local1.get("clearFaceByImage") or []),
        )
    return local1, local2


def feature_record_fields(local1: dict[str, Any], local2: dict[str, Any]) -> dict[str, Any]:
    return {
        "featureSchema": current_feature_schema(),
        "features": {
            "local1": rounded(local1["feature"]),
            "local2": rounded(local2["feature"]),
        },
        "viewFeatures": {
            "local1": serialized_view_features(local1),
            "local2": serialized_view_features(local2),
        },
        "models": {"local1": LOCAL1_DINO, "local2": LOCAL2_DINO, "semantic": SIGLIP_MODEL},
    }


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
    local1, local2 = analyze_learning_images(
        images,
        [item["url"] for item in saved_images],
    )
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
            "clearBodyImages": local1["clearBodyImages"],
            "clearBodyByImage": local1["clearBodyByImage"],
            "clearFaceByImage": local1["clearFaceByImage"],
        },
        **feature_record_fields(local1, local2),
    }
    STORE.upsert(record)
    # Retire old files only after inference and the durable record update have
    # both succeeded. A failed partial fetch must never destroy prior evidence.
    prune_persisted_images(artist_url, saved_images)
    if MIGRATION_STATE.get("complete"):
        MIGRATION_STATE["compatible"] = sum(
            1 for current in STORE.records() if record_schema_compatible(current)
        )
    return {
        "ok": True,
        "saved": True,
        "label": label,
        "artistUrl": artist_url,
        "images": len(saved_images),
        "records": len(STORE.records()),
        "evidence": record["evidence"],
        "retrained": True,
        "model_revision": model_revision(),
        "service_instance_id": SERVICE_INSTANCE_ID,
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


MIGRATION_STATE: dict[str, Any] = {
    "schema_version": FEATURE_SCHEMA_VERSION,
    "running": False,
    "complete": False,
    "total": 0,
    "processed": 0,
    "migrated": 0,
    "failed": 0,
    "compatible": 0,
    "current_artist": "",
    "errors": [],
}


def load_retained_record_images(record: dict[str, Any]) -> list[Image.Image]:
    images: list[Image.Image] = []
    for item in (record.get("images") or [])[:MAX_LEARN_IMAGES]:
        try:
            relative = str(item.get("path", ""))
            path = (DATA_DIR / relative).resolve() if relative else None
            if path is not None and path.is_file() and DATA_DIR.resolve() in path.parents:
                images.append(Image.open(path).convert("RGB"))
                continue
            url = normalize_url(item.get("url", ""))
            if url:
                images.append(fetch_image(url))
        except Exception:
            continue
    return images


def migrate_store_features() -> None:
    records = STORE.records()
    targets = [record for record in records if not record_schema_compatible(record)]
    MIGRATION_STATE.update({
        "running": bool(targets),
        "complete": not bool(targets),
        "total": len(targets),
        "processed": 0,
        "migrated": 0,
        "failed": 0,
        "compatible": len(records) - len(targets),
        "current_artist": "",
        "errors": [],
    })
    if not targets:
        MIGRATION_BACKUP_PATH.unlink(missing_ok=True)
        return
    if STORE_PATH.exists() and not MIGRATION_BACKUP_PATH.exists():
        shutil.copy2(STORE_PATH, MIGRATION_BACKUP_PATH)

    pending: dict[str, dict[str, Any]] = {}
    for record in targets:
        artist_url = str(record.get("artistUrl", ""))
        artist_name = str(record.get("artistName", ""))
        MIGRATION_STATE["current_artist"] = artist_name or artist_url
        try:
            images = load_retained_record_images(record)
            if not images:
                raise ValueError("no retained learning images available")
            local1, local2 = analyze_learning_images(images)
            evidence = {
                **(record.get("evidence") or {}),
                "faceAvailable": local1["faceAvailable"],
                "bodyAvailable": local1["bodyAvailable"],
                "clearBodyImages": local1["clearBodyImages"],
                "clearBodyByImage": local1["clearBodyByImage"],
                "clearFaceByImage": local1["clearFaceByImage"],
            }
            pending[artist_url] = {
                **record,
                "evidence": evidence,
                **feature_record_fields(local1, local2),
                "featureMigratedAt": now_iso(),
            }
            MIGRATION_STATE["migrated"] += 1
        except Exception as exc:
            MIGRATION_STATE["failed"] += 1
            if len(MIGRATION_STATE["errors"]) < 12:
                MIGRATION_STATE["errors"].append({"artistUrl": artist_url, "error": str(exc)[:240]})
        MIGRATION_STATE["processed"] += 1
        if len(pending) >= 25:
            STORE.replace_records(pending)
            pending = {}
        if MIGRATION_STATE["processed"] % 5 == 0 or MIGRATION_STATE["processed"] == len(targets):
            write_status(
                "migrating",
                f"Re-embedding preference records {MIGRATION_STATE['processed']}/{len(targets)}.",
                migration=MIGRATION_STATE,
            )
    STORE.replace_records(pending)
    current_records = STORE.records()
    MIGRATION_STATE.update({
        "running": False,
        "complete": True,
        "compatible": sum(1 for record in current_records if record_schema_compatible(record)),
        "current_artist": "",
    })
    # The backup is only a crash-recovery aid. Once every record migrated
    # successfully, remove the redundant preference copy instead of retaining
    # stale URLs and labels indefinitely.
    if MIGRATION_STATE["failed"] == 0:
        MIGRATION_BACKUP_PATH.unlink(missing_ok=True)


BOOTSTRAP_STATE = {"running": False, "complete": STORE_PATH.exists(), "imported": 0, "error": ""}
SERVICE_STATE: dict[str, Any] = {
    "ready": False,
    "warming": True,
    "error": "",
    "warmup_seconds": 0.0,
}


def warm_personal_heads() -> None:
    for variant in ("local", "local2"):
        cached_head(variant)
        cached_head(variant, "body", BODY_REASON_PATTERN)
        cached_head(variant, "face", FACE_REASON_PATTERN)
        cached_preference_view_head(variant, "body", BODY_REASON_PATTERN)
        cached_preference_view_head(variant, "face", FACE_REASON_PATTERN)
        cached_head(variant, "all", r"male|\bman\b|trans")
        cached_head(variant, "all", r"feet|foot")
        cached_head(variant, "all", r"logo|placeholder|blank|anime|illustration|non[- ]?photo")
        cached_head(variant, "all", r"underage|minor|too\s+young|over\s*50|too\s+old")
        cached_head(variant, "all", r"penis|testicles|attached\s+anatomy|anatomy\s+conflict")


def migrate_features_after_ready() -> None:
    try:
        migrate_store_features()
        warm_personal_heads()
        write_status("ready", "Preference models ready; background feature migration complete.", migration=MIGRATION_STATE)
    except Exception as exc:
        MIGRATION_STATE.update({"running": False, "complete": False, "current_artist": ""})
        write_status("warning", f"Preference models ready; background migration paused: {exc}", migration=MIGRATION_STATE)


def warm_models() -> None:
    started = time.perf_counter()
    try:
        write_status("warming", "Warming YOLO, DINOv2 Local1/Local2, SigLIP2, and personal heads.")
        dummy = Image.new("RGB", (384, 384), (36, 36, 36))
        with INFERENCE_SEMAPHORE:
            # Actual inference (not just model construction) allocates CUDA
            # kernels and catches missing weights before readiness is reported.
            VISION.analyze([dummy.copy() for _ in range(5)], "local", include_semantics=True)
            VISION.analyze([dummy.copy() for _ in range(5)], "local2", include_semantics=False)
        needs_migration = any(not record_schema_compatible(record) for record in STORE.records())
        if not needs_migration:
            migrate_store_features()
        warm_personal_heads()
        if DEVICE == "cuda":
            torch.cuda.synchronize()
        SERVICE_STATE.update({
            "ready": True,
            "warming": False,
            "error": "",
            "warmup_seconds": round(time.perf_counter() - started, 3),
        })
        write_status(
            "ready",
            f"Preference models and feature schema ready in {SERVICE_STATE['warmup_seconds']} seconds.",
            migration=MIGRATION_STATE,
        )
        if not STORE.records() and LEGACY_STORE_PATH.exists():
            threading.Timer(1.0, bootstrap_legacy).start()
        if needs_migration:
            threading.Thread(
                target=migrate_features_after_ready,
                name="pong-feature-migration",
                daemon=True,
            ).start()
    except Exception as exc:
        SERVICE_STATE.update({
            "ready": False,
            "warming": False,
            "error": str(exc),
            "warmup_seconds": round(time.perf_counter() - started, 3),
        })
        write_status("error", f"Preference model warmup failed: {exc}")


def bootstrap_legacy() -> None:
    if STORE.records() or not LEGACY_STORE_PATH.exists():
        BOOTSTRAP_STATE["complete"] = True
        return
    BOOTSTRAP_STATE["running"] = True
    write_status("bootstrapping", "Importing legacy preference examples into compact feature-schema v3 records.")
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
        self.end_headers()
        self.wfile.write(payload)

    def caller_allowed(self) -> bool:
        # This service is an internal Node sidecar. Browser requests carry an
        # Origin header and must go through the guarded port-8787 API instead.
        return not str(self.headers.get("Origin", "")).strip()

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 10 * 1024 * 1024:
            raise ValueError("request body too large")
        return json.loads(self.rfile.read(length).decode("utf-8")) if length else {}

    def do_OPTIONS(self) -> None:
        self.send_json(403, {"ok": False, "error": "direct browser access is not allowed"})

    def do_GET(self) -> None:
        try:
            if not self.caller_allowed():
                self.send_json(403, {"ok": False, "error": "direct browser access is not allowed"})
                return
            if self.path.split("?", 1)[0] == "/health":
                records = STORE.records()
                with ACTIVE_CLASSIFY_LOCK:
                    active_classify = ACTIVE_CLASSIFY
                with IMAGE_DOWNLOAD_CACHE_LOCK:
                    image_cache = {
                        "items": len(IMAGE_DOWNLOAD_CACHE),
                        "bytes": IMAGE_DOWNLOAD_CACHE_BYTES,
                        "max_items": IMAGE_CACHE_MAX_ITEMS,
                        "max_bytes": IMAGE_CACHE_MAX_BYTES,
                    }
                with VISION.cache_lock:
                    feature_cache = {
                        "items": len(VISION.feature_cache),
                        "bytes": VISION.feature_cache_bytes,
                        "max_items": FEATURE_CACHE_MAX_ITEMS,
                        "max_bytes": FEATURE_CACHE_MAX_BYTES,
                    }
                compatible_records = sum(1 for record in records if record_schema_compatible(record))
                self.send_json(200, {
                    "ok": True,
                    "app": "pong-preference-ai",
                    "model_revision": model_revision(),
                    "service_instance_id": SERVICE_INSTANCE_ID,
                    "ready": bool(SERVICE_STATE["ready"]),
                    "warming": bool(SERVICE_STATE["warming"]),
                    "warmup_seconds": SERVICE_STATE["warmup_seconds"],
                    "warmup_error": SERVICE_STATE["error"],
                    "device": DEVICE,
                    "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "",
                    "local1_model": LOCAL1_DINO,
                    "local2_model": LOCAL2_DINO,
                    "semantic_model": SIGLIP_MODEL,
                    "pose_model": POSE_MODEL,
                    "feature_schema": current_feature_schema(),
                    "records": len(records),
                    "compatible_records": compatible_records,
                    "incompatible_records": len(records) - compatible_records,
                    "accepts": sum(1 for r in records if r.get("label") == "accept"),
                    "rejects": sum(1 for r in records if r.get("label") == "reject"),
                    "active_classify": active_classify,
                    "classify_admission_limit": CLASSIFY_ADMISSION_LIMIT,
                    "image_download_workers": IMAGE_DOWNLOAD_WORKERS,
                    "bootstrap": BOOTSTRAP_STATE,
                    "migration": MIGRATION_STATE,
                    "image_cache": image_cache,
                    "feature_cache": feature_cache,
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
            if not self.caller_allowed():
                self.send_json(403, {"ok": False, "error": "direct browser access is not allowed"})
                return
            payload = self.read_json()
            path = self.path.split("?", 1)[0]
            if path == "/body-triage":
                if not SERVICE_STATE["ready"]:
                    self.send_json(503, {"ok": False, "error": "personal preference models are still warming"})
                    return
                self.send_json(200, body_triage(payload))
                return
            if path == "/classify":
                if not SERVICE_STATE["ready"]:
                    self.send_json(503, {"ok": False, "error": "personal preference models are still warming"})
                    return
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
                if not SERVICE_STATE["ready"]:
                    self.send_json(503, {"ok": False, "error": "personal preference models are still warming"})
                    return
                self.send_json(200, learn(payload))
                return
            self.send_json(404, {"ok": False, "error": "not found"})
        except Exception as exc:
            self.send_json(500, {"ok": False, "error": str(exc)})


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    write_status("warming", f"Preference service listening on {HOST}:{PORT}; models are warming.")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Pong preference AI listening at http://{HOST}:{PORT} ({DEVICE})", flush=True)
    threading.Thread(target=warm_models, name="pong-model-warmup", daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
