"""Publish a fail-closed adoption certificate for an already-built GPEN plan.

The plan bytes are never changed.  Adoption is allowed only after the exact
bytes pass generated numerical/temporal qualification, a strict temporal and
occlusion promotion gate, and a distinct 20+ clip holdout run.  This preserves
truthful ``externalPlan: true`` provenance instead of pretending the plan was
built by the qualification invocation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path


KINDS = {"ramp", "checker", "bars", "noise", "impulse", "constant"}
GATES = {
    "mae": 0.10,
    "p99Abs": 1.0,
    "maxAbs": 4.0,
    "psnrDb": 50.0,
    "ssim": 0.999,
    "temporalMae": 0.20,
}


def digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    return digest(path.read_bytes())


def atomic_json(path: Path, payload: dict) -> None:
    encoded = json.dumps(payload, indent=2, allow_nan=False).encode("utf-8")
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    try:
        temporary.write_bytes(encoded)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def validate_generated_qualification(report: dict, plan_hash: str) -> None:
    require(report.get("status") == "pass", "qualification status did not pass")
    require(report.get("qualityPass") is True, "qualification quality did not pass")
    require(report.get("planSha256") == plan_hash, "qualification plan hash mismatch")
    require(report.get("qualityGates") == GATES, "qualification gates changed")
    fixtures = report.get("fixtures")
    require(isinstance(fixtures, list), "qualification fixtures are missing")
    observed = {kind: set() for kind in KINDS}
    seen = set()
    for index, item in enumerate(fixtures):
        require(isinstance(item, dict), f"fixture {index} is not an object")
        kind, step = item.get("kind"), item.get("step")
        require(kind in KINDS, f"fixture {index} has unknown kind")
        require(isinstance(step, int) and not isinstance(step, bool), f"fixture {index} step")
        require((kind, step) not in seen, f"duplicate fixture {(kind, step)}")
        seen.add((kind, step))
        observed[kind].add(step)
        require(item.get("pass") is True, f"fixture {(kind, step)} did not pass")
        for metric in ("mae", "p99Abs", "maxAbs", "psnrDb", "ssim"):
            value = item.get(metric)
            require(
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(float(value)),
                f"fixture {(kind, step)} invalid {metric}",
            )
        require(0.0 <= float(item["mae"]) <= GATES["mae"], "fixture mae gate")
        require(0.0 <= float(item["p99Abs"]) <= GATES["p99Abs"], "fixture p99 gate")
        require(0.0 <= float(item["maxAbs"]) <= GATES["maxAbs"], "fixture max gate")
        require(float(item["psnrDb"]) >= GATES["psnrDb"], "fixture psnr gate")
        require(GATES["ssim"] <= float(item["ssim"]) <= 1.0, "fixture ssim gate")
        if step > 0:
            temporal = item.get("temporalMae")
            require(item.get("temporalPass") is True, "fixture temporal pass")
            require(
                isinstance(temporal, (int, float))
                and not isinstance(temporal, bool)
                and 0.0 <= float(temporal) <= GATES["temporalMae"],
                "fixture temporal gate",
            )
    require(all({0, 1}.issubset(steps) for steps in observed.values()), "fixture coverage")
    reference = report.get("reference") or {}
    candidate = report.get("candidate") or {}
    require(int(reference.get("count", 0)) >= 8, "reference timing count")
    require(int(candidate.get("count", 0)) >= 8, "candidate timing count")
    require(
        0.0 < float(candidate.get("p50Ms", math.inf))
        < float(reference.get("p50Ms", -math.inf)),
        "candidate timing did not improve",
    )


def warm_plan(document: dict) -> dict:
    return (((document.get("warm") or {}).get("restorers") or {}).get("512") or {})


def validate_strict(report: dict, plan_path: Path, plan_hash: str) -> None:
    require(report.get("schema") == "pong-temporal-attachment-v1", "strict schema")
    gate = report.get("promotionGate") or {}
    require(gate.get("passed") is True, "strict promotion gate failed")
    require(gate.get("expectedPlanSha256") == plan_hash, "strict plan hash")
    require(float(gate.get("minimumSpeedupPercent", 0.0)) >= 20.0, "strict speed gate")
    summary = report.get("summary") or {}
    require(summary.get("noErrors") is True and summary.get("allSilent") is True, "strict run")
    clips = list(report.get("clips") or [])
    require(len(clips) >= 3, "strict clip count")
    require(
        all(
            (clip.get("checks") or {}).get("identityProof") is True
            and (clip.get("checks") or {}).get("noError") is True
            for clip in clips
        ),
        "strict identity/error proof",
    )
    require(
        any(int((clip.get("quality") or {}).get("occlusionCoreSampleCount", 0)) > 0 for clip in clips),
        "strict occlusion evidence",
    )
    warm = warm_plan(report)
    require(
        warm.get("nativePlanSha256") == plan_hash
        and warm.get("nativePlanQualified") is True
        and warm.get("effectiveBackend") == "native-trt",
        "strict run did not use qualified native plan",
    )
    configured = Path(str(report["configuration"]["runtime"]["restorerNativeTrtQualifiedPlan"]))
    require(configured.resolve() == plan_path, "strict configuration plan mismatch")


def validate_holdout(report: dict, plan_path: Path, plan_hash: str) -> None:
    require(report.get("schema") == "pong-realtime-corpus-v1", "holdout schema")
    summary = report.get("summary") or {}
    require(summary.get("allClipsPassed") is True, "holdout failed")
    require(int(summary.get("distinctEligibleClipCount", 0)) >= 20, "holdout distinct clips")
    require(int(summary.get("failedClips", -1)) == 0, "holdout clip failure")
    warm = warm_plan(report)
    require(
        warm.get("nativePlanSha256") == plan_hash
        and warm.get("nativePlanQualified") is True
        and warm.get("effectiveBackend") == "native-trt",
        "holdout did not use qualified native plan",
    )
    configured = Path(str(report["configuration"]["runtime"]["restorerNativeTrtQualifiedPlan"]))
    require(configured.resolve() == plan_path, "holdout configuration plan mismatch")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("plan", type=Path)
    parser.add_argument("--strict-report", type=Path, required=True)
    parser.add_argument("--holdout-report", type=Path, required=True)
    args = parser.parse_args()

    plan_path = args.plan.resolve()
    manifest_path = Path(str(plan_path) + ".manifest.json")
    original_manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(original_manifest_bytes.decode("utf-8"))
    report_path = Path(str(manifest.get("report") or "")).resolve()
    original_report_bytes = report_path.read_bytes()
    report = json.loads(original_report_bytes.decode("utf-8"))
    plan_hash = sha256_file(plan_path)

    require(manifest.get("planSha256") == plan_hash, "manifest plan hash mismatch")
    require(report.get("planSha256") == plan_hash, "report plan hash mismatch")
    require(manifest.get("reportSha256") == digest(original_report_bytes), "report hash mismatch")
    require((manifest.get("build") or {}).get("externalPlan") is True, "plan is not external")
    require(report.get("build") == manifest.get("build"), "build metadata mismatch")
    validate_generated_qualification(report, plan_hash)

    strict_path = args.strict_report.resolve()
    strict = json.loads(strict_path.read_text(encoding="utf-8"))
    validate_strict(strict, plan_path, plan_hash)
    holdout_path = args.holdout_report.resolve()
    holdout = json.loads(holdout_path.read_text(encoding="utf-8"))
    validate_holdout(holdout, plan_path, plan_hash)

    prior_adoption = manifest.get("externalPlanAdoption") or {}
    adoption = {
        "schema": "pong-gpen-external-plan-adoption-v1",
        "planSha256": plan_hash,
        "planBytes": plan_path.stat().st_size,
        "engineBytesModified": False,
        "originalReportSha256": prior_adoption.get(
            "originalReportSha256", digest(original_report_bytes)
        ),
        "originalManifestSha256": prior_adoption.get(
            "originalManifestSha256", digest(original_manifest_bytes)
        ),
        "evidence": {
            "strictTemporal": {
                "path": str(strict_path),
                "sha256": sha256_file(strict_path),
            },
            "holdoutCorpus": {
                "path": str(holdout_path),
                "sha256": sha256_file(holdout_path),
            },
        },
    }
    report["externalPlanAdoption"] = adoption
    atomic_json(report_path, report)
    manifest["externalPlanAdoption"] = adoption
    manifest["reportSha256"] = sha256_file(report_path)
    atomic_json(manifest_path, manifest)
    print(json.dumps({
        "plan": str(plan_path),
        "planSha256": plan_hash,
        "report": str(report_path),
        "reportSha256": sha256_file(report_path),
        "manifest": str(manifest_path),
        "adoption": adoption,
    }, indent=2))


if __name__ == "__main__":
    main()
