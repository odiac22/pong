"""One-time fail-closed migration for an in-process GPEN builder certificate.

The first qualifier-built artifact recorded builderOptimizationLevel in the
invocation identity but omitted it from the duplicated `build` object. This
tool may only migrate artifacts carrying facts that the external-plan path
cannot produce: positive buildMs, a generated timing-cache hash, tactic-source
metadata, and no externalPlan marker. Original hashes are retained in both
published documents; engine bytes are never touched.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path


def digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def atomic_json(path: Path, payload: dict) -> None:
    encoded = json.dumps(payload, indent=2, allow_nan=False).encode("utf-8")
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    try:
        temporary.write_bytes(encoded)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("report", type=Path)
    args = parser.parse_args()
    report_path = args.report.resolve()
    original_report_bytes = report_path.read_bytes()
    report = json.loads(original_report_bytes.decode("utf-8"))
    plan_path = Path(str(report.get("plan") or "")).resolve()
    manifest_path = Path(str(plan_path) + ".manifest.json")
    original_manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(original_manifest_bytes.decode("utf-8"))
    build = report.get("build")
    identity = report.get("identity") or {}
    plan_hash = digest(plan_path.read_bytes())
    failures = []
    if report.get("status") != "pass" or report.get("qualityPass") is not True:
        failures.append("qualification did not pass")
    if report.get("planSha256") != plan_hash or manifest.get("planSha256") != plan_hash:
        failures.append("plan hash mismatch")
    if manifest.get("reportSha256") != digest(original_report_bytes):
        failures.append("original report hash mismatch")
    if not isinstance(build, dict) or manifest.get("build") != build:
        failures.append("build objects do not match")
    elif (
        float(build.get("buildMs", 0.0)) <= 0.0
        or not str(build.get("timingCacheOutputSha256") or "")
        or "tacticSourcesMask" not in build
        or "externalPlan" in build
    ):
        failures.append("artifact lacks in-process builder-only evidence")
    if int(identity.get("builderOptimizationLevel", -1)) != 5:
        failures.append("invocation identity did not record optimization level 5")
    if identity.get("buildRecipeVersion") != "strict-fp32-builder-v2":
        failures.append("unexpected build recipe")
    if failures:
        raise RuntimeError("certificate migration rejected: " + "; ".join(failures))

    migration = {
        "schema": "pong-gpen-certificate-migration-v1",
        "reason": "copy recorded builderOptimizationLevel into build metadata",
        "originalReportSha256": digest(original_report_bytes),
        "originalManifestSha256": digest(original_manifest_bytes),
        "planSha256": plan_hash,
        "engineBytesModified": False,
        "evidence": {
            "identityBuilderOptimizationLevel": 5,
            "buildMs": build["buildMs"],
            "tacticSourcesMask": build["tacticSourcesMask"],
            "timingCacheOutputSha256": build["timingCacheOutputSha256"],
        },
    }
    migrated_build = dict(build)
    migrated_build["builderOptimizationLevel"] = 5
    migrated_build["externalPlan"] = False
    report["build"] = migrated_build
    report["certificateMigration"] = migration
    atomic_json(report_path, report)

    migrated_report_bytes = report_path.read_bytes()
    manifest["build"] = migrated_build
    manifest["reportSha256"] = digest(migrated_report_bytes)
    manifest["certificateMigration"] = migration
    atomic_json(manifest_path, manifest)
    print(json.dumps({
        "report": str(report_path),
        "manifest": str(manifest_path),
        "planSha256": plan_hash,
        "migratedReportSha256": digest(migrated_report_bytes),
        "migration": migration,
    }, indent=2))


if __name__ == "__main__":
    main()
