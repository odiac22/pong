"""Compare temporal attachment quality on paired, already-rendered corpora.

The renderer is not timed here. Both baseline and candidate videos are decoded
over the same complete interval and evaluated by the same detector in one
process. The report fails closed per distinct source clip: no aggregate can
hide a regression in attachment, motion, edges, occlusion, or face detail.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import statistics

import av

from benchmark_realtime_corpus import (
    CORPUS_ROOT,
    STOCK_FACE,
    identity_score,
    sha256_file,
)
from benchmark_temporal_attachment import (
    PROMOTION_LOWER_IS_BETTER,
    analyze_pair,
)
from pong_swap_engine import PongSwapEngine


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-report", type=Path, required=True)
    parser.add_argument("--candidate-report", type=Path, required=True)
    parser.add_argument("--strict-evidence-report", type=Path, required=True)
    parser.add_argument("--expected-plan-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seconds", type=float, default=5.25)
    parser.add_argument("--sample-fps", type=float, default=10.0)
    args = parser.parse_args()

    baseline_path = args.baseline_report.resolve()
    candidate_path = args.candidate_report.resolve()
    strict_evidence_path = args.strict_evidence_report.resolve()
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    candidate = json.loads(candidate_path.read_text(encoding="utf-8"))
    strict_evidence = json.loads(strict_evidence_path.read_text(encoding="utf-8"))
    baseline_by_name = {
        str(item.get("clip") or ""): item for item in baseline.get("clips", [])
    }
    candidate_by_name = {
        str(item.get("clip") or ""): item for item in candidate.get("clips", [])
    }

    baseline_config = baseline.get("configuration")
    candidate_config = candidate.get("configuration")
    global_failures = []
    if not isinstance(baseline_config, dict) or not isinstance(candidate_config, dict):
        raise TypeError("paired reports must contain their effective configuration")
    # User-visible appearance parameters are frozen. Runtime scheduling and
    # backends may differ, but the complete parameter object must be identical.
    if baseline_config.get("parameters") != candidate_config.get("parameters"):
        global_failures.append({"kind": "protected-parameters-changed"})
    if (
        (baseline.get("provenance") or {}).get("modelSha256")
        != (candidate.get("provenance") or {}).get("modelSha256")
    ):
        global_failures.append({"kind": "model-identity-changed"})
    candidate_config_sha = hashlib.sha256(json.dumps(
        candidate_config,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")).hexdigest()
    if (candidate.get("provenance") or {}).get("configurationSha256") != candidate_config_sha:
        global_failures.append({"kind": "candidate-configuration-hash"})
    candidate_restorer = (
        ((candidate.get("warm") or {}).get("restorers") or {}).get("512") or {}
    )
    if (
        candidate_restorer.get("effectiveBackend") != "native-trt"
        or candidate_restorer.get("nativePlanQualified") is not True
        or candidate_restorer.get("nativePlanSha256") != args.expected_plan_sha256
    ):
        global_failures.append({"kind": "candidate-plan-identity"})
    strict_config = strict_evidence.get("configuration")
    if strict_config != candidate_config:
        global_failures.append({"kind": "strict-evidence-configuration"})
    strict_restorer = (
        ((strict_evidence.get("warm") or {}).get("restorers") or {}).get("512") or {}
    )
    strict_gate = strict_evidence.get("promotionGate") or {}
    if (
        strict_gate.get("passed") is not True
        or strict_restorer.get("nativePlanSha256") != args.expected_plan_sha256
        or strict_restorer.get("nativePlanQualified") is not True
    ):
        global_failures.append({"kind": "strict-promotion-evidence"})
    strict_clips = list(strict_evidence.get("clips") or [])
    if not strict_clips or any(
        (clip.get("checks") or {}).get("identityProof") is not True
        for clip in strict_clips
    ):
        global_failures.append({"kind": "strict-identity-evidence"})
    occlusion_clips = [
        clip for clip in strict_clips
        if int((clip.get("quality") or {}).get("occlusionCoreSampleCount", 0)) > 0
    ]
    if not occlusion_clips or any(
        int((clip.get("encoded") or {}).get("audioStreams", -1)) != 0
        or (clip.get("checks") or {}).get("identityProof") is not True
        for clip in occlusion_clips
    ):
        global_failures.append({"kind": "strict-occlusion-evidence"})

    config = deepcopy(candidate_config)
    if not isinstance(config, dict):
        raise TypeError("paired reports must contain their effective configuration")
    config.setdefault("runtime", {})["swapAudioEnabled"] = False
    # Quality analysis needs only the already-shared detector. Avoid warming a
    # restorer or mask graph whose pixels have already been encoded in both
    # inputs; this cannot alter the measurements and keeps the evaluator pure.
    config.setdefault("parameters", {})["RestorerSwitch"] = False
    config["parameters"]["OccluderSwitch"] = False
    config["parameters"]["FaceParserSwitch"] = False

    engine = PongSwapEngine()
    engine._config = config
    engine.warm(config=config, allow_create_selected=True)
    source_embedding = engine.embedding_from_images((STOCK_FACE,), config)
    comparisons = []
    frozen_eligible = []
    seen_sources = set()
    for name, baseline_clip in baseline_by_name.items():
        source_hash = str(baseline_clip.get("sourceSha256") or "")
        if (
            (baseline_clip.get("eligibility") or {}).get("eligible")
            and source_hash not in seen_sources
        ):
            seen_sources.add(source_hash)
            frozen_eligible.append((name, baseline_clip, source_hash))

    def paired_identity_gains(source_path: Path, output_path: Path) -> dict:
        source_container = av.open(str(source_path))
        output_container = av.open(str(output_path))
        source_stream = next(item for item in source_container.streams if item.type == "video")
        output_stream = next(item for item in output_container.streams if item.type == "video")
        fps = float(source_stream.average_rate or source_stream.base_rate or 24.0)
        stride = max(1, int(round(fps / 2.0)))
        source_iterator = iter(source_container.decode(source_stream))
        output_iterator = iter(output_container.decode(output_stream))
        gains = []
        paired_frames = 0
        try:
            while paired_frames < max(1, int(math.ceil(args.seconds * fps))):
                try:
                    source_rgb = next(source_iterator).to_ndarray(format="rgb24")
                    output_rgb = next(output_iterator).to_ndarray(format="rgb24")
                except StopIteration:
                    break
                if paired_frames % stride == 0:
                    before = identity_score(engine, source_rgb, source_embedding)
                    after = identity_score(engine, output_rgb, source_embedding)
                    if before is not None and after is not None:
                        gains.append(float(after - before))
                paired_frames += 1
        finally:
            source_container.close()
            output_container.close()
        return {
            "pairedFrameCount": paired_frames,
            "gainSamples": gains,
            "medianGain": statistics.median(gains) if gains else None,
        }

    try:
        for name, baseline_clip, source_hash in frozen_eligible:
            candidate_clip = candidate_by_name.get(name)
            failures = []
            if candidate_clip is None:
                comparisons.append({
                    "clip": name,
                    "sourceSha256": source_hash,
                    "failures": [{"kind": "missing-candidate-clip"}],
                })
                continue
            if not (candidate_clip.get("eligibility") or {}).get("eligible"):
                failures.append({"kind": "candidate-eligibility-regression"})
            if candidate_clip.get("sourceSha256") != source_hash:
                failures.append({"kind": "source-sha256"})
            source_path = CORPUS_ROOT / name
            baseline_output = Path(str(baseline_clip.get("output") or ""))
            candidate_output = Path(str(candidate_clip.get("output") or ""))
            for role, path in (
                ("source", source_path),
                ("baseline", baseline_output),
                ("candidate", candidate_output),
            ):
                if not path.is_file():
                    failures.append({"kind": "missing-file", "role": role})
            if source_path.is_file() and sha256_file(source_path) != source_hash:
                failures.append({"kind": "source-bytes-changed"})
            for role, path, clip in (
                ("baseline", baseline_output, baseline_clip),
                ("candidate", candidate_output, candidate_clip),
            ):
                if path.is_file() and sha256_file(path) != str(clip.get("outputSha256") or ""):
                    failures.append({"kind": "output-sha256", "role": role})
            for role, clip in (("baseline", baseline_clip), ("candidate", candidate_clip)):
                encoded = clip.get("encoded") or {}
                if int(encoded.get("audioStreams", -1)) != 0:
                    failures.append({"kind": "audio-present", "role": role})
                if int(encoded.get("videoStreams", -1)) != 1:
                    failures.append({"kind": "video-stream-count", "role": role})
            baseline_frames = int((baseline_clip.get("source") or {}).get("frames", -1))
            candidate_frames = int((candidate_clip.get("source") or {}).get("frames", -2))
            if candidate_frames != baseline_frames:
                failures.append({
                    "kind": "frame-interval-mismatch",
                    "baseline": baseline_frames,
                    "candidate": candidate_frames,
                })
            if failures:
                comparisons.append({"clip": name, "sourceSha256": source_hash, "failures": failures})
                continue

            baseline_quality = analyze_pair(
                engine,
                source_path,
                baseline_output,
                max_seconds=args.seconds,
                sample_fps=args.sample_fps,
                occlusion_fixture=False,
            )
            candidate_quality = analyze_pair(
                engine,
                source_path,
                candidate_output,
                max_seconds=args.seconds,
                sample_fps=args.sample_fps,
                occlusion_fixture=False,
            )
            for role, quality in (
                ("baseline", baseline_quality),
                ("candidate", candidate_quality),
            ):
                if int(quality.get("decodedPairFrameCount", 0)) < baseline_frames:
                    failures.append({
                        "kind": "incomplete-decoded-interval",
                        "role": role,
                        "expectedFrames": baseline_frames,
                        "actualFrames": quality.get("decodedPairFrameCount"),
                    })
                if int(quality.get("sampleCount", 0)) < 20:
                    failures.append({
                        "kind": "insufficient-temporal-samples",
                        "role": role,
                        "actual": quality.get("sampleCount"),
                    })
            if int(candidate_quality.get("sampleCount", 0)) < int(
                baseline_quality.get("sampleCount", 0)
            ):
                failures.append({
                    "kind": "sample-count",
                    "baseline": baseline_quality.get("sampleCount"),
                    "candidate": candidate_quality.get("sampleCount"),
                })
            stock_metrics = PROMOTION_LOWER_IS_BETTER[:5]
            for metric in stock_metrics:
                baseline_value = baseline_quality.get(metric)
                candidate_value = candidate_quality.get(metric)
                if (
                    baseline_value is None
                    or candidate_value is None
                    or not math.isfinite(float(baseline_value))
                    or not math.isfinite(float(candidate_value))
                ):
                    failures.append({"kind": "missing", "metric": metric})
                elif float(candidate_value) > float(baseline_value) + 1e-12:
                    failures.append({
                        "kind": "quality-regression",
                        "metric": metric,
                        "baseline": baseline_value,
                        "candidate": candidate_value,
                    })
            baseline_sharpness = baseline_quality.get("sharpnessMedian")
            candidate_sharpness = candidate_quality.get("sharpnessMedian")
            if (
                baseline_sharpness is None
                or candidate_sharpness is None
                or not math.isfinite(float(candidate_sharpness))
                or float(candidate_sharpness) + 1e-12 < float(baseline_sharpness)
            ):
                failures.append({
                    "kind": "quality-regression",
                    "metric": "sharpnessMedian",
                    "baseline": baseline_sharpness,
                    "candidate": candidate_sharpness,
                })
            identity = paired_identity_gains(source_path, candidate_output)
            if (
                int(identity.get("pairedFrameCount", 0)) < baseline_frames
                or len(identity.get("gainSamples") or []) < 4
                or identity.get("medianGain") is None
                or float(identity["medianGain"]) <= 0.25
            ):
                failures.append({
                    "kind": "identity-transformation-proof",
                    "evidence": identity,
                })
            comparisons.append({
                "clip": name,
                "sourceSha256": source_hash,
                "baselineOutputSha256": sha256_file(baseline_output),
                "candidateOutputSha256": sha256_file(candidate_output),
                "baseline": baseline_quality,
                "candidate": candidate_quality,
                "identity": identity,
                "failures": failures,
                "passed": not failures,
            })
            print(json.dumps({
                "clip": name,
                "passed": not failures,
                "samples": candidate_quality.get("sampleCount"),
                "failures": failures,
            }), flush=True)
    finally:
        engine.unload()
        engine.shutdown_gpu_worker()

    passed = sum(1 for item in comparisons if not item.get("failures"))
    report = {
        "schema": "pong-paired-strict-corpus-quality-v1",
        "baselineReport": str(baseline_path),
        "baselineReportSha256": sha256_file(baseline_path),
        "candidateReport": str(candidate_path),
        "candidateReportSha256": sha256_file(candidate_path),
        "strictEvidenceReport": str(strict_evidence_path),
        "strictEvidenceReportSha256": sha256_file(strict_evidence_path),
        "expectedPlanSha256": args.expected_plan_sha256,
        "completeMatchedIntervalSeconds": float(args.seconds),
        "sampleFps": float(args.sample_fps),
        "comparisons": comparisons,
        "summary": {
            "distinctEligibleClipCount": len(comparisons),
            "passedClipCount": passed,
            "failedClipCount": len(comparisons) - passed,
            "globalFailures": global_failures,
            "allPassed": (
                len(frozen_eligible) >= 20
                and len(comparisons) == len(frozen_eligible)
                and passed == len(comparisons)
                and not global_failures
            ),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(args.output.resolve()), **report["summary"]}, indent=2))
    if not report["summary"]["allPassed"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
