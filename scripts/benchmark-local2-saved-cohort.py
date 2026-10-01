"""Privacy-safe regression harness for Pong's saved Local2 cohort.

Default mode is entirely offline. It opens both learning databases read-only,
reconciles every direct Save/Red-X identity by its one-way SHA-256 key, and
evaluates three deliberately separate production contracts:

1. exact-memory preservation for all saved identities;
2. artist-held-out Ridge taste classification using the same combined feature
   bank, numeric-store precedence, hard-reason exclusion, and thresholds as
   production Local2;
3. Local2Policy replay for the saved subset that has numeric semantic evidence.

Output contains only aggregate strata and anonymous counts. No artist identity,
URL, image URL, or one-way key is emitted. Offline mode performs no image,
media, network, model, playback, or service work.

An optional ``--live`` lane sends a small stratified cohort to the existing
loopback ``/classify`` endpoint. It performs image/model I/O but never requests
or plays audio/video. Live mode is opt-in and refuses non-loopback endpoints
unless ``--allow-remote-endpoint`` is also supplied.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass, replace
from datetime import datetime
import hashlib
import json
from pathlib import Path
import random
import re
import sqlite3
import sys
import time
from typing import Any, Iterable, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

import numpy as np


ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / ".pong-local-ai"
DEFAULT_PREFERENCE_DB = (DATA_DIR / "preference-examples-v3.sqlite3").resolve()
DEFAULT_LOCAL2_DB = (DATA_DIR / "local2-clean-v2.sqlite3").resolve()
DEFAULT_AUDIT = (DATA_DIR / "train-ai-verdict-audit.jsonl").resolve()
DEFAULT_ENDPOINT = "http://127.0.0.1:8787"
DEFAULT_SEED = 20260910
DEFAULT_FOLDS = 5
PRODUCTION_PREFILTER_REJECT = 0.30
PRODUCTION_PREFERENCE_ACCEPT = 0.36
MINIMUM_ACCEPT_RECALL = 0.90
MINIMUM_REJECT_RECALL = 0.80
MINIMUM_HISTORY = 303

sys.path.insert(0, str(ROOT / "scripts"))
from local2_clean import (  # noqa: E402
    Local2ImageEvidence,
    Local2NumericView,
    Local2Policy,
    Local2Thresholds,
    RidgeLinearHead,
)
from local2_vision_adapter import (  # noqa: E402
    DEFAULT_FEATURE_SCHEMA,
    HARD_ONLY_REASON,
    Local2VisionAdapter,
)


VALID_LABELS = {"accept", "reject"}
EVIDENCE_REASON_CODES = {
    "insufficient_usable_evidence",
    "missing_personalization",
    "ambiguous_hard_evidence",
}
URL_RE = re.compile(r"https?://[^\s)\]}]+", re.I)


@dataclass(frozen=True)
class SavedCase:
    artist_key: str
    label: str
    reason: str
    updated_at: float
    source: str
    feature: np.ndarray | None
    descriptors: tuple[Local2ImageEvidence, ...] | None = None
    artist_url: str = ""
    image_urls: tuple[str, ...] = ()


@dataclass(frozen=True)
class Prediction:
    label: str
    reason_category: str
    probability: float | None
    outcome: str
    decision: str
    reason_code: str = ""


def artist_identity(raw: str) -> str:
    try:
        parsed = urlparse(str(raw or ""))
        parts = [part for part in parsed.path.split("/") if part]
        marker = next(
            (index for index, part in enumerate(parts) if part.lower() in {"u", "c"}),
            -1,
        )
        if marker >= 0 and len(parts) > marker + 2:
            return f"{parts[marker + 1].lower()}:{parts[marker + 2].lower()}"
        return parsed.path.rstrip("/").lower()
    except Exception:
        return ""


def stable_artist_key(identity: str) -> str:
    normalized = str(identity or "").strip().lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest() if normalized else ""


def feedback_timestamp(record: Mapping[str, object], fallback: float) -> float:
    try:
        value = str(
            record.get("learnedAt")
            or record.get("acceptedAt")
            or record.get("rejectedAt")
            or ""
        )
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return float(fallback)


def open_query_only(path: Path) -> sqlite3.Connection:
    resolved = path.expanduser().resolve(strict=True)
    connection = sqlite3.connect(f"{resolved.as_uri()}?mode=ro", uri=True)
    connection.execute("PRAGMA query_only = ON")
    if int(connection.execute("PRAGMA query_only").fetchone()[0]) != 1:
        connection.close()
        raise RuntimeError("SQLite query-only mode could not be enabled")
    return connection


def load_audited_keys(path: Path) -> tuple[set[str], int]:
    keys: set[str] = set()
    rows = 0
    with path.expanduser().resolve(strict=True).open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"invalid Train AI audit JSON at line {line_number}") from error
            if not isinstance(record, dict) or not record.get("auditedAt"):
                continue
            rows += 1
            key = stable_artist_key(artist_identity(record.get("artistUrl", "")))
            if key:
                keys.add(key)
    return keys, rows


def direct_workflow(workflow: str, key: str, audited: set[str]) -> bool:
    normalized = str(workflow or "").strip().lower()
    if normalized == "train-ai":
        return False
    if normalized in {"save", "red-x"}:
        return True
    return bool(key and key not in audited)


def reason_category(label: str, reason: str) -> str:
    if label == "accept":
        return "accept"
    normalized = str(reason or "").strip().lower()
    if re.search(r"\bugly\b", normalized):
        return "ugly"
    if re.search(r"\b(?:fat|body)\b", normalized):
        return "body"
    if re.search(r"not.?my.?taste|preference", normalized):
        return "not-my-taste"
    if HARD_ONLY_REASON.search(normalized):
        return "hard-filter"
    return "other-reject"


def valid_feature(raw: object) -> np.ndarray | None:
    if not isinstance(raw, list) or not raw:
        return None
    try:
        vector = np.asarray(raw, dtype=np.float32).reshape(-1)
    except (TypeError, ValueError):
        return None
    if not len(vector) or not np.all(np.isfinite(vector)):
        return None
    return vector


def load_shared_cases(
    db_path: Path, audited: set[str]
) -> tuple[dict[str, SavedCase], dict[str, SavedCase], dict[str, int]]:
    connection = open_query_only(db_path)
    try:
        rows = connection.execute(
            "SELECT updated_at, record_json FROM preference_records "
            "ORDER BY updated_at DESC LIMIT 2000"
        ).fetchall()
    finally:
        connection.close()

    all_cases: dict[str, SavedCase] = {}
    direct_cases: dict[str, SavedCase] = {}
    malformed = 0
    for database_updated_at, raw in rows:
        try:
            record = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            malformed += 1
            continue
        if not isinstance(record, dict):
            malformed += 1
            continue
        identity = artist_identity(record.get("artistUrl", ""))
        key = stable_artist_key(identity)
        label = str(record.get("label", "")).strip().lower()
        if not key or label not in VALID_LABELS:
            malformed += 1
            continue
        if key in all_cases:
            continue
        reason = str(
            record.get("rejectReason") or record.get("rejectReasonLabel") or ""
        ).strip()[:80]
        feature = valid_feature((record.get("features") or {}).get("local2"))
        image_urls = tuple(dict.fromkeys(
            str(item.get("url") or "").strip()
            for item in (record.get("images") or [])
            if isinstance(item, dict) and str(item.get("url") or "").startswith("https://")
        ))
        case = SavedCase(
            artist_key=key,
            label=label,
            reason=reason,
            updated_at=feedback_timestamp(record, float(database_updated_at)),
            source="preference",
            feature=feature,
            artist_url=str(record.get("artistUrl") or ""),
            image_urls=image_urls,
        )
        all_cases[key] = case
        if direct_workflow(str(record.get("workflow", "")), key, audited):
            direct_cases[key] = case
    return all_cases, direct_cases, {
        "shared_rows": len(rows),
        "shared_cases": len(all_cases),
        "shared_direct": len(direct_cases),
        "shared_malformed": malformed,
    }


def load_numeric_cases(
    db_path: Path, audited: set[str]
) -> tuple[dict[str, SavedCase], dict[str, SavedCase], dict[str, int]]:
    connection = open_query_only(db_path)
    try:
        rows = connection.execute(
            "SELECT artist_key, updated_at, label, reason_code, workflow, "
            "feature_schema, descriptor_json FROM local2_examples "
            "ORDER BY updated_at DESC"
        ).fetchall()
        all_cases: dict[str, SavedCase] = {}
        direct_cases: dict[str, SavedCase] = {}
        malformed = 0
        for key, updated_at, label, reason, workflow, schema, raw_descriptors in rows:
            normalized_key = str(key or "").strip().lower()
            normalized_label = str(label or "").strip().lower()
            if (
                len(normalized_key) != 64
                or any(character not in "0123456789abcdef" for character in normalized_key)
                or normalized_label not in VALID_LABELS
                or str(schema) != DEFAULT_FEATURE_SCHEMA
            ):
                malformed += 1
                continue
            try:
                descriptors = tuple(
                    Local2ImageEvidence(**item) for item in json.loads(raw_descriptors)
                )
                vector_rows = connection.execute(
                    "SELECT image_index, view_kind, dimension, vector_f32 "
                    "FROM local2_vectors WHERE artist_key = ? "
                    "ORDER BY image_index, view_kind",
                    (normalized_key,),
                ).fetchall()
                views: list[Local2NumericView] = []
                for image_index, view_kind, dimension, raw_vector in vector_rows:
                    vector = np.frombuffer(raw_vector, dtype="<f4").copy()
                    if len(vector) != int(dimension):
                        raise ValueError("numeric vector dimension mismatch")
                    views.append(Local2NumericView(int(image_index), str(view_kind), vector))
                feature = Local2VisionAdapter._artist_feature(descriptors, tuple(views))
            except (TypeError, ValueError, json.JSONDecodeError):
                malformed += 1
                continue
            case = SavedCase(
                artist_key=normalized_key,
                label=normalized_label,
                reason=str(reason or "").strip()[:80],
                updated_at=float(updated_at),
                source="local2",
                feature=feature,
                descriptors=descriptors,
            )
            all_cases[normalized_key] = case
            if direct_workflow(str(workflow or ""), normalized_key, audited):
                direct_cases[normalized_key] = case
    finally:
        connection.close()
    return all_cases, direct_cases, {
        "numeric_rows": len(rows),
        "numeric_cases": len(all_cases),
        "numeric_direct": len(direct_cases),
        "numeric_malformed": malformed,
    }


def load_exact_labels(db_path: Path) -> tuple[dict[str, str], int]:
    connection = open_query_only(db_path)
    try:
        rows = connection.execute(
            "SELECT artist_identity, label FROM exact_direct_feedback"
        ).fetchall()
    finally:
        connection.close()
    exact: dict[str, str] = {}
    malformed = 0
    for identity, label in rows:
        key = stable_artist_key(str(identity or ""))
        normalized = str(label or "").strip().lower()
        if not key or normalized not in VALID_LABELS or key in exact:
            malformed += 1
            continue
        exact[key] = normalized
    return exact, malformed


def latest_direct_cases(
    shared: Mapping[str, SavedCase], numeric: Mapping[str, SavedCase]
) -> dict[str, SavedCase]:
    output = dict(shared)
    for key, case in numeric.items():
        previous = output.get(key)
        if previous is None or case.updated_at >= previous.updated_at:
            output[key] = case
    return output


def production_training_bank(
    shared: Mapping[str, SavedCase], numeric: Mapping[str, SavedCase]
) -> dict[str, SavedCase]:
    # Mirror Local2VisionAdapter: usable numeric examples take precedence, and
    # hard-only reason labels never train the taste head.
    numeric_taste = {
        key: case for key, case in numeric.items()
        if case.feature is not None and not HARD_ONLY_REASON.search(case.reason)
    }
    shared_taste = {
        key: case for key, case in shared.items()
        if (
            key not in numeric_taste
            and case.feature is not None
            and not HARD_ONLY_REASON.search(case.reason)
        )
    }
    return {**shared_taste, **numeric_taste}


def stratified_folds(cases: Sequence[SavedCase], folds: int, seed: int) -> list[list[str]]:
    strata: dict[str, list[str]] = defaultdict(list)
    for case in cases:
        strata[reason_category(case.label, case.reason)].append(case.artist_key)
    actual = max(2, min(int(folds), len(cases)))
    output: list[list[str]] = [[] for _ in range(actual)]
    rng = random.Random(seed)
    for name in sorted(strata):
        keys = sorted(strata[name])
        rng.shuffle(keys)
        for index, key in enumerate(keys):
            output[index % actual].append(key)
    return output


def classify_outcome(expected: str, decision: str, reason_code: str) -> str:
    normalized_decision = str(decision or "").strip().lower()
    normalized_reason = str(reason_code or "").strip().lower()
    if normalized_decision in {"review", "unsure", ""} or normalized_reason in EVIDENCE_REASON_CODES:
        return "evidence_failure"
    if normalized_decision not in VALID_LABELS:
        return "operational_failure"
    return "pass" if normalized_decision == expected else "policy_failure"


def cross_validated_predictions(
    cohort: Mapping[str, SavedCase],
    training_bank: Mapping[str, SavedCase],
    *,
    folds: int,
    seed: int,
    threshold: float,
) -> tuple[list[Prediction], list[Prediction]]:
    taste_predictions: list[Prediction] = []
    semantic_predictions: list[Prediction] = []
    policy = Local2Policy(replace(Local2Thresholds(), preference_accept=threshold))
    ordered = sorted(cohort.values(), key=lambda case: case.artist_key)
    by_key = dict(cohort)
    for fold_keys in stratified_folds(ordered, folds, seed):
        test_keys = set(fold_keys)
        training = [case for key, case in training_bank.items() if key not in test_keys]
        dimensions = Counter(len(case.feature) for case in training if case.feature is not None)
        if not dimensions:
            for key in fold_keys:
                case = by_key[key]
                failure = Prediction(
                    case.label,
                    reason_category(case.label, case.reason),
                    None,
                    "operational_failure",
                    "",
                    "missing_training_bank",
                )
                taste_predictions.append(failure)
                if case.descriptors is not None:
                    semantic_predictions.append(failure)
            continue
        dimension = dimensions.most_common(1)[0][0]
        training = [case for case in training if len(case.feature) == dimension]
        try:
            labels = [1 if case.label == "accept" else 0 for case in training]
            head = RidgeLinearHead.fit(
                np.stack([case.feature for case in training]), labels
            )
        except Exception:
            for key in fold_keys:
                case = by_key[key]
                failure = Prediction(
                    case.label,
                    reason_category(case.label, case.reason),
                    None,
                    "operational_failure",
                    "",
                    "head_fit_failed",
                )
                taste_predictions.append(failure)
                if case.descriptors is not None:
                    semantic_predictions.append(failure)
            continue
        for key in fold_keys:
            case = by_key[key]
            category = reason_category(case.label, case.reason)
            if case.feature is None or len(case.feature) != dimension:
                failure = Prediction(
                    case.label, category, None, "evidence_failure", "", "missing_numeric_feature"
                )
                taste_predictions.append(failure)
                if case.descriptors is not None:
                    semantic_predictions.append(failure)
                continue
            try:
                probability = head.predict_probability(case.feature)
                taste_decision = "accept" if probability >= threshold else "reject"
                taste_predictions.append(Prediction(
                    case.label,
                    category,
                    probability,
                    classify_outcome(case.label, taste_decision, ""),
                    taste_decision,
                ))
                if case.descriptors is not None:
                    semantic = policy.decide(
                        case.descriptors,
                        taste_probability=probability,
                        conservative_ambiguity=False,
                    )
                    semantic_predictions.append(Prediction(
                        case.label,
                        category,
                        probability,
                        classify_outcome(case.label, semantic.decision, semantic.reason_code),
                        semantic.decision,
                        semantic.reason_code,
                    ))
            except Exception:
                failure = Prediction(
                    case.label, category, None, "operational_failure", "", "prediction_failed"
                )
                taste_predictions.append(failure)
                if case.descriptors is not None:
                    semantic_predictions.append(failure)
    return taste_predictions, semantic_predictions


def summarize_predictions(rows: Sequence[Prediction], *, taste_only: bool) -> dict[str, object]:
    # Hard-reason rejects are excluded from the taste-only quality denominator:
    # production deliberately excludes their labels from its taste head.
    evaluated = [
        row for row in rows
        if not taste_only or row.label == "accept" or row.reason_category != "hard-filter"
    ]
    counts = Counter(row.outcome for row in evaluated)
    usable = [row for row in evaluated if row.outcome in {"pass", "policy_failure"}]
    accepts = [row for row in evaluated if row.label == "accept"]
    rejects = [row for row in evaluated if row.label == "reject"]
    accepted_correct = sum(
        row.outcome == "pass" and row.decision == "accept" for row in accepts
    )
    rejected_correct = sum(
        row.outcome == "pass" and row.decision == "reject" for row in rejects
    )
    by_stratum: dict[str, dict[str, object]] = {}
    for category in sorted({row.reason_category for row in evaluated}):
        current = [row for row in evaluated if row.reason_category == category]
        by_stratum[category] = {
            "total": len(current),
            "pass": sum(row.outcome == "pass" for row in current),
            "policy_failure": sum(row.outcome == "policy_failure" for row in current),
            "evidence_failure": sum(row.outcome == "evidence_failure" for row in current),
            "operational_failure": sum(row.outcome == "operational_failure" for row in current),
        }
    return {
        "total": len(evaluated),
        "pass": counts["pass"],
        "policy_failure": counts["policy_failure"],
        "evidence_failure": counts["evidence_failure"],
        "operational_failure": counts["operational_failure"],
        "decision_coverage": len(usable) / len(evaluated) if evaluated else 0.0,
        "accept_recall": accepted_correct / len(accepts) if accepts else 0.0,
        "reject_recall": rejected_correct / len(rejects) if rejects else 0.0,
        "strata": by_stratum,
    }


def memory_summary(
    cohort: Mapping[str, SavedCase], exact: Mapping[str, str]
) -> dict[str, object]:
    missing = sum(key not in exact for key in cohort)
    mismatched = sum(key in exact and exact[key] != case.label for key, case in cohort.items())
    extra = sum(key not in cohort for key in exact)
    ugly = [case for case in cohort.values() if reason_category(case.label, case.reason) == "ugly"]
    ugly_rejected = sum(
        case.label == "reject" and exact.get(case.artist_key) == "reject" for case in ugly
    )
    matched = len(cohort) - missing - mismatched
    return {
        "total": len(cohort),
        "matched": matched,
        "missing": missing,
        "mismatched": mismatched,
        "extra": extra,
        "ugly_total": len(ugly),
        "ugly_rejected": ugly_rejected,
        "passed": bool(
            cohort
            and matched == len(cohort)
            and missing == 0
            and mismatched == 0
            and extra == 0
            and ugly_rejected == len(ugly)
        ),
    }


def safe_error(error: object) -> str:
    return URL_RE.sub("[url]", str(error or "unknown error")).replace("\\", "/")[:240]


def post_json(endpoint: str, payload: Mapping[str, object], timeout: float) -> dict[str, Any]:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = Request(
        f"{endpoint.rstrip('/')}/classify",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            parsed = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        raise RuntimeError(f"classification HTTP {error.code}") from error
    except (URLError, TimeoutError) as error:
        raise RuntimeError(f"classification transport failure: {safe_error(error.reason)}") from error
    if not isinstance(parsed, dict):
        raise RuntimeError("classification returned a non-object payload")
    return parsed


def select_live_cases(
    cohort: Mapping[str, SavedCase], per_stratum: int, seed: int
) -> list[SavedCase]:
    strata: dict[str, list[SavedCase]] = defaultdict(list)
    for case in cohort.values():
        if case.artist_url and len(case.image_urls) >= 4:
            strata[reason_category(case.label, case.reason)].append(case)
    rng = random.Random(seed)
    selected: list[SavedCase] = []
    for category in sorted(strata):
        current = sorted(strata[category], key=lambda case: case.artist_key)
        rng.shuffle(current)
        selected.extend(current[:per_stratum])
    return selected


def run_live_classification(
    cohort: Mapping[str, SavedCase],
    *,
    endpoint: str,
    mode: str,
    per_stratum: int,
    seed: int,
    timeout: float,
) -> dict[str, object]:
    selected = select_live_cases(cohort, per_stratum, seed)
    outcomes: list[Prediction] = []
    elapsed: list[float] = []
    for index, case in enumerate(selected, start=1):
        category = reason_category(case.label, case.reason)
        private_artist_url = case.artist_url if mode == "exact" else (
            f"https://benchmark.invalid/u/benchmark/case-{index:03d}"
        )
        payload = {
            "app": "pong-local2-saved-cohort-regression",
            "localVariant": "local2",
            "preferencePolicy": "broad-hard-safe",
            "stage": "full",
            "deferQwenReview": True,
            "artist": {"artistUrl": private_artist_url, "artistName": "benchmark-candidate"},
            "candidateImageUrls": list(case.image_urls[:4]),
        }
        started = time.monotonic()
        try:
            result = post_json(endpoint, payload, timeout)
            decision = str(result.get("decision") or "").lower()
            reason_code = str(result.get("reason_code") or "").lower()
            if (
                case.label == "accept"
                and (decision in {"review", "unsure"} or result.get("requires_qwen_review") is True)
                and len(case.image_urls) >= 6
            ):
                confirmation = {
                    **payload,
                    "preferencePolicy": "hard-confirmation",
                    "stage": "hard-confirmation",
                    "deferQwenReview": False,
                    "candidateImageUrls": list(case.image_urls[:8]),
                }
                result = post_json(endpoint, confirmation, timeout)
                decision = str(result.get("decision") or "").lower()
                reason_code = str(result.get("reason_code") or "").lower()
            outcomes.append(Prediction(
                case.label,
                category,
                None,
                classify_outcome(case.label, decision, reason_code),
                decision,
                reason_code,
            ))
        except Exception:
            outcomes.append(Prediction(
                case.label,
                category,
                None,
                "operational_failure",
                "",
                "live_request_failed",
            ))
        elapsed.append(time.monotonic() - started)
    summary = summarize_predictions(outcomes, taste_only=False)
    return {
        "enabled": True,
        "mode": mode,
        "selected": len(selected),
        "per_stratum": per_stratum,
        "average_elapsed_ms": round(sum(elapsed) * 1000 / len(elapsed)) if elapsed else 0,
        "classification": summary,
        "media_qualification": "not exercised; no video URLs are requested or played",
    }


def benchmark(args: argparse.Namespace) -> dict[str, object]:
    audited, audited_rows = load_audited_keys(args.audit)
    shared_all, shared_direct, shared_stats = load_shared_cases(args.preference_db, audited)
    numeric_all, numeric_direct, numeric_stats = load_numeric_cases(args.local2_db, audited)
    cohort = latest_direct_cases(shared_direct, numeric_direct)
    training = production_training_bank(shared_all, numeric_all)
    exact, exact_malformed = load_exact_labels(args.preference_db)
    memory = memory_summary(cohort, exact)
    taste_rows, semantic_rows = cross_validated_predictions(
        cohort,
        training,
        folds=args.folds,
        seed=args.seed,
        threshold=args.preference_accept,
    )
    taste = summarize_predictions(taste_rows, taste_only=True)
    semantic = summarize_predictions(semantic_rows, taste_only=False)
    malformed = (
        shared_stats["shared_malformed"]
        + numeric_stats["numeric_malformed"]
        + exact_malformed
    )
    quality_pass = bool(
        memory["passed"]
        and len(cohort) >= MINIMUM_HISTORY
        and taste["accept_recall"] >= args.minimum_accept_recall
        and taste["reject_recall"] >= args.minimum_reject_recall
        and taste["operational_failure"] == 0
        and malformed == 0
    )
    result: dict[str, object] = {
        "schema": "pong-local2-saved-cohort-regression-v1",
        "safety": {
            "sqlite": "read-only/query-only; live WAL included",
            "artist_identifiers_in_output": False,
            "default_image_io": "none",
            "media_io": "none in every mode",
            "audio_or_video_playback": "none in every mode",
            "network_and_model_io": "none unless --live is explicitly supplied",
            "service_control": "none",
        },
        "configuration": {
            "folds": args.folds,
            "seed": args.seed,
            "production_prefilter_reject": PRODUCTION_PREFILTER_REJECT,
            "production_preference_accept": args.preference_accept,
            "minimum_accept_recall": args.minimum_accept_recall,
            "minimum_reject_recall": args.minimum_reject_recall,
            "report_only": args.report_only,
        },
        "data": {
            **shared_stats,
            **numeric_stats,
            "audited_rows": audited_rows,
            "direct_cohort": len(cohort),
            "production_taste_training_bank": len(training),
            "cohort_strata": dict(sorted(Counter(
                reason_category(case.label, case.reason) for case in cohort.values()
            ).items())),
            "malformed": malformed,
        },
        "stages": {
            "exact_memory": memory,
            "held_out_taste": taste,
            "held_out_semantic_policy": {
                **semantic,
                "scope": "numeric-store cases with saved grouped semantic descriptors",
            },
        },
        "failure_taxonomy": {
            "policy_failure": "sufficient numeric evidence produced the opposite saved label",
            "evidence_failure": "required numeric/semantic evidence was missing or remained ambiguous",
            "operational_failure": "database, model-head, parsing, or optional live request failed",
        },
        "limitations": [
            "Saved labels are user feedback, not independently adjudicated visual ground truth.",
            "Held-out taste evaluation disables exact identity memory to measure unseen generalization.",
            "Only Local2 numeric rows contain grouped semantic descriptors for offline hard-policy replay.",
            "Text hard filters and the 15-distinct-video contract require a separate opt-in live source benchmark.",
            "The optional live lane exercises production /classify only and never requests or plays media.",
        ],
        "quality_pass": quality_pass,
        "passed": quality_pass or args.report_only,
    }
    if args.live:
        result["live"] = run_live_classification(
            cohort,
            endpoint=args.endpoint,
            mode=args.live_mode,
            per_stratum=args.live_per_stratum,
            seed=args.seed,
            timeout=args.live_timeout,
        )
    else:
        result["live"] = {
            "enabled": False,
            "reason": "requires explicit --live opt-in",
        }
    return result


def print_stage(name: str, stage: Mapping[str, object]) -> None:
    print(
        f"{name}: {stage['pass']}/{stage['total']} pass; "
        f"policy {stage['policy_failure']}, evidence {stage['evidence_failure']}, "
        f"operational {stage['operational_failure']}; "
        f"coverage {stage['decision_coverage']:.1%}, "
        f"accept recall {stage['accept_recall']:.1%}, reject recall {stage['reject_recall']:.1%}"
    )
    for category, values in stage["strata"].items():
        print(
            f"  {category}: {values['pass']}/{values['total']} pass; "
            f"policy {values['policy_failure']}, evidence {values['evidence_failure']}, "
            f"operational {values['operational_failure']}"
        )


def print_report(result: Mapping[str, object]) -> None:
    data = result["data"]
    memory = result["stages"]["exact_memory"]
    print("Pong Local2 saved-cohort regression")
    print(
        "Safety: aggregate anonymous output; SQLite query-only; no image, media, "
        "network, model, playback, audio, or service work by default"
    )
    print(
        f"Cohort: {data['direct_cohort']} direct histories; "
        f"production taste bank {data['production_taste_training_bank']}; "
        f"strata {json.dumps(data['cohort_strata'], sort_keys=True)}"
    )
    print(
        f"Exact memory: {memory['matched']}/{memory['total']}; "
        f"missing {memory['missing']}, mismatched {memory['mismatched']}, "
        f"extra {memory['extra']}; ugly {memory['ugly_rejected']}/{memory['ugly_total']} reject"
    )
    print_stage("Held-out taste", result["stages"]["held_out_taste"])
    print_stage("Held-out semantic policy", result["stages"]["held_out_semantic_policy"])
    live = result["live"]
    if live.get("enabled"):
        print_stage("Opt-in live classify", live["classification"])
        print(
            f"Live classification: {live['selected']} anonymous cases, "
            f"average {live['average_elapsed_ms']} ms; {live['media_qualification']}"
        )
    else:
        print("Live classification: not run (requires explicit --live)")
    print(
        f"Strict quality gates: {'PASS' if result['quality_pass'] else 'FAIL'}; "
        f"command result: {'PASS' if result['passed'] else 'FAIL'}"
    )


def synthetic_descriptor(index: int, *, male: float = 0.01) -> Local2ImageEvidence:
    return Local2ImageEvidence(
        image_index=index,
        photo=0.98,
        person=0.98,
        female_presentation=0.98 if male < 0.5 else 0.01,
        male_presentation=male,
        feet_dominant=0.01,
        nonphoto=0.01,
        body_mismatch=0.02,
        body_preferred=0.96,
        attached_anatomy=0.01,
        toy_or_prosthetic=0.01,
        over_60=0.01,
        adult_probability=1.0,
        adult_safety_risk=0.0,
        adult_safety_unclear=0.0,
        body_clear=True,
        anatomy_clear=True,
        face_clear=True,
    )


def run_self_test() -> int:
    assert reason_category("accept", "") == "accept"
    assert reason_category("reject", "not-my-taste") == "not-my-taste"
    assert reason_category("reject", "Fat") == "body"
    assert reason_category("reject", "ugly") == "ugly"
    policy = Local2Policy(replace(
        Local2Thresholds(), preference_accept=PRODUCTION_PREFERENCE_ACCEPT
    ))
    accepted = policy.decide(
        [synthetic_descriptor(1), synthetic_descriptor(2)],
        taste_probability=0.90,
        conservative_ambiguity=False,
    )
    rejected = policy.decide(
        [synthetic_descriptor(1, male=0.99), synthetic_descriptor(2, male=0.99)],
        taste_probability=0.90,
        conservative_ambiguity=False,
    )
    assert accepted.decision == "accept"
    assert rejected.decision == "reject"
    assert classify_outcome("accept", "accept", "accepted") == "pass"
    assert classify_outcome("reject", "accept", "accepted") == "policy_failure"
    assert classify_outcome("accept", "review", "ambiguous_hard_evidence") == "evidence_failure"
    key = stable_artist_key("onlyfans:anonymous-test")
    case = SavedCase(key, "reject", "ugly", 1.0, "test", np.ones(4))
    memory = memory_summary({key: case}, {key: "reject"})
    assert memory["passed"] and memory["ugly_rejected"] == 1
    print("Local2 saved-cohort harness self-test: PASS")
    return 0


def validate_live_endpoint(endpoint: str, allow_remote: bool) -> None:
    parsed = urlparse(endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("--endpoint must be an HTTP(S) origin")
    if not allow_remote and parsed.hostname.lower() not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("live classification refuses non-loopback endpoint without --allow-remote-endpoint")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preference-db", type=Path, default=DEFAULT_PREFERENCE_DB)
    parser.add_argument("--local2-db", type=Path, default=DEFAULT_LOCAL2_DB)
    parser.add_argument("--audit", type=Path, default=DEFAULT_AUDIT)
    parser.add_argument("--folds", type=int, default=DEFAULT_FOLDS)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--preference-accept", type=float, default=PRODUCTION_PREFERENCE_ACCEPT)
    parser.add_argument("--minimum-accept-recall", type=float, default=MINIMUM_ACCEPT_RECALL)
    parser.add_argument("--minimum-reject-recall", type=float, default=MINIMUM_REJECT_RECALL)
    parser.add_argument("--report-only", action="store_true", help="Report quality misses without a failing exit code")
    parser.add_argument("--json", action="store_true", help="Print aggregate JSON")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--live", action="store_true", help="Opt in to image/network/model classification")
    parser.add_argument("--live-mode", choices=("exact", "holdout"), default="exact")
    parser.add_argument("--live-per-stratum", type=int, default=2)
    parser.add_argument("--live-timeout", type=float, default=180.0)
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--allow-remote-endpoint", action="store_true")
    args = parser.parse_args(argv)
    if args.folds < 2:
        parser.error("--folds must be at least 2")
    for name in ("preference_accept", "minimum_accept_recall", "minimum_reject_recall"):
        if not 0.0 <= getattr(args, name) <= 1.0:
            parser.error(f"--{name.replace('_', '-')} must be between 0 and 1")
    if args.live_per_stratum < 1 or args.live_per_stratum > 20:
        parser.error("--live-per-stratum must be between 1 and 20")
    if args.live_timeout < 10 or args.live_timeout > 600:
        parser.error("--live-timeout must be between 10 and 600 seconds")
    if args.live:
        try:
            validate_live_endpoint(args.endpoint, args.allow_remote_endpoint)
        except ValueError as error:
            parser.error(str(error))
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.self_test:
        return run_self_test()
    result = benchmark(args)
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print_report(result)
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
