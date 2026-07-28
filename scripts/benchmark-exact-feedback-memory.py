"""Offline, aggregate-only benchmark for exact Pong Save/Red-X memory.

No image, media, network, or service work is performed. The preference DB is
opened read-only/query-only, Train AI identities are excluded from timestamped
``auditedAt`` rows, and the production service:account lookup is replayed.
Artist URLs and identities are never printed.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Mapping, Sequence
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = (ROOT / ".pong-local-ai" / "preference-examples-v3.sqlite3").resolve()
DEFAULT_AUDIT = (ROOT / ".pong-local-ai" / "train-ai-verdict-audit.jsonl").resolve()
MINIMUM_DEFAULT = (217, 119, 98)
VALID_LABELS = {"accept", "reject"}


def artist_identity(raw: str) -> str:
    """Match preference_ai_service.artist_identity exactly."""
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


def load_service_records(db_path: Path) -> tuple[list[tuple[str, str, str]], int, int]:
    """Reproduce Store._load ordering and cross-mirror identity deduplication."""
    resolved = db_path.expanduser().resolve(strict=True)
    # Do not add immutable=1: it can ignore the live WAL and return stale data.
    connection = sqlite3.connect(f"{resolved.as_uri()}?mode=ro", uri=True)
    connection.execute("PRAGMA query_only = ON")
    if int(connection.execute("PRAGMA query_only").fetchone()[0]) != 1:
        connection.close()
        raise RuntimeError("SQLite query-only mode could not be enabled")
    try:
        rows = connection.execute(
            "SELECT record_json FROM preference_records ORDER BY updated_at DESC LIMIT 2000"
        ).fetchall()
    finally:
        connection.close()

    records: list[tuple[str, str, str]] = []
    seen: set[str] = set()
    malformed = 0
    for (raw_record,) in rows:
        try:
            parsed = json.loads(raw_record)
        except (TypeError, json.JSONDecodeError):
            malformed += 1
            continue
        if not isinstance(parsed, dict):
            malformed += 1
            continue
        identity = artist_identity(parsed.get("artistUrl", ""))
        if not identity or identity in seen:
            continue
        seen.add(identity)
        records.append((
            identity,
            str(parsed.get("label", "")).strip().lower(),
            str(parsed.get("workflow", "")).strip().lower(),
        ))
    return records, len(rows), malformed


def load_exact_feedback(db_path: Path) -> dict[str, str]:
    """Read the production exact-direct table created by the preference service."""
    resolved = db_path.expanduser().resolve(strict=True)
    connection = sqlite3.connect(f"{resolved.as_uri()}?mode=ro", uri=True)
    connection.execute("PRAGMA query_only = ON")
    try:
        rows = connection.execute(
            "SELECT artist_identity, label FROM exact_direct_feedback"
        ).fetchall()
    finally:
        connection.close()
    return {
        str(identity).strip().lower(): str(label).strip().lower()
        for identity, label in rows
        if str(identity).strip() and str(label).strip().lower() in VALID_LABELS
    }


def load_audited_identities(audit_path: Path) -> tuple[set[str], int, int]:
    identities: set[str] = set()
    parsed_rows = 0
    timestamped_rows = 0
    with audit_path.expanduser().resolve(strict=True).open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Train AI audit has invalid JSON on line {line_number}") from exc
            parsed_rows += 1
            if not isinstance(parsed, dict) or not parsed.get("auditedAt"):
                continue
            timestamped_rows += 1
            identity = artist_identity(parsed.get("artistUrl", ""))
            if identity:
                identities.add(identity)
    return identities, parsed_rows, timestamped_rows


def exact_feedback_lookup(exact: Mapping[str, str], identity: str) -> str | None:
    return exact.get(identity)


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--audit", type=Path, default=DEFAULT_AUDIT)
    parser.add_argument("--minimum-accuracy", type=float, default=0.95)
    parser.add_argument(
        "--no-default-count-assertion",
        action="store_true",
        help="Do not assert the 217 total / 119 Save / 98 Red-X minimum for the default files.",
    )
    args = parser.parse_args(argv)
    if not 0.0 <= args.minimum_accuracy <= 1.0:
        parser.error("--minimum-accuracy must be between 0 and 1")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    records, database_rows, malformed_rows = load_service_records(args.db)
    exact = load_exact_feedback(args.db)
    audited, audit_rows, timestamped_rows = load_audited_identities(args.audit)
    cohort = [
        record for record in records
        if record[2] in {"save", "red-x"} or (
            record[2] != "train-ai" and record[0] not in audited
        )
    ]

    save = sum(label == "accept" for _, label, _ in cohort)
    red_x = sum(label == "reject" for _, label, _ in cohort)
    correct = [
        (identity, label)
        for identity, label, _ in cohort
        if exact_feedback_lookup(exact, identity) == label
    ]
    save_correct = sum(label == "accept" for _, label in correct)
    red_x_correct = sum(label == "reject" for _, label in correct)
    accuracy = len(correct) / len(cohort) if cohort else 0.0
    excluded = len(records) - len(cohort)

    default_files = (
        args.db.expanduser().resolve() == DEFAULT_DB
        and args.audit.expanduser().resolve() == DEFAULT_AUDIT
    )
    check_expected = default_files and not args.no_default_count_assertion
    actual_counts = (len(cohort), save, red_x)
    expected_pass = not check_expected or all(
        actual >= minimum
        for actual, minimum in zip(actual_counts, MINIMUM_DEFAULT)
    )

    print("Exact direct-feedback memory benchmark (offline, aggregate-only)")
    print(f"Read-only source: {database_rows} database rows -> {len(records)} service identities")
    print(f"Production exact-direct store: {len(exact)} identities")
    print(
        f"Train AI exclusion: {timestamped_rows}/{audit_rows} timestamped audit rows, "
        f"{excluded} matching identities excluded"
    )
    print(f"Direct feedback cohort: {len(cohort)} total / {save} Save / {red_x} Red-X")
    print(
        f"Exact-memory correctness: {len(correct)}/{len(cohort)} ({accuracy:.2%}); "
        f"Save {save_correct}/{save}; Red-X {red_x_correct}/{red_x}"
    )
    print(
        f"Accuracy threshold: {args.minimum_accuracy:.2%} -> "
        f"{'PASS' if accuracy >= args.minimum_accuracy and cohort else 'FAIL'}"
    )
    if check_expected:
        print(f"Default live-data cohort minimum assertion: {'PASS' if expected_pass else 'FAIL'}")
    if malformed_rows:
        print(f"Malformed preference records skipped: {malformed_rows} -> FAIL")

    return 0 if cohort and accuracy >= args.minimum_accuracy and expected_pass and not malformed_rows else 1


if __name__ == "__main__":
    raise SystemExit(main())
