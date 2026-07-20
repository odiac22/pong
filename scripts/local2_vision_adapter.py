"""In-memory vision adapter for the clean Local2 engine.

The adapter borrows an already-created preference-service vision runtime.  It
does not load a second copy of SigLIP or DINO, fetch URLs, open local files, or
persist media.  All durable Local2 learning is delegated to Local2NumericStore.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence
from urllib.parse import urlparse

import numpy as np

from local2_clean import (
    ENGINE_SCHEMA,
    GROUP_LABELS,
    SEMANTIC_PROMPT_GROUPS,
    Local2ImageEvidence,
    Local2NumericStore,
    Local2NumericView,
    Local2Policy,
    RidgeLinearHead,
    stable_artist_key,
)


DEFAULT_FEATURE_SCHEMA = "facebook-dinov2-small/local2-clean-full-body-face-v2"
MAX_LOCAL2_IMAGES = 12
HARD_ONLY_REASON = re.compile(
    r"\b(?:male|man|men|trans|transgender|feet|foot|logo|placeholder|anime|"
    r"illustration|advertisement|age|over\s*60|too\s*old|penis|testicles|"
    r"anatomy|adult[_ -]?safety|minor|underage|spam|non[- ]?photo)\b",
    re.I,
)


def _unit(vector: np.ndarray) -> np.ndarray:
    value = np.asarray(vector, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(value))
    return value / norm if norm > 1e-8 else value


def _mean_unit(vectors: Sequence[np.ndarray], dimension: int) -> np.ndarray:
    if not vectors:
        return np.zeros(dimension, dtype=np.float32)
    return _unit(np.mean(np.stack(vectors).astype(np.float32), axis=0))


def _softmax_rows(values: np.ndarray) -> np.ndarray:
    matrix = np.asarray(values, dtype=np.float64)
    matrix = matrix - np.max(matrix, axis=1, keepdims=True)
    exponent = np.exp(np.clip(matrix, -50.0, 50.0))
    return (exponent / np.maximum(exponent.sum(axis=1, keepdims=True), 1e-12)).astype(np.float32)


def _legacy_artist_identity(raw: Any) -> str:
    try:
        parsed = urlparse(str(raw or ""))
        parts = [part for part in parsed.path.split("/") if part]
        marker = next((index for index, part in enumerate(parts) if part.lower() in {"u", "c"}), -1)
        if marker >= 0 and len(parts) > marker + 2:
            return f"{parts[marker + 1].lower()}:{parts[marker + 2].lower()}"
        return parsed.path.rstrip("/").lower()
    except Exception:
        return ""


def _view_value(view: Mapping[str, Any], *names: str) -> Any | None:
    for name in names:
        value = view.get(name)
        if value is not None:
            return value
    return None


def _derived_lower_torso(full: Any, view: Mapping[str, Any]) -> Any | None:
    existing = _view_value(view, "lower_torso", "lowerTorso", "pelvis")
    if existing is not None:
        return existing
    body_box = view.get("bodyBox")
    size = getattr(full, "size", None)
    crop = getattr(full, "crop", None)
    if not body_box or not isinstance(size, tuple) or len(size) != 2 or not callable(crop):
        return None
    width, height = int(size[0]), int(size[1])
    x1, y1, x2, y2 = [float(value) for value in body_box]
    torso_height = max(1.0, y2 - y1)
    torso_width = max(1.0, x2 - x1)
    lower_box = (
        max(0, int(x1 - torso_width * 0.12)),
        max(0, int(y1 + torso_height * 0.42)),
        min(width, int(x2 + torso_width * 0.12)),
        min(height, int(y2 + torso_height * 1.05)),
    )
    if lower_box[2] - lower_box[0] < 40 or lower_box[3] - lower_box[1] < 48:
        return None
    return crop(lower_box)


@dataclass(frozen=True, slots=True)
class Local2AnalysisBundle:
    descriptors: tuple[Local2ImageEvidence, ...]
    numeric_views: tuple[Local2NumericView, ...]
    artist_feature: np.ndarray
    feature_schema: str


class RuntimeSiglipGroupedScorer:
    """Score every prompt once per image batch, then normalize within groups."""

    def __init__(self, runtime: Any, *, batch_size: int = 8) -> None:
        self.runtime = runtime
        self.batch_size = max(4, min(48, int(batch_size)))
        self.prompts: list[str] = []
        self.slices: dict[str, slice] = {}
        for group_name, prompts in SEMANTIC_PROMPT_GROUPS.items():
            start = len(self.prompts)
            self.prompts.extend(prompts)
            self.slices[group_name] = slice(start, len(self.prompts))
        self.cache: OrderedDict[str, dict[str, np.ndarray]] = OrderedDict()
        self.cache_lock = threading.RLock()
        self.cache_max_items = 2048

    def _score_uncached(self, images: Sequence[Any]) -> dict[str, np.ndarray]:
        if not images:
            return {
                name: np.zeros((0, len(labels)), dtype=np.float32)
                for name, labels in GROUP_LABELS.items()
            }
        # Torch remains a lazy dependency so pure-numeric tests can import this
        # module without loading CUDA or model code.
        import torch

        processor, model = self.runtime._siglip()
        try:
            device = next(model.parameters()).device
        except Exception:
            device = getattr(model, "device", "cpu")
        logits_batches: list[np.ndarray] = []
        for start in range(0, len(images), self.batch_size):
            batch = list(images[start:start + self.batch_size])
            encoded = processor(
                text=self.prompts,
                images=batch,
                padding="max_length",
                return_tensors="pt",
            )
            encoded = {
                key: value.to(device) if hasattr(value, "to") else value
                for key, value in encoded.items()
            }
            with torch.inference_mode():
                output = model(**encoded)
                logits = output.logits_per_image.float().detach().cpu().numpy()
            logits_batches.append(np.asarray(logits, dtype=np.float32))
        all_logits = np.concatenate(logits_batches, axis=0)
        if all_logits.shape != (len(images), len(self.prompts)):
            raise ValueError("shared SigLIP returned an unexpected grouped-score shape")
        return {
            name: _softmax_rows(all_logits[:, group_slice])
            for name, group_slice in self.slices.items()
        }

    def __call__(
        self,
        images: Sequence[Any],
        *,
        cache_keys: Sequence[str] | None = None,
    ) -> dict[str, np.ndarray]:
        if not cache_keys or len(cache_keys) != len(images) or not all(cache_keys):
            return self._score_uncached(images)
        rows: list[dict[str, np.ndarray] | None] = [None] * len(images)
        missing_indices: list[int] = []
        with self.cache_lock:
            for index, key in enumerate(cache_keys):
                cached = self.cache.get(str(key))
                if cached is None:
                    missing_indices.append(index)
                    continue
                self.cache.move_to_end(str(key))
                rows[index] = {name: value.copy() for name, value in cached.items()}
        if missing_indices:
            missing = self._score_uncached([images[index] for index in missing_indices])
            with self.cache_lock:
                for result_index, image_index in enumerate(missing_indices):
                    row = {
                        name: np.asarray(values[result_index], dtype=np.float32).copy()
                        for name, values in missing.items()
                    }
                    rows[image_index] = row
                    self.cache[str(cache_keys[image_index])] = row
                    self.cache.move_to_end(str(cache_keys[image_index]))
                while len(self.cache) > self.cache_max_items:
                    self.cache.popitem(last=False)
        return {
            name: np.stack([row[name] for row in rows if row is not None]).astype(np.float32)
            for name in GROUP_LABELS
        }


class Local2VisionAdapter:
    """Convert in-memory images to the isolated Local2 numeric contract."""

    def __init__(
        self,
        runtime: Any,
        *,
        numeric_store: Local2NumericStore | None = None,
        legacy_record_provider: Callable[[], Sequence[Mapping[str, Any]]] | None = None,
        legacy_revision_provider: Callable[[], Any] | None = None,
        group_scorer: Callable[[Sequence[Any]], Mapping[str, np.ndarray]] | None = None,
        view_detector: Callable[[Sequence[Any]], Sequence[Mapping[str, Any]]] | None = None,
        feature_encoder: Callable[[Sequence[Any]], Sequence[np.ndarray]] | None = None,
        policy: Local2Policy | None = None,
        feature_schema: str = DEFAULT_FEATURE_SCHEMA,
        max_images: int = MAX_LOCAL2_IMAGES,
    ) -> None:
        self.runtime = runtime
        self.numeric_store = numeric_store
        self.legacy_record_provider = legacy_record_provider
        self.legacy_revision_provider = legacy_revision_provider
        self.group_scorer = group_scorer or RuntimeSiglipGroupedScorer(runtime)
        self.view_detector = view_detector
        self.feature_encoder = feature_encoder or self._runtime_dino
        self.policy = policy or Local2Policy()
        self.feature_schema = str(feature_schema)
        self.max_images = max(2, min(MAX_LOCAL2_IMAGES, int(max_images)))
        self._head_lock = threading.RLock()
        self._head_token = ""
        self._head: RidgeLinearHead | None = None

    def _runtime_views(
        self,
        images: Sequence[Any],
        image_urls: Sequence[str] | None = None,
    ) -> Sequence[Mapping[str, Any]]:
        urls = tuple(image_urls) if image_urls and len(image_urls) == len(images) else None
        if urls is None:
            return self.runtime.detect_views_batch(list(images))
        try:
            return self.runtime.detect_views_batch(list(images), urls)
        except TypeError:
            return self.runtime.detect_views_batch(list(images))

    def _runtime_dino(self, images: Sequence[Any]) -> Sequence[np.ndarray]:
        return self.runtime.dino_encode(list(images), "local2")

    @staticmethod
    def _validate_group_scores(
        scores: Mapping[str, np.ndarray], expected_rows: int
    ) -> dict[str, np.ndarray]:
        result: dict[str, np.ndarray] = {}
        for group_name, labels in GROUP_LABELS.items():
            values = np.asarray(scores.get(group_name), dtype=np.float32)
            if values.shape != (expected_rows, len(labels)):
                raise ValueError(
                    f"Local2 group {group_name} expected {(expected_rows, len(labels))}, got {values.shape}"
                )
            if not np.all(np.isfinite(values)) or np.any(values < 0):
                raise ValueError(f"Local2 group {group_name} contains invalid scores")
            totals = values.sum(axis=1, keepdims=True)
            result[group_name] = values / np.maximum(totals, 1e-12)
        return result

    @staticmethod
    def _group_row(scores: Mapping[str, np.ndarray], group_name: str, row: int) -> dict[str, float]:
        return {
            label: float(value)
            for label, value in zip(GROUP_LABELS[group_name], scores[group_name][row])
        }

    @staticmethod
    def _artist_feature(
        descriptors: Sequence[Local2ImageEvidence], views: Sequence[Local2NumericView]
    ) -> np.ndarray:
        if not views:
            raise ValueError("Local2 DINO encoder returned no numeric views")
        dimension = len(views[0].vector)
        if any(len(view.vector) != dimension for view in views):
            raise ValueError("Local2 DINO view dimensions do not match")
        descriptor_by_index = {item.image_index: item for item in descriptors}
        full = [view.vector for view in views if view.view_kind == "full"]
        body = [
            view.vector for view in views
            if view.view_kind == "body" and descriptor_by_index[view.image_index].body_clear
        ]
        face = [
            view.vector for view in views
            if view.view_kind == "face" and descriptor_by_index[view.image_index].face_clear
        ]
        return np.concatenate(
            [
                _mean_unit(full, dimension),
                _mean_unit(body, dimension),
                _mean_unit(face, dimension),
                np.asarray([1.0 if face else 0.0, 1.0 if body else 0.0], dtype=np.float32),
            ]
        ).astype(np.float32)

    def analyze(
        self,
        images: Sequence[Any],
        *,
        image_urls: Sequence[str] | None = None,
        include_taste: bool = True,
    ) -> Local2AnalysisBundle:
        selected = list(images[: self.max_images])
        if len(selected) < 1:
            raise ValueError("Local2 requires at least one in-memory image")
        selected_urls = list(image_urls[:len(selected)]) if image_urls else []
        if len(selected_urls) != len(selected):
            selected_urls = []
        views = list(
            self.view_detector(selected)
            if self.view_detector is not None
            else self._runtime_views(selected, selected_urls)
        )
        if len(views) != len(selected):
            raise ValueError("Local2 view detector returned a mismatched result count")

        full_images: list[Any] = []
        body_images: list[Any] = []
        lower_images: list[Any] = []
        face_images: list[Any] = []
        body_visible: list[bool] = []
        lower_visible: list[bool] = []
        face_visible: list[bool] = []
        for image, view in zip(selected, views):
            full = _view_value(view, "full")
            if full is None:
                full = image
            body = _view_value(view, "body")
            face = _view_value(view, "face")
            lower = _derived_lower_torso(full, view)
            full_images.append(full)
            body_images.append(body if body is not None else full)
            lower_images.append(lower if lower is not None else full)
            face_images.append(face if face is not None else full)
            body_visible.append(body is not None)
            lower_visible.append(lower is not None)
            face_visible.append(face is not None)

        count = len(selected)
        semantic_views = full_images + body_images + lower_images + face_images
        semantic_cache_keys = (
            [f"{ENGINE_SCHEMA}:{url}:full" for url in selected_urls] +
            [f"{ENGINE_SCHEMA}:{url}:body" for url in selected_urls] +
            [f"{ENGINE_SCHEMA}:{url}:lower" for url in selected_urls] +
            [f"{ENGINE_SCHEMA}:{url}:face" for url in selected_urls]
        ) if selected_urls else None
        grouped_raw = (
            self.group_scorer(semantic_views, cache_keys=semantic_cache_keys)
            if isinstance(self.group_scorer, RuntimeSiglipGroupedScorer)
            else self.group_scorer(semantic_views)
        )
        grouped = self._validate_group_scores(grouped_raw, len(semantic_views))
        descriptors: list[Local2ImageEvidence] = []
        for index in range(count):
            groups = {
                "media_type": self._group_row(grouped, "media_type", index),
                "presentation": self._group_row(grouped, "presentation", index),
                "content_focus": self._group_row(grouped, "content_focus", index),
                "body_shape": self._group_row(grouped, "body_shape", count + index),
                "anatomy": self._group_row(grouped, "anatomy", count * 2 + index),
                "age_limit": self._group_row(grouped, "age_limit", count * 3 + index),
                "adult_safety": self._group_row(grouped, "adult_safety", count * 3 + index),
            }
            descriptors.append(
                Local2ImageEvidence.from_grouped_scores(
                    index + 1,
                    groups,
                    body_visible=body_visible[index],
                    face_visible=face_visible[index],
                    lower_torso_visible=lower_visible[index],
                )
            )

        numeric_views: list[Local2NumericView] = []
        if include_taste:
            # Lower-torso views are needed by grouped anatomy semantics but not
            # by the DINO taste head. Avoiding that fourth DINO view saves 25%.
            taste_views = full_images + body_images + face_images
            encoded = [
                np.asarray(value, dtype=np.float32).reshape(-1)
                for value in self.feature_encoder(taste_views)
            ]
            if len(encoded) != len(taste_views):
                raise ValueError("Local2 DINO encoder returned a mismatched result count")
            for index in range(count):
                image_index = index + 1
                numeric_views.append(Local2NumericView(image_index, "full", encoded[index]))
                if body_visible[index]:
                    numeric_views.append(Local2NumericView(image_index, "body", encoded[count + index]))
                if face_visible[index]:
                    numeric_views.append(Local2NumericView(image_index, "face", encoded[count * 2 + index]))
            feature = self._artist_feature(descriptors, numeric_views)
        else:
            feature = np.zeros(0, dtype=np.float32)
        return Local2AnalysisBundle(
            descriptors=tuple(descriptors),
            numeric_views=tuple(numeric_views),
            artist_feature=feature,
            feature_schema=self.feature_schema,
        )

    @staticmethod
    def _record_reason(record: Mapping[str, Any]) -> str:
        return f"{record.get('rejectReason', '')} {record.get('rejectReasonLabel', '')}".strip()

    def _legacy_rows(
        self,
        dimension: int,
        excluded_artist_keys: set[str] | None = None,
    ) -> tuple[list[np.ndarray], list[int], str]:
        records = list(self.legacy_record_provider() if self.legacy_record_provider else [])
        excluded = excluded_artist_keys or set()
        features: list[np.ndarray] = []
        labels: list[int] = []
        signature: list[tuple[str, str, str, str]] = []
        for record in records:
            try:
                artist_key = stable_artist_key(_legacy_artist_identity(
                    record.get("artistUrl") or record.get("artist_url") or ""
                ))
            except ValueError:
                artist_key = ""
            if artist_key and artist_key in excluded:
                continue
            label = str(record.get("label", "")).lower()
            reason = self._record_reason(record)
            if label not in {"accept", "reject"}:
                continue
            if label == "reject" and HARD_ONLY_REASON.search(reason):
                continue
            raw = (record.get("features") or {}).get("local2")
            if not isinstance(raw, list) or len(raw) != dimension:
                continue
            vector = np.asarray(raw, dtype=np.float32)
            if not np.all(np.isfinite(vector)):
                continue
            features.append(vector)
            labels.append(1 if label == "accept" else 0)
            signature.append((artist_key, label, reason, str(record.get("learnedAt", ""))))
        token = hashlib.sha256(
            json.dumps(signature, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        ).hexdigest()[:20]
        return features, labels, token

    def _numeric_rows(self, dimension: int) -> tuple[list[np.ndarray], list[int], int, set[str]]:
        if self.numeric_store is None:
            return [], [], 0, set()
        features: list[np.ndarray] = []
        labels: list[int] = []
        artist_keys: set[str] = set()
        for example in self.numeric_store.load(feature_schema=self.feature_schema):
            if example.label == "reject" and HARD_ONLY_REASON.search(example.reason_code):
                continue
            vector = self._artist_feature(example.descriptors, example.views)
            if len(vector) != dimension:
                continue
            features.append(vector)
            labels.append(1 if example.label == "accept" else 0)
            artist_keys.add(example.artist_key)
        return features, labels, int(self.numeric_store.revision), artist_keys

    def _taste_head(self, dimension: int) -> RidgeLinearHead | None:
        quick_token = ""
        if self.legacy_revision_provider is not None:
            try:
                legacy_revision = str(self.legacy_revision_provider())
            except Exception:
                legacy_revision = "unavailable"
            numeric_revision = int(self.numeric_store.revision) if self.numeric_store is not None else 0
            quick_token = f"{dimension}:legacy-{legacy_revision}:numeric-{numeric_revision}"
        with self._head_lock:
            if quick_token and quick_token == self._head_token:
                return self._head
            numeric_features, numeric_labels, numeric_revision, numeric_artist_keys = self._numeric_rows(dimension)
            legacy_features, legacy_labels, legacy_token = self._legacy_rows(
                dimension,
                numeric_artist_keys,
            )
            features = legacy_features + numeric_features
            labels = legacy_labels + numeric_labels
            token = quick_token or f"{dimension}:{legacy_token}:{numeric_revision}:{len(features)}:{sum(labels)}"
            if token == self._head_token:
                return self._head
            positives = sum(labels)
            negatives = len(labels) - positives
            self._head = (
                RidgeLinearHead.fit(np.stack(features), labels)
                if positives >= 2 and negatives >= 2
                else None
            )
            self._head_token = token
            return self._head

    def classify_analysis(
        self,
        analysis: Local2AnalysisBundle,
        *,
        hard_only: bool = False,
    ) -> dict[str, Any]:
        head = None if hard_only else self._taste_head(len(analysis.artist_feature))
        taste_probability = 1.0 if hard_only else (
            head.predict_probability(analysis.artist_feature) if head is not None else None
        )
        decision = self.policy.decide(
            analysis.descriptors,
            taste_probability=taste_probability,
        )
        result = decision.as_dict()
        aggregate_anatomy_conflict = decision.checks.get("attached_male_anatomy") is True

        def anatomy_vote(item: Local2ImageEvidence) -> bool:
            return bool(
                item.anatomy_clear
                and item.attached_anatomy >= self.policy.thresholds.anatomy_reject
                and item.attached_anatomy >=
                    item.toy_or_prosthetic + self.policy.thresholds.anatomy_margin
            )

        result.update({
            "model": "shared SigLIP grouped hard triage" if hard_only else
                "shared SigLIP grouped semantics + facebook/dinov2-small weighted-ridge taste head",
            "local2_schema": ENGINE_SCHEMA,
            "feature_schema": analysis.feature_schema,
            "preference_probability": None if hard_only else taste_probability,
            "preference_threshold": self.policy.thresholds.preference_accept,
            "image_grades": [
                {
                    "image_index": item.image_index,
                    "decision": "unsure",
                    "checks": {
                        "body_evidence_clear": item.body_clear,
                        "body_preference_match": item.body_preferred >= self.policy.thresholds.body_preferred_vote,
                        # A single SigLIP vote is ambiguity evidence, not a veto.
                        # Otherwise Node's legacy per-image anatomy scan would
                        # undo the clean policy's independent-view consensus.
                        "attached_male_anatomy": (
                            True if aggregate_anatomy_conflict and anatomy_vote(item)
                            else None if anatomy_vote(item)
                            else False
                        ),
                        "toy_or_dildo": item.toy_or_prosthetic >= self.policy.thresholds.anatomy_reject,
                        "anatomy_ambiguous": anatomy_vote(item) and not aggregate_anatomy_conflict,
                        "feet_dominant": item.feet_dominant >= self.policy.thresholds.feet_vote,
                    },
                    "scores": {
                        "photo": item.photo,
                        "female_presentation": item.female_presentation,
                        "male_presentation": item.male_presentation,
                        "body_mismatch": item.body_mismatch,
                        "body_preferred": item.body_preferred,
                        "attached_anatomy": item.attached_anatomy,
                        "toy_or_prosthetic": item.toy_or_prosthetic,
                        "feet_dominant": item.feet_dominant,
                        "over_60": item.over_60,
                        "adult_probability": item.adult_probability,
                        "adult_safety_risk": item.adult_safety_risk,
                        "adult_safety_unclear": item.adult_safety_unclear,
                    },
                }
                for item in analysis.descriptors
            ],
            "training": {
                "head_available": head is not None,
                "hard_only": hard_only,
            },
        })
        return result

    def classify(self, images: Sequence[Any]) -> dict[str, Any]:
        return self.classify_analysis(self.analyze(images))

    def learn_numeric(
        self,
        *,
        artist_identity: str,
        label: str,
        reason_code: str,
        analysis: Local2AnalysisBundle,
    ) -> dict[str, Any]:
        if self.numeric_store is None:
            raise RuntimeError("Local2 numeric learning store is not configured")
        artist_key = self.numeric_store.upsert(
            artist_identity=artist_identity,
            label=label,
            reason_code=reason_code,
            feature_schema=analysis.feature_schema,
            descriptors=analysis.descriptors,
            views=analysis.numeric_views,
        )
        with self._head_lock:
            self._head_token = ""
            self._head = None
        return {
            "ok": True,
            "saved": True,
            "numeric_only": True,
            "artist_key": artist_key,
            "label": str(label).lower(),
            "images": len(analysis.descriptors),
            "vectors": len(analysis.numeric_views),
            "feature_schema": analysis.feature_schema,
            "model_revision": self.numeric_store.revision_token,
        }


__all__ = [
    "DEFAULT_FEATURE_SCHEMA",
    "Local2AnalysisBundle",
    "Local2VisionAdapter",
    "MAX_LOCAL2_IMAGES",
    "RuntimeSiglipGroupedScorer",
]
