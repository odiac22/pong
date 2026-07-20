"""Clean-slate, model-agnostic Local2 decision and numeric-learning engine.

This module deliberately has no image, video, audio, HTTP, model-loading, or
filesystem-media dependencies.  A vision adapter supplies numeric descriptors
and embeddings.  The optional SQLite store persists only those numbers, labels,
and a one-way artist-identity hash.

Local1 must not import this module.  Local2 can change feature extractors without
changing the hard-filter policy as long as the adapter emits this module's
grouped descriptor contract.
"""

from __future__ import annotations

import hashlib
import json
import math
import secrets
import sqlite3
import threading
import time
from dataclasses import asdict, dataclass, fields
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import numpy as np


ENGINE_SCHEMA = "pong-local2-clean-v2"

# Keep overlapping concepts out of a single softmax.  A Local2 vision adapter
# should score/normalize each group independently.  "Transgender" is purposely
# absent: identity cannot be inferred reliably from an image.  The observable
# hard checks are male-presenting content and visibly attached anatomy.
SEMANTIC_PROMPT_GROUPS: dict[str, tuple[str, ...]] = {
    "media_type": (
        "a usable photograph containing a clearly visible adult person",
        "anime, illustration, logo, advertisement, placeholder, or synthetic graphic",
        "blank, tiny, heavily obscured, or unusable visual evidence",
    ),
    "presentation": (
        "a clearly female-presenting adult person",
        "a clearly male-presenting adult person",
        "mixed, hidden, or unclear presentation",
    ),
    "content_focus": (
        "the visible adult person's face or body is the main subject",
        "feet or a foot are the main subject",
        "the main subject is unclear",
    ),
    "body_shape": (
        "a clear slim, fit, athletic, or proportionate adult torso",
        "a clear adult torso with a pronounced large midsection, abdominal folds, or apron-like overhang",
        "the torso or midsection is hidden, cropped, distorted, or unclear",
    ),
    "anatomy": (
        "penis or testicles visibly attached to the photographed adult person's body",
        "a dildo, sex toy, strap-on, prosthetic, or artificial object",
        "no penis, testicles, or explicit intimate object is visible",
        "the relevant anatomy or object is hidden or unclear",
    ),
    "age_limit": (
        "a clearly visible adult who appears younger than 60",
        "a clearly visible adult who appears age 60 or older",
        "the visible adult's age cannot be judged",
    ),
    # Mandatory content-safety evidence is deliberately separate from the
    # user's 60+ preference boundary. It is not a taste label and cannot be
    # disabled by Local2 training.
    "adult_safety": (
        "a clearly visible adult person age 18 or older",
        "the visible person may be under age 18 or may be a minor",
        "whether the visible person is an adult cannot be judged",
    ),
}

GROUP_LABELS: dict[str, tuple[str, ...]] = {
    "media_type": ("person_photo", "nonphoto", "unusable"),
    "presentation": ("female", "male", "unclear"),
    "content_focus": ("person", "feet", "unclear"),
    "body_shape": ("preferred", "mismatch", "unclear"),
    "anatomy": ("attached", "toy", "none", "unclear"),
    "age_limit": ("under_60", "over_60", "unclear"),
    "adult_safety": ("adult", "minor_risk", "unclear"),
}


def _probability(value: float, name: str) -> float:
    result = float(value)
    if not math.isfinite(result) or result < 0.0 or result > 1.0:
        raise ValueError(f"{name} must be a finite probability in [0, 1]")
    return result


def _normalized_group(
    groups: Mapping[str, Mapping[str, float]], group_name: str
) -> dict[str, float]:
    labels = GROUP_LABELS[group_name]
    raw = groups.get(group_name)
    if not isinstance(raw, Mapping):
        raise ValueError(f"missing Local2 semantic group: {group_name}")
    values = np.asarray(
        [_probability(raw.get(label, 0.0), f"{group_name}.{label}") for label in labels],
        dtype=np.float64,
    )
    total = float(values.sum())
    if total <= 1e-12:
        raise ValueError(f"Local2 semantic group {group_name} has no evidence")
    values /= total
    return {label: float(value) for label, value in zip(labels, values)}


@dataclass(frozen=True, slots=True)
class Local2ImageEvidence:
    """Numeric evidence for one independently deduplicated source image."""

    image_index: int
    photo: float
    person: float
    female_presentation: float
    male_presentation: float
    feet_dominant: float
    nonphoto: float
    body_mismatch: float
    body_preferred: float
    attached_anatomy: float
    toy_or_prosthetic: float
    over_60: float
    adult_probability: float
    adult_safety_risk: float
    adult_safety_unclear: float
    body_clear: bool
    anatomy_clear: bool
    face_clear: bool

    def __post_init__(self) -> None:
        if int(self.image_index) < 1:
            raise ValueError("image_index must be positive")
        for field in fields(self):
            if field.name in {"image_index", "body_clear", "anatomy_clear", "face_clear"}:
                continue
            _probability(getattr(self, field.name), field.name)

    @classmethod
    def from_grouped_scores(
        cls,
        image_index: int,
        groups: Mapping[str, Mapping[str, float]],
        *,
        body_visible: bool,
        face_visible: bool,
        lower_torso_visible: bool,
    ) -> "Local2ImageEvidence":
        """Build the stable policy descriptor from independently scored groups."""

        media = _normalized_group(groups, "media_type")
        presentation = _normalized_group(groups, "presentation")
        focus = _normalized_group(groups, "content_focus")
        body = _normalized_group(groups, "body_shape")
        anatomy = _normalized_group(groups, "anatomy")
        age = _normalized_group(groups, "age_limit")
        adult_safety = _normalized_group(groups, "adult_safety")
        return cls(
            image_index=int(image_index),
            photo=media["person_photo"],
            person=focus["person"],
            female_presentation=presentation["female"],
            male_presentation=presentation["male"],
            feet_dominant=focus["feet"],
            nonphoto=max(media["nonphoto"], media["unusable"]),
            body_mismatch=body["mismatch"],
            body_preferred=body["preferred"],
            attached_anatomy=anatomy["attached"],
            toy_or_prosthetic=anatomy["toy"],
            over_60=age["over_60"],
            adult_probability=adult_safety["adult"],
            adult_safety_risk=adult_safety["minor_risk"],
            adult_safety_unclear=adult_safety["unclear"],
            body_clear=bool(body_visible and body["unclear"] < 0.45),
            anatomy_clear=bool(lower_torso_visible and anatomy["unclear"] < 0.48),
            face_clear=bool(face_visible and age["unclear"] < 0.48),
        )


@dataclass(frozen=True, slots=True)
class Local2Thresholds:
    """Independent Local2 policy thresholds; none are shared with Local1."""

    usable_photo: float = 0.52
    usable_person: float = 0.42
    female_vote: float = 0.62
    female_margin: float = 0.08
    male_vote: float = 0.76
    male_strong: float = 0.96
    male_margin: float = 0.12
    male_review: float = 0.52
    anatomy_reject: float = 0.86
    anatomy_margin: float = 0.20
    anatomy_review: float = 0.42
    feet_vote: float = 0.72
    feet_review: float = 0.48
    body_mismatch_vote: float = 0.66
    body_mismatch_review: float = 0.48
    body_preferred_vote: float = 0.58
    over_60_vote: float = 0.74
    over_60_strong: float = 0.97
    over_60_review: float = 0.50
    adult_safety_vote: float = 0.82
    adult_safety_strong: float = 0.97
    adult_safety_review: float = 0.45
    adult_evidence_vote: float = 0.62
    adult_evidence_strong: float = 0.90
    adult_evidence_margin: float = 0.10
    hard_consensus: int = 2
    required_usable_images: int = 2
    required_clear_body_images: int = 2
    preference_accept: float = 0.72


@dataclass(frozen=True, slots=True)
class Local2Decision:
    decision: str
    confidence: float
    reason_code: str
    reason: str
    checks: dict[str, bool | None]
    evidence_counts: dict[str, int]
    review_codes: tuple[str, ...] = ()

    @property
    def requires_second_stage(self) -> bool:
        return self.decision == "review"

    def as_dict(self) -> dict[str, Any]:
        return {
            "decision": self.decision,
            "confidence": self.confidence,
            "reason_code": self.reason_code,
            "reason": self.reason,
            "source": ENGINE_SCHEMA,
            "vision_source": ENGINE_SCHEMA,
            "variant": "local2",
            "hard_verified": self.decision == "accept",
            "requires_second_stage": self.requires_second_stage,
            "requires_qwen_review": self.requires_second_stage,
            "review_codes": list(self.review_codes),
            "checks": dict(self.checks),
            "evidence": dict(self.evidence_counts),
        }


class Local2Policy:
    """Fail-closed hard-filter fusion followed by personalized taste."""

    def __init__(self, thresholds: Local2Thresholds | None = None) -> None:
        self.thresholds = thresholds or Local2Thresholds()

    @staticmethod
    def _unique(images: Sequence[Local2ImageEvidence]) -> list[Local2ImageEvidence]:
        indices = [int(image.image_index) for image in images]
        if len(indices) != len(set(indices)):
            raise ValueError("Local2 evidence images must be independently deduplicated")
        return list(images)

    def decide(
        self,
        images: Sequence[Local2ImageEvidence],
        *,
        taste_probability: float | None,
    ) -> Local2Decision:
        t = self.thresholds
        rows = self._unique(images)
        if taste_probability is not None:
            taste_probability = _probability(taste_probability, "taste_probability")

        usable = [
            row for row in rows
            if row.photo >= t.usable_photo and row.person >= t.usable_person
        ]
        clear_body = [row for row in usable if row.body_clear]
        clear_anatomy = [row for row in rows if row.anatomy_clear]
        clear_faces = [row for row in usable if row.face_clear]

        attached = [
            row for row in clear_anatomy
            if row.attached_anatomy >= t.anatomy_reject
            and row.attached_anatomy >= row.toy_or_prosthetic + t.anatomy_margin
        ]
        anatomy_uncertain = [
            row for row in clear_anatomy
            if row.attached_anatomy >= t.anatomy_review
            and row not in attached
        ]
        male_votes = [
            row for row in usable
            if row.male_presentation >= t.male_vote
            and row.male_presentation >= row.female_presentation + t.male_margin
        ]
        strong_male = [row for row in male_votes if row.male_presentation >= t.male_strong]
        male_uncertain = [
            row for row in usable
            if row.male_presentation >= t.male_review
            and row.male_presentation >= row.female_presentation
            and row not in male_votes
        ]
        female_votes = [
            row for row in usable
            if row.female_presentation >= t.female_vote
            and row.female_presentation >= row.male_presentation + t.female_margin
        ]
        feet_votes = [row for row in rows if row.photo >= t.usable_photo and row.feet_dominant >= t.feet_vote]
        feet_uncertain = [
            row for row in rows
            if row.photo >= t.usable_photo
            and row.feet_dominant >= t.feet_review
            and row not in feet_votes
        ]
        body_mismatch = [row for row in clear_body if row.body_mismatch >= t.body_mismatch_vote]
        body_uncertain = [
            row for row in clear_body
            if row.body_mismatch >= t.body_mismatch_review
            and row not in body_mismatch
        ]
        body_preferred = [row for row in clear_body if row.body_preferred >= t.body_preferred_vote]
        over_60 = [row for row in clear_faces if row.over_60 >= t.over_60_vote]
        strong_over_60 = [row for row in over_60 if row.over_60 >= t.over_60_strong]
        age_uncertain = [
            row for row in clear_faces
            if row.over_60 >= t.over_60_review
            and row not in over_60
        ]
        adult_safety_votes = [
            row for row in usable if row.adult_safety_risk >= t.adult_safety_vote
        ]
        strong_adult_safety_risk = [
            row for row in adult_safety_votes
            if row.adult_safety_risk >= t.adult_safety_strong
        ]
        adult_evidence_votes = [
            row for row in usable
            if row.adult_probability >= t.adult_evidence_vote
            and row.adult_probability >= row.adult_safety_risk + t.adult_evidence_margin
            and row.adult_probability >= row.adult_safety_unclear + t.adult_evidence_margin
        ]
        strong_adult_evidence = [
            row for row in adult_evidence_votes
            if row.adult_probability >= t.adult_evidence_strong
        ]
        adult_safety_uncertain = [
            row for row in usable
            if row not in adult_safety_votes
            and row not in adult_evidence_votes
            and (
                row.adult_safety_risk >= t.adult_safety_review
                or row.adult_safety_unclear >= t.adult_safety_review
            )
        ]
        adult_safety_established = bool(
            strong_adult_evidence or len(adult_evidence_votes) >= t.hard_consensus
        )

        counts = {
            "images": len(rows),
            "usable_images": len(usable),
            "clear_body_images": len(clear_body),
            "clear_anatomy_images": len(clear_anatomy),
            "clear_face_images": len(clear_faces),
            "female_votes": len(female_votes),
            "male_votes": len(male_votes),
            "attached_anatomy_votes": len(attached),
            "feet_votes": len(feet_votes),
            "body_mismatch_votes": len(body_mismatch),
            "body_preferred_votes": len(body_preferred),
            "over_60_votes": len(over_60),
            "adult_safety_votes": len(adult_safety_votes),
            "adult_evidence_votes": len(adult_evidence_votes),
        }
        checks: dict[str, bool | None] = {
            "photograph": bool(usable),
            "female_presenting_adult": bool(female_votes),
            "male_present": bool(strong_male or len(male_votes) >= t.hard_consensus),
            "male_only": bool(strong_male or len(male_votes) >= t.hard_consensus),
            "attached_male_anatomy": bool(attached),
            "toy_or_dildo": any(row.toy_or_prosthetic >= t.anatomy_reject for row in clear_anatomy),
            "feet_dominant": len(feet_votes) >= t.hard_consensus,
            "logo_or_placeholder": not bool(usable),
            "appears_over_60": bool(strong_over_60 or len(over_60) >= t.hard_consensus),
            "underage_looking": bool(
                strong_adult_safety_risk or len(adult_safety_votes) >= t.hard_consensus
            ),
            "adult_safety_established": adult_safety_established,
            "body_preference_conflict": len(body_mismatch) >= t.hard_consensus,
            "body_evidence_ambiguous": len(clear_body) < t.required_clear_body_images,
        }

        def result(
            decision: str,
            confidence: float,
            code: str,
            reason: str,
            review_codes: Iterable[str] = (),
        ) -> Local2Decision:
            return Local2Decision(
                decision=decision,
                confidence=float(max(0.0, min(0.999, confidence))),
                reason_code=code,
                reason=reason,
                checks=checks,
                evidence_counts=counts,
                review_codes=tuple(dict.fromkeys(review_codes)),
            )

        # A single unambiguous attached-anatomy view is direct evidence.  A toy
        # never satisfies this gate because the attached score must beat it by a
        # substantial margin.
        if attached:
            return result(
                "reject", max(row.attached_anatomy for row in attached),
                "visible_attached_anatomy", "visible attached anatomy conflicts with the hard filter",
            )
        if strong_male or len(male_votes) >= t.hard_consensus:
            strength = max(row.male_presentation for row in strong_male or male_votes)
            return result("reject", strength, "male_presenting_content", "male-presenting person visible")
        if len(feet_votes) >= t.hard_consensus:
            return result(
                "reject", float(np.mean([row.feet_dominant for row in feet_votes])),
                "feet_dominant", "feet are the dominant subject in multiple images",
            )
        # Body-shape rejection is never permitted from one crop, regardless of
        # confidence.  Two independently deduplicated clear views must agree.
        if len(body_mismatch) >= t.hard_consensus:
            return result(
                "reject", float(np.mean([row.body_mismatch for row in body_mismatch[: t.hard_consensus]])),
                "body_shape_mismatch", "two clear body views agree on a body-shape mismatch",
            )
        if strong_adult_safety_risk or len(adult_safety_votes) >= t.hard_consensus:
            strength = max(
                row.adult_safety_risk
                for row in strong_adult_safety_risk or adult_safety_votes
            )
            return result(
                "reject", strength, "adult_safety_risk",
                "adult age could not be safely established",
            )
        if strong_over_60 or len(over_60) >= t.hard_consensus:
            strength = max(row.over_60 for row in strong_over_60 or over_60)
            return result("reject", strength, "appears_over_60", "visible adult clearly appears age 60 or older")
        if len(usable) < t.required_usable_images:
            return result("reject", 0.92, "insufficient_usable_evidence", "too few usable person photographs")

        review_codes: list[str] = []
        if anatomy_uncertain:
            review_codes.append("anatomy")
        if male_uncertain or (not female_votes and usable):
            review_codes.append("presentation")
        if len(feet_votes) == 1 or feet_uncertain:
            review_codes.append("feet")
        if len(body_mismatch) == 1 or body_uncertain:
            review_codes.append("body-shape")
        if strong_over_60 or len(over_60) == 1 or age_uncertain:
            review_codes.append("age-60")
        if (
            len(adult_safety_votes) == 1
            or adult_safety_uncertain
            or not adult_safety_established
        ):
            review_codes.append("adult-safety")
        if len(clear_body) < t.required_clear_body_images or not body_preferred:
            review_codes.append("body-evidence")
        if review_codes:
            return result(
                "review", 0.50, "ambiguous_hard_evidence",
                "hard-filter evidence needs a second-stage review", review_codes,
            )
        if taste_probability is None:
            return result(
                "review", 0.50, "missing_personalization",
                "no calibrated Local2 preference score is available", ("preference",),
            )
        if taste_probability < t.preference_accept:
            return result(
                "reject", 1.0 - taste_probability,
                "personal_preference_mismatch", "personalized preference score is below threshold",
            )
        return result(
            "accept", taste_probability,
            "accepted", "all Local2 hard filters and personalized preference checks passed",
        )


def _unit_rows(matrix: np.ndarray) -> np.ndarray:
    values = np.asarray(matrix, dtype=np.float64)
    if values.ndim != 2:
        raise ValueError("feature matrix must be two-dimensional")
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    return values / np.maximum(norms, 1e-12)


@dataclass(frozen=True, slots=True)
class BalancedLinearHead:
    """Small numeric head for taste or corroborating specialist evidence.

    Hard filters must not use this head as their only evidence.  It is intended
    for personalized taste and for prioritizing an uncertain specialist review.
    """

    weights: np.ndarray
    bias: float
    center: np.ndarray

    @classmethod
    def fit(
        cls,
        features: Sequence[Sequence[float]] | np.ndarray,
        labels: Sequence[int],
        *,
        l2: float = 0.20,
        learning_rate: float = 0.16,
        iterations: int = 220,
    ) -> "BalancedLinearHead":
        matrix = _unit_rows(np.asarray(features, dtype=np.float64))
        targets = np.asarray(labels, dtype=np.float64).reshape(-1)
        if len(matrix) != len(targets) or len(targets) < 4:
            raise ValueError("at least four aligned feature rows are required")
        if not set(np.unique(targets)).issubset({0.0, 1.0}) or len(np.unique(targets)) != 2:
            raise ValueError("labels must contain both binary classes")
        center = np.mean(matrix, axis=0)
        matrix = matrix - center
        positives = max(1, int(np.sum(targets)))
        negatives = max(1, len(targets) - positives)
        sample_weights = np.where(
            targets > 0.5,
            len(targets) / (2.0 * positives),
            len(targets) / (2.0 * negatives),
        )
        weights = np.zeros(matrix.shape[1], dtype=np.float64)
        bias = 0.0
        for step in range(max(1, int(iterations))):
            logits = np.clip(matrix @ weights + bias, -24.0, 24.0)
            predicted = 1.0 / (1.0 + np.exp(-logits))
            error = (predicted - targets) * sample_weights
            rate = learning_rate / math.sqrt(1.0 + step / 55.0)
            weights -= rate * ((matrix.T @ error) / len(targets) + l2 * weights)
            bias -= rate * float(np.mean(error))
        return cls(weights=weights.astype(np.float32), bias=float(bias), center=center.astype(np.float32))

    def predict_many(self, features: Sequence[Sequence[float]] | np.ndarray) -> np.ndarray:
        matrix = _unit_rows(np.asarray(features, dtype=np.float64))
        if matrix.shape[1] != len(self.weights):
            raise ValueError("feature dimension does not match the trained Local2 head")
        logits = np.clip((matrix - self.center) @ self.weights + self.bias, -24.0, 24.0)
        return (1.0 / (1.0 + np.exp(-logits))).astype(np.float64)

    def predict_probability(self, feature: Sequence[float] | np.ndarray) -> float:
        return float(self.predict_many(np.asarray(feature, dtype=np.float64).reshape(1, -1))[0])

    def numeric_state(self) -> dict[str, Any]:
        return {
            "schema": ENGINE_SCHEMA,
            "weights": self.weights.astype(np.float32).tolist(),
            "bias": self.bias,
            "center": self.center.astype(np.float32).tolist(),
        }


@dataclass(frozen=True, slots=True)
class RidgeLinearHead:
    """Fast weighted ridge head selected by the offline artist-group benchmark.

    The raw ridge margin is mapped through the same fixed sigmoid scale used by
    the benchmark. Hard filters never depend on this learned taste head.
    """

    coefficients: np.ndarray
    margin_scale: float = 2.5

    @classmethod
    def fit(
        cls,
        features: Sequence[Sequence[float]] | np.ndarray,
        labels: Sequence[int],
        *,
        regularization: float = 0.35,
        margin_scale: float = 2.5,
    ) -> "RidgeLinearHead":
        matrix = _unit_rows(np.asarray(features, dtype=np.float64))
        targets = np.asarray(labels, dtype=np.float64).reshape(-1)
        if len(matrix) != len(targets) or len(targets) < 4:
            raise ValueError("at least four aligned feature rows are required")
        if not set(np.unique(targets)).issubset({0.0, 1.0}) or len(np.unique(targets)) != 2:
            raise ValueError("labels must contain both binary classes")
        positives = max(1, int(np.sum(targets)))
        negatives = max(1, len(targets) - positives)
        sample_weights = np.where(
            targets > 0.5,
            len(targets) / (2.0 * positives),
            len(targets) / (2.0 * negatives),
        )
        augmented = np.column_stack([matrix, np.ones(len(matrix), dtype=np.float64)])
        root_weights = np.sqrt(sample_weights)
        weighted = augmented * root_weights[:, None]
        weighted_targets = (targets * 2.0 - 1.0) * root_weights
        gram = weighted @ weighted.T
        system = gram + np.eye(len(gram), dtype=np.float64) * float(regularization)
        try:
            dual = np.linalg.solve(system, weighted_targets)
        except np.linalg.LinAlgError:
            dual = np.linalg.lstsq(system, weighted_targets, rcond=None)[0]
        coefficients = weighted.T @ dual
        return cls(
            coefficients=np.asarray(coefficients, dtype=np.float32),
            margin_scale=float(margin_scale),
        )

    def predict_many(self, features: Sequence[Sequence[float]] | np.ndarray) -> np.ndarray:
        matrix = _unit_rows(np.asarray(features, dtype=np.float64))
        if matrix.shape[1] + 1 != len(self.coefficients):
            raise ValueError("feature dimension does not match the trained Local2 ridge head")
        augmented = np.column_stack([matrix, np.ones(len(matrix), dtype=np.float64)])
        margins = np.clip(augmented @ self.coefficients * self.margin_scale, -24.0, 24.0)
        return (1.0 / (1.0 + np.exp(-margins))).astype(np.float64)

    def predict_probability(self, feature: Sequence[float] | np.ndarray) -> float:
        return float(self.predict_many(np.asarray(feature, dtype=np.float64).reshape(1, -1))[0])

    def numeric_state(self) -> dict[str, Any]:
        return {
            "schema": ENGINE_SCHEMA,
            "head": "weighted-ridge-v1",
            "coefficients": self.coefficients.astype(np.float32).tolist(),
            "margin_scale": self.margin_scale,
        }


@dataclass(frozen=True, slots=True)
class Local2NumericView:
    image_index: int
    view_kind: str
    vector: np.ndarray

    def __post_init__(self) -> None:
        if int(self.image_index) < 1:
            raise ValueError("image_index must be positive")
        if self.view_kind not in {"full", "body", "face", "lower_torso", "person_mask"}:
            raise ValueError("unsupported Local2 numeric view kind")
        vector = np.asarray(self.vector, dtype=np.float32).reshape(-1)
        if not len(vector) or not np.all(np.isfinite(vector)):
            raise ValueError("numeric view vector must be finite and non-empty")
        object.__setattr__(self, "vector", vector)


@dataclass(frozen=True, slots=True)
class Local2StoredExample:
    artist_key: str
    label: str
    reason_code: str
    feature_schema: str
    descriptors: tuple[Local2ImageEvidence, ...]
    views: tuple[Local2NumericView, ...]


def stable_artist_key(artist_identity: str) -> str:
    value = str(artist_identity or "").strip().lower()
    if not value:
        raise ValueError("artist identity is required")
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class Local2NumericStore:
    """Independent Local2 SQLite store containing no media or source URLs."""

    def __init__(self, path: str | Path = ":memory:", *, max_records: int = 3000) -> None:
        self.max_records = max(4, int(max_records))
        self.lock = threading.RLock()
        self.connection = sqlite3.connect(str(path), check_same_thread=False)
        self.connection.execute("PRAGMA foreign_keys=ON")
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS local2_examples (
                artist_key TEXT PRIMARY KEY,
                updated_at REAL NOT NULL,
                label TEXT NOT NULL CHECK(label IN ('accept', 'reject')),
                reason_code TEXT NOT NULL,
                feature_schema TEXT NOT NULL,
                descriptor_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS local2_vectors (
                artist_key TEXT NOT NULL REFERENCES local2_examples(artist_key) ON DELETE CASCADE,
                image_index INTEGER NOT NULL,
                view_kind TEXT NOT NULL,
                dimension INTEGER NOT NULL,
                vector_f32 BLOB NOT NULL,
                PRIMARY KEY (artist_key, image_index, view_kind)
            );
            CREATE TABLE IF NOT EXISTS local2_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        with self.connection:
            store_row = self.connection.execute(
                "SELECT value FROM local2_metadata WHERE key = 'store_id'"
            ).fetchone()
            self.store_id = str(store_row[0]) if store_row else secrets.token_hex(8)
            if not store_row:
                self.connection.execute(
                    "INSERT INTO local2_metadata (key, value) VALUES ('store_id', ?)",
                    (self.store_id,),
                )
            generation_row = self.connection.execute(
                "SELECT value FROM local2_metadata WHERE key = 'generation'"
            ).fetchone()
            self.revision = int(generation_row[0]) if generation_row else 0
            if not generation_row:
                self.connection.execute(
                    "INSERT INTO local2_metadata (key, value) VALUES ('generation', '0')"
                )

    @property
    def revision_token(self) -> str:
        with self.lock:
            return f"{ENGINE_SCHEMA}:{self.store_id}:{self.revision}"

    def close(self) -> None:
        with self.lock:
            self.connection.close()

    def record_count(self) -> int:
        with self.lock:
            return int(self.connection.execute("SELECT COUNT(*) FROM local2_examples").fetchone()[0])

    def upsert(
        self,
        *,
        artist_identity: str,
        label: str,
        reason_code: str,
        feature_schema: str,
        descriptors: Sequence[Local2ImageEvidence],
        views: Sequence[Local2NumericView],
    ) -> str:
        normalized_label = str(label).strip().lower()
        if normalized_label not in {"accept", "reject"}:
            raise ValueError("label must be accept or reject")
        if not feature_schema:
            raise ValueError("feature_schema is required")
        artist_key = stable_artist_key(artist_identity)
        descriptor_json = json.dumps(
            [asdict(item) for item in descriptors], separators=(",", ":"), sort_keys=True
        )
        now = time.time()
        with self.lock:
            next_revision = self.revision + 1
            with self.connection:
                self.connection.execute(
                    "INSERT OR REPLACE INTO local2_examples "
                    "(artist_key, updated_at, label, reason_code, feature_schema, descriptor_json) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (artist_key, now, normalized_label, str(reason_code)[:80], str(feature_schema), descriptor_json),
                )
                self.connection.execute("DELETE FROM local2_vectors WHERE artist_key = ?", (artist_key,))
                self.connection.executemany(
                    "INSERT INTO local2_vectors "
                    "(artist_key, image_index, view_kind, dimension, vector_f32) VALUES (?, ?, ?, ?, ?)",
                    [
                        (
                            artist_key,
                            int(view.image_index),
                            view.view_kind,
                            int(len(view.vector)),
                            sqlite3.Binary(np.asarray(view.vector, dtype="<f4").tobytes()),
                        )
                        for view in views
                    ],
                )
                stale = self.connection.execute(
                    "SELECT artist_key FROM local2_examples ORDER BY updated_at DESC LIMIT -1 OFFSET ?",
                    (self.max_records,),
                ).fetchall()
                if stale:
                    self.connection.executemany(
                        "DELETE FROM local2_examples WHERE artist_key = ?", stale
                    )
                self.connection.execute(
                    "INSERT OR REPLACE INTO local2_metadata (key, value) VALUES ('generation', ?)",
                    (str(next_revision),),
                )
            self.revision = next_revision
        return artist_key

    def load(self, *, feature_schema: str | None = None) -> list[Local2StoredExample]:
        with self.lock:
            if feature_schema is None:
                rows = self.connection.execute(
                    "SELECT artist_key, label, reason_code, feature_schema, descriptor_json "
                    "FROM local2_examples ORDER BY updated_at DESC"
                ).fetchall()
            else:
                rows = self.connection.execute(
                    "SELECT artist_key, label, reason_code, feature_schema, descriptor_json "
                    "FROM local2_examples WHERE feature_schema = ? ORDER BY updated_at DESC",
                    (feature_schema,),
                ).fetchall()
            result: list[Local2StoredExample] = []
            for artist_key, label, reason_code, schema, raw_descriptors in rows:
                descriptors = tuple(
                    Local2ImageEvidence(**item) for item in json.loads(raw_descriptors)
                )
                vector_rows = self.connection.execute(
                    "SELECT image_index, view_kind, dimension, vector_f32 "
                    "FROM local2_vectors WHERE artist_key = ? ORDER BY image_index, view_kind",
                    (artist_key,),
                ).fetchall()
                views: list[Local2NumericView] = []
                for image_index, view_kind, dimension, raw_vector in vector_rows:
                    vector = np.frombuffer(raw_vector, dtype="<f4").copy()
                    if len(vector) != int(dimension):
                        raise ValueError("corrupt Local2 numeric vector dimension")
                    views.append(Local2NumericView(int(image_index), str(view_kind), vector))
                result.append(
                    Local2StoredExample(
                        artist_key=str(artist_key),
                        label=str(label),
                        reason_code=str(reason_code),
                        feature_schema=str(schema),
                        descriptors=descriptors,
                        views=tuple(views),
                    )
                )
        return result


__all__ = [
    "BalancedLinearHead",
    "ENGINE_SCHEMA",
    "GROUP_LABELS",
    "Local2Decision",
    "Local2ImageEvidence",
    "Local2NumericStore",
    "Local2NumericView",
    "Local2Policy",
    "Local2StoredExample",
    "Local2Thresholds",
    "RidgeLinearHead",
    "SEMANTIC_PROMPT_GROUPS",
    "stable_artist_key",
]
