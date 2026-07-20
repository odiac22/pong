#!/usr/bin/env python3
"""Offline, media-safe benchmark for Pong's stored Local2 embeddings.

Safety contract
---------------
* Opens the preference SQLite database read-only.
* Reads only labels/reasons and already-stored numeric Local2 vectors.
* Never opens, decodes, fetches, saves, or inspects an image.
* Never requests, plays, probes, or validates a video.
* Uses only ``*.invalid`` URLs and generated HTML for scraper-gate fixtures.
* Does not import the production preference service or start/stop any service.

The benchmark has two deliberately separate parts:

1. A deterministic synthetic fixture checks text-hard-filter-first behavior and
   distinct-media counting without network or media I/O.
2. Artist-grouped cross-validation compares small CPU classifier families on
   stored Local2 aggregate and body vectors.  The hard-filter-first pipeline
   metrics use explicit stored hard-reject reasons as an *accounting upper
   bound*; they do not claim that embeddings rediscovered those reasons.

Run with the preference-service virtual environment, which already has NumPy:

    .\.pong-local-ai\lora-venv\Scripts\python.exe scripts\benchmark-local2-offline.py
"""

from __future__ import annotations

import argparse
import hashlib
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import random
import re
import sqlite3
import sys
from dataclasses import dataclass
from typing import Callable, Sequence

try:
    import numpy as np
except ModuleNotFoundError as error:  # pragma: no cover - environment guidance
    raise SystemExit(
        "NumPy is required. Run this script with "
        ".pong-local-ai\\lora-venv\\Scripts\\python.exe"
    ) from error


MIN_DISTINCT_MEDIA = 15
DEFAULT_SEED = 20260719
PRODUCTION_RIDGE_THRESHOLD = 0.72
HARD_REASON_RE = re.compile(
    r"\b(?:male|trans|feet|foot|logo|anime|illustration|placeholder|spam|"
    r"attached\s+anatomy|anatomy\s+conflict|adult[_ -]?safety|minor|underage|"
    r"over\s*(?:50|60)|too\s+old|non[- ]?photo)\b",
    re.I,
)
BODY_REASON_RE = re.compile(r"\b(?:fat|body)\b", re.I)
MOCK_TEXT_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("blocked_male", re.compile(r"\b(?:male[ -]only|solo male|male creator|men only)\b", re.I)),
    (
        "blocked_trans",
        re.compile(r"\b(?:transgender|transsexual|trans creator|mtf creator)\b", re.I),
    ),
    (
        "blocked_feet",
        re.compile(r"\b(?:feet[ -]only|feet dominant|foot fetish profile)\b", re.I),
    ),
    (
        "blocked_anime",
        re.compile(r"\b(?:anime[ -]only|illustration[ -]only|anime profile)\b", re.I),
    ),
)


@dataclass(frozen=True)
class ArtistRecord:
    """Only the non-media fields permitted in this offline benchmark."""

    group: str
    accepted: bool
    reason: str
    aggregate: np.ndarray
    body: np.ndarray | None


@dataclass(frozen=True)
class BinaryCase:
    group: str
    target: int
    reason: str
    vector: np.ndarray


@dataclass(frozen=True)
class FoldPrediction:
    group: str
    target: int
    reason: str
    score: float
    balanced_prediction: int
    precision_prediction: int
    fixed_prediction: int


class SyntheticProfileParser(HTMLParser):
    """Extract text and declared mock media URLs; it performs no I/O."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.text_parts: list[str] = []
        self.media_urls: list[str] = []

    def handle_starttag(self, _tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        media_url = values.get("data-media-url")
        if media_url:
            self.media_urls.append(media_url)

    def handle_data(self, data: str) -> None:
        if data.strip():
            self.text_parts.append(data.strip())


def mock_profile_html(description: str, media_count: int, *, unique_count: int | None = None) -> str:
    """Create generated HTML whose URLs can never resolve on the public Internet."""

    unique = media_count if unique_count is None else max(1, unique_count)
    links = [
        '<a data-media-url="https://media.mock.invalid/video-{0}.mp4">clip</a>'.format(index % unique)
        for index in range(media_count)
    ]
    return "<html><body><p>{}</p>{}</body></html>".format(
        html.escape(description), "".join(links)
    )


def synthetic_hard_gate(profile_html: str, artist_url: str) -> str:
    """Exercise a proposed cheap ordering: text rules, then distinct media count."""

    if not artist_url.endswith(".invalid/profile"):
        return "unsafe_mock_url"
    parser = SyntheticProfileParser()
    parser.feed(profile_html)
    searchable = " ".join(parser.text_parts)
    for reason, pattern in MOCK_TEXT_RULES:
        if pattern.search(searchable):
            return reason
    distinct_media = len(set(parser.media_urls))
    if distinct_media < MIN_DISTINCT_MEDIA:
        return "fewer_than_15_distinct_media"
    return "pass"


def run_synthetic_fixture() -> dict[str, object]:
    fixtures = (
        ("safe", "adult creator dance archive", 18, None, "pass"),
        ("exact_minimum", "adult creator", 15, None, "pass"),
        ("too_few", "adult creator", 14, None, "fewer_than_15_distinct_media"),
        ("duplicates", "adult creator", 20, 10, "fewer_than_15_distinct_media"),
        ("male", "solo male creator archive", 18, None, "blocked_male"),
        ("trans", "transgender creator archive", 18, None, "blocked_trans"),
        ("feet", "feet-only foot fetish profile", 18, None, "blocked_feet"),
        ("anime", "anime-only illustration archive", 18, None, "blocked_anime"),
        # Word-boundary/context regression: "trans" must not match transformation.
        ("context", "adult transformation artist", 18, None, "pass"),
    )
    results: list[dict[str, str]] = []
    for name, description, count, unique, expected in fixtures:
        actual = synthetic_hard_gate(
            mock_profile_html(description, count, unique_count=unique),
            "https://artist.mock.invalid/profile",
        )
        results.append({"name": name, "expected": expected, "actual": actual})
    passed = sum(item["expected"] == item["actual"] for item in results)
    return {"passed": passed, "total": len(results), "cases": results}


def unit(vector: np.ndarray) -> np.ndarray:
    value = np.asarray(vector, dtype=np.float64)
    norm = float(np.linalg.norm(value))
    return value / norm if norm > 1e-12 else np.zeros_like(value)


def unit_rows(matrix: np.ndarray) -> np.ndarray:
    values = np.asarray(matrix, dtype=np.float64)
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    return np.divide(values, norms, out=np.zeros_like(values), where=norms > 1e-12)


def sigmoid(value: np.ndarray | float) -> np.ndarray:
    values = np.clip(np.asarray(value, dtype=np.float64), -30.0, 30.0)
    return 1.0 / (1.0 + np.exp(-values))


def numeric_vector(value: object) -> np.ndarray | None:
    if not isinstance(value, list) or not value:
        return None
    try:
        vector = np.asarray(value, dtype=np.float64)
    except (TypeError, ValueError):
        return None
    if vector.ndim != 1 or not np.all(np.isfinite(vector)) or not np.any(vector):
        return None
    return vector


def mean_body_vector(value: object) -> np.ndarray | None:
    if not isinstance(value, list):
        return None
    vectors = [numeric_vector(item) for item in value]
    usable = [unit(item) for item in vectors if item is not None]
    if not usable:
        return None
    dimensions = {len(item) for item in usable}
    if len(dimensions) != 1:
        return None
    return unit(np.mean(np.stack(usable), axis=0))


def load_records(db_path: Path) -> tuple[list[ArtistRecord], dict[str, int]]:
    """Load only numeric fields and labels through a query-only SQLite handle."""

    resolved = db_path.resolve()
    if not resolved.is_file():
        raise FileNotFoundError(f"Preference database not found: {resolved}")
    connection = sqlite3.connect(f"file:{resolved.as_posix()}?mode=ro", uri=True)
    connection.execute("PRAGMA query_only=ON")
    try:
        rows = connection.execute(
            "SELECT record_json FROM preference_records ORDER BY updated_at DESC"
        ).fetchall()
    finally:
        connection.close()

    parsed: list[ArtistRecord] = []
    skipped = 0
    seen_groups: set[str] = set()
    dimensions: dict[int, int] = {}
    for row_index, (raw_record,) in enumerate(rows):
        try:
            record = json.loads(raw_record)
        except (TypeError, json.JSONDecodeError):
            skipped += 1
            continue
        aggregate = numeric_vector(((record.get("features") or {}).get("local2")))
        if aggregate is None:
            skipped += 1
            continue
        identity = str(record.get("artistUrl") or f"anonymous-row-{row_index}")
        # Stored URLs are used solely to prevent artist leakage, never printed or opened.
        group = hashlib.sha256(identity.encode("utf-8", "replace")).hexdigest()[:24]
        if group in seen_groups:
            skipped += 1
            continue
        seen_groups.add(group)
        dimensions[len(aggregate)] = dimensions.get(len(aggregate), 0) + 1
        reason = str(record.get("rejectReasonLabel") or record.get("rejectReason") or "").strip()
        body_values = (((record.get("viewFeatures") or {}).get("local2") or {}).get("bodyByImage"))
        parsed.append(
            ArtistRecord(
                group=group,
                accepted=record.get("label") == "accept",
                reason=reason,
                aggregate=aggregate,
                body=mean_body_vector(body_values),
            )
        )

    if not parsed:
        raise RuntimeError("No compatible Local2 numeric records were found")
    modal_dimension = max(dimensions, key=dimensions.get)
    compatible = [record for record in parsed if len(record.aggregate) == modal_dimension]
    skipped += len(parsed) - len(compatible)
    return compatible, {
        "database_rows": len(rows),
        "compatible_records": len(compatible),
        "skipped_records": skipped,
        "aggregate_dimension": modal_dimension,
    }


def grouped_stratified_folds(
    cases: Sequence[BinaryCase], fold_count: int, seed: int
) -> list[list[int]]:
    groups: dict[str, list[int]] = {}
    targets: dict[str, int] = {}
    for index, case in enumerate(cases):
        groups.setdefault(case.group, []).append(index)
        previous = targets.setdefault(case.group, case.target)
        if previous != case.target:
            raise ValueError("An artist group contains conflicting targets")

    by_target: dict[int, list[str]] = {0: [], 1: []}
    for group, target in targets.items():
        by_target[target].append(group)
    minority = min(len(by_target[0]), len(by_target[1]))
    actual_folds = min(fold_count, minority)
    if actual_folds < 2:
        raise RuntimeError("At least two artist groups per class are required")

    rng = random.Random(seed)
    fold_groups: list[list[str]] = [[] for _ in range(actual_folds)]
    for target in (0, 1):
        current = list(by_target[target])
        rng.shuffle(current)
        for index, group in enumerate(current):
            fold_groups[index % actual_folds].append(group)
    return [
        [index for group in groups_in_fold for index in groups[group]]
        for groups_in_fold in fold_groups
    ]


def class_weights(targets: np.ndarray) -> np.ndarray:
    positive = max(1, int(np.sum(targets == 1)))
    negative = max(1, int(np.sum(targets == 0)))
    return np.where(
        targets == 1,
        len(targets) / (2.0 * positive),
        len(targets) / (2.0 * negative),
    )


def cosine_centroid_scores(train_x: np.ndarray, train_y: np.ndarray, test_x: np.ndarray) -> np.ndarray:
    train = unit_rows(train_x)
    test = unit_rows(test_x)
    positive = unit(np.mean(train[train_y == 1], axis=0))
    negative = unit(np.mean(train[train_y == 0], axis=0))
    return sigmoid((test @ positive - test @ negative) * 8.0)


def topk_prototype_scores(train_x: np.ndarray, train_y: np.ndarray, test_x: np.ndarray) -> np.ndarray:
    train = unit_rows(train_x)
    test = unit_rows(test_x)
    positive = train[train_y == 1]
    negative = train[train_y == 0]
    positive_k = min(5, len(positive))
    negative_k = min(7, len(negative))
    positive_similarities = test @ positive.T
    negative_similarities = test @ negative.T
    positive_top = np.partition(positive_similarities, -positive_k, axis=1)[:, -positive_k:]
    negative_top = np.partition(negative_similarities, -negative_k, axis=1)[:, -negative_k:]
    return sigmoid((np.mean(positive_top, axis=1) - np.mean(negative_top, axis=1)) * 14.0)


def diagonal_lda_scores(train_x: np.ndarray, train_y: np.ndarray, test_x: np.ndarray) -> np.ndarray:
    weights = class_weights(train_y)
    positive = train_x[train_y == 1]
    negative = train_x[train_y == 0]
    positive_mean = np.mean(positive, axis=0)
    negative_mean = np.mean(negative, axis=0)
    centered = train_x - np.where(train_y[:, None] == 1, positive_mean, negative_mean)
    variance = np.average(centered * centered, axis=0, weights=weights)
    shrinkage = max(float(np.median(variance)) * 0.25, 1e-5)
    direction = (positive_mean - negative_mean) / (variance + shrinkage)
    midpoint = (positive_mean + negative_mean) * 0.5
    raw_train = (train_x - midpoint) @ direction
    scale = max(float(np.std(raw_train)), 1e-6)
    return sigmoid(((test_x - midpoint) @ direction) / scale)


def ridge_scores(train_x: np.ndarray, train_y: np.ndarray, test_x: np.ndarray) -> np.ndarray:
    train = unit_rows(train_x)
    test = unit_rows(test_x)
    augmented = np.column_stack([train, np.ones(len(train))])
    test_augmented = np.column_stack([test, np.ones(len(test))])
    sample_weights = class_weights(train_y)
    root_weights = np.sqrt(sample_weights)
    weighted_x = augmented * root_weights[:, None]
    weighted_target = (train_y * 2.0 - 1.0) * root_weights
    regularization = 0.35
    gram = weighted_x @ weighted_x.T
    coefficients = weighted_x.T @ np.linalg.solve(
        gram + np.eye(len(gram)) * regularization,
        weighted_target,
    )
    return sigmoid((test_augmented @ coefficients) * 2.5)


def production_blend_scores(
    train_x: np.ndarray, train_y: np.ndarray, test_x: np.ndarray
) -> np.ndarray:
    """Mirror the service's balanced linear-head/prototype family."""

    targets = train_y.astype(np.float64)
    sample_weights = class_weights(train_y)
    weights = np.zeros(train_x.shape[1], dtype=np.float64)
    bias = 0.0
    for _ in range(180):
        predictions = sigmoid(train_x @ weights + bias)
        error = (predictions - targets) * sample_weights
        weights -= 0.18 * ((train_x.T @ error) / len(targets) + 0.22 * weights)
        bias -= 0.18 * float(np.mean(error))
    learned = sigmoid(test_x @ weights + bias)
    prototype = topk_prototype_scores(train_x, train_y, test_x)
    return learned * 0.72 + prototype * 0.28


FAMILIES: dict[str, Callable[[np.ndarray, np.ndarray, np.ndarray], np.ndarray]] = {
    "cosine-centroid": cosine_centroid_scores,
    "topk-prototype": topk_prototype_scores,
    "diagonal-lda": diagonal_lda_scores,
    "ridge-linear": ridge_scores,
    "production-blend": production_blend_scores,
}


def score_family(
    family: str, train_cases: Sequence[BinaryCase], test_cases: Sequence[BinaryCase]
) -> np.ndarray:
    train_x = np.stack([case.vector for case in train_cases]).astype(np.float64)
    train_y = np.asarray([case.target for case in train_cases], dtype=np.int64)
    test_x = np.stack([case.vector for case in test_cases]).astype(np.float64)
    if len(set(train_y.tolist())) != 2:
        raise RuntimeError(f"{family}: training fold does not contain both classes")
    return np.asarray(FAMILIES[family](train_x, train_y, test_x), dtype=np.float64)


def confusion(targets: np.ndarray, predictions: np.ndarray) -> dict[str, float | int]:
    tp = int(np.sum((targets == 1) & (predictions == 1)))
    fp = int(np.sum((targets == 0) & (predictions == 1)))
    tn = int(np.sum((targets == 0) & (predictions == 0)))
    fn = int(np.sum((targets == 1) & (predictions == 0)))
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    specificity = tn / (tn + fp) if tn + fp else 0.0
    return {
        "tp": tp,
        "fp": fp,
        "tn": tn,
        "fn": fn,
        "precision": precision,
        "recall": recall,
        "specificity": specificity,
        "balanced_accuracy": (recall + specificity) * 0.5,
        "f1": 2.0 * precision * recall / (precision + recall) if precision + recall else 0.0,
        "false_positive_rate": fp / (fp + tn) if fp + tn else 0.0,
        "predicted_positive_rate": (tp + fp) / len(targets) if len(targets) else 0.0,
    }


def threshold_candidates(scores: np.ndarray) -> list[float]:
    unique = sorted(set(float(value) for value in scores))
    if not unique:
        return [0.5]
    candidates = [unique[0] - 1e-9]
    candidates.extend((left + right) * 0.5 for left, right in zip(unique, unique[1:]))
    candidates.append(unique[-1] + 1e-9)
    return candidates


def choose_threshold(
    targets: np.ndarray, scores: np.ndarray, policy: str, precision_floor: float
) -> float:
    ranked: list[tuple[tuple[float, ...], float]] = []
    fallback: list[tuple[tuple[float, ...], float]] = []
    for threshold in threshold_candidates(scores):
        metrics = confusion(targets, (scores >= threshold).astype(np.int64))
        if policy == "balanced":
            key = (
                float(metrics["balanced_accuracy"]),
                float(metrics["precision"]),
                float(metrics["recall"]),
                threshold,
            )
            ranked.append((key, threshold))
        else:
            key = (
                float(metrics["recall"]),
                float(metrics["balanced_accuracy"]),
                float(metrics["precision"]),
                threshold,
            )
            if float(metrics["precision"]) >= precision_floor and int(metrics["tp"]) > 0:
                ranked.append((key, threshold))
            fallback.append(
                (
                    (
                        float(metrics["precision"]),
                        float(metrics["recall"]),
                        float(metrics["balanced_accuracy"]),
                        threshold,
                    ),
                    threshold,
                )
            )
    candidates = ranked if ranked else fallback
    return max(candidates, key=lambda item: item[0])[1]


def inner_oof_scores(
    family: str, train_cases: Sequence[BinaryCase], fold_count: int, seed: int
) -> np.ndarray:
    scores = np.full(len(train_cases), np.nan, dtype=np.float64)
    folds = grouped_stratified_folds(train_cases, min(3, fold_count), seed)
    all_indices = set(range(len(train_cases)))
    for test_indices in folds:
        test_set = set(test_indices)
        train_indices = sorted(all_indices - test_set)
        current_train = [train_cases[index] for index in train_indices]
        current_test = [train_cases[index] for index in test_indices]
        scores[test_indices] = score_family(family, current_train, current_test)
    if np.any(~np.isfinite(scores)):
        raise RuntimeError(f"{family}: inner grouped validation did not score every artist")
    return scores


def grouped_cross_validate(
    family: str,
    cases: Sequence[BinaryCase],
    fold_count: int,
    seed: int,
    precision_floor: float,
) -> list[FoldPrediction]:
    outer_folds = grouped_stratified_folds(cases, fold_count, seed)
    all_indices = set(range(len(cases)))
    predictions: list[FoldPrediction] = []
    for fold_index, test_indices in enumerate(outer_folds):
        test_set = set(test_indices)
        train_indices = sorted(all_indices - test_set)
        train_cases = [cases[index] for index in train_indices]
        test_cases = [cases[index] for index in test_indices]
        train_targets = np.asarray([case.target for case in train_cases], dtype=np.int64)
        calibration_scores = inner_oof_scores(
            family, train_cases, fold_count, seed + fold_index * 101 + 17
        )
        balanced_threshold = choose_threshold(
            train_targets, calibration_scores, "balanced", precision_floor
        )
        precision_threshold = choose_threshold(
            train_targets, calibration_scores, "precision", precision_floor
        )
        test_scores = score_family(family, train_cases, test_cases)
        for case, score in zip(test_cases, test_scores):
            predictions.append(
                FoldPrediction(
                    group=case.group,
                    target=case.target,
                    reason=case.reason,
                    score=float(score),
                    balanced_prediction=int(score >= balanced_threshold),
                    precision_prediction=int(score >= precision_threshold),
                    fixed_prediction=int(score >= PRODUCTION_RIDGE_THRESHOLD),
                )
            )
    if len(predictions) != len(cases) or len({item.group for item in predictions}) != len(cases):
        raise RuntimeError(f"{family}: artist grouping invariant failed")
    return predictions


def rank_auc(targets: np.ndarray, scores: np.ndarray) -> float:
    positives = scores[targets == 1]
    negatives = scores[targets == 0]
    if not len(positives) or not len(negatives):
        return 0.5
    wins = 0.0
    for value in positives:
        wins += float(np.sum(value > negatives)) + 0.5 * float(np.sum(value == negatives))
    return wins / (len(positives) * len(negatives))


def summarize_predictions(predictions: Sequence[FoldPrediction]) -> dict[str, object]:
    targets = np.asarray([item.target for item in predictions], dtype=np.int64)
    scores = np.asarray([item.score for item in predictions], dtype=np.float64)
    balanced = np.asarray([item.balanced_prediction for item in predictions], dtype=np.int64)
    precision = np.asarray([item.precision_prediction for item in predictions], dtype=np.int64)
    fixed = np.asarray([item.fixed_prediction for item in predictions], dtype=np.int64)
    return {
        "artists": len(predictions),
        "positive_artists": int(np.sum(targets == 1)),
        "negative_artists": int(np.sum(targets == 0)),
        "roc_auc": rank_auc(targets, scores),
        "balanced_policy": confusion(targets, balanced),
        "precision_policy": confusion(targets, precision),
        "fixed_production_policy": confusion(targets, fixed),
    }


def preference_cases(records: Sequence[ArtistRecord]) -> tuple[list[BinaryCase], list[ArtistRecord]]:
    safe: list[BinaryCase] = []
    hard: list[ArtistRecord] = []
    for record in records:
        if not record.accepted and HARD_REASON_RE.search(record.reason):
            hard.append(record)
            continue
        safe.append(
            BinaryCase(
                group=record.group,
                target=1 if record.accepted else 0,
                reason=record.reason,
                vector=record.aggregate,
            )
        )
    return safe, hard


def body_cases(records: Sequence[ArtistRecord]) -> list[BinaryCase]:
    cases: list[BinaryCase] = []
    for record in records:
        is_body_reject = not record.accepted and bool(BODY_REASON_RE.search(record.reason))
        if record.body is None or (not record.accepted and not is_body_reject):
            continue
        cases.append(
            BinaryCase(
                group=record.group,
                target=1 if is_body_reject else 0,
                reason=record.reason,
                vector=record.body,
            )
        )
    return cases


def hard_first_summary(
    predictions: Sequence[FoldPrediction], hard_records: Sequence[ArtistRecord]
) -> dict[str, object]:
    augmented = list(predictions)
    for record in hard_records:
        augmented.append(
            FoldPrediction(
                group=record.group,
                target=0,
                reason=record.reason,
                score=0.0,
                balanced_prediction=0,
                precision_prediction=0,
                fixed_prediction=0,
            )
        )
    summary = summarize_predictions(augmented)
    body_predictions = [item for item in predictions if BODY_REASON_RE.search(item.reason)]
    summary["body_reject_artists"] = len(body_predictions)
    summary["body_escape_balanced"] = (
        sum(item.balanced_prediction == 1 for item in body_predictions) / len(body_predictions)
        if body_predictions
        else 0.0
    )
    summary["body_escape_precision"] = (
        sum(item.precision_prediction == 1 for item in body_predictions) / len(body_predictions)
        if body_predictions
        else 0.0
    )
    summary["label_hard_gate_artists"] = len(hard_records)
    return summary


def benchmark(
    db_path: Path, fold_count: int, seed: int, precision_floor: float
) -> dict[str, object]:
    synthetic = run_synthetic_fixture()
    if synthetic["passed"] != synthetic["total"]:
        raise RuntimeError("Synthetic hard-gate fixture failed")
    records, load_stats = load_records(db_path)
    preference, hard = preference_cases(records)
    body = body_cases(records)

    preference_counts = {case.target for case in preference}
    body_counts = {case.target for case in body}
    if preference_counts != {0, 1} or body_counts != {0, 1}:
        raise RuntimeError("Both benchmark targets require positive and negative artist groups")

    preference_results: dict[str, object] = {}
    body_results: dict[str, object] = {}
    for family in FAMILIES:
        preference_predictions = grouped_cross_validate(
            family, preference, fold_count, seed, precision_floor
        )
        preference_results[family] = {
            "hard_safe_model": summarize_predictions(preference_predictions),
            "hard_filter_first_pipeline": hard_first_summary(preference_predictions, hard),
        }
        body_predictions = grouped_cross_validate(
            family, body, fold_count, seed + 1009, precision_floor
        )
        body_results[family] = summarize_predictions(body_predictions)

    return {
        "safety": {
            "database_mode": "read-only/query-only",
            "image_io": "none",
            "media_io": "none",
            "network_io": "none",
            "service_control": "none",
        },
        "configuration": {
            "folds": fold_count,
            "seed": seed,
            "precision_floor": precision_floor,
            "minimum_distinct_mock_media": MIN_DISTINCT_MEDIA,
            "production_ridge_threshold": PRODUCTION_RIDGE_THRESHOLD,
        },
        "synthetic_hard_gate": synthetic,
        "data": {
            **load_stats,
            "hard_safe_preference_artists": len(preference),
            "explicit_hard_reason_artists": len(hard),
            "body_benchmark_artists": len(body),
            "body_reject_artists": sum(case.target == 1 for case in body),
        },
        "preference": preference_results,
        "body_mismatch": body_results,
        "limitations": [
            "Stored reason labels are user feedback, not independently adjudicated ground truth.",
            "The label-derived hard gate is upper-bound accounting, not hard-filter model validation.",
            "Body vectors inherit artist-level labels; per-image labels would yield a cleaner benchmark.",
            "Synthetic HTML verifies code paths only and estimates no real-source prevalence.",
        ],
    }


def percent(value: object) -> str:
    return f"{float(value) * 100:6.1f}%"


def print_report(result: dict[str, object]) -> None:
    data = result["data"]
    fixture = result["synthetic_hard_gate"]
    config = result["configuration"]
    print("Offline Local2 numeric benchmark")
    print("Safety: SQLite read-only; no image, media, network, or service I/O")
    print(
        f"Synthetic hard gate: {fixture['passed']}/{fixture['total']} fixtures passed; "
        f"minimum distinct mock media={config['minimum_distinct_mock_media']}"
    )
    print(
        "Data: {compatible_records} compatible artists, aggregate dim {aggregate_dimension}; "
        "{hard_safe_preference_artists} enter learned preference after "
        "{explicit_hard_reason_artists} explicit hard-reason rejects".format(**data)
    )
    print()
    print("Hard-filter-first preference pipeline (positive = accept)")
    print(
        "family              AUC    bal-prec bal-rec bal-FAR  p90-prec p90-rec p90-FAR "
        "body-escape"
    )
    for family, family_result in result["preference"].items():
        summary = family_result["hard_filter_first_pipeline"]
        balanced = summary["balanced_policy"]
        precision = summary["precision_policy"]
        print(
            f"{family:20} {summary['roc_auc']:5.3f}  "
            f"{percent(balanced['precision'])} {percent(balanced['recall'])} "
            f"{percent(balanced['false_positive_rate'])}  "
            f"{percent(precision['precision'])} {percent(precision['recall'])} "
            f"{percent(precision['false_positive_rate'])} "
            f"{percent(summary['body_escape_precision'])}"
        )
    print()
    ridge = result["preference"].get("ridge-linear", {}).get("hard_filter_first_pipeline", {})
    fixed = ridge.get("fixed_production_policy", {})
    if fixed:
        print(
            f"Production ridge @ {config['production_ridge_threshold']:.2f}: "
            f"precision {percent(fixed['precision'])}, recall {percent(fixed['recall'])}, "
            f"false-accept rate {percent(fixed['false_positive_rate'])}"
        )
        print()
    print("Body-mismatch head (positive = Fat/Body reject; vectors pooled per artist)")
    print("family              AUC    bal-prec bal-rec false-rej  p90-prec p90-rec false-rej")
    for family, summary in result["body_mismatch"].items():
        balanced = summary["balanced_policy"]
        precision = summary["precision_policy"]
        print(
            f"{family:20} {summary['roc_auc']:5.3f}  "
            f"{percent(balanced['precision'])} {percent(balanced['recall'])} "
            f"{percent(balanced['false_positive_rate'])}  "
            f"{percent(precision['precision'])} {percent(precision['recall'])} "
            f"{percent(precision['false_positive_rate'])}"
        )
    print()
    print("Interpret p90 columns as train-fold calibrated high-precision operating points.")
    print("The explicit hard-reason stage is an accounting upper bound, not visual-model proof.")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    repo_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db",
        type=Path,
        default=repo_root / ".pong-local-ai" / "preference-examples-v3.sqlite3",
        help="Existing preference database; it is always opened read-only.",
    )
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--precision-floor", type=float, default=0.90)
    parser.add_argument("--json", action="store_true", help="Print JSON to stdout; writes no file.")
    args = parser.parse_args(argv)
    if args.folds < 2:
        parser.error("--folds must be at least 2")
    if not 0.5 <= args.precision_floor <= 1.0:
        parser.error("--precision-floor must be between 0.5 and 1.0")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    result = benchmark(args.db, args.folds, args.seed, args.precision_floor)
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print_report(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
