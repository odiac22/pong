"""Fail-closed paired timing comparison for identical silent corpus runs."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import statistics

from benchmark_realtime_corpus import percentile, sha256_file


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-report", type=Path, required=True)
    parser.add_argument("--candidate-report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--minimum-median-percent", type=float, default=20.0)
    parser.add_argument("--minimum-p10-percent", type=float, default=5.0)
    args = parser.parse_args()

    baseline_path = args.baseline_report.resolve()
    candidate_path = args.candidate_report.resolve()
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    candidate = json.loads(candidate_path.read_text(encoding="utf-8"))
    failures = []
    if baseline.get("timingOnly") is not True or candidate.get("timingOnly") is not True:
        failures.append({"kind": "not-timing-only"})
    baseline_clips = list(baseline.get("clips") or [])
    candidate_clips = list(candidate.get("clips") or [])
    if len(baseline_clips) != len(candidate_clips) or len(baseline_clips) < 20:
        failures.append({
            "kind": "clip-count",
            "baseline": len(baseline_clips),
            "candidate": len(candidate_clips),
        })
    comparisons = []
    distinct_eligible = set()
    for index, baseline_clip in enumerate(baseline_clips):
        if index >= len(candidate_clips):
            break
        candidate_clip = candidate_clips[index]
        name = str(baseline_clip.get("clip") or "")
        item_failures = []
        if candidate_clip.get("clip") != name:
            item_failures.append({"kind": "clip-order"})
        source_hash = str(baseline_clip.get("sourceSha256") or "")
        if candidate_clip.get("sourceSha256") != source_hash or len(source_hash) != 64:
            item_failures.append({"kind": "source-sha256"})
        baseline_source = baseline_clip.get("source") or {}
        candidate_source = candidate_clip.get("source") or {}
        for field in ("width", "height", "fps", "frames"):
            if candidate_source.get(field) != baseline_source.get(field):
                item_failures.append({"kind": "source-interval", "field": field})
        for role, clip in (("baseline", baseline_clip), ("candidate", candidate_clip)):
            if clip.get("passed") is not True or clip.get("error"):
                item_failures.append({"kind": "operational-failure", "role": role})
            timing = clip.get("timing") or {}
            if float(timing.get("qualityDiagnosticSeconds", -1)) != 0.0:
                item_failures.append({"kind": "quality-time-present", "role": role})
            if float(timing.get("frameHashDiagnosticSeconds", -1)) != 0.0:
                item_failures.append({"kind": "hash-time-present", "role": role})
        baseline_fps = float((baseline_clip.get("timing") or {}).get("processingFps", 0.0))
        candidate_fps = float((candidate_clip.get("timing") or {}).get("processingFps", 0.0))
        uplift = (
            100.0 * (candidate_fps / baseline_fps - 1.0)
            if baseline_fps > 0 and math.isfinite(candidate_fps)
            else -math.inf
        )
        eligible = bool(
            (baseline_clip.get("eligibility") or {}).get("eligible")
            and (candidate_clip.get("eligibility") or {}).get("eligible")
        )
        if eligible:
            distinct_eligible.add(source_hash)
        comparisons.append({
            "clip": name,
            "sourceSha256": source_hash,
            "eligible": eligible,
            "baselineFps": baseline_fps,
            "candidateFps": candidate_fps,
            "upliftPercent": uplift,
            "failures": item_failures,
        })
        failures.extend({"clip": name, **failure} for failure in item_failures)

    distinct_values = []
    consumed = set()
    for item in comparisons:
        source_hash = item["sourceSha256"]
        if item["eligible"] and source_hash not in consumed:
            consumed.add(source_hash)
            distinct_values.append(float(item["upliftPercent"]))
    median_uplift = statistics.median(distinct_values) if distinct_values else -math.inf
    p10_uplift = percentile(distinct_values, 0.10) if distinct_values else -math.inf
    if len(distinct_eligible) < 20:
        failures.append({"kind": "distinct-eligible-count", "actual": len(distinct_eligible)})
    if not math.isfinite(median_uplift) or median_uplift < args.minimum_median_percent:
        failures.append({
            "kind": "median-speed",
            "minimumPercent": args.minimum_median_percent,
            "actualPercent": median_uplift,
        })
    if not math.isfinite(p10_uplift) or p10_uplift < args.minimum_p10_percent:
        failures.append({
            "kind": "p10-speed",
            "minimumPercent": args.minimum_p10_percent,
            "actualPercent": p10_uplift,
        })
    report = {
        "schema": "pong-paired-corpus-timing-v1",
        "baselineReport": str(baseline_path),
        "baselineReportSha256": sha256_file(baseline_path),
        "candidateReport": str(candidate_path),
        "candidateReportSha256": sha256_file(candidate_path),
        "comparisons": comparisons,
        "summary": {
            "clipCount": len(comparisons),
            "distinctEligibleClipCount": len(distinct_eligible),
            "medianUpliftPercent": median_uplift,
            "p10UpliftPercent": p10_uplift,
            "minimumMedianPercent": args.minimum_median_percent,
            "minimumP10Percent": args.minimum_p10_percent,
            "passed": not failures,
            "failures": failures,
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(args.output.resolve()), **report["summary"]}, indent=2))
    if failures:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
