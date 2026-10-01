"""Audit every durable Pong Save/Red-X label without media or model work.

This benchmark reconciles the two stores that can originate direct feedback:

* ``preference-examples-v3.sqlite3`` for legacy/shared Save and Red-X actions;
* ``local2-clean-v2.sqlite3`` for Local2 numeric Save and Red-X actions.

It independently rebuilds the latest label for each one-way artist key, then
checks the production ``exact_direct_feedback`` lookup table against that
source-of-truth union. Artist identities and URLs are never printed. SQLite is
opened read-only/query-only; no image, media, network, model, or service I/O is
performed.
"""

from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
from typing import Iterable, Mapping, Sequence
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / ".pong-local-ai"
DEFAULT_PREFERENCE_DB = (DATA_DIR / "preference-examples-v3.sqlite3").resolve()
DEFAULT_LOCAL2_DB = (DATA_DIR / "local2-clean-v2.sqlite3").resolve()
DEFAULT_AUDIT = (DATA_DIR / "train-ai-verdict-audit.jsonl").resolve()
VALID_LABELS = {"accept", "reject"}

# These are floors, not frozen totals: later explicit feedback may grow the
# cohort. Falling below them means history disappeared and must fail loudly.
DEFAULT_MINIMUM_TOTAL = 303
DEFAULT_MINIMUM_ACCEPT = 178
DEFAULT_MINIMUM_REJECT = 125
DEFAULT_MINIMUM_UGLY_REJECT = 6


@dataclass(frozen=True)
class Feedback:
    artist_key: str
    updated_at: float
    label: str
    reason: str
    source: str


def artist_identity(raw: str) -> str:
    """Match preference_ai_service.artist_identity without exposing its value."""

    try:
        parsed = urlparse(str(raw or ""))
        parts = [part for part in parsed.path.split("/") if part]
        marker = next(
            (index for index, part in enumerate(parts) if part.lower() in {"u", "c"}),
            -1,
        )
        service = parts[marker + 1] if marker >= 0 and len(parts) > marker + 1 else ""
        account = parts[marker + 2] if marker >= 0 and len(parts) > marker + 2 else ""
        if service and account:
            return f"{service.lower()}:{account.lower()}"
        return parsed.path.rstrip("/").lower()
    except Exception:
        return ""


def stable_artist_key(identity: str) -> str:
    normalized = str(identity or "").strip().lower()
    if not normalized:
        return ""
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def feedback_timestamp(record: Mapping[str, object]) -> float:
    """Match the production fallback timestamp used for shared feedback."""

    try:
        value = str(
            record.get("learnedAt")
            or record.get("acceptedAt")
            or record.get("rejectedAt")
            or ""
        )
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0.0


def open_query_only(path: Path) -> sqlite3.Connection:
    resolved = path.expanduser().resolve(strict=True)
    # immutable=1 is intentionally absent because it can ignore a live WAL.
    connection = sqlite3.connect(f"{resolved.as_uri()}?mode=ro", uri=True)
    connection.execute("PRAGMA query_only = ON")
    if int(connection.execute("PRAGMA query_only").fetchone()[0]) != 1:
        connection.close()
        raise RuntimeError("SQLite query-only mode could not be enabled")
    return connection


def load_audited_keys(path: Path) -> tuple[set[str], dict[str, int]]:
    keys: set[str] = set()
    parsed_rows = 0
    timestamped_rows = 0
    with path.expanduser().resolve(strict=True).open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(
                    f"Train AI audit has invalid JSON on line {line_number}"
                ) from error
            parsed_rows += 1
            if not isinstance(record, dict) or not record.get("auditedAt"):
                continue
            timestamped_rows += 1
            key = stable_artist_key(artist_identity(record.get("artistUrl", "")))
            if key:
                keys.add(key)
    return keys, {
        "audit_rows": parsed_rows,
        "timestamped_audit_rows": timestamped_rows,
        "audited_identities": len(keys),
    }


def is_direct_shared_record(record: Mapping[str, object], key: str, audited: set[str]) -> bool:
    workflow = str(record.get("workflow", "")).strip().lower()
    if workflow == "train-ai":
        return False
    if workflow in {"save", "red-x"}:
        return True
    return bool(key and key not in audited)


def load_shared_feedback(
    db_path: Path, audited: set[str]
) -> tuple[list[Feedback], dict[str, int]]:
    connection = open_query_only(db_path)
    try:
        rows = connection.execute(
            "SELECT updated_at, record_json FROM preference_records "
            "ORDER BY updated_at DESC LIMIT 2000"
        ).fetchall()
    finally:
        connection.close()

    # Reproduce Store._load identity deduplication before separating direct
    # feedback from Train AI supervision.
    feedback: list[Feedback] = []
    seen: set[str] = set()
    malformed = 0
    duplicate_identities = 0
    excluded_train_ai = 0
    for database_updated_at, raw in rows:
        try:
            record = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            malformed += 1
            continue
        if not isinstance(record, dict):
            malformed += 1
            continue
        key = stable_artist_key(artist_identity(record.get("artistUrl", "")))
        if not key:
            malformed += 1
            continue
        if key in seen:
            duplicate_identities += 1
            continue
        seen.add(key)
        if not is_direct_shared_record(record, key, audited):
            excluded_train_ai += 1
            continue
        label = str(record.get("label", "")).strip().lower()
        if label not in VALID_LABELS:
            malformed += 1
            continue
        reason = str(
            record.get("rejectReason") or record.get("rejectReasonLabel") or ""
        ).strip()[:80]
        feedback.append(
            Feedback(
                artist_key=key,
                # Valid learnedAt timestamps reproduce local2_known_feedback.
                # The DB timestamp is a deterministic fallback for older rows.
                updated_at=feedback_timestamp(record) or float(database_updated_at),
                label=label,
                reason=reason,
                source="preference",
            )
        )
    return feedback, {
        "preference_database_rows": len(rows),
        "preference_service_identities": len(seen),
        "preference_direct_feedback": len(feedback),
        "preference_train_ai_excluded": excluded_train_ai,
        "preference_duplicate_identities": duplicate_identities,
        "preference_malformed": malformed,
    }


def load_local2_feedback(
    db_path: Path, audited: set[str]
) -> tuple[list[Feedback], dict[str, int]]:
    connection = open_query_only(db_path)
    try:
        rows = connection.execute(
            "SELECT artist_key, updated_at, label, reason_code, workflow "
            "FROM local2_examples ORDER BY updated_at DESC"
        ).fetchall()
    finally:
        connection.close()

    feedback: list[Feedback] = []
    malformed = 0
    excluded_train_ai = 0
    for artist_key, updated_at, label, reason, workflow in rows:
        key = str(artist_key or "").strip().lower()
        normalized_label = str(label or "").strip().lower()
        normalized_workflow = str(workflow or "").strip().lower()
        if len(key) != 64 or any(character not in "0123456789abcdef" for character in key):
            malformed += 1
            continue
        direct = normalized_workflow in {"save", "red-x"} or (
            normalized_workflow != "train-ai" and
            (bool(normalized_workflow) or key not in audited)
        )
        if not direct:
            excluded_train_ai += 1
            continue
        if normalized_label not in VALID_LABELS:
            malformed += 1
            continue
        feedback.append(
            Feedback(
                artist_key=key,
                updated_at=float(updated_at),
                label=normalized_label,
                reason=str(reason or "").strip()[:80],
                source="local2",
            )
        )
    return feedback, {
        "local2_database_rows": len(rows),
        "local2_direct_feedback": len(feedback),
        "local2_train_ai_excluded": excluded_train_ai,
        "local2_malformed": malformed,
    }


def latest_feedback(rows: Iterable[Feedback]) -> dict[str, Feedback]:
    latest: dict[str, Feedback] = {}
    # Local2 wins an exact timestamp tie because it is the newer direct store.
    source_priority = {"preference": 0, "local2": 1}
    for row in rows:
        previous = latest.get(row.artist_key)
        if previous is None or (
            row.updated_at,
            source_priority.get(row.source, 0),
        ) >= (
            previous.updated_at,
            source_priority.get(previous.source, 0),
        ):
            latest[row.artist_key] = row
    return latest


def load_exact_feedback(db_path: Path) -> tuple[dict[str, Feedback], dict[str, int]]:
    connection = open_query_only(db_path)
    try:
        rows = connection.execute(
            "SELECT artist_identity, updated_at, label, reason, source "
            "FROM exact_direct_feedback"
        ).fetchall()
    finally:
        connection.close()

    exact: dict[str, Feedback] = {}
    malformed = 0
    collisions = 0
    for identity, updated_at, label, reason, source in rows:
        key = stable_artist_key(str(identity or ""))
        normalized_label = str(label or "").strip().lower()
        if not key or normalized_label not in VALID_LABELS:
            malformed += 1
            continue
        if key in exact:
            collisions += 1
            continue
        exact[key] = Feedback(
            artist_key=key,
            updated_at=float(updated_at),
            label=normalized_label,
            reason=str(reason or "").strip()[:80],
            source=str(source or "").strip()[:40],
        )
    return exact, {
        "exact_database_rows": len(rows),
        "exact_identities": len(exact),
        "exact_malformed": malformed,
        "exact_hash_collisions": collisions,
    }


def compare_feedback(
    expected: Mapping[str, Feedback], exact: Mapping[str, Feedback]
) -> dict[str, object]:
    missing = [key for key in expected if key not in exact]
    mismatched = [
        key for key, row in expected.items()
        if key in exact and exact[key].label != row.label
    ]
    extra = [key for key in exact if key not in expected]
    matched = len(expected) - len(missing) - len(mismatched)
    expected_labels = Counter(row.label for row in expected.values())
    exact_labels = Counter(row.label for row in exact.values())
    ugly = [
        row for row in expected.values()
        if row.reason.strip().lower() == "ugly"
    ]
    ugly_rejects = sum(
        row.label == "reject" and
        exact.get(row.artist_key) is not None and
        exact[row.artist_key].label == "reject"
        for row in ugly
    )
    return {
        "source_truth_total": len(expected),
        "source_truth_accept": expected_labels["accept"],
        "source_truth_reject": expected_labels["reject"],
        "exact_total": len(exact),
        "exact_accept": exact_labels["accept"],
        "exact_reject": exact_labels["reject"],
        "matched": matched,
        "missing": len(missing),
        "mismatched": len(mismatched),
        "extra": len(extra),
        "accuracy": matched / len(expected) if expected else 0.0,
        "ugly_total": len(ugly),
        "ugly_rejected": ugly_rejects,
    }


def benchmark(
    preference_db: Path,
    local2_db: Path,
    audit_path: Path,
    *,
    enforce_default_floors: bool,
) -> dict[str, object]:
    audited, audit_stats = load_audited_keys(audit_path)
    shared, shared_stats = load_shared_feedback(preference_db, audited)
    local2, local2_stats = load_local2_feedback(local2_db, audited)
    expected = latest_feedback([*shared, *local2])
    exact, exact_stats = load_exact_feedback(preference_db)
    comparison = compare_feedback(expected, exact)
    overlap = len({row.artist_key for row in shared} & {row.artist_key for row in local2})
    malformed = (
        shared_stats["preference_malformed"]
        + local2_stats["local2_malformed"]
        + exact_stats["exact_malformed"]
        + exact_stats["exact_hash_collisions"]
    )
    floors_pass = not enforce_default_floors or (
        comparison["source_truth_total"] >= DEFAULT_MINIMUM_TOTAL
        and comparison["source_truth_accept"] >= DEFAULT_MINIMUM_ACCEPT
        and comparison["source_truth_reject"] >= DEFAULT_MINIMUM_REJECT
        and comparison["ugly_rejected"] >= DEFAULT_MINIMUM_UGLY_REJECT
    )
    passed = bool(
        expected
        and comparison["matched"] == comparison["source_truth_total"]
        and comparison["missing"] == 0
        and comparison["mismatched"] == 0
        and comparison["extra"] == 0
        and comparison["ugly_rejected"] == comparison["ugly_total"]
        and malformed == 0
        and floors_pass
    )
    return {
        "schema": "pong-comprehensive-feedback-memory-benchmark-v1",
        "safety": {
            "sqlite": "read-only/query-only; live WAL included",
            "identities_printed": False,
            "image_io": "none",
            "media_io": "none",
            "network_io": "none",
            "model_io": "none",
            "service_control": "none",
        },
        "sources": {
            **audit_stats,
            **shared_stats,
            **local2_stats,
            **exact_stats,
            "cross_store_identity_overlap": overlap,
        },
        "comparison": comparison,
        "default_floors": {
            "enforced": enforce_default_floors,
            "minimum_total": DEFAULT_MINIMUM_TOTAL,
            "minimum_accept": DEFAULT_MINIMUM_ACCEPT,
            "minimum_reject": DEFAULT_MINIMUM_REJECT,
            "minimum_ugly_reject": DEFAULT_MINIMUM_UGLY_REJECT,
            "passed": floors_pass,
        },
        "passed": passed,
    }


def print_report(result: Mapping[str, object]) -> None:
    sources = result["sources"]
    comparison = result["comparison"]
    floors = result["default_floors"]
    print("Comprehensive exact-history feedback benchmark")
    print(
        "Safety: both SQLite databases query-only; no identities, images, media, "
        "network, models, playback, or service control"
    )
    print(
        "Sources: "
        f"{sources['preference_direct_feedback']} shared direct + "
        f"{sources['local2_direct_feedback']} Local2 direct; "
        f"{sources['cross_store_identity_overlap']} cross-store overlap"
    )
    print(
        "Latest direct-feedback truth: "
        f"{comparison['source_truth_total']} total / "
        f"{comparison['source_truth_accept']} Save / "
        f"{comparison['source_truth_reject']} Red-X"
    )
    print(
        "Exact-memory correctness: "
        f"{comparison['matched']}/{comparison['source_truth_total']} "
        f"({comparison['accuracy']:.2%}); missing {comparison['missing']}, "
        f"mismatched {comparison['mismatched']}, extra {comparison['extra']}"
    )
    print(
        "Ugly-reason protection: "
        f"{comparison['ugly_rejected']}/{comparison['ugly_total']} exact rejects"
    )
    print(
        "Train AI separation: "
        f"{sources['preference_train_ai_excluded']} shared and "
        f"{sources['local2_train_ai_excluded']} Local2 rows excluded"
    )
    if floors["enforced"]:
        print(
            "Historical floors: "
            f"{floors['minimum_total']} total / {floors['minimum_accept']} Save / "
            f"{floors['minimum_reject']} Red-X / "
            f"{floors['minimum_ugly_reject']} ugly rejects -> "
            f"{'PASS' if floors['passed'] else 'FAIL'}"
        )
    print(f"Overall: {'PASS' if result['passed'] else 'FAIL'}")


def run_self_test() -> int:
    key_a = stable_artist_key("onlyfans:example-a")
    key_b = stable_artist_key("fansly:example-b")
    source = latest_feedback([
        Feedback(key_a, 1.0, "accept", "", "preference"),
        Feedback(key_a, 2.0, "reject", "not-my-taste", "local2"),
        Feedback(key_b, 1.0, "reject", "ugly", "preference"),
    ])
    exact = {
        key_a: Feedback(key_a, 2.0, "reject", "not-my-taste", "exact"),
        key_b: Feedback(key_b, 1.0, "reject", "ugly", "exact"),
    }
    matched = compare_feedback(source, exact)
    assert matched["matched"] == 2
    assert matched["mismatched"] == 0
    assert matched["ugly_rejected"] == matched["ugly_total"] == 1
    broken = dict(exact)
    broken[key_b] = Feedback(key_b, 1.0, "accept", "ugly", "exact")
    mismatch = compare_feedback(source, broken)
    assert mismatch["mismatched"] == 1
    assert mismatch["ugly_rejected"] == 0
    print("Comprehensive feedback-memory self-test: PASS (latest-wins, mismatch, ugly guard)")
    return 0


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preference-db", type=Path, default=DEFAULT_PREFERENCE_DB)
    parser.add_argument("--local2-db", type=Path, default=DEFAULT_LOCAL2_DB)
    parser.add_argument("--audit", type=Path, default=DEFAULT_AUDIT)
    parser.add_argument("--json", action="store_true", help="Print aggregate JSON only")
    parser.add_argument("--self-test", action="store_true", help="Run pure in-memory reconciliation tests")
    parser.add_argument(
        "--no-default-count-assertion",
        action="store_true",
        help="Disable the live default-store historical floor assertions",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.self_test:
        return run_self_test()
    default_files = (
        args.preference_db.expanduser().resolve() == DEFAULT_PREFERENCE_DB
        and args.local2_db.expanduser().resolve() == DEFAULT_LOCAL2_DB
        and args.audit.expanduser().resolve() == DEFAULT_AUDIT
    )
    result = benchmark(
        args.preference_db,
        args.local2_db,
        args.audit,
        enforce_default_floors=default_files and not args.no_default_count_assertion,
    )
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print_report(result)
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
