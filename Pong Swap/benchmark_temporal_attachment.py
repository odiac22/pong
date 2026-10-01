"""Silent temporal-attachment benchmark for Pong Swap.

This benchmark is intentionally separate from the 20-clip production gate. It
uses user-selected, approved local identity conditioning and public stock video
fixtures to measure attachment stability, temporal flicker, occlusion
preservation, and processing speed. It never exports source identity images or
intermediate face crops.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import subprocess
import time
from collections import defaultdict
from copy import deepcopy
from pathlib import Path

import av
import cv2
import numpy as np

from benchmark_realtime_corpus import (
    benchmark_clip,
    detect_on_engine_stream,
    encoder,
    percentile,
    probe_output,
)
from pong_swap_config import MODELS_DIR
from pong_swap_engine import PongSwapEngine
from semantic_landmarks import (
    FAN_2D_68_PATH,
    FAN_68_5_PATH,
    SemanticLandmarkEstimator,
)


ROOT = Path(__file__).resolve().parent
BENCHMARK_ROOT = ROOT / "benchmarks" / "temporal-attachment-20260919"
DEFAULT_INPUT = BENCHMARK_ROOT / "input"

PROMOTION_LOWER_IS_BETTER = (
    "attachmentPoseDeltaP95",
    "attachmentPoseAccelerationP95",
    "motionFidelityErrorP95",
    "featureRelationChangeP95",
    "boundaryFlickerMaeP95",
    "occlusionCoreBadRatioP95",
    "occlusionCoreBadRatioMax",
    "occlusionCorePositiveViolationCount",
)


def evaluate_promotion_gate(
    candidate: dict,
    baseline: dict,
    *,
    minimum_speedup_percent: float,
    expected_plan_sha256: str | None,
    require_frame_hash_equivalence: bool = False,
) -> dict:
    """Fail closed on every frozen per-fixture quality and speed contract."""
    failures: list[dict[str, object]] = []
    candidate_clips = list(candidate.get("clips") or [])
    baseline_clips = list(baseline.get("clips") or [])
    if len(candidate_clips) != len(baseline_clips) or len(candidate_clips) != 3:
        failures.append({
            "kind": "fixture-count",
            "expected": len(baseline_clips),
            "actual": len(candidate_clips),
        })
    for index, baseline_clip in enumerate(baseline_clips):
        if index >= len(candidate_clips):
            break
        candidate_clip = candidate_clips[index]
        baseline_name = Path(str(baseline_clip.get("clip", ""))).name
        candidate_name = Path(str(candidate_clip.get("clip", ""))).name
        if candidate_name != baseline_name:
            failures.append({
                "kind": "fixture-identity",
                "expected": baseline_name,
                "actual": candidate_name,
            })
            continue
        if candidate_clip.get("error"):
            failures.append({"kind": "fixture-error", "clip": candidate_name})
        # Some frozen fixtures predate the identity-aware proof and therefore
        # fail the coarse pixel-delta `transformationApplied` heuristic even in
        # the accepted baseline.  Promotion must never require a candidate to
        # satisfy a check its baseline does not satisfy.  It must preserve every
        # check the baseline *does* satisfy, while the metric and identity gates
        # below independently fail closed on quality and transformation proof.
        baseline_checks = baseline_clip.get("checks") or {}
        candidate_checks = candidate_clip.get("checks") or {}
        for check_name in (
            "decodedFiveSeconds",
            "faceDetected",
            "identityProof",
            "durationPreserved",
            "silent",
            "singleVideoStream",
            "noError",
        ):
            if candidate_checks.get(check_name) is not True:
                failures.append({
                    "kind": "mandatory-fixture-check",
                    "clip": candidate_name,
                    "check": check_name,
                })
        for check_name, baseline_check in baseline_checks.items():
            if baseline_check is True and candidate_checks.get(check_name) is not True:
                failures.append({
                    "kind": "fixture-check-regression",
                    "clip": candidate_name,
                    "check": check_name,
                })
        if int((candidate_clip.get("encoded") or {}).get("audioStreams", -1)) != 0:
            failures.append({"kind": "audio-present", "clip": candidate_name})
        baseline_quality = baseline_clip.get("quality") or {}
        candidate_quality = candidate_clip.get("quality") or {}
        if require_frame_hash_equivalence:
            baseline_hashes = (
                (baseline_clip.get("transformation") or {}).get(
                    "frameHashProvenance"
                )
                or {}
            )
            candidate_hashes = (
                (candidate_clip.get("transformation") or {}).get(
                    "frameHashProvenance"
                )
                or {}
            )
            for hash_kind in ("source", "preEncoder"):
                baseline_values = baseline_hashes.get(hash_kind)
                candidate_values = candidate_hashes.get(hash_kind)
                if not baseline_values or not candidate_values:
                    failures.append({
                        "kind": "missing-frame-hash-evidence",
                        "clip": candidate_name,
                        "hashKind": hash_kind,
                    })
                elif list(candidate_values) != list(baseline_values):
                    failures.append({
                        "kind": "frame-hash-mismatch",
                        "clip": candidate_name,
                        "hashKind": hash_kind,
                    })
            baseline_frame_provenance = (
                (baseline_clip.get("transformation") or {}).get(
                    "frameProvenance"
                )
            )
            candidate_frame_provenance = (
                (candidate_clip.get("transformation") or {}).get(
                    "frameProvenance"
                )
            )
            if (
                not baseline_frame_provenance
                or not candidate_frame_provenance
                or candidate_frame_provenance != baseline_frame_provenance
            ):
                failures.append({
                    "kind": "frame-provenance-mismatch",
                    "clip": candidate_name,
                })
        if int(candidate_quality.get("sampleCount", 0)) < int(
            baseline_quality.get("sampleCount", 0)
        ):
            failures.append({
                "kind": "sample-count",
                "clip": candidate_name,
                "expectedMinimum": baseline_quality.get("sampleCount"),
                "actual": candidate_quality.get("sampleCount"),
            })
        for metric in PROMOTION_LOWER_IS_BETTER:
            baseline_value = baseline_quality.get(metric)
            candidate_value = candidate_quality.get(metric)
            if baseline_value is None:
                if candidate_value is not None and not math.isfinite(float(candidate_value)):
                    failures.append({"kind": "nonfinite", "clip": candidate_name, "metric": metric})
                continue
            if candidate_value is None or not math.isfinite(float(candidate_value)):
                failures.append({"kind": "missing-or-nonfinite", "clip": candidate_name, "metric": metric})
            elif float(candidate_value) > float(baseline_value):
                failures.append({
                    "kind": "quality-regression",
                    "clip": candidate_name,
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
            or float(candidate_sharpness) < float(baseline_sharpness)
        ):
            failures.append({
                "kind": "quality-regression",
                "clip": candidate_name,
                "metric": "sharpnessMedian",
                "baseline": baseline_sharpness,
                "candidate": candidate_sharpness,
            })
        baseline_fps = float((baseline_clip.get("timing") or {}).get("processingFps", 0.0))
        candidate_fps = float((candidate_clip.get("timing") or {}).get("processingFps", 0.0))
        speedup = 100.0 * (candidate_fps / baseline_fps - 1.0) if baseline_fps > 0 else -math.inf
        if not math.isfinite(speedup) or speedup < float(minimum_speedup_percent):
            failures.append({
                "kind": "throughput",
                "clip": candidate_name,
                "minimumPercent": minimum_speedup_percent,
                "actualPercent": speedup,
            })
    restorer_status = ((candidate.get("warm") or {}).get("restorers") or {}).get("512") or {}
    if expected_plan_sha256:
        if restorer_status.get("effectiveBackend") != "native-trt":
            failures.append({
                "kind": "backend",
                "expected": "native-trt",
                "actual": restorer_status.get("effectiveBackend"),
            })
        if not restorer_status.get("nativePlanQualified", False):
            failures.append({"kind": "unqualified-plan"})
        if restorer_status.get("nativePlanSha256") != expected_plan_sha256:
            failures.append({
                "kind": "plan-sha256",
                "expected": expected_plan_sha256,
                "actual": restorer_status.get("nativePlanSha256"),
            })
    activation = candidate.get("experimentActivation") or {}
    if not bool(activation.get("allRequestedActivated", True)):
        failures.append({
            "kind": "experiment-not-activated",
            "missing": list(activation.get("missing") or []),
        })
    return {
        "schema": "pong-temporal-promotion-gate-v1",
        "passed": not failures,
        "minimumSpeedupPercent": float(minimum_speedup_percent),
        "expectedPlanSha256": expected_plan_sha256,
        "requireFrameHashEquivalence": bool(
            require_frame_hash_equivalence
        ),
        "failures": failures,
    }
DEFAULT_IDENTITY = ROOT / "approved-faces" / "Approved 21"
DEFAULT_CLIPS = (
    DEFAULT_INPUT / "pexels-3761547-silent-720p.mp4",
    DEFAULT_INPUT / "pexels-18400987-silent-720p.mp4",
)
CANONICAL_112 = np.asarray(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float32,
)
CANONICAL_256 = CANONICAL_112 * (256.0 / 112.0)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def effective_model_hashes(config: dict) -> dict[str, str]:
    names = ["inswapper_128.fp16.onnx", "det_10g.onnx", "w600k_r50.onnx"]
    parameters = config.get("parameters") or {}
    if parameters.get("RestorerSwitch"):
        names.append(
            "GPEN-BFR-512.onnx"
            if str(parameters.get("RestorerTypeTextSel")) == "GPEN512"
            else "GPEN-BFR-256.onnx"
        )
    if parameters.get("OccluderSwitch"):
        names.append("occluder.onnx")
    if parameters.get("FaceParserSwitch"):
        names.append("faceparser_resnet34.onnx")
    hashes = {
        name: sha256_file(MODELS_DIR / name)
        for name in sorted(set(names))
        if (MODELS_DIR / name).is_file()
    }
    if bool(
        (config.get("runtime") or {}).get("temporalSemanticMeshEnabled", False)
        or (config.get("runtime") or {}).get(
            "temporalSemanticFeaturePatchesEnabled",
            False,
        )
    ):
        for path in (FAN_68_5_PATH, FAN_2D_68_PATH):
            if path.is_file():
                hashes[f"semantic/{path.name}"] = sha256_file(path)
    return hashes


def protected_settings(config: dict) -> dict:
    parameters = config.get("parameters") or {}
    runtime = config.get("runtime") or {}
    parameter_keys = sorted(
        key
        for key in parameters
        if any(token in key.lower() for token in ("occlud", "restorer", "swapper"))
    )
    runtime_keys = sorted(
        key
        for key in runtime
        if any(token in key.lower() for token in ("occlud", "restorer", "swapper"))
    )
    return {
        "parameters": {key: parameters[key] for key in parameter_keys},
        "runtime": {key: runtime[key] for key in runtime_keys},
    }


def first_landmarks(engine: PongSwapEngine, rgb: np.ndarray, reference_kps=None) -> np.ndarray | None:
    detected = detect_on_engine_stream(engine, rgb, recognize=False, max_faces=10)
    if not detected:
        return None
    candidates = []
    for item in detected:
        try:
            kps = np.asarray(item[1], dtype=np.float32)
        except (IndexError, TypeError, ValueError):
            continue
        if kps.shape != (5, 2) or not np.isfinite(kps).all():
            continue
        span = max(float(np.ptp(kps[:, 0])), float(np.ptp(kps[:, 1])))
        candidates.append((span, kps))
    if reference_kps is not None and candidates:
        reference = np.asarray(reference_kps, dtype=np.float32)
        span = max(float(np.ptp(reference[:, 0])), float(np.ptp(reference[:, 1])), 1.0)
        distance, points = min(
            [(float(np.linalg.norm(np.mean(points, axis=0) - np.mean(reference, axis=0))), points)
             for _, points in candidates], key=lambda item: item[0])
        return points if distance <= span * 0.75 else None
    return max(candidates, key=lambda item: item[0])[1] if candidates else None


def align_patch(rgb: np.ndarray, kps: np.ndarray) -> np.ndarray | None:
    matrix, _ = cv2.estimateAffinePartial2D(
        np.asarray(kps, dtype=np.float32),
        CANONICAL_256,
        method=cv2.LMEDS,
    )
    if matrix is None or not np.isfinite(matrix).all():
        return None
    return cv2.warpAffine(
        rgb,
        matrix.astype(np.float32),
        (256, 256),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REFLECT_101,
    )


def similarity_parameters(source: np.ndarray, output: np.ndarray) -> tuple[float, float, float, float] | None:
    matrix, _ = cv2.estimateAffinePartial2D(
        np.asarray(source, dtype=np.float32),
        np.asarray(output, dtype=np.float32),
        method=cv2.LMEDS,
    )
    if matrix is None or not np.isfinite(matrix).all():
        return None
    a, b, tx = (float(value) for value in matrix[0])
    _, _, ty = (float(value) for value in matrix[1])
    scale = max(1e-8, math.sqrt(a * a + b * b))
    angle = math.atan2(b, a)
    span = max(float(np.ptp(source[:, 0])), float(np.ptp(source[:, 1])), 1.0)
    return tx / span, ty / span, angle, math.log(scale)


def _delta_norm(values: list[tuple[float, ...]]) -> list[float]:
    if len(values) < 2:
        return []
    array = np.asarray(values, dtype=np.float64)
    array[:, 2] = np.unwrap(array[:, 2])
    return [float(value) for value in np.linalg.norm(np.diff(array, axis=0), axis=1)]


def _acceleration_norm(values: list[tuple[float, ...]]) -> list[float]:
    if len(values) < 3:
        return []
    array = np.asarray(values, dtype=np.float64)
    array[:, 2] = np.unwrap(array[:, 2])
    return [float(value) for value in np.linalg.norm(np.diff(array, n=2, axis=0), axis=1)]


def _face_span(points: np.ndarray) -> float:
    values = np.asarray(points, dtype=np.float64).reshape(-1, 2)
    return max(float(np.ptp(values[:, 0])), float(np.ptp(values[:, 1])), 1.0)


def _normalized_feature_shape(points: np.ndarray) -> np.ndarray:
    """Remove global translation/rotation/scale, retaining feature geometry."""
    values = np.asarray(points, dtype=np.float64).reshape(5, 2)
    center = np.mean(values, axis=0)
    centered = values - center
    eye_axis = values[1] - values[0]
    angle = math.atan2(float(eye_axis[1]), float(eye_axis[0]))
    cosine = math.cos(-angle)
    sine = math.sin(-angle)
    rotation = np.asarray([[cosine, -sine], [sine, cosine]], dtype=np.float64)
    normalized = centered @ rotation.T
    return normalized / _face_span(values)


def _motion_lag(source_values: list[float], output_values: list[float]) -> dict:
    """Find phase lag without allowing a flat/frozen signal to score well."""
    if len(source_values) < 8 or len(output_values) != len(source_values):
        return {"bestLagFrames": None, "bestCorrelation": None, "zeroLagCorrelation": None}
    source_delta = np.diff(np.unwrap(np.asarray(source_values, dtype=np.float64)))
    output_delta = np.diff(np.unwrap(np.asarray(output_values, dtype=np.float64)))

    def correlation(lag: int) -> float | None:
        if lag < 0:
            left = source_delta[-lag:]
            right = output_delta[: len(output_delta) + lag]
        elif lag > 0:
            left = source_delta[: len(source_delta) - lag]
            right = output_delta[lag:]
        else:
            left = source_delta
            right = output_delta
        if len(left) < 5 or float(np.std(left)) < 1e-8 or float(np.std(right)) < 1e-8:
            return None
        return float(np.corrcoef(left, right)[0, 1])

    correlations = {lag: correlation(lag) for lag in range(-3, 4)}
    finite = {lag: value for lag, value in correlations.items() if value is not None and math.isfinite(value)}
    best_lag = max(finite, key=finite.get) if finite else None
    return {
        "bestLagFrames": best_lag,
        "bestCorrelation": finite.get(best_lag) if best_lag is not None else None,
        "zeroLagCorrelation": finite.get(0),
    }


def analyze_pair(
    engine: PongSwapEngine,
    source_path: Path,
    output_path: Path,
    *,
    max_seconds: float,
    sample_fps: float,
    occlusion_fixture: bool,
    frame_provenance: list[dict] | None = None,
    associate_faces: bool = False,
    source_frame_stride: int = 1,
) -> dict:
    source_container = av.open(str(source_path))
    output_container = av.open(str(output_path))
    source_stream = next(item for item in source_container.streams if item.type == "video")
    output_stream = next(item for item in output_container.streams if item.type == "video")
    source_frame_stride = max(1, int(source_frame_stride))
    source_fps = float(source_stream.average_rate or source_stream.base_rate or 24.0) / source_frame_stride
    stride = max(1, int(round(source_fps / max(1.0, sample_fps))))
    max_frames = max(1, int(math.ceil(max_seconds * source_fps)))
    source_iter = (frame for index, frame in enumerate(source_container.decode(source_stream))
                   if index % source_frame_stride == 0)
    output_iter = iter(output_container.decode(output_stream))

    poses: list[tuple[float, float, float, float]] = []
    residual_temporal_mae: list[float] = []
    boundary_temporal_mae: list[float] = []
    sharpness: list[float] = []
    occlusion_core_mae: list[float] = []
    occlusion_core_bad_ratio: list[float] = []
    motion_fidelity_error: list[float] = []
    motion_gain: list[float] = []
    feature_relation_change: list[float] = []
    source_angles: list[float] = []
    output_angles: list[float] = []
    detection_failures = 0
    previous_residual = None
    previous_source_kps = None
    previous_output_kps = None
    previous_feature_relation = None
    frame_index = 0
    provenance_by_frame = {
        int(item.get("frameIndex", -1)): item
        for item in (frame_provenance or [])
        if isinstance(item, dict)
    }
    attribution_values: dict[str, dict[str, list[float]]] = defaultdict(
        lambda: defaultdict(list)
    )
    previous_sample_kind: str | None = None
    previous_pose: tuple[float, float, float, float] | None = None
    previous_previous_pose: tuple[float, float, float, float] | None = None
    previous_sharpness: float | None = None
    frame_metrics: list[dict] = []

    def attribution_keys(kind: str, anchor_age: int) -> tuple[str, ...]:
        keys = [kind]
        if previous_sample_kind is not None:
            keys.append(f"{previous_sample_kind}-to-{kind}")
        if kind == "reuse":
            if anchor_age <= 1:
                keys.append("reuse-age-1")
            elif anchor_age <= 3:
                keys.append("reuse-age-2-3")
            else:
                keys.append("reuse-age-4-plus")
        return tuple(dict.fromkeys(keys))

    def attribute(keys: tuple[str, ...], metric: str, value: float | None) -> None:
        if value is None or not math.isfinite(float(value)):
            return
        for key in keys:
            attribution_values[key][metric].append(float(value))

    previous_source_kps = None
    try:
        while frame_index < max_frames:
            try:
                source_rgb = next(source_iter).to_ndarray(format="rgb24")
                output_rgb = next(output_iter).to_ndarray(format="rgb24")
            except StopIteration:
                break
            if frame_index % stride:
                frame_index += 1
                continue
            source_kps = first_landmarks(engine, source_rgb, previous_source_kps if associate_faces else None)
            output_kps = first_landmarks(engine, output_rgb, source_kps if associate_faces else None)
            if source_kps is None or output_kps is None:
                detection_failures += 1
                frame_index += 1
                continue
            previous_source_kps = source_kps
            provenance = provenance_by_frame.get(frame_index, {})
            kind = str(provenance.get("kind") or "unknown")
            anchor_age = int(provenance.get("anchorAge") or 0)
            keys = attribution_keys(kind, anchor_age)
            frame_metric: dict[str, object] = {
                "frameIndex": int(frame_index),
                "sourceLandmarks": source_kps.tolist(),
                "outputLandmarks": output_kps.tolist(),
                "kind": kind,
                "anchorAge": anchor_age,
            }
            pose = similarity_parameters(source_kps, output_kps)
            if pose is not None:
                poses.append(pose)
                if previous_pose is not None:
                    pose_array = np.asarray(pose, dtype=np.float64)
                    prior_array = np.asarray(previous_pose, dtype=np.float64)
                    angle_delta = math.atan2(
                        math.sin(float(pose_array[2] - prior_array[2])),
                        math.cos(float(pose_array[2] - prior_array[2])),
                    )
                    delta = pose_array - prior_array
                    delta[2] = angle_delta
                    pose_delta_value = float(np.linalg.norm(delta))
                    frame_metric["attachmentPoseDelta"] = pose_delta_value
                    attribute(keys, "attachmentPoseDelta", pose_delta_value)
                if previous_pose is not None and previous_previous_pose is not None:
                    triplet = np.asarray(
                        [previous_previous_pose, previous_pose, pose],
                        dtype=np.float64,
                    )
                    triplet[:, 2] = np.unwrap(triplet[:, 2])
                    acceleration = np.diff(triplet, n=2, axis=0)[0]
                    acceleration_value = float(np.linalg.norm(acceleration))
                    frame_metric["attachmentPoseAcceleration"] = acceleration_value
                    attribute(
                        keys,
                        "attachmentPoseAcceleration",
                        acceleration_value,
                    )
                previous_previous_pose = previous_pose
                previous_pose = pose

            source_eye_axis = source_kps[1] - source_kps[0]
            output_eye_axis = output_kps[1] - output_kps[0]
            source_angles.append(math.atan2(float(source_eye_axis[1]), float(source_eye_axis[0])))
            output_angles.append(math.atan2(float(output_eye_axis[1]), float(output_eye_axis[0])))

            source_shape = _normalized_feature_shape(source_kps)
            output_shape = _normalized_feature_shape(output_kps)
            feature_relation = output_shape - source_shape
            if previous_feature_relation is not None:
                feature_change = float(
                    np.sqrt(np.mean(np.square(feature_relation - previous_feature_relation)))
                )
                feature_relation_change.append(feature_change)
                frame_metric["featureRelationChange"] = feature_change
                attribute(keys, "featureRelationChange", feature_change)
            previous_feature_relation = feature_relation

            if previous_source_kps is not None and previous_output_kps is not None:
                source_flow = (
                    np.asarray(source_kps, dtype=np.float64) - previous_source_kps
                ) / _face_span(previous_source_kps)
                output_flow = (
                    np.asarray(output_kps, dtype=np.float64) - previous_output_kps
                ) / _face_span(previous_output_kps)
                motion_error = float(
                    np.sqrt(np.mean(np.square(output_flow - source_flow)))
                )
                motion_fidelity_error.append(motion_error)
                frame_metric["motionFidelityError"] = motion_error
                attribute(keys, "motionFidelityError", motion_error)
                source_motion = float(np.sqrt(np.mean(np.square(source_flow))))
                output_motion = float(np.sqrt(np.mean(np.square(output_flow))))
                if source_motion > 1e-5:
                    motion_gain.append(output_motion / source_motion)
            previous_source_kps = np.asarray(source_kps, dtype=np.float64)
            previous_output_kps = np.asarray(output_kps, dtype=np.float64)

            source_patch = align_patch(source_rgb, source_kps)
            output_patch = align_patch(output_rgb, source_kps)
            if source_patch is not None and output_patch is not None:
                residual = output_patch.astype(np.float32) - source_patch.astype(np.float32)
                if previous_residual is not None:
                    change = np.abs(residual - previous_residual)
                    residual_change = float(np.mean(change))
                    residual_temporal_mae.append(residual_change)
                    attribute(keys, "temporalResidualMae", residual_change)
                    yy, xx = np.ogrid[:256, :256]
                    radius = np.sqrt(((xx - 128.0) / 92.0) ** 2 + ((yy - 132.0) / 112.0) ** 2)
                    band = (radius >= 0.86) & (radius <= 1.10)
                    boundary_change = float(np.mean(change[band]))
                    boundary_temporal_mae.append(boundary_change)
                    frame_metric["boundaryFlickerMae"] = boundary_change
                    attribute(keys, "boundaryFlickerMae", boundary_change)
                previous_residual = residual
                gray = cv2.cvtColor(output_patch, cv2.COLOR_RGB2GRAY)
                current_sharpness = float(cv2.Laplacian(gray, cv2.CV_32F).var())
                sharpness.append(current_sharpness)
                frame_metric["sharpness"] = current_sharpness
                attribute(keys, "sharpness", current_sharpness)
                if previous_sharpness is not None:
                    attribute(
                        keys,
                        "sharpnessFrameDelta",
                        abs(current_sharpness - previous_sharpness)
                        / max(previous_sharpness, 1.0),
                    )
                previous_sharpness = current_sharpness

            if occlusion_fixture:
                # The deterministic benchmark object uses saturated magenta and
                # cyan checks. Compression changes them slightly, so derive the
                # core mask from the source with a conservative color-distance
                # test and compare the output to those exact decoded pixels.
                source_i16 = source_rgb.astype(np.int16)
                magenta = np.linalg.norm(source_i16 - np.asarray([245, 24, 210]), axis=2)
                cyan = np.linalg.norm(source_i16 - np.asarray([20, 230, 240]), axis=2)
                core = (magenta < 55.0) | (cyan < 55.0)
                if int(core.sum()) >= 25:
                    error = np.mean(
                        np.abs(output_rgb.astype(np.int16) - source_i16),
                        axis=2,
                    )[core]
                    occlusion_core_mae.append(float(np.mean(error)))
                    bad_ratio = float(np.mean(error > 18.0))
                    occlusion_core_bad_ratio.append(bad_ratio)
                    frame_metric["occlusionCoreBadRatio"] = bad_ratio
                    attribute(keys, "occlusionCoreBadRatio", bad_ratio)
            frame_metrics.append(frame_metric)
            previous_sample_kind = kind
            frame_index += 1
    finally:
        source_container.close()
        output_container.close()

    pose_delta = _delta_norm(poses)
    pose_acceleration = _acceleration_norm(poses)
    sharpness_delta = [
        abs(sharpness[index] - sharpness[index - 1]) / max(sharpness[index - 1], 1.0)
        for index in range(1, len(sharpness))
    ]
    lag = _motion_lag(source_angles, output_angles)
    attribution = {}
    for key, values in sorted(attribution_values.items()):
        attribution[key] = {
            metric: {
                "count": len(samples),
                "median": statistics.median(samples),
                "p95": percentile(samples, 0.95),
            }
            for metric, samples in sorted(values.items())
            if samples
        }
    return {
        "sampleFps": sample_fps,
        "sourceFrameStride": source_frame_stride,
        "faceAssociation": "source-continuity-and-paired-position" if associate_faces else "independent-largest-face",
        "decodedPairFrameCount": int(frame_index),
        "requestedMaximumFrames": int(max_frames),
        "sampleCount": len(poses),
        "detectionFailures": detection_failures,
        "attachmentPoseDeltaRms": math.sqrt(statistics.mean(value * value for value in pose_delta)) if pose_delta else None,
        "attachmentPoseDeltaP95": percentile(pose_delta, 0.95) if pose_delta else None,
        "attachmentPoseAccelerationRms": math.sqrt(statistics.mean(value * value for value in pose_acceleration)) if pose_acceleration else None,
        "attachmentPoseAccelerationP95": percentile(pose_acceleration, 0.95) if pose_acceleration else None,
        "motionFidelityErrorMedian": statistics.median(motion_fidelity_error) if motion_fidelity_error else None,
        "motionFidelityErrorP95": percentile(motion_fidelity_error, 0.95) if motion_fidelity_error else None,
        "motionGainMedian": statistics.median(motion_gain) if motion_gain else None,
        "motionGainP10": percentile(motion_gain, 0.10) if motion_gain else None,
        "motionGainP90": percentile(motion_gain, 0.90) if motion_gain else None,
        "featureRelationChangeMedian": statistics.median(feature_relation_change) if feature_relation_change else None,
        "featureRelationChangeP95": percentile(feature_relation_change, 0.95) if feature_relation_change else None,
        "headAngleBestLagFrames": lag["bestLagFrames"],
        "headAngleBestCorrelation": lag["bestCorrelation"],
        "headAngleZeroLagCorrelation": lag["zeroLagCorrelation"],
        "temporalResidualMaeMedian": statistics.median(residual_temporal_mae) if residual_temporal_mae else None,
        "temporalResidualMaeP95": percentile(residual_temporal_mae, 0.95) if residual_temporal_mae else None,
        "boundaryFlickerMaeMedian": statistics.median(boundary_temporal_mae) if boundary_temporal_mae else None,
        "boundaryFlickerMaeP95": percentile(boundary_temporal_mae, 0.95) if boundary_temporal_mae else None,
        "sharpnessMedian": statistics.median(sharpness) if sharpness else None,
        "sharpnessFrameDeltaP95": percentile(sharpness_delta, 0.95) if sharpness_delta else None,
        "occlusionCoreMaeMedian": statistics.median(occlusion_core_mae) if occlusion_core_mae else None,
        "occlusionCoreBadRatioP95": percentile(occlusion_core_bad_ratio, 0.95) if occlusion_core_bad_ratio else None,
        "occlusionCoreSampleCount": len(occlusion_core_bad_ratio),
        "occlusionCoreBadRatioMax": max(occlusion_core_bad_ratio) if occlusion_core_bad_ratio else None,
        "occlusionCorePositiveViolationCount": sum(
            1 for value in occlusion_core_bad_ratio if value > 0.0
        ),
        "temporalAttribution": attribution,
        "frameMetrics": frame_metrics,
    }


def draw_popsicle_fixture(
    engine: PongSwapEngine,
    source_path: Path,
    destination: Path,
    config: dict,
) -> dict:
    source_hash = sha256_file(source_path)
    metadata_path = destination.with_suffix(".json")
    if destination.is_file() and metadata_path.is_file():
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata.get("sourceSha256") == source_hash:
            return metadata

    container = av.open(str(source_path))
    stream = next(item for item in container.streams if item.type == "video")
    fps = float(stream.average_rate or stream.base_rate or 24.0)
    width = int(stream.codec_context.width)
    height = int(stream.codec_context.height)
    process = encoder(width, height, fps, destination, config)
    overlaid_frames = 0
    frames = 0
    try:
        for frame in container.decode(stream):
            rgb = frame.to_ndarray(format="rgb24")
            kps = first_landmarks(engine, rgb)
            if kps is not None:
                mouth = np.mean(kps[3:5], axis=0)
                span = max(float(np.ptp(kps[:, 0])), float(np.ptp(kps[:, 1])), 24.0)
                phase = math.sin((frames / max(fps, 1.0)) * math.pi * 0.8)
                center_x = int(round(float(mouth[0] + phase * span * 0.10)))
                center_y = int(round(float(mouth[1] + span * 0.28)))
                candy_w = max(10, int(round(span * 0.28)))
                candy_h = max(28, int(round(span * 0.95)))
                top = center_y - candy_h // 2
                bottom = center_y + candy_h // 2
                left = center_x - candy_w // 2
                right = center_x + candy_w // 2
                # RGB colors are deliberately uncommon, textured, and fully
                # opaque so preservation can be measured analytically.
                cv2.rectangle(rgb, (left, top), (right, bottom), (245, 24, 210), -1)
                cv2.ellipse(rgb, (center_x, top), (candy_w // 2, candy_w // 2), 0, 180, 360, (20, 230, 240), -1)
                cv2.ellipse(rgb, (center_x, bottom), (candy_w // 2, candy_w // 2), 0, 0, 180, (20, 230, 240), -1)
                stripe_h = max(3, candy_h // 8)
                for stripe_y in range(top + stripe_h, bottom, stripe_h * 2):
                    cv2.rectangle(rgb, (left, stripe_y), (right, min(bottom, stripe_y + stripe_h)), (20, 230, 240), -1)
                stick_top = bottom
                stick_bottom = min(height - 1, bottom + max(12, int(round(span * 0.35))))
                stick_w = max(4, candy_w // 4)
                cv2.rectangle(
                    rgb,
                    (center_x - stick_w // 2, stick_top),
                    (center_x + stick_w // 2, stick_bottom),
                    (185, 130, 70),
                    -1,
                )
                overlaid_frames += 1
            if process.stdin is None:
                raise RuntimeError("occlusion fixture encoder input closed")
            process.stdin.write(memoryview(np.ascontiguousarray(rgb)).cast("B"))
            frames += 1
    finally:
        container.close()
        if process.stdin is not None:
            process.stdin.close()
    stderr = process.stderr.read().decode("utf-8", errors="replace") if process.stderr else ""
    exit_code = process.wait(timeout=60)
    if exit_code:
        raise RuntimeError(f"occlusion fixture encoder failed: {stderr[-1000:]}")
    metadata = {
        "schema": "pong-temporal-occlusion-fixture-v1",
        "source": str(source_path),
        "sourceSha256": source_hash,
        "output": str(destination),
        "outputSha256": sha256_file(destination),
        "frames": frames,
        "overlaidFrames": overlaid_frames,
        "silent": probe_output(destination).get("audioStreams") == 0,
    }
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata


def run(args: argparse.Namespace) -> dict:
    identity_images = tuple(
        path
        for path in sorted(args.identity_dir.iterdir())
        if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
    )
    if not identity_images:
        raise FileNotFoundError(f"no approved identity images in {args.identity_dir}")
    clips = tuple(path.resolve() for path in args.clips)
    for clip in clips:
        if not clip.is_file():
            raise FileNotFoundError(clip)

    output_dir = (args.output_dir or (BENCHMARK_ROOT / "runs" / args.label)).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    engine = PongSwapEngine()
    base_report_sha256 = ""
    if args.config_base_report is not None:
        base_report_path = args.config_base_report.resolve()
        if not base_report_path.is_file():
            raise FileNotFoundError(
                f"benchmark base report is missing: {base_report_path}"
            )
        base_report = json.loads(base_report_path.read_text(encoding="utf-8"))
        embedded_config = base_report.get("configuration")
        if not isinstance(embedded_config, dict):
            raise TypeError("benchmark base report has no configuration object")
        config = deepcopy(embedded_config)
        base_report_sha256 = sha256_file(base_report_path)
    else:
        config = deepcopy(engine.config)
    override_sha256 = ""
    if args.config_overrides_json is not None:
        override_path = args.config_overrides_json.resolve()
        if not override_path.is_file():
            raise FileNotFoundError(f"benchmark override file is missing: {override_path}")
        overrides = json.loads(override_path.read_text(encoding="utf-8"))
        if not isinstance(overrides, dict):
            raise TypeError("benchmark overrides must be a JSON object")
        unexpected_sections = sorted(set(overrides) - {"runtime", "parameters"})
        if unexpected_sections:
            raise ValueError(
                "benchmark overrides may contain only runtime and parameters: "
                + ", ".join(unexpected_sections)
            )
        for section in ("runtime", "parameters"):
            values = overrides.get(section, {})
            if not isinstance(values, dict):
                raise TypeError(f"benchmark override section {section} must be an object")
            config.setdefault(section, {}).update(deepcopy(values))
        override_sha256 = sha256_file(override_path)
    config["runtime"]["swapAudioEnabled"] = False
    if args.restorer_backend is not None:
        config["runtime"]["restorerBackendPreference"] = str(args.restorer_backend)
    if args.restorer_trt_fp32:
        config["runtime"]["restorerTrtFp16"] = False
    if args.restorer_native_trt_tf32:
        config["runtime"]["restorerNativeTrtTf32"] = True
    if args.restorer_native_trt_qualified_plan is not None:
        if args.restorer_backend != "native-trt":
            raise ValueError(
                "--restorer-native-trt-qualified-plan requires "
                "--restorer-backend native-trt"
            )
        config["runtime"]["restorerNativeTrtQualifiedPlan"] = str(
            args.restorer_native_trt_qualified_plan.resolve()
        )
    if args.restorer_native_trt_split_plan is not None:
        if args.restorer_backend != "native-trt":
            raise ValueError(
                "--restorer-native-trt-split-plan requires "
                "--restorer-backend native-trt"
            )
        config["runtime"]["restorerNativeTrtSplitPlan"] = str(
            args.restorer_native_trt_split_plan.resolve()
        )
    if args.restorer_native_static_residual is not None:
        if args.restorer_backend != "native-trt":
            raise ValueError(
                "--restorer-native-static-residual requires "
                "--restorer-backend native-trt"
            )
        config["runtime"]["restorerNativeStaticResidualPath"] = str(
            args.restorer_native_static_residual.resolve()
        )
    if args.restorer_cuda_direct_io:
        config["runtime"]["restorerCudaDirectIo"] = True
    if args.restorer_cuda_graph:
        config["runtime"]["restorerCudaGraph"] = True
    if args.restorer_pixel_center_return_map:
        config["runtime"]["restorerPixelCenterReturnMap"] = True
    if args.restorer_bounded_cubic_return_sampler:
        config["runtime"]["restorerBoundedCubicReturnSampler"] = True
        config["runtime"]["restorerBoundedCubicWeight"] = float(
            args.restorer_bounded_cubic_weight
        )
    if args.restorer_monotone_hermite_return_sampler:
        config["runtime"]["restorerMonotoneHermiteReturnSampler"] = True
    if args.restorer_bilinear_input_alignment:
        config["runtime"]["restorerBilinearInputAlignment"] = True
    if args.restorer_fused_input_alignment:
        config["runtime"]["restorerFusedInputAlignment"] = True
    if args.restorer_residual_return:
        config["runtime"]["restorerResidualReturn"] = True
        config["runtime"]["restorerResidualReturnWeight"] = float(
            args.restorer_residual_return_weight
        )
        config["runtime"]["restorerResidualReturnMinimumFaceSize"] = int(
            args.restorer_residual_return_minimum_face_size
        )
    if args.restorer_residual_parser_uses_legacy_appearance:
        config["runtime"]["restorerResidualParserUsesLegacyAppearance"] = True
    if args.restorer_low_frequency_anchor_stabilization:
        config["runtime"]["restorerLowFrequencyAnchorStabilization"] = True
        config["runtime"]["restorerLowFrequencyAnchorStrength"] = float(
            args.restorer_low_frequency_anchor_strength
        )
        config["runtime"]["restorerLowFrequencyAnchorKernel"] = int(
            args.restorer_low_frequency_anchor_kernel
        )
        config["runtime"]["restorerLowFrequencyAnchorMaxCorrection"] = float(
            args.restorer_low_frequency_anchor_max_correction
        )
    if args.exact_pasteback_round_to_nearest:
        config["runtime"]["exactPastebackRoundToNearest"] = True
    if args.exact_pasteback_float64_composite:
        config["runtime"]["exactPastebackFloat64Composite"] = True
    if args.continuous_residual_warp:
        config["runtime"]["temporalContinuousResidualWarp"] = True
    if args.restorer_output_fractional_levels is not None:
        config["runtime"]["restorerOutputFractionalLevels"] = int(
            args.restorer_output_fractional_levels
        )
    if args.face_parser_evidence_quantization_step is not None:
        config["runtime"]["faceParserEvidenceQuantizationStep"] = float(
            args.face_parser_evidence_quantization_step
        )
    if args.reference_parser_mask_diagnostic:
        config["runtime"]["referenceParserMaskDiagnostic"] = True
    if args.restorer_hybrid_reference_reasons:
        config["runtime"]["restorerHybridReferenceReasons"] = list(
            args.restorer_hybrid_reference_reasons
        )
    if args.restorer_spatial_exact_blend:
        config["runtime"]["temporalRestorerSpatialBlendEnabled"] = True
        config["runtime"]["temporalRestorerSpatialBlendTriggerReasons"] = list(
            args.restorer_spatial_exact_blend_trigger_reasons
        )
        config["runtime"]["temporalRestorerSpatialBlendRequiresHybridReference"] = bool(
            args.restorer_spatial_exact_blend_requires_hybrid_reference
        )
        config["runtime"]["temporalRestorerSpatialBlendTriggerMaxGapFrames"] = int(
            args.restorer_spatial_exact_blend_trigger_max_gap_frames
        )
        config["runtime"]["temporalRestorerSpatialBlendTriggerMinimumEvents"] = int(
            args.restorer_spatial_exact_blend_trigger_minimum_events
        )
        config["runtime"]["temporalRestorerSpatialBlendTriggerMinimumPatchToMeanRatio"] = float(
            args.restorer_spatial_exact_blend_trigger_minimum_patch_to_mean_ratio
        )
        config["runtime"]["temporalRestorerSpatialBlendBurstHoldFrames"] = int(
            args.restorer_spatial_exact_blend_burst_hold_frames
        )
        config["runtime"]["temporalRestorerSpatialBlendCurrentWeight"] = float(
            args.restorer_spatial_exact_blend_weight
        )
        config["runtime"]["temporalRestorerSpatialBlendChangeLow"] = float(
            args.restorer_spatial_exact_blend_change_low
        )
        config["runtime"]["temporalRestorerSpatialBlendChangeHigh"] = float(
            args.restorer_spatial_exact_blend_change_high
        )
        config["runtime"]["temporalRestorerSpatialBlendEdgeGuardFraction"] = float(
            args.restorer_spatial_exact_blend_edge_guard
        )
    hybrid_cadence = {}
    if args.restorer_hybrid_frame_age_every is not None:
        hybrid_cadence["frame-age"] = int(args.restorer_hybrid_frame_age_every)
    if args.restorer_hybrid_patch_every is not None:
        hybrid_cadence["patch-disagreement"] = int(args.restorer_hybrid_patch_every)
    if args.restorer_hybrid_mean_every is not None:
        hybrid_cadence["mean-disagreement"] = int(args.restorer_hybrid_mean_every)
    if args.restorer_hybrid_lower_center_every is not None:
        hybrid_cadence["lower-center-disagreement"] = int(
            args.restorer_hybrid_lower_center_every
        )
    if hybrid_cadence:
        config["runtime"]["restorerHybridReferenceCadenceByReason"] = hybrid_cadence
    hybrid_phase = {}
    if args.restorer_hybrid_frame_age_phase is not None:
        hybrid_phase["frame-age"] = int(
            args.restorer_hybrid_frame_age_phase
        )
    if args.restorer_hybrid_lower_center_phase is not None:
        hybrid_phase["lower-center-disagreement"] = int(
            args.restorer_hybrid_lower_center_phase
        )
    if hybrid_phase:
        config["runtime"]["restorerHybridReferencePhaseByReason"] = hybrid_phase
    if args.restorer_hybrid_lower_center_min_input_mae is not None:
        config["runtime"]["restorerHybridReferenceMinimumInputMaeByReason"] = {
            "lower-center-disagreement": float(
                args.restorer_hybrid_lower_center_min_input_mae
            )
        }
    if args.restorer_hybrid_reference_blend_weight is not None:
        config["runtime"]["restorerHybridReferenceBlendWeight"] = float(
            args.restorer_hybrid_reference_blend_weight
        )
    if args.restorer_hybrid_lower_center_blend_weight is not None:
        config["runtime"]["restorerHybridReferenceBlendWeightByReason"] = {
            "lower-center-disagreement": float(
                args.restorer_hybrid_lower_center_blend_weight
            )
        }
    if args.restorer_return_geometry_cache:
        config["runtime"]["restorerReturnGeometryCache"] = True
    if args.mask_cuda_graph:
        config["runtime"]["maskCudaGraph"] = True
    if args.mask_backend is not None:
        config["runtime"]["maskBackendPreference"] = str(args.mask_backend)
    if args.mask_occluder_backend is not None:
        config["runtime"]["maskOccluderBackendPreference"] = str(
            args.mask_occluder_backend
        )
    if args.mask_face_parser_backend is not None:
        config["runtime"]["maskFaceParserBackendPreference"] = str(
            args.mask_face_parser_backend
        )
    if args.adaptive_mask_backend:
        config["runtime"]["maskAdaptiveBackendEnabled"] = True
        config["runtime"]["maskAdaptiveResidualThreshold"] = float(
            args.adaptive_mask_residual_threshold
        )
        config["runtime"]["maskAdaptiveMinimumSamples"] = int(
            args.adaptive_mask_minimum_samples
        )
    if args.adaptive_mask_preflight:
        config["runtime"]["maskAdaptiveBackendEnabled"] = True
        config["runtime"]["maskAdaptivePreflightEnabled"] = True
        config["runtime"]["maskAdaptivePreflightFrames"] = int(
            args.adaptive_mask_preflight_frames
        )
        config["runtime"]["maskAdaptiveFlowP90Threshold"] = float(
            args.adaptive_mask_flow_p90_threshold
        )
    if args.mask_exact_parser_blend:
        config["runtime"]["maskExactParserBlendEnabled"] = True
        config["runtime"]["maskExactParserBlendCurrentWeight"] = float(
            args.mask_exact_parser_blend_current_weight
        )
    if args.mask_trt_detail_gain_compensation is not None:
        config["runtime"]["maskTrtDetailGainCompensation"] = float(
            args.mask_trt_detail_gain_compensation
        )
    if args.mask_trt_post_sharpen_amount is not None:
        config["runtime"]["maskTrtPostSharpenAmount"] = float(
            args.mask_trt_post_sharpen_amount
        )
    if args.mask_trt_sparse_edge_boost_threshold is not None:
        config["runtime"]["maskTrtSparseEdgeBoostThreshold"] = float(
            args.mask_trt_sparse_edge_boost_threshold
        )
    if args.exact_cpu_overlap:
        config["runtime"]["exactCpuResidualOverlap"] = True
    if args.disable_full_reuse:
        config["runtime"]["temporalForegroundReuseEnabled"] = False
    if args.full_anchor_hz is not None:
        config["runtime"]["temporalFullAnchorHz"] = float(args.full_anchor_hz)
    if args.restorer_anchor_hz is not None:
        config["runtime"]["temporalRestorerAnchorHz"] = float(
            args.restorer_anchor_hz
        )
    if args.restorer_max_input_mae is not None:
        config["runtime"]["temporalRestorerMaxInputMae"] = float(
            args.restorer_max_input_mae
        )
    if args.restorer_max_input_patch_mae is not None:
        config["runtime"]["temporalRestorerMaxInputPatchMae"] = float(
            args.restorer_max_input_patch_mae
        )
    if args.mask_max_input_mae is not None:
        config["runtime"]["temporalMaskMaxInputMae"] = float(
            args.mask_max_input_mae
        )
    if args.mask_max_input_patch_mae is not None:
        config["runtime"]["temporalMaskMaxInputPatchMae"] = float(
            args.mask_max_input_patch_mae
        )
    if args.dfl_xseg_reuse:
        config["runtime"]["temporalDflXSegReuseEnabled"] = True
    if args.occluder_decoupled:
        config["runtime"]["temporalOccluderDecoupledFromRestorer"] = True
    if args.full_max_face_mae is not None:
        config["runtime"]["temporalFullMaxFaceMae"] = float(args.full_max_face_mae)
    if args.full_max_face_p90 is not None:
        config["runtime"]["temporalFullMaxFaceP90"] = float(args.full_max_face_p90)
    if args.full_max_patch_mae is not None:
        config["runtime"]["temporalFullMaxPatchMae"] = float(args.full_max_patch_mae)
    if args.restorer_exact_blend:
        config["runtime"]["temporalRestorerExactBlendEnabled"] = True
        config["runtime"]["temporalRestorerExactBlendCurrentWeight"] = float(
            args.restorer_exact_blend_weight
        )
    if args.exact_output_stabilization:
        config["runtime"]["temporalExactOutputStabilizationEnabled"] = True
        config["runtime"]["temporalExactOutputCurrentWeight"] = float(
            args.exact_output_current_weight
        )
        config["runtime"]["temporalExactOutputDenseFlowEnabled"] = bool(
            args.exact_output_dense_flow
        )
    if args.exact_mouth_stabilization:
        config["runtime"]["temporalExactMouthStabilizationEnabled"] = True
        config["runtime"]["temporalExactMouthCurrentWeight"] = float(
            args.exact_mouth_current_weight
        )
        config["runtime"]["temporalExactMouthMaxMae"] = float(
            args.exact_mouth_max_mae
        )
        config["runtime"]["temporalExactMouthMaxP90"] = float(
            args.exact_mouth_max_p90
        )
    if args.exact_landmark_lock:
        config["runtime"]["temporalExactLandmarkLockEnabled"] = True
        config["runtime"]["temporalExactLandmarkLockStrength"] = float(
            args.exact_landmark_lock_strength
        )
    if args.realtime_face_enhancer:
        config["runtime"]["frameEnhancerEnabled"] = True
        config["runtime"]["frameEnhancerScope"] = "realtime"
    if args.whole_output_bicubic:
        config["runtime"]["temporalFullBicubicResidual"] = True
    if args.detector_lk_fusion:
        config["runtime"]["temporalDetectorLkFusionEnabled"] = True
        config["runtime"]["temporalDetectorLkFusionWeight"] = float(
            args.detector_lk_fusion_weight
        )
        config["runtime"]["temporalDetectorLkFusionMaxResidualRatio"] = float(
            args.detector_lk_fusion_max_residual_ratio
        )
    if args.detector_shape_continuity:
        config["runtime"]["temporalDetectorShapeContinuityEnabled"] = True
        config["runtime"]["temporalDetectorShapeContinuityWeight"] = float(
            args.detector_shape_continuity_weight
        )
        config["runtime"]["temporalDetectorShapeContinuityMaxResidualRatio"] = float(
            args.detector_shape_continuity_max_residual_ratio
        )
    if args.identity_residual_stabilization:
        config["runtime"]["temporalIdentityResidualStabilizationEnabled"] = True
        config["runtime"]["temporalIdentityResidualHighMotionOnly"] = bool(
            args.identity_residual_high_motion_only
        )
        config["runtime"]["temporalIdentityResidualCurrentWeight"] = float(
            args.identity_residual_current_weight
        )
        config["runtime"]["temporalIdentityResidualChangeLow"] = float(
            args.identity_residual_change_low
        )
        config["runtime"]["temporalIdentityResidualChangeHigh"] = float(
            args.identity_residual_change_high
        )
        config["runtime"]["temporalIdentityResidualMaxInputMae"] = float(
            args.identity_residual_max_input_mae
        )
        config["runtime"]["temporalIdentityResidualMaxInputPatchMae"] = float(
            args.identity_residual_max_input_patch_mae
        )
    if args.disable_lk_smoothing:
        config["runtime"]["temporalDisableLkSmoothing"] = True
    if args.feature_patch_lock:
        config["runtime"]["temporalFullFeaturePatchLockEnabled"] = True
        config["runtime"]["temporalFullFeaturePatchLockStrength"] = float(
            args.feature_patch_lock_strength
        )
        config["runtime"]["temporalFullFeaturePatchMaxMae"] = float(
            args.feature_patch_max_mae
        )
        config["runtime"]["temporalFullFeaturePatchMaxP90"] = float(
            args.feature_patch_max_p90
        )
    if args.canonical_residual_transport:
        config["runtime"]["temporalCanonicalResidualTransport"] = True
        config["runtime"]["temporalCanonicalResidualLowMotionOnly"] = bool(
            args.canonical_residual_low_motion_only
        )
        config["runtime"]["temporalCanonicalResidualBlendWeight"] = float(
            args.canonical_residual_blend_weight
        )
    if args.pose_aware_affine_residual:
        config["runtime"]["temporalPoseAwareAffineResidual"] = True
        config["runtime"]["temporalPoseAwareAffineMaxAnisotropy"] = float(
            args.pose_aware_affine_max_anisotropy
        )
        config["runtime"]["temporalPoseAwareAffineMinImprovement"] = float(
            args.pose_aware_affine_min_improvement
        )
        config["runtime"]["temporalPoseAwareAffineMinResidualRatio"] = float(
            args.pose_aware_affine_min_residual_ratio
        )
    if args.adaptive_grace:
        config["runtime"]["temporalFullAdaptiveGraceEnabled"] = True
    if args.landmark_residual_ratio is not None:
        config["runtime"]["temporalFullMaxLandmarkResidualRatio"] = float(
            args.landmark_residual_ratio
        )
    if args.dense_flow_residual:
        config["runtime"]["temporalFullDenseFlowResidual"] = True
        config["runtime"]["temporalFullDenseFlowSize"] = int(args.dense_flow_size)
    if args.sparse_mesh_residual:
        config["runtime"]["temporalFullSparseMeshResidual"] = True
        config["runtime"]["temporalFullSparseMeshSize"] = int(args.sparse_mesh_size)
    if args.semantic_mesh_residual:
        config["runtime"]["temporalFullSparseMeshResidual"] = True
        config["runtime"]["temporalFullSparseMeshSize"] = int(args.sparse_mesh_size)
        config["runtime"]["temporalSemanticMeshEnabled"] = True
        config["runtime"]["temporalSemanticHighMotionOnly"] = bool(
            args.semantic_high_motion_only
        )
        config["runtime"]["temporalSemanticLandmarkRefreshHz"] = float(
            args.semantic_landmark_refresh_hz
        )
    if args.semantic_feature_patches:
        config["runtime"]["temporalSemanticFeaturePatchesEnabled"] = True
        config["runtime"]["temporalSemanticFeatureGroups"] = (
            ["leftEye", "rightEye"]
            if args.semantic_feature_groups == "eyes"
            else ["leftEye", "rightEye", "nose", "mouth"]
        )
        config["runtime"]["temporalSemanticLandmarkRefreshHz"] = float(
            args.semantic_landmark_refresh_hz
        )
    if args.current_geometry:
        config["runtime"]["temporalCurrentGeometryEnabled"] = True
    if args.registered_residual:
        config["runtime"]["temporalRegisteredResidualReuse"] = True
    if args.registered_region_confidence:
        config["runtime"]["temporalRegisteredRegionConfidence"] = True
        config["runtime"]["temporalRegisteredMinImportantSupport"] = float(
            args.registered_min_important_support
        )
        config["runtime"]["temporalRegisteredMinPartSupport"] = float(
            args.registered_min_part_support
        )
        config["runtime"]["temporalRegisteredMinCoreSupport"] = float(
            args.registered_min_core_support
        )
        config["runtime"]["temporalRegisteredRequireCenters"] = not bool(
            args.registered_allow_invalid_centers
        )
        config["runtime"]["temporalRegisteredMaxInvalidImportantRatio"] = float(
            args.registered_max_invalid_important_ratio
        )
    config["runtime"]["temporalRegisteredFlowSize"] = int(args.registered_flow_size)
    if args.registered_bicubic_residual:
        config["runtime"]["temporalRegisteredBicubicResidual"] = True
    if args.current_masks:
        config["runtime"]["temporalCurrentFrameMasks"] = True
    if args.current_occluder:
        config["runtime"]["temporalCurrentOccluder"] = True
        config["runtime"]["temporalCurrentFaceParser"] = False
    if args.current_face_parser:
        config["runtime"]["temporalCurrentFaceParser"] = True
    if args.parser_pre_restorer:
        config["runtime"]["temporalParserUsesPreRestorerBase"] = True
        config["runtime"]["temporalParserDecoupledFromRestorer"] = True
    if args.parser_decoupled:
        config["runtime"]["temporalParserDecoupledFromRestorer"] = True
    config["runtime"]["temporalFaceParserSkipFrames"] = int(args.parser_skip_frames)
    engine._config = config
    config_json = json.dumps(config, sort_keys=True, separators=(",", ":"))
    config_sha256 = hashlib.sha256(config_json.encode("utf-8")).hexdigest()
    if args.restorer_native_trt_qualified_plan is not None:
        parameters = config.get("parameters") or {}
        if str(parameters.get("RestorerTypeTextSel")) != "GPEN512":
            raise ValueError("qualified GPEN512 benchmark requires GPEN512")
        if str(parameters.get("ModelSessionsTextSel")) != "Shared":
            raise ValueError(
                "qualified GPEN512 benchmark requires Shared model sessions"
            )

    warm_started = time.perf_counter()
    warm = engine.warm(config=config, allow_create_selected=True)
    engine._compute_stream.synchronize()
    cold_warm_seconds = time.perf_counter() - warm_started
    embedding_started = time.perf_counter()
    source_embedding = engine.embedding_from_images(identity_images, config)
    engine._compute_stream.synchronize()
    embedding_seconds = time.perf_counter() - embedding_started
    semantic_landmark_estimator_factory = (
        lambda: SemanticLandmarkEstimator(
            stream_id=int(engine._compute_stream.cuda_stream),
            use_cuda=True,
        )
        if bool(
            config["runtime"].get("temporalSemanticMeshEnabled", False)
            or config["runtime"].get(
                "temporalSemanticFeaturePatchesEnabled",
                False,
            )
        )
        else None
    )

    occlusion_path = DEFAULT_INPUT / "pexels-18400987-popsicle-occlusion-silent-720p.mp4"
    occlusion_metadata = (
        {}
        if args.no_occlusion_fixture
        else draw_popsicle_fixture(engine, clips[-1], occlusion_path, config)
    )
    run_clips = clips if args.no_occlusion_fixture else clips + (occlusion_path,)
    clip_reports = []
    try:
        for clip in run_clips:
            output_path = output_dir / f"{clip.stem}-swapped-silent.mp4"
            output_path.unlink(missing_ok=True)
            report = benchmark_clip(
                engine,
                source_embedding,
                clip,
                output_path,
                args.seconds,
                temporal_anchor_hz=(
                    float(config["runtime"].get("temporalFullAnchorHz", 0.0))
                    if bool(config["runtime"].get("temporalForegroundReuseEnabled", False))
                    else 0.0
                ),
                temporal_restorer_hz=(
                    float(config["runtime"].get("temporalRestorerAnchorHz", 0.0))
                    if bool(config["runtime"].get("adaptiveRestorer", False))
                    else 0.0
                ),
                pipelined_decode=True,
                baseline_evidence={"eligible": True},
                whole_output_reuse_enabled=not bool(
                    config["runtime"].get("temporalCurrentGeometryEnabled", False)
                ),
                semantic_landmark_estimator_factory=(
                    semantic_landmark_estimator_factory
                ),
                capture_restorer_inputs_path=(
                    args.capture_restorer_inputs
                    / f"{clip.stem}-gpen-inputs-f32.npy"
                    if args.capture_restorer_inputs is not None
                    else None
                ),
                capture_restorer_inputs_limit=max(
                    0,
                    int(args.capture_restorer_inputs_per_clip),
                ),
                capture_frame_hashes=bool(args.capture_frame_hashes),
                diagnose_mask_backend_parity=bool(
                    args.diagnose_mask_backend_parity
                ),
                mask_backend_parity_samples=int(
                    args.mask_backend_parity_samples
                ),
                exact_cpu_overlap=bool(
                    config["runtime"].get("exactCpuResidualOverlap", False)
                ),
            )
            report["inputSha256"] = sha256_file(clip)
            report["outputSha256"] = sha256_file(output_path)
            if report.get("error") or int(report.get("encoded", {}).get("videoStreams", 0)) != 1:
                clip_reports.append(report)
                print(
                    json.dumps(
                        {
                            "clip": clip.name,
                            "error": report.get("error") or "benchmark output has no video stream",
                        }
                    ),
                    flush=True,
                )
                break
            report["quality"] = analyze_pair(
                engine,
                clip,
                output_path,
                max_seconds=args.seconds,
                sample_fps=args.quality_sample_fps,
                occlusion_fixture=clip == occlusion_path,
                frame_provenance=report["transformation"].get("frameProvenance"),
            )
            clip_reports.append(report)
            print(
                json.dumps(
                    {
                        "clip": clip.name,
                        "fps": round(report["timing"]["processingFps"], 3),
                        "headroom": round(report["timing"]["realtimeHeadroom"], 3),
                        "poseP95": report["quality"]["attachmentPoseDeltaP95"],
                        "flickerP95": report["quality"]["boundaryFlickerMaeP95"],
                        "occlusionBadP95": report["quality"]["occlusionCoreBadRatioP95"],
                    }
                ),
                flush=True,
            )
    finally:
        engine.unload()
        engine.shutdown_gpu_worker()

    processing_fps = [item["timing"]["processingFps"] for item in clip_reports]
    headroom = [item["timing"]["realtimeHeadroom"] for item in clip_reports]
    activation_totals: dict[str, int] = {
        "continuousResidualWarp": 0,
        "canonicalResidualTransport": 0,
        "residualReturn": 0,
        "residualLegacyParserEvidence": 0,
        "exactPastebackRoundToNearest": 0,
        "outputFractionalLevels": 0,
        "faceParserEvidenceQuantization": 0,
        "referenceParserMaskDiagnostic": 0,
        "lowFrequencyAnchorStabilization": 0,
        "hybridReference": 0,
    }
    for clip_report in clip_reports:
        counts = (
            (clip_report.get("transformation") or {}).get(
                "experimentalActivationCounts", {}
            )
        )
        activation_totals["continuousResidualWarp"] += int(
            (counts.get("reuseSampler") or {}).get(
                "continuous-four-tap-linear", 0
            )
        )
        activation_totals["canonicalResidualTransport"] += int(
            (counts.get("reuseTransport") or {}).get(
                "canonical-composition", 0
            )
        )
        activation_totals["residualReturn"] += int(
            counts.get("residualReturnFrames", 0)
        )
        activation_totals["residualLegacyParserEvidence"] += int(
            counts.get("residualLegacyParserEvidenceFrames", 0)
        )
        activation_totals["exactPastebackRoundToNearest"] += int(
            counts.get("exactPastebackRoundedFrames", 0)
        )
        activation_totals["outputFractionalLevels"] += int(
            counts.get("outputFractionalFrames", 0)
        )
        activation_totals["faceParserEvidenceQuantization"] += int(
            counts.get("parserEvidenceQuantizedFrames", 0)
        )
        activation_totals["referenceParserMaskDiagnostic"] += int(
            counts.get("referenceParserMaskFrames", 0)
        )
        activation_totals["lowFrequencyAnchorStabilization"] += int(
            counts.get("lowFrequencyAnchorStabilizedFrames", 0)
        )
        activation_totals["hybridReference"] += sum(
            int(value)
            for value in (counts.get("hybridReferenceByReason") or {}).values()
        )
    requested_activations = {
        "continuousResidualWarp": bool(args.continuous_residual_warp),
        "canonicalResidualTransport": bool(args.canonical_residual_transport),
        "residualReturn": bool(args.restorer_residual_return),
        "residualLegacyParserEvidence": bool(
            args.restorer_residual_parser_uses_legacy_appearance
        ),
        "exactPastebackRoundToNearest": bool(args.exact_pasteback_round_to_nearest),
        "outputFractionalLevels": bool(
            args.restorer_output_fractional_levels is not None
            and int(args.restorer_output_fractional_levels) > 0
        ),
        "faceParserEvidenceQuantization": bool(
            args.face_parser_evidence_quantization_step is not None
            and float(args.face_parser_evidence_quantization_step) > 0.0
        ),
        "referenceParserMaskDiagnostic": bool(
            args.reference_parser_mask_diagnostic
        ),
        "lowFrequencyAnchorStabilization": bool(
            args.restorer_low_frequency_anchor_stabilization
        ),
        "hybridReference": bool(args.restorer_hybrid_reference_reasons),
    }
    missing_activations = sorted(
        name
        for name, requested in requested_activations.items()
        if requested and activation_totals.get(name, 0) <= 0
    )
    experiment_activation = {
        "requested": requested_activations,
        "counts": activation_totals,
        "missing": missing_activations,
        "allRequestedActivated": not missing_activations,
    }
    result = {
        "schema": "pong-temporal-attachment-v1",
        "label": args.label,
        "silent": True,
        "identity": args.identity_dir.name,
        "configuration": config,
        "protectedSettings": protected_settings(config),
        "provenance": {
            "configurationSha256": config_sha256,
            "modelSha256": effective_model_hashes(config),
            "clipSha256": {clip.name: sha256_file(clip) for clip in run_clips},
            "configOverrides": (
                str(args.config_overrides_json.resolve())
                if args.config_overrides_json is not None
                else ""
            ),
            "configOverridesSha256": override_sha256,
            "configBaseReport": (
                str(args.config_base_report.resolve())
                if args.config_base_report is not None
                else ""
            ),
            "configBaseReportSha256": base_report_sha256,
        },
        "startup": {
            "coldWarmSeconds": cold_warm_seconds,
            "embeddingSeconds": embedding_seconds,
        },
        "warm": warm,
        "occlusionFixture": occlusion_metadata,
        "experimentActivation": experiment_activation,
        "clips": clip_reports,
        "summary": {
            "clipCount": len(clip_reports),
            "medianProcessingFps": statistics.median(processing_fps),
            "p10RealtimeHeadroom": percentile(headroom, 0.10),
            "minimumRealtimeHeadroom": min(headroom),
            "allSilent": all(item["encoded"].get("audioStreams") == 0 for item in clip_reports),
            "noErrors": all(not item.get("error") for item in clip_reports),
        },
    }
    if args.promotion_baseline is not None:
        baseline_path = args.promotion_baseline.resolve()
        baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
        result["promotionGate"] = evaluate_promotion_gate(
            result,
            baseline,
            minimum_speedup_percent=float(args.minimum_speedup_percent),
            expected_plan_sha256=(
                str(args.expected_plan_sha256).strip().lower()
                if args.expected_plan_sha256
                else None
            ),
            require_frame_hash_equivalence=bool(
                args.require_frame_hash_equivalence
            ),
        )
        result["promotionGate"]["baseline"] = str(baseline_path)
    report_path = output_dir / "report.json"
    report_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({"report": str(report_path), **result["summary"]}, indent=2))
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True)
    parser.add_argument("--identity-dir", type=Path, default=DEFAULT_IDENTITY)
    parser.add_argument("--clips", type=Path, nargs="+", default=list(DEFAULT_CLIPS))
    parser.add_argument("--seconds", type=float, default=10.0)
    parser.add_argument("--quality-sample-fps", type=float, default=10.0)
    parser.add_argument(
        "--restorer-backend",
        choices=("legacy", "cuda", "trt", "native-trt"),
    )
    parser.add_argument("--restorer-hybrid-frame-age-every", type=int)
    parser.add_argument("--restorer-hybrid-frame-age-phase", type=int)
    parser.add_argument("--restorer-hybrid-patch-every", type=int)
    parser.add_argument("--restorer-hybrid-mean-every", type=int)
    parser.add_argument("--restorer-hybrid-lower-center-every", type=int)
    parser.add_argument("--restorer-hybrid-lower-center-phase", type=int)
    parser.add_argument(
        "--restorer-hybrid-lower-center-min-input-mae",
        type=float,
    )
    parser.add_argument(
        "--restorer-hybrid-reference-blend-weight",
        type=float,
    )
    parser.add_argument(
        "--restorer-hybrid-lower-center-blend-weight",
        type=float,
    )
    parser.add_argument("--restorer-spatial-exact-blend", action="store_true")
    parser.add_argument(
        "--restorer-spatial-exact-blend-trigger-reasons",
        nargs="+",
        default=[],
    )
    parser.add_argument(
        "--restorer-spatial-exact-blend-requires-hybrid-reference",
        action="store_true",
    )
    parser.add_argument(
        "--restorer-spatial-exact-blend-trigger-max-gap-frames",
        type=int,
        default=0,
    )
    parser.add_argument(
        "--restorer-spatial-exact-blend-trigger-minimum-events",
        type=int,
        default=2,
    )
    parser.add_argument(
        "--restorer-spatial-exact-blend-trigger-minimum-patch-to-mean-ratio",
        type=float,
        default=0.0,
    )
    parser.add_argument(
        "--restorer-spatial-exact-blend-burst-hold-frames",
        type=int,
        default=0,
    )
    parser.add_argument("--restorer-spatial-exact-blend-weight", type=float, default=0.75)
    parser.add_argument("--restorer-spatial-exact-blend-change-low", type=float, default=1.0)
    parser.add_argument("--restorer-spatial-exact-blend-change-high", type=float, default=8.0)
    parser.add_argument(
        "--restorer-spatial-exact-blend-edge-guard", type=float, default=0.0
    )
    parser.add_argument("--restorer-trt-fp32", action="store_true")
    parser.add_argument("--restorer-native-trt-tf32", action="store_true")
    parser.add_argument("--restorer-native-trt-qualified-plan", type=Path)
    parser.add_argument("--restorer-native-trt-split-plan", type=Path)
    parser.add_argument("--restorer-native-static-residual", type=Path)
    parser.add_argument("--restorer-cuda-direct-io", action="store_true")
    parser.add_argument("--restorer-cuda-graph", action="store_true")
    parser.add_argument("--restorer-pixel-center-return-map", action="store_true")
    parser.add_argument("--restorer-bounded-cubic-return-sampler", action="store_true")
    parser.add_argument("--restorer-bounded-cubic-weight", type=float, default=1.0)
    parser.add_argument("--restorer-monotone-hermite-return-sampler", action="store_true")
    parser.add_argument("--restorer-bilinear-input-alignment", action="store_true")
    parser.add_argument("--restorer-fused-input-alignment", action="store_true")
    parser.add_argument("--restorer-residual-return", action="store_true")
    parser.add_argument("--restorer-residual-return-weight", type=float, default=1.0)
    parser.add_argument("--restorer-residual-return-minimum-face-size", type=int, default=0)
    parser.add_argument(
        "--restorer-residual-parser-uses-legacy-appearance",
        action="store_true",
    )
    parser.add_argument("--restorer-low-frequency-anchor-stabilization", action="store_true")
    parser.add_argument("--restorer-low-frequency-anchor-strength", type=float, default=0.15)
    parser.add_argument("--restorer-low-frequency-anchor-kernel", type=int, default=15)
    parser.add_argument("--restorer-low-frequency-anchor-max-correction", type=float, default=3.0)
    parser.add_argument("--exact-pasteback-round-to-nearest", action="store_true")
    parser.add_argument("--exact-pasteback-float64-composite", action="store_true")
    parser.add_argument("--continuous-residual-warp", action="store_true")
    parser.add_argument("--restorer-output-fractional-levels", type=int)
    parser.add_argument("--face-parser-evidence-quantization-step", type=float)
    parser.add_argument("--reference-parser-mask-diagnostic", action="store_true")
    parser.add_argument(
        "--restorer-hybrid-reference-reasons",
        nargs="+",
        choices=(
            "first-anchor",
            "identity-deadline",
            "frame-age",
            "patch-disagreement",
            "mean-disagreement",
            "lower-center-disagreement",
        ),
    )
    parser.add_argument("--restorer-return-geometry-cache", action="store_true")
    parser.add_argument("--mask-cuda-graph", action="store_true")
    parser.add_argument("--mask-backend", choices=("cuda", "trt"))
    parser.add_argument("--adaptive-mask-backend", action="store_true")
    parser.add_argument("--adaptive-mask-residual-threshold", type=float, default=0.008)
    parser.add_argument("--adaptive-mask-minimum-samples", type=int, default=3)
    parser.add_argument("--adaptive-mask-preflight", action="store_true")
    parser.add_argument("--adaptive-mask-preflight-frames", type=int, default=5)
    parser.add_argument("--adaptive-mask-flow-p90-threshold", type=float, default=0.80)
    parser.add_argument("--mask-occluder-backend", choices=("cuda", "trt"))
    parser.add_argument("--mask-face-parser-backend", choices=("cuda", "trt"))
    parser.add_argument("--mask-exact-parser-blend", action="store_true")
    parser.add_argument("--mask-exact-parser-blend-current-weight", type=float, default=0.80)
    parser.add_argument("--mask-trt-detail-gain-compensation", type=float)
    parser.add_argument("--mask-trt-post-sharpen-amount", type=float)
    parser.add_argument("--mask-trt-sparse-edge-boost-threshold", type=float)
    parser.add_argument("--exact-cpu-overlap", action="store_true")
    parser.add_argument("--disable-full-reuse", action="store_true")
    parser.add_argument("--full-anchor-hz", type=float)
    parser.add_argument("--restorer-anchor-hz", type=float)
    parser.add_argument("--restorer-max-input-mae", type=float)
    parser.add_argument("--restorer-max-input-patch-mae", type=float)
    parser.add_argument("--mask-max-input-mae", type=float)
    parser.add_argument("--mask-max-input-patch-mae", type=float)
    parser.add_argument("--dfl-xseg-reuse", action="store_true")
    parser.add_argument("--occluder-decoupled", action="store_true")
    parser.add_argument("--full-max-face-mae", type=float)
    parser.add_argument("--full-max-face-p90", type=float)
    parser.add_argument("--full-max-patch-mae", type=float)
    parser.add_argument("--restorer-exact-blend", action="store_true")
    parser.add_argument("--restorer-exact-blend-weight", type=float, default=0.75)
    parser.add_argument("--exact-output-stabilization", action="store_true")
    parser.add_argument("--exact-output-current-weight", type=float, default=0.85)
    parser.add_argument("--exact-output-dense-flow", action="store_true")
    parser.add_argument("--exact-mouth-stabilization", action="store_true")
    parser.add_argument("--exact-mouth-current-weight", type=float, default=0.80)
    parser.add_argument("--exact-mouth-max-mae", type=float, default=10.0)
    parser.add_argument("--exact-mouth-max-p90", type=float, default=24.0)
    parser.add_argument("--exact-landmark-lock", action="store_true")
    parser.add_argument("--exact-landmark-lock-strength", type=float, default=0.5)
    parser.add_argument("--realtime-face-enhancer", action="store_true")
    parser.add_argument("--whole-output-bicubic", action="store_true")
    parser.add_argument("--detector-lk-fusion", action="store_true")
    parser.add_argument("--detector-lk-fusion-weight", type=float, default=0.5)
    parser.add_argument("--detector-lk-fusion-max-residual-ratio", type=float, default=0.02)
    parser.add_argument("--detector-shape-continuity", action="store_true")
    parser.add_argument("--detector-shape-continuity-weight", type=float, default=0.20)
    parser.add_argument("--detector-shape-continuity-max-residual-ratio", type=float, default=0.05)
    parser.add_argument("--identity-residual-stabilization", action="store_true")
    parser.add_argument("--identity-residual-high-motion-only", action="store_true")
    parser.add_argument("--identity-residual-current-weight", type=float, default=0.70)
    parser.add_argument("--identity-residual-change-low", type=float, default=2.0)
    parser.add_argument("--identity-residual-change-high", type=float, default=14.0)
    parser.add_argument("--identity-residual-max-input-mae", type=float, default=20.0)
    parser.add_argument("--identity-residual-max-input-patch-mae", type=float, default=48.0)
    parser.add_argument("--disable-lk-smoothing", action="store_true")
    parser.add_argument("--feature-patch-lock", action="store_true")
    parser.add_argument("--feature-patch-lock-strength", type=float, default=0.65)
    parser.add_argument("--feature-patch-max-mae", type=float, default=16.0)
    parser.add_argument("--feature-patch-max-p90", type=float, default=34.0)
    parser.add_argument("--canonical-residual-transport", action="store_true")
    parser.add_argument("--canonical-residual-low-motion-only", action="store_true")
    parser.add_argument("--canonical-residual-blend-weight", type=float, default=1.0)
    parser.add_argument("--pose-aware-affine-residual", action="store_true")
    parser.add_argument("--pose-aware-affine-max-anisotropy", type=float, default=1.12)
    parser.add_argument("--pose-aware-affine-min-improvement", type=float, default=0.12)
    parser.add_argument("--pose-aware-affine-min-residual-ratio", type=float, default=0.008)
    parser.add_argument("--adaptive-grace", action="store_true")
    parser.add_argument("--landmark-residual-ratio", type=float)
    parser.add_argument("--dense-flow-residual", action="store_true")
    parser.add_argument("--dense-flow-size", type=int, default=192)
    parser.add_argument("--sparse-mesh-residual", action="store_true")
    parser.add_argument("--semantic-mesh-residual", action="store_true")
    parser.add_argument("--semantic-high-motion-only", action="store_true")
    parser.add_argument("--semantic-feature-patches", action="store_true")
    parser.add_argument(
        "--semantic-feature-groups",
        choices=("eyes", "all"),
        default="eyes",
    )
    parser.add_argument("--semantic-landmark-refresh-hz", type=float, default=1.0)
    parser.add_argument("--sparse-mesh-size", type=int, default=128)
    parser.add_argument("--no-occlusion-fixture", action="store_true")
    parser.add_argument("--current-geometry", action="store_true")
    parser.add_argument("--registered-residual", action="store_true")
    parser.add_argument("--registered-region-confidence", action="store_true")
    parser.add_argument("--registered-min-important-support", type=float, default=0.98)
    parser.add_argument("--registered-min-part-support", type=float, default=0.97)
    parser.add_argument("--registered-min-core-support", type=float, default=0.75)
    parser.add_argument("--registered-max-invalid-important-ratio", type=float, default=0.01)
    parser.add_argument("--registered-allow-invalid-centers", action="store_true")
    parser.add_argument("--registered-flow-size", type=int, default=128)
    parser.add_argument("--registered-bicubic-residual", action="store_true")
    parser.add_argument("--current-masks", action="store_true")
    parser.add_argument("--current-occluder", action="store_true")
    parser.add_argument("--current-face-parser", action="store_true")
    parser.add_argument("--parser-pre-restorer", action="store_true")
    parser.add_argument("--parser-decoupled", action="store_true")
    parser.add_argument("--parser-skip-frames", type=int, default=0)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument(
        "--config-base-report",
        type=Path,
        help="Use the frozen configuration embedded in a prior benchmark report.",
    )
    parser.add_argument(
        "--config-overrides-json",
        type=Path,
        help=(
            "Optional benchmark-only runtime/parameter overrides. The file is "
            "hashed into provenance and never written to the live preset."
        ),
    )
    parser.add_argument("--capture-restorer-inputs", type=Path)
    parser.add_argument("--capture-restorer-inputs-per-clip", type=int, default=0)
    parser.add_argument("--capture-frame-hashes", action="store_true")
    parser.add_argument(
        "--require-frame-hash-equivalence",
        action="store_true",
        help=(
            "Fail the promotion gate unless source CRCs, pre-encoder CRCs, "
            "and frame provenance exactly match the promotion baseline."
        ),
    )
    parser.add_argument("--diagnose-mask-backend-parity", action="store_true")
    parser.add_argument("--mask-backend-parity-samples", type=int, default=12)
    parser.add_argument("--promotion-baseline", type=Path)
    parser.add_argument("--minimum-speedup-percent", type=float, default=0.0)
    parser.add_argument("--expected-plan-sha256")
    args = parser.parse_args()
    result = run(args)
    promotion_gate = result.get("promotionGate")
    if promotion_gate is not None and not promotion_gate.get("passed", False):
        print(json.dumps(promotion_gate, indent=2), flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
