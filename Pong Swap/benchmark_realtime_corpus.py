"""Silent, per-clip real-time and transformation gate for Pong Swap.

The benchmark deliberately uses only the repository's stock test identity and
the licensed stock corpus.  It never scans the user's approved-face folders.
Every clip is judged independently so a fast/easy video cannot conceal a slow
or untransformed one in an aggregate average.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import os
import queue
import statistics
import subprocess
import sys
import threading
import time
import zlib
from types import SimpleNamespace
from collections import Counter
from copy import deepcopy
from pathlib import Path

import av
import cv2
import numpy as np
from skimage.metrics import structural_similarity


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pong_swap_config import MODELS_DIR
from pong_swap_engine import (
    LandmarkTrackAdvance,
    MaskMotionPreflight,
    PongSwapEngine,
    _advance_prefetch_tracking,
    _apply_source_fps_runtime_cadence,
    _quality_preserving_output_cadence,
    build_temporal_restorer_context,
    _commit_tracking_advance,
    _full_frame_reuse_appearance_is_safe,
    _initialize_sparse_residual_mesh,
    _record_adaptive_mask_motion,
    _rebase_sparse_residual_mesh,
    _plan_prior_swap_residual,
    _render_prior_swap_residual,
    _stabilize_exact_output_with_prior,
    _warp_prior_swap_residual,
    _warp_prior_swap_with_semantic_features,
    _warp_prior_swap_residual_dense_flow,
    _warp_prior_swap_residual_sparse_mesh,
)


CORPUS_ROOT = ROOT / "benchmarks" / "realtime-stock-corpus"
MANIFEST_PATH = CORPUS_ROOT / "manifest.json"
STOCK_FACE = ROOT / "cache" / "benchmark" / "source-face.jpg"
DEFAULT_ELIGIBILITY_REPORT = (
    CORPUS_ROOT / "runs" / "production-parity-quality-gpen512-24-v2" / "report.json"
)


def _seed_tracking_render_contract(tracking_state: dict, runtime: dict) -> dict:
    """Match the live feeder's LK rendering mode on start and reset."""
    tracking_state["sharedLandmarkEstimator"] = bool(
        runtime.get("temporalDetectorLkFusionEnabled", False)
    )
    tracking_state["disableLkSmoothing"] = bool(
        runtime.get("temporalDisableLkSmoothing", False)
    )
    return tracking_state


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_eligibility_report(
    path: Path | None,
    manifest_by_name: dict[str, dict],
) -> dict[str, dict]:
    """Return exact-baseline evidence for clips that contain a usable face.

    A performance candidate must not be failed merely because a stock clip has
    no transformable face. Conversely, an easy no-face clip must never count
    toward the requested 20-video gate. Eligibility is fixed by the untouched
    exact GPEN512 baseline, never by the faster candidate being evaluated.
    """
    if path is None or not path.is_file():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    evidence: dict[str, dict] = {}
    for clip in payload.get("clips", []):
        name = str(clip.get("clip") or "")
        # Eligibility evidence must identify the bytes it actually processed.
        # A same-named manifest entry is not historical provenance.
        source_sha256 = str(clip.get("sourceSha256") or "").lower()
        if len(source_sha256) != 64:
            continue
        transformation = clip.get("transformation") or {}
        face_frames = int(transformation.get("faceFrames") or 0)
        ratio = float(transformation.get("transformedFaceFrameRatio") or 0.0)
        identity_proof = bool((clip.get("checks") or {}).get("identityProof"))
        # At least about one second of independently detected face content, a
        # mostly transformed sequence, and independent identity evidence from
        # the untouched exact run.  This excludes clips 06/13/17.  Clip 07 is
        # also a byte-for-byte duplicate of clip 04, leaving exactly twenty
        # distinct, independently proven five-second face videos in the stock
        # gate rather than allowing filenames or no-face clips to inflate it.
        eligible = face_frames >= 24 and ratio >= 0.80 and identity_proof
        evidence[source_sha256] = {
            "eligible": eligible,
            "faceFrames": face_frames,
            "transformedFaceFrameRatio": ratio,
            "identityProof": identity_proof,
            "sourceFrames": int((clip.get("source") or {}).get("frames") or 0),
            "baselineClip": name,
            "baselineOutputSha256": str(clip.get("outputSha256") or ""),
        }
    return evidence


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return float(ordered[low])
    return float(ordered[low] * (high - position) + ordered[high] * (position - low))


def face_roi(rgb: np.ndarray, kps: np.ndarray | None) -> np.ndarray:
    if kps is None:
        return np.empty((0, 0, 3), dtype=np.uint8)
    points = np.asarray(kps, dtype=np.float32)
    height, width = rgb.shape[:2]
    center_x = float((points[:, 0].min() + points[:, 0].max()) * 0.5)
    center_y = float((points[:, 1].min() + points[:, 1].max()) * 0.5)
    span = max(float(np.ptp(points[:, 0])), float(np.ptp(points[:, 1])))
    side = max(48, int(round(span * 3.2)))
    left = max(0, min(width - 2, int(round(center_x - side * 0.5))))
    top = max(0, min(height - 2, int(round(center_y - side * 0.55))))
    right = max(left + 2, min(width, left + side))
    bottom = max(top + 2, min(height, top + side))
    crop = np.ascontiguousarray(rgb[top:bottom, left:right])
    if crop.size == 0:
        return np.empty((0, 0, 3), dtype=np.uint8)
    # A face that approaches a frame edge produces a clipped crop whose raw
    # dimensions vary by a few pixels.  Normalize only the diagnostic ROI so
    # consecutive-frame temporal comparisons remain defined.  Rendering and
    # the encoded benchmark output are untouched.
    return np.ascontiguousarray(cv2.resize(crop, (160, 160), interpolation=cv2.INTER_AREA))


def identity_score(engine: PongSwapEngine, rgb: np.ndarray, source_embedding: np.ndarray) -> float | None:
    detected = detect_on_engine_stream(engine, rgb, recognize=True)
    if not detected or detected[0][2] is None:
        return None
    return float(engine._vm.findCosineDistance(np.asarray(detected[0][2]), source_embedding))


def detect_on_engine_stream(
    engine: PongSwapEngine,
    rgb: np.ndarray,
    *,
    recognize: bool,
    max_faces: int | None = None,
):
    """Run diagnostic detection through the production stream contract.

    Shared ORT I/O bindings are owned by Pong's persistent compute stream.
    Benchmark verification must not call those sessions from the default CUDA
    stream and accidentally create an independent allocator high-water mark.
    """
    def detect():
        with engine._lock:
            with engine._torch.cuda.stream(engine._compute_stream):
                detected = engine._detect(
                    engine._frame_tensor(rgb),
                    recognize=recognize,
                    max_faces=max_faces,
                )
            engine._compute_stream.synchronize()
        return detected

    run_gpu_work = getattr(engine, "_run_gpu_work", None)
    if callable(run_gpu_work):
        return run_gpu_work(
            detect,
            priority=0,
            work_label=(
                "validator-detect-recognize" if recognize else "validator-detect"
            ),
        )
    return detect()


def stabilize_exact_render_landmarks(
    engine: PongSwapEngine,
    current_source: np.ndarray,
    current_exact: np.ndarray,
    current_source_kps: np.ndarray,
    previous_source: np.ndarray | None,
    previous_source_kps: np.ndarray | None,
    previous_render_kps: np.ndarray | None,
    *,
    strength: float,
) -> tuple[np.ndarray, np.ndarray | None]:
    """Carry identity-relative five-point geometry across safe exact anchors."""
    detected = detect_on_engine_stream(engine, current_exact, recognize=False)
    if not detected:
        return current_exact, None
    current_render_kps = np.asarray(detected[0][1], dtype=np.float32).reshape(-1, 2)
    if (
        previous_source is None
        or previous_source_kps is None
        or previous_render_kps is None
        or current_render_kps.shape != (5, 2)
    ):
        return current_exact, current_render_kps
    appearance = {}
    if not _full_frame_reuse_appearance_is_safe(
        current_source,
        previous_source,
        previous_source_kps,
        current_source_kps,
        max_face_mae=14.0,
        max_face_p90=32.0,
        max_patch_mae=46.0,
        diagnostics=appearance,
    ):
        return current_exact, current_render_kps
    transform, _ = cv2.estimateAffinePartial2D(
        np.asarray(previous_source_kps, dtype=np.float32),
        np.asarray(current_source_kps, dtype=np.float32),
        method=cv2.LMEDS,
    )
    if transform is None or not np.isfinite(transform).all():
        return current_exact, current_render_kps
    predicted = cv2.transform(
        np.asarray(previous_render_kps, dtype=np.float32).reshape(1, -1, 2),
        transform,
    )[0]
    innovation = predicted - current_render_kps
    span = max(1.0, float(np.linalg.norm(
        current_render_kps[1] - current_render_kps[0]
    )))
    residual_ratio = float(
        math.sqrt(float(np.mean(np.square(np.linalg.norm(innovation, axis=1)))))
        / span
    )
    if not math.isfinite(residual_ratio) or residual_ratio > 0.04:
        return current_exact, current_render_kps
    bounded_strength = float(np.clip(strength, 0.0, 1.0))
    desired = current_render_kps + innovation * bounded_strength
    corrected = _warp_prior_swap_residual(
        current_source,
        current_source,
        current_exact,
        current_render_kps,
        desired,
        max_landmark_residual_ratio=0.05,
    )
    if corrected is None:
        return current_exact, current_render_kps
    return corrected, desired.astype(np.float32, copy=False)


def probe_output(path: Path) -> dict:
    completed = subprocess.run(
        [
            "ffprobe", "-v", "error", "-count_frames", "-show_entries",
            "stream=codec_type,avg_frame_rate,r_frame_rate,duration,nb_read_frames:format=duration",
            "-of", "json", str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    payload = json.loads(completed.stdout)
    streams = payload.get("streams", [])
    video_streams = [stream for stream in streams if stream.get("codec_type") == "video"]
    duration = float(payload.get("format", {}).get("duration") or 0.0)
    video_frames = sum(int(stream.get("nb_read_frames") or 0) for stream in video_streams)
    return {
        "durationSeconds": duration,
        "videoStreams": len(video_streams),
        "audioStreams": sum(1 for stream in streams if stream.get("codec_type") == "audio"),
        "videoFrames": video_frames,
        "avgFrameRate": str(video_streams[0].get("avg_frame_rate") or "") if video_streams else "",
    }


def encoder(width: int, height: int, fps: float, output_path: Path, config: dict) -> subprocess.Popen:
    runtime = config["runtime"]
    return subprocess.Popen(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s:v", f"{width}x{height}",
            "-r", f"{fps:.9f}", "-i", "pipe:0", "-an", "-c:v", "h264_nvenc",
            "-preset", str(runtime.get("encoderPreset", "p1")), "-tune", "ll",
            "-rc", "vbr", "-cq", str(runtime.get("encoderCq", 23)), "-b:v", "0",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output_path),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )


def mask_backend_motion_preflight(
    clip_path: Path,
    *,
    frame_count: int = 5,
    flow_p90_threshold: float = 0.80,
) -> dict:
    """Classify mask execution from a tiny source-only motion probe.

    Five 160x90 grayscale frames are enough to identify broad non-rigid/high
    motion without loading another neural model.  This observes source motion
    only; it never examines transformed output or identity pixels.
    """
    started = time.perf_counter()
    capture = cv2.VideoCapture(str(clip_path))
    classifier = MaskMotionPreflight(
        frame_count=frame_count,
        flow_p90_threshold=flow_p90_threshold,
    )
    try:
        for _ in range(max(2, int(frame_count))):
            ok, frame = capture.read()
            if not ok:
                break
            classifier.add(frame, rgb=False)
    finally:
        capture.release()
    return {
        **classifier.result(),
        "seconds": time.perf_counter() - started,
    }


def benchmark_clip(
    engine: PongSwapEngine,
    source_embedding: np.ndarray,
    clip_path: Path,
    output_path: Path,
    seconds: float,
    temporal_anchor_hz: float = 0.0,
    temporal_restorer_hz: float = 0.0,
    pipelined_decode: bool = False,
    reference_path: Path | None = None,
    baseline_evidence: dict | None = None,
    whole_output_reuse_enabled: bool = True,
    semantic_landmark_estimator=None,
    semantic_landmark_estimator_factory=None,
    capture_restorer_inputs_path: Path | None = None,
    capture_restorer_metadata_path: Path | None = None,
    capture_restorer_inputs_limit: int = 0,
    capture_frame_hashes: bool = False,
    diagnose_mask_backend_parity: bool = False,
    mask_backend_parity_samples: int = 12,
    exact_cpu_overlap: bool = False,
    quality_diagnostics: bool = True,
    tracking_lookahead_enabled: bool = False,
) -> dict:
    # Match production's per-session configuration snapshot. Repeated public
    # property reads deep-copy hundreds of settings and are test overhead,
    # not renderer work. Refresh once after source-FPS normalization below.
    benchmark_config = engine.config
    mask_preflight = None
    if bool(benchmark_config["runtime"].get("maskAdaptivePreflightEnabled", False)):
        mask_preflight = mask_backend_motion_preflight(
            clip_path,
            frame_count=int(
                benchmark_config["runtime"].get("maskAdaptivePreflightFrames", 5)
            ),
            flow_p90_threshold=float(
                benchmark_config["runtime"].get("maskAdaptiveFlowP90Threshold", 0.80)
            ),
        )
    semantic_requested = bool(
        benchmark_config["runtime"].get("temporalSemanticMeshEnabled", False)
        or benchmark_config["runtime"].get(
            "temporalSemanticFeaturePatchesEnabled", False
        )
    )
    semantic_motion_allowed_for_clip = bool(
        not benchmark_config["runtime"].get(
            "temporalSemanticHighMotionOnly", False
        )
        or (
            mask_preflight is not None
            and str(mask_preflight.get("backend")) == "cuda"
        )
    )
    if (
        semantic_landmark_estimator is None
        and semantic_landmark_estimator_factory is not None
        and semantic_requested
        and semantic_motion_allowed_for_clip
    ):
        semantic_landmark_estimator = semantic_landmark_estimator_factory()
    container = av.open(str(clip_path))
    stream = next(item for item in container.streams if item.type == "video")
    source_fps = float(stream.average_rate or stream.base_rate or 24.0)
    fps, source_frame_stride = _quality_preserving_output_cadence(
        source_fps, benchmark_config['runtime'].get('qualityPreservingMaxFps', 0.0),
    )
    def selected_source_frames():
        for index, decoded in enumerate(container.decode(stream)):
            if index % source_frame_stride == 0:
                yield decoded
    _apply_source_fps_runtime_cadence(engine._config["runtime"], fps)
    benchmark_config = engine.config
    width = int(stream.codec_context.width)
    height = int(stream.codec_context.height)
    frame_limit = max(1, int(math.ceil(seconds * fps)))
    process = encoder(width, height, fps, output_path, benchmark_config)
    process_ms: list[float] = []
    lookahead = None
    if tracking_lookahead_enabled and pipelined_decode:
        from pong_swap_lookahead import TrackingLookahead
        from pong_swap_engine import _track_landmarks_lk
        lookahead = TrackingLookahead(_track_landmarks_lk)
    # Keep a frame-aligned timing ledger for dependency-aware scheduling
    # experiments.  Aggregate percentiles hide whether temporal CPU work can
    # actually overlap the next exact GPU anchor.  Recording the already
    # measured wall interval is diagnostic-only and does not add work inside
    # the renderer.
    process_frame_timings: list[dict[str, int | str | float]] = []
    decode_ms: list[float] = []
    download_ms: list[float] = []
    pipe_ms: list[float] = []
    face_deltas: list[float] = []
    identity_gains: list[float] = []
    identity_sample_attempts = 0
    last_identity_sample_frame = -1_000_000
    quality_diagnostic_seconds = 0.0
    stage_diagnostics: dict[str, list[float]] = {}
    decode_queue: queue.Queue = queue.Queue(maxsize=3)
    decode_stop = threading.Event()
    decode_sentinel = object()
    decode_thread = None
    reference_container = (
        av.open(str(reference_path))
        if quality_diagnostics and reference_path and reference_path.is_file()
        else None
    )
    reference_stream = (
        next((item for item in reference_container.streams if item.type == "video"), None)
        if reference_container is not None
        else None
    )
    reference_iterator = iter(reference_container.decode(reference_stream)) if reference_stream is not None else None
    reference_ssim: list[float] = []
    reference_mae: list[float] = []
    reference_psnr: list[float] = []
    temporal_delta_mae: list[float] = []
    previous_candidate_roi = None
    previous_reference_roi = None

    if pipelined_decode:
        def publish_decoded(item) -> bool:
            while not decode_stop.is_set():
                try:
                    decode_queue.put(item, timeout=0.1)
                    return True
                except queue.Full:
                    continue
            return False

        def decode_worker() -> None:
            try:
                for decoded in selected_source_frames():
                    if decode_stop.is_set():
                        break
                    decode_started = time.perf_counter()
                    rgb = decoded.to_ndarray(format="rgb24")
                    timeline_seconds = (
                        float(decoded.pts * stream.time_base)
                        if decoded.pts is not None and stream.time_base
                        else None
                    )
                    item = (
                        rgb,
                        (time.perf_counter() - decode_started) * 1000.0,
                        timeline_seconds,
                    )
                    if not publish_decoded(item):
                        break
            except Exception as exc:
                publish_decoded(exc)
            finally:
                publish_decoded(decode_sentinel)

        decode_thread = threading.Thread(target=decode_worker, name="PongBenchmarkDecode", daemon=True)
        decode_thread.start()
    transformed_frames = 0
    face_frames = 0
    frames = 0
    anchor = None
    tracking_state: dict = _seed_tracking_render_contract(
        {"trackGeneration": 0}, benchmark_config["runtime"],
    )

    def seed_mask_preflight_state() -> None:
        if mask_preflight is None:
            return
        tracking_state["maskAdaptiveBackend"] = {
            "generation": int(tracking_state.get("trackGeneration", 0)),
            "backend": str(mask_preflight["backend"]),
            "locked": True,
            "samples": [],
            "preflightMedianFlowP90": float(mask_preflight["medianFlowP90"]),
            "preflightSampleCount": int(mask_preflight.get("sampleCount", 0)),
        }

    seed_mask_preflight_state()
    previous_source_frame = None
    previous_swapped_frame = None
    previous_swap_kps = None
    previous_canonical_transform = None
    previous_rendered_kps = None
    previous_render_signature = None
    last_exact_frame = -1
    last_exact_timeline_seconds = None
    previous_timeline_seconds = None
    exact_frames = 0
    reused_frames = 0
    reuse_sampler_counts: Counter[str] = Counter()
    reuse_transport_counts: Counter[str] = Counter()
    # Benchmark-only provenance for temporal attribution.  This records no
    # pixels or identity data; it lets the quality harness distinguish exact
    # renders, reuse frames, and the two handoff directions by source frame.
    frame_provenance: list[dict[str, int | str]] = []
    # Deterministic, non-image provenance for locating rendering divergence.
    # Hashes are captured before FFmpeg so encoder nondeterminism cannot be
    # mistaken for a model/mask/buffer lifetime defect.  They intentionally
    # expose no pixels and are used only by the local benchmark reports.
    source_frame_crc32: list[str] = []
    pre_encoder_frame_crc32: list[str] = []
    frame_hash_diagnostic_seconds = 0.0
    restorer_capture_sink: list[np.ndarray] = []
    restorer_capture_metadata_sink: list[dict] = []
    temporal_restorer_context = build_temporal_restorer_context(
        benchmark_config["runtime"],
        enabled=temporal_restorer_hz > 0,
        extras={
            "nominalFrameSeconds": 1.0 / max(1.0, fps),
            "restorerCaptureSink": restorer_capture_sink,
            "restorerCaptureMetadataSink": restorer_capture_metadata_sink,
            "restorerCaptureLimit": max(0, int(capture_restorer_inputs_limit)),
        },
    )
    mask_backend_probe = None
    if diagnose_mask_backend_parity:
        from mask_backend_parity_probe import MaskBackendParityProbe

        mask_backend_probe = MaskBackendParityProbe(
            engine,
            maximum_samples_per_family=mask_backend_parity_samples,
        ).install()
    configured_identity_interval = max(
        1,
        int(benchmark_config["runtime"].get("identityCheckIntervalFrames", 12)),
    )
    identity_anchor_frames = max(
        1,
        int(math.ceil(fps / max(temporal_anchor_hz, 0.25))),
    )
    identity_interval = configured_identity_interval
    if temporal_anchor_hz > 0 and configured_identity_interval >= identity_anchor_frames:
        identity_interval = max(
            identity_anchor_frames,
            (configured_identity_interval // identity_anchor_frames)
            * identity_anchor_frames,
        )
    sample_indexes = {0, max(1, frame_limit // 3), max(2, (2 * frame_limit) // 3), frame_limit - 1}
    identity_sample_stride = max(1, frame_limit // 12)
    full_reuse_reject_counts: Counter[str] = Counter()
    semantic_refresh_frames = max(
        1,
        int(
            math.ceil(
                fps
                / max(
                    0.1,
                    float(
                        benchmark_config["runtime"].get(
                            "temporalSemanticLandmarkRefreshHz",
                            1.0,
                        )
                    ),
                )
            )
        ),
    )
    last_semantic_refresh_frame = -semantic_refresh_frames
    semantic_refresh_ms: list[float] = []
    semantic_refresh_scores: list[float] = []
    semantic_mesh_configured = bool(
        benchmark_config["runtime"].get("temporalSemanticMeshEnabled", False)
    )
    semantic_feature_configured = bool(
        benchmark_config["runtime"].get(
            "temporalSemanticFeaturePatchesEnabled", False
        )
    )
    semantic_motion_allowed = semantic_motion_allowed_for_clip
    semantic_mesh_enabled_for_clip = bool(
        semantic_mesh_configured and semantic_motion_allowed
    )
    semantic_feature_enabled_for_clip = bool(
        semantic_feature_configured and semantic_motion_allowed
    )
    sparse_mesh_enabled_for_clip = bool(
        benchmark_config["runtime"].get("temporalFullSparseMeshResidual", False)
        and (
            not semantic_mesh_configured
            or semantic_mesh_enabled_for_clip
        )
    )
    started = time.perf_counter()
    error = ""
    overlap_enabled = bool(
        exact_cpu_overlap
        and whole_output_reuse_enabled
        and not bool(benchmark_config["runtime"].get("temporalFullDenseFlowResidual", False))
        and not sparse_mesh_enabled_for_clip
        and not semantic_feature_enabled_for_clip
    )
    output_executor = (
        concurrent.futures.ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="PongResidualRender",
        )
        if overlap_enabled
        else None
    )
    pending_outputs: list[dict] = []

    def render_plan_job(plan, diagnostics):
        render_started = time.perf_counter()
        rendered = _render_prior_swap_residual(plan, diagnostics=diagnostics)
        return rendered, (time.perf_counter() - render_started) * 1000.0

    def finalize_output(record: dict) -> None:
        nonlocal transformed_frames, face_frames
        nonlocal quality_diagnostic_seconds, frame_hash_diagnostic_seconds
        nonlocal previous_candidate_roi, previous_reference_roi, reference_iterator
        nonlocal identity_sample_attempts, last_identity_sample_frame

        render_future = record.get("future")
        if render_future is not None:
            result, render_ms = render_future.result()
            frame_process_ms = float(record.get("planMs", 0.0)) + float(render_ms)
            stage_diagnostics.setdefault("reuseWarpCpuMs", []).append(float(render_ms))
            render_diagnostics = record.get("renderDiagnostics") or {}
            sampler = render_diagnostics.get("residualSampler")
            if sampler:
                reuse_sampler_counts[str(sampler)] += 1
        else:
            result = record["result"]
            frame_process_ms = float(record["processMs"])
        frame_index = int(record["frameIndex"])
        rgb = record["rgb"]
        kps = record.get("kps")
        kind = str(record["kind"])
        process_ms.append(frame_process_ms)
        process_frame_timings.append({
            "frameIndex": frame_index,
            "kind": kind,
            "milliseconds": frame_process_ms,
        })
        download_started = time.perf_counter()
        download_ms.append((time.perf_counter() - download_started) * 1000.0)
        if quality_diagnostics and kps is not None:
            face_frames += 1
            before_roi = face_roi(rgb, kps)
            after_roi = face_roi(result, kps)
            if before_roi.size and before_roi.shape == after_roi.shape:
                delta = float(np.mean(np.abs(after_roi.astype(np.int16) - before_roi.astype(np.int16))))
                face_deltas.append(delta)
                if delta >= 1.0:
                    transformed_frames += 1
        if quality_diagnostics and reference_iterator is not None:
            quality_started = time.perf_counter()
            try:
                reference_rgb = next(reference_iterator).to_ndarray(format="rgb24")
            except StopIteration:
                reference_iterator = None
            else:
                candidate_roi = face_roi(result, kps) if kps is not None else np.empty((0, 0, 3), dtype=np.uint8)
                reference_roi = face_roi(reference_rgb, kps) if kps is not None else np.empty((0, 0, 3), dtype=np.uint8)
                if candidate_roi.size and candidate_roi.shape == reference_roi.shape:
                    diff = candidate_roi.astype(np.float32) - reference_roi.astype(np.float32)
                    mae = float(np.mean(np.abs(diff)))
                    mse = float(np.mean(np.square(diff)))
                    reference_mae.append(mae)
                    reference_psnr.append(99.0 if mse <= 1e-9 else 10.0 * math.log10((255.0 * 255.0) / mse))
                    reference_ssim.append(float(structural_similarity(
                        reference_roi,
                        candidate_roi,
                        channel_axis=2,
                        data_range=255,
                    )))
                    if (
                        previous_candidate_roi is not None
                        and previous_reference_roi is not None
                        and previous_candidate_roi.shape == candidate_roi.shape
                        and previous_reference_roi.shape == reference_roi.shape
                    ):
                        candidate_delta = candidate_roi.astype(np.int16) - previous_candidate_roi.astype(np.int16)
                        reference_delta = reference_roi.astype(np.int16) - previous_reference_roi.astype(np.int16)
                        temporal_delta_mae.append(float(np.mean(np.abs(candidate_delta - reference_delta))))
                    previous_candidate_roi = candidate_roi.copy()
                    previous_reference_roi = reference_roi.copy()
            quality_diagnostic_seconds += time.perf_counter() - quality_started
        identity_sample_due = bool(
            quality_diagnostics
            and
            kps is not None
            and (
                frame_index in sample_indexes
                or (
                    len(identity_gains) < 4
                    and identity_sample_attempts < 12
                    and frame_index - last_identity_sample_frame
                    >= identity_sample_stride
                )
            )
        )
        if identity_sample_due:
            identity_sample_attempts += 1
            last_identity_sample_frame = int(frame_index)
            quality_started = time.perf_counter()
            before_identity = identity_score(engine, rgb, source_embedding)
            after_identity = identity_score(engine, result, source_embedding)
            quality_diagnostic_seconds += time.perf_counter() - quality_started
            if before_identity is not None and after_identity is not None:
                identity_gains.append(after_identity - before_identity)

        pipe_started = time.perf_counter()
        if process.stdin is None:
            raise RuntimeError("encoder input closed")
        contiguous_result = np.ascontiguousarray(result)
        result_bytes = memoryview(contiguous_result).cast("B")
        if capture_frame_hashes:
            hash_started = time.perf_counter()
            pre_encoder_frame_crc32.append(f"{zlib.crc32(result_bytes):08x}")
            frame_hash_diagnostic_seconds += time.perf_counter() - hash_started
        process.stdin.write(result_bytes)
        pipe_ms.append((time.perf_counter() - pipe_started) * 1000.0)

    def flush_pending_outputs() -> None:
        while pending_outputs:
            finalize_output(pending_outputs.pop(0))

    try:
        iterator = None if pipelined_decode else iter(selected_source_frames())
        while frames < frame_limit:
            if pipelined_decode:
                decoded_item = decode_queue.get()
                if decoded_item is decode_sentinel:
                    break
                if isinstance(decoded_item, Exception):
                    raise decoded_item
                rgb, decoded_ms, decoded_timeline_seconds = decoded_item
                decode_ms.append(decoded_ms)
            else:
                decode_started = time.perf_counter()
                try:
                    decoded = next(iterator)
                except StopIteration:
                    break
                rgb = decoded.to_ndarray(format="rgb24")
                decode_ms.append((time.perf_counter() - decode_started) * 1000.0)
                decoded_timeline_seconds = (
                    float(decoded.pts * stream.time_base)
                    if decoded.pts is not None and stream.time_base
                    else None
                )

            if capture_frame_hashes:
                hash_started = time.perf_counter()
                source_bytes = memoryview(np.ascontiguousarray(rgb)).cast("B")
                source_frame_crc32.append(f"{zlib.crc32(source_bytes):08x}")
                frame_hash_diagnostic_seconds += time.perf_counter() - hash_started
            frame_started = time.perf_counter()
            verify_identity = frames % identity_interval == 0
            timeline_reliable = bool(
                decoded_timeline_seconds is not None
                and math.isfinite(float(decoded_timeline_seconds))
            )
            timeline_seconds = (
                float(decoded_timeline_seconds)
                if timeline_reliable
                else frames / fps
            )
            pts_discontinuity = not timeline_reliable
            if timeline_reliable and previous_timeline_seconds is not None:
                pts_delta = timeline_seconds - previous_timeline_seconds
                pts_discontinuity = bool(
                    not math.isfinite(pts_delta)
                    or pts_delta <= 0.0
                    or pts_delta
                    > max(
                        3.5 / max(1.0, fps),
                        float(benchmark_config["runtime"].get("temporalMaxPtsGapSeconds", 0.25)),
                    )
                )
            if pts_discontinuity:
                generation = int(tracking_state.get("trackGeneration", 0)) + 1
                tracking_state.clear()
                tracking_state["trackGeneration"] = generation
                _seed_tracking_render_contract(
                    tracking_state, benchmark_config["runtime"],
                )
                seed_mask_preflight_state()
                previous_source_frame = None
                previous_swapped_frame = None
                previous_swap_kps = None
                previous_canonical_transform = None
                previous_rendered_kps = None
                previous_render_signature = None
                last_exact_frame = -1
                last_exact_timeline_seconds = None
                for state_key in (
                    "restorerAnchor",
                    "occluderAnchor",
                    "faceParserAnchor",
                    "spatialExactBlendRecentTriggerFrames",
                    "spatialExactBlendBurstUntilFrame",
                    "spatialExactBlendLastTriggerFrame",
                    "spatialExactBlendLastObservedFrame",
                ):
                    temporal_restorer_context.pop(state_key, None)
                temporal_restorer_context["lastInvalidationReason"] = "pts-discontinuity"
            frame_delta_seconds = 1.0 / max(1.0, fps)
            if timeline_reliable and previous_timeline_seconds is not None:
                observed_delta = timeline_seconds - previous_timeline_seconds
                if 0 < observed_delta <= .25:
                    frame_delta_seconds = observed_delta
            tracking_state['frameDeltaSeconds'] = frame_delta_seconds
            temporal_restorer_context['nominalFrameSeconds'] = frame_delta_seconds
            previous_timeline_seconds = timeline_seconds if timeline_reliable else None
            temporal_restorer_context["frameIndex"] = frames
            temporal_restorer_context["mediaTimeSeconds"] = timeline_seconds
            temporal_restorer_context["frameDependencyAnchorFrame"] = frames
            temporal_restorer_context["frameDependencyAnchorTimeSeconds"] = timeline_seconds
            temporal_restorer_context["frameHadStageReuse"] = False
            temporal_restorer_context["maxAnchorFrames"] = (
                max(1, int(math.ceil(fps / max(temporal_restorer_hz, 0.001))))
                if temporal_restorer_hz > 0
                else 1
            )
            force_exact_reasons = []
            if verify_identity:
                force_exact_reasons.append("identity-deadline")
            if pts_discontinuity:
                force_exact_reasons.append("pts-discontinuity")
            temporal_restorer_context["forceExactReasons"] = force_exact_reasons
            temporal_restorer_context["forceExact"] = bool(force_exact_reasons)
            max_anchor_frames = (
                max(1, int(math.ceil(fps / temporal_anchor_hz)))
                if temporal_anchor_hz > 0
                else 1
            )
            reused = None
            reuse_future = None
            reuse_plan_ms = 0.0
            reuse_render_diagnostics = None
            frame_age = frames - last_exact_frame
            adaptive_grace = bool(
                benchmark_config["runtime"].get(
                    "temporalFullAdaptiveGraceEnabled", False
                )
                and frame_age == max_anchor_frames
            )
            if (
                whole_output_reuse_enabled
                and
                temporal_anchor_hz > 0
                and last_exact_frame >= 0
                and (frame_age < max_anchor_frames or adaptive_grace)
                and timeline_reliable
                and last_exact_timeline_seconds is not None
                and 0.0 < timeline_seconds - last_exact_timeline_seconds
                < (max_anchor_frames / fps) + (0.5 / fps)
                and not verify_identity
                and previous_source_frame is not None
                and previous_swapped_frame is not None
                and previous_swap_kps is not None
                and previous_render_signature
                == (
                    int(tracking_state.get("trackGeneration", 0)),
                    str(benchmark_config["parameters"].get("SwapperTypeTextSel", "128")),
                    str(benchmark_config["parameters"].get("RestorerTypeTextSel", "")),
                )
            ):
                detect_interval = max(
                    max_anchor_frames + 1,
                    int(benchmark_config["runtime"].get("targetDetectIntervalFrames", 1)),
                )
                reuse_tracking_started = time.perf_counter()
                pending_advance = _advance_prefetch_tracking(
                    rgb,
                    tracking_state,
                    detect_interval,
                    require_all_observed=True,
                    commit=False,
                    return_advance=True,
                )
                # Match the production lane exactly: a strict LK miss may be
                # recovered by a fresh five-landmark detector observation, but
                # that observation still has to pass the same source-appearance
                # guard below. Without this branch the benchmark needlessly ran
                # extra exact GPEN frames on motion-heavy clips and measured a
                # different algorithm from the one shipped to Pong.
                if not isinstance(pending_advance, LandmarkTrackAdvance):
                    pending_advance = engine._redetect_landmarks_for_temporal_reuse(
                        rgb,
                        tracking_state,
                        config=benchmark_config,
                    )
                stage_diagnostics.setdefault("reuseTrackingCpuMs", []).append(
                    (time.perf_counter() - reuse_tracking_started) * 1000.0
                )
                appearance_diagnostics = {}
                dense_flow_residual = bool(
                    benchmark_config["runtime"].get(
                        "temporalFullDenseFlowResidual", False
                    )
                )
                sparse_mesh_residual = sparse_mesh_enabled_for_clip
                semantic_feature_patches = semantic_feature_enabled_for_clip
                if not isinstance(pending_advance, LandmarkTrackAdvance):
                    full_reuse_reject_counts["tracking"] += 1
                else:
                    reuse_appearance_started = time.perf_counter()
                    appearance_safe = bool(
                        dense_flow_residual
                        or sparse_mesh_residual
                        or _full_frame_reuse_appearance_is_safe(
                            rgb,
                            previous_source_frame,
                            previous_swap_kps,
                            pending_advance.points,
                            max_face_mae=float(benchmark_config["runtime"].get("temporalFullMaxFaceMae", 14.0)),
                            max_face_p90=float(benchmark_config["runtime"].get("temporalFullMaxFaceP90", 32.0)),
                            max_patch_mae=float(benchmark_config["runtime"].get("temporalFullMaxPatchMae", 46.0)),
                            diagnostics=appearance_diagnostics,
                        )
                    )
                    stage_diagnostics.setdefault("reuseAppearanceCpuMs", []).append(
                        (time.perf_counter() - reuse_appearance_started) * 1000.0
                    )
                if isinstance(pending_advance, LandmarkTrackAdvance) and appearance_safe:
                    warp_diagnostics = {}
                    next_sparse_mesh_state = None
                    reuse_warp_started = time.perf_counter()
                    if sparse_mesh_residual:
                        reused, next_sparse_mesh_state = (
                            _warp_prior_swap_residual_sparse_mesh(
                                rgb,
                                previous_source_frame,
                                previous_swapped_frame,
                                previous_swap_kps,
                                pending_advance.points,
                                tracking_state.get("sparseResidualMesh"),
                                mesh_size=int(
                                    benchmark_config["runtime"].get(
                                        "temporalFullSparseMeshSize", 128
                                    )
                                ),
                                diagnostics=warp_diagnostics,
                            )
                        )
                    elif dense_flow_residual:
                        reused = _warp_prior_swap_residual_dense_flow(
                            rgb,
                            previous_source_frame,
                            previous_swapped_frame,
                            previous_swap_kps,
                            pending_advance.points,
                            flow_size=int(
                                benchmark_config["runtime"].get(
                                    "temporalFullDenseFlowSize", 192
                                )
                            ),
                            diagnostics=warp_diagnostics,
                        )
                    elif semantic_feature_patches:
                        reused, next_sparse_mesh_state = (
                            _warp_prior_swap_with_semantic_features(
                                rgb,
                                previous_source_frame,
                                previous_swapped_frame,
                                previous_swap_kps,
                                pending_advance.points,
                                tracking_state.get("sparseResidualMesh"),
                                max_landmark_residual_ratio=float(
                                    benchmark_config["runtime"].get(
                                        "temporalFullMaxLandmarkResidualRatio",
                                        0.12,
                                    )
                                ),
                                interpolation=(
                                    cv2.INTER_CUBIC
                                    if bool(
                                        benchmark_config["runtime"].get(
                                            "temporalFullBicubicResidual",
                                            False,
                                        )
                                    )
                                    else cv2.INTER_LINEAR
                                ),
                                feature_strength=float(
                                    benchmark_config["runtime"].get(
                                        "temporalFullFeaturePatchLockStrength",
                                        0.65,
                                    )
                                ),
                                feature_max_mae=float(
                                    benchmark_config["runtime"].get(
                                        "temporalFullFeaturePatchMaxMae",
                                        16.0,
                                    )
                                ),
                                feature_max_p90=float(
                                    benchmark_config["runtime"].get(
                                        "temporalFullFeaturePatchMaxP90",
                                        34.0,
                                    )
                                ),
                                feature_groups=tuple(
                                    str(value)
                                    for value in benchmark_config["runtime"].get(
                                        "temporalSemanticFeatureGroups",
                                        ("leftEye", "rightEye"),
                                    )
                                ),
                                diagnostics=warp_diagnostics,
                            )
                        )
                    else:
                        current_canonical_transform = None
                        canonical_transport_enabled = bool(
                            benchmark_config["runtime"].get(
                                "temporalCanonicalResidualTransport", False
                            )
                        )
                        if bool(benchmark_config["runtime"].get(
                            "temporalCanonicalResidualLowMotionOnly", False
                        )):
                            canonical_transport_enabled = bool(
                                canonical_transport_enabled
                                and mask_preflight is not None
                                and str(mask_preflight.get("backend")) == "trt"
                            )
                        if (
                            canonical_transport_enabled
                            and previous_canonical_transform is not None
                        ):
                            try:
                                current_canonical_transform, _pipeline_size = (
                                    engine._vm.canonical_face_transform_matrix(
                                        pending_advance.points,
                                        benchmark_config["parameters"],
                                    )
                                )
                            except (TypeError, ValueError, ArithmeticError):
                                current_canonical_transform = None
                        residual_arguments = {
                            "max_landmark_residual_ratio": float(
                                benchmark_config["runtime"].get(
                                    "temporalFullMaxLandmarkResidualRatio", 0.12
                                )
                            ),
                            "interpolation": (
                                cv2.INTER_CUBIC
                                if bool(benchmark_config["runtime"].get(
                                    "temporalFullBicubicResidual", False
                                ))
                                else cv2.INTER_LINEAR
                            ),
                            "continuous_linear": bool(
                                benchmark_config["runtime"].get(
                                    "temporalContinuousResidualWarp", False
                                )
                            ),
                            "feature_patch_lock_strength": (
                                float(benchmark_config["runtime"].get(
                                    "temporalFullFeaturePatchLockStrength", 0.0
                                ))
                                if bool(benchmark_config["runtime"].get(
                                    "temporalFullFeaturePatchLockEnabled", False
                                ))
                                else 0.0
                            ),
                            "feature_patch_max_mae": float(
                                benchmark_config["runtime"].get(
                                    "temporalFullFeaturePatchMaxMae", 16.0
                                )
                            ),
                            "feature_patch_max_p90": float(
                                benchmark_config["runtime"].get(
                                    "temporalFullFeaturePatchMaxP90", 34.0
                                )
                            ),
                            "source_to_canonical": previous_canonical_transform,
                            "target_to_canonical": current_canonical_transform,
                            "canonical_blend_weight": float(
                                benchmark_config["runtime"].get(
                                    "temporalCanonicalResidualBlendWeight", 1.0
                                )
                            ),
                            "pose_aware_affine": bool(
                                benchmark_config["runtime"].get(
                                    "temporalPoseAwareAffineResidual", False
                                )
                            ),
                            "pose_aware_affine_max_anisotropy": float(
                                benchmark_config["runtime"].get(
                                    "temporalPoseAwareAffineMaxAnisotropy", 1.12
                                )
                            ),
                            "pose_aware_affine_min_improvement": float(
                                benchmark_config["runtime"].get(
                                    "temporalPoseAwareAffineMinImprovement", 0.12
                                )
                            ),
                            "pose_aware_affine_min_residual_ratio": float(
                                benchmark_config["runtime"].get(
                                    "temporalPoseAwareAffineMinResidualRatio", 0.008
                                )
                            ),
                            "diagnostics": warp_diagnostics,
                        }
                        if overlap_enabled and output_executor is not None:
                            reused = _plan_prior_swap_residual(
                                rgb,
                                previous_source_frame,
                                previous_swapped_frame,
                                previous_swap_kps,
                                pending_advance.points,
                                **residual_arguments,
                            )
                            reuse_plan_ms = (
                                time.perf_counter() - reuse_warp_started
                            ) * 1000.0
                            if reused is not None:
                                reuse_render_diagnostics = warp_diagnostics
                        else:
                            reused = _warp_prior_swap_residual(
                                rgb,
                                previous_source_frame,
                                previous_swapped_frame,
                                previous_swap_kps,
                                pending_advance.points,
                                **residual_arguments,
                            )
                    if reuse_future is None:
                        stage_diagnostics.setdefault("reuseWarpCpuMs", []).append(
                            (time.perf_counter() - reuse_warp_started) * 1000.0
                        )
                    for diagnostic_name, diagnostic_value in warp_diagnostics.items():
                        if isinstance(diagnostic_value, (int, float)) and math.isfinite(
                            float(diagnostic_value)
                        ):
                            stage_diagnostics.setdefault(
                                f"reuse.{diagnostic_name}", []
                            ).append(float(diagnostic_value))
                        elif isinstance(diagnostic_value, (list, tuple)):
                            numeric = [
                                float(value)
                                for value in diagnostic_value
                                if isinstance(value, (int, float))
                                and math.isfinite(float(value))
                            ]
                            if numeric:
                                stage_diagnostics.setdefault(
                                    f"reuse.{diagnostic_name}.minimum", []
                                ).append(min(numeric))
                    _record_adaptive_mask_motion(
                        benchmark_config["runtime"],
                        tracking_state,
                        warp_diagnostics,
                    )
                    if warp_diagnostics.get("residualSampler"):
                        reuse_sampler_counts[str(warp_diagnostics["residualSampler"])] += 1
                    if warp_diagnostics.get("transportMode"):
                        reuse_transport_counts[str(warp_diagnostics["transportMode"])] += 1
                    if reused is not None and adaptive_grace:
                        grace_safe = bool(
                            float(appearance_diagnostics.get("faceMae", math.inf))
                            <= float(benchmark_config["runtime"].get("temporalFullMaxFaceMae", 14.0)) * 0.5
                            and float(appearance_diagnostics.get("faceP90", math.inf))
                            <= float(benchmark_config["runtime"].get("temporalFullMaxFaceP90", 32.0)) * 0.5
                            and float(appearance_diagnostics.get("patchMae", math.inf))
                            <= float(benchmark_config["runtime"].get("temporalFullMaxPatchMae", 46.0)) * 0.5
                            and float(warp_diagnostics.get("landmarkResidualRatio", math.inf))
                            <= min(
                                0.015,
                                float(
                                    benchmark_config["runtime"].get(
                                        "temporalFullMaxLandmarkResidualRatio", 0.12
                                    )
                                ) * 0.5,
                            )
                        )
                        if not grace_safe:
                            reused = None
                            full_reuse_reject_counts["adaptive-grace"] += 1
                    if reused is not None:
                        if (
                            overlap_enabled
                            and output_executor is not None
                            and reuse_render_diagnostics is not None
                        ):
                            # Submit only after every acceptance decision has
                            # consumed the immutable planning diagnostics.  This
                            # prevents the renderer from racing the grace gate
                            # or mutating the diagnostics dictionary mid-scan.
                            reuse_future = output_executor.submit(
                                render_plan_job,
                                reused,
                                reuse_render_diagnostics,
                            )
                        if next_sparse_mesh_state is not None:
                            tracking_state["sparseResidualMesh"] = next_sparse_mesh_state
                        _commit_tracking_advance(tracking_state, pending_advance)
                    else:
                        full_reuse_reject_counts[
                            str(warp_diagnostics.get("reason") or "warp")
                        ] += 1
                elif isinstance(pending_advance, LandmarkTrackAdvance):
                    full_reuse_reject_counts[
                        str(appearance_diagnostics.get("reason") or "appearance")
                    ] += 1
            if reused is None:
                next_rgb = None
                if lookahead is not None:
                    with decode_queue.mutex:
                        head = decode_queue.queue[0] if decode_queue.queue else None
                        if isinstance(head, tuple):
                            next_rgb = head[0]
                swapped, anchor = engine.process_frame(
                    rgb,
                    source_embedding,
                    anchor,
                    verify_identity=verify_identity,
                    tracking_state=tracking_state,
                    config=benchmark_config,
                    diagnostics=stage_diagnostics,
                    tracking_lookahead=lookahead,
                    next_frame=next_rgb,
                    temporal_context=(
                        temporal_restorer_context if temporal_restorer_hz > 0 else None
                    ),
                )
                if swapped is None:
                    raise RuntimeError("transformation returned no frame")
                result = swapped.cpu().numpy()
                current_kps = tracking_state.get("kps")
                if current_kps is None:
                    tracking_state["trackGeneration"] = int(
                        tracking_state.get("trackGeneration", 0)
                    ) + 1
                    seed_mask_preflight_state()
                    previous_source_frame = None
                    previous_swapped_frame = None
                    previous_swap_kps = None
                    previous_rendered_kps = None
                    previous_render_signature = None
                    last_exact_frame = -1
                    last_exact_timeline_seconds = None
                else:
                    if bool(benchmark_config["runtime"].get(
                        "temporalExactLandmarkLockEnabled", False
                    )):
                        result, next_rendered_kps = stabilize_exact_render_landmarks(
                            engine,
                            rgb,
                            result,
                            np.asarray(current_kps, dtype=np.float32),
                            previous_source_frame,
                            previous_swap_kps,
                            previous_rendered_kps,
                            strength=float(benchmark_config["runtime"].get(
                                "temporalExactLandmarkLockStrength", 0.5
                            )),
                        )
                        previous_rendered_kps = next_rendered_kps
                    if (
                        bool(benchmark_config["runtime"].get(
                            "temporalExactOutputStabilizationEnabled", False
                        ))
                        and previous_source_frame is not None
                        and previous_swapped_frame is not None
                        and previous_swap_kps is not None
                        and current_kps is not None
                        and previous_render_signature
                        == (
                            int(tracking_state.get("trackGeneration", 0)),
                            str(benchmark_config["parameters"].get("SwapperTypeTextSel", "128")),
                            str(benchmark_config["parameters"].get("RestorerTypeTextSel", "")),
                        )
                    ):
                        result = _stabilize_exact_output_with_prior(
                            rgb,
                            result,
                            previous_source_frame,
                            previous_swapped_frame,
                            previous_swap_kps,
                            np.asarray(current_kps, dtype=np.float32),
                            current_weight=float(benchmark_config["runtime"].get(
                                "temporalExactOutputCurrentWeight", 0.85
                            )),
                            max_face_mae=float(benchmark_config["runtime"].get("temporalFullMaxFaceMae", 14.0)),
                            max_face_p90=float(benchmark_config["runtime"].get("temporalFullMaxFaceP90", 32.0)),
                            max_patch_mae=float(benchmark_config["runtime"].get("temporalFullMaxPatchMae", 46.0)),
                            max_landmark_residual_ratio=float(benchmark_config["runtime"].get("temporalFullMaxLandmarkResidualRatio", 0.12)),
                            dense_flow=bool(benchmark_config["runtime"].get(
                                "temporalExactOutputDenseFlowEnabled", False
                            )),
                            delta_seconds=frame_delta_seconds,
                            half_life_seconds=float(benchmark_config["runtime"].get(
                                "temporalExactOutputHalfLifeSeconds", 0.020
                            )),
                            local_change_low=float(benchmark_config["runtime"].get(
                                "temporalExactOutputLocalChangeLow", 3.0
                            )),
                            local_change_high=float(benchmark_config["runtime"].get(
                                "temporalExactOutputLocalChangeHigh", 18.0
                            )),
                            motion_low_per_second=float(benchmark_config["runtime"].get(
                                "temporalExactOutputMotionLowPerSecond", 0.20
                            )),
                            motion_high_per_second=float(benchmark_config["runtime"].get(
                                "temporalExactOutputMotionHighPerSecond", 1.50
                            )),
                            pose_aware_affine=bool(benchmark_config["runtime"].get(
                                "temporalExactOutputPoseAwareAffine", True
                            )),
                        )
                    previous_source_frame = np.ascontiguousarray(rgb)
                    previous_swapped_frame = np.ascontiguousarray(result)
                    previous_swap_kps = np.asarray(current_kps, dtype=np.float32).copy()
                    exact_canonical_transform = temporal_restorer_context.get(
                        "fullCanonicalTransform"
                    )
                    if exact_canonical_transform is None:
                        previous_canonical_transform = None
                    else:
                        canonical_matrix = np.asarray(
                            exact_canonical_transform,
                            dtype=np.float64,
                        )
                        previous_canonical_transform = (
                            canonical_matrix.copy()
                            if canonical_matrix.shape == (3, 3)
                            and np.isfinite(canonical_matrix).all()
                            else None
                        )
                    if bool(
                        sparse_mesh_enabled_for_clip
                        or semantic_feature_enabled_for_clip
                    ):
                        semantic_mesh_enabled = semantic_mesh_enabled_for_clip
                        semantic_feature_patches = semantic_feature_enabled_for_clip
                        semantic_landmarks = None
                        refresh_due = bool(
                            (semantic_mesh_enabled or semantic_feature_patches)
                            and semantic_landmark_estimator is not None
                            and frames - last_semantic_refresh_frame
                            >= semantic_refresh_frames
                        )
                        if refresh_due:
                            semantic_result = semantic_landmark_estimator.detect(
                                rgb,
                                current_kps,
                            )
                            semantic_refresh_ms.append(float(semantic_result.inference_ms))
                            semantic_refresh_scores.append(float(semantic_result.score))
                            if float(semantic_result.score) >= 0.75:
                                semantic_landmarks = semantic_result.points
                                last_semantic_refresh_frame = int(frames)
                        if semantic_mesh_enabled or semantic_feature_patches:
                            tracking_state["sparseResidualMesh"] = (
                                _rebase_sparse_residual_mesh(
                                    rgb,
                                    current_kps,
                                    tracking_state.get("sparseResidualMesh"),
                                    semantic_landmarks=semantic_landmarks,
                                    maximum_features=(
                                        0 if semantic_feature_patches else 40
                                    ),
                                    semantic_indices_to_keep=(
                                        np.arange(36, 48, dtype=np.int16)
                                        if semantic_feature_patches
                                        and set(
                                            str(value)
                                            for value in benchmark_config["runtime"].get(
                                                "temporalSemanticFeatureGroups",
                                                ("leftEye", "rightEye"),
                                            )
                                        )
                                        == {"leftEye", "rightEye"}
                                        else None
                                    ),
                                )
                            )
                        else:
                            tracking_state["sparseResidualMesh"] = (
                                _initialize_sparse_residual_mesh(rgb, current_kps)
                            )
                    last_exact_frame = int(
                        temporal_restorer_context.get("frameDependencyAnchorFrame", frames)
                    )
                    last_exact_timeline_seconds = float(
                        temporal_restorer_context.get(
                            "frameDependencyAnchorTimeSeconds",
                            timeline_seconds,
                        )
                    )
                    previous_render_signature = (
                        int(tracking_state.get("trackGeneration", 0)),
                        str(benchmark_config["parameters"].get("SwapperTypeTextSel", "128")),
                        str(benchmark_config["parameters"].get("RestorerTypeTextSel", "")),
                    )
                exact_frames += 1
                frame_provenance.append(
                    {"frameIndex": int(frames), "kind": "exact", "anchorAge": 0}
                )
            else:
                result = reused if reuse_future is None else None
                reused_frames += 1
                frame_provenance.append(
                    {
                        "frameIndex": int(frames),
                        "kind": "reuse",
                        "anchorAge": max(1, int(frames) - int(last_exact_frame)),
                    }
                )
            kps = tracking_state.get("kps")
            pending_outputs.append({
                "frameIndex": int(frames),
                "kind": "reuse" if reused is not None else "exact",
                "rgb": rgb,
                "kps": (
                    np.asarray(kps, dtype=np.float32).copy()
                    if kps is not None
                    else None
                ),
                "result": result,
                "future": reuse_future,
                "planMs": reuse_plan_ms,
                "renderDiagnostics": reuse_render_diagnostics,
                "processMs": (time.perf_counter() - frame_started) * 1000.0,
            })
            frames += 1
            # Exact GPU work is deliberately completed before waiting on the
            # preceding CPU residual jobs.  Flushing here preserves encoder,
            # diagnostics, and timestamp order while exposing real overlap.
            if not overlap_enabled or reused is None:
                flush_pending_outputs()
        flush_pending_outputs()
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
    finally:
        if lookahead is not None:
            lookahead.close()
        if output_executor is not None:
            output_executor.shutdown(wait=True, cancel_futures=True)
        if mask_backend_probe is not None:
            mask_backend_probe.close()
        decode_stop.set()
        if decode_thread is not None:
            decode_thread.join(timeout=2.0)
        container.close()
        if reference_container is not None:
            reference_container.close()
        if process.stdin is not None:
            try:
                process.stdin.close()
            except OSError:
                pass
    benchmark_wall_seconds = time.perf_counter() - started
    preflight_seconds = float((mask_preflight or {}).get("seconds", 0.0))
    processing_seconds = max(
        0.001,
        benchmark_wall_seconds
        - quality_diagnostic_seconds
        - frame_hash_diagnostic_seconds
        - (
            float(mask_backend_probe.elapsed_seconds)
            if mask_backend_probe is not None
            else 0.0
        )
        + preflight_seconds,
    )
    stderr = process.stderr.read().decode("utf-8", errors="replace") if process.stderr else ""
    try:
        exit_code = process.wait(timeout=60)
    except subprocess.TimeoutExpired:
        process.kill()
        exit_code = process.wait(timeout=5)
        error = error or "encoder timeout"
    if exit_code and not error:
        error = f"encoder exited {exit_code}: {stderr[-1000:]}"

    probe = probe_output(output_path) if output_path.is_file() and output_path.stat().st_size else {
        "durationSeconds": 0.0, "videoStreams": 0, "audioStreams": 0,
    }
    expected_duration = frames / max(fps, 0.001)
    processing_fps = frames / max(processing_seconds, 0.001)
    transformation_ratio = transformed_frames / max(face_frames, 1)
    identity_proof = bool(identity_gains) and statistics.median(identity_gains) > 0.25
    baseline_evidence = baseline_evidence or {}
    eligible = bool(baseline_evidence.get("eligible", True))
    expected_face_frames = int(baseline_evidence.get("faceFrames") or 0)
    minimum_face_frames = (
        max(3, int(math.floor(expected_face_frames * 0.50)))
        if expected_face_frames > 0
        else max(3, int(frames * 0.50))
    )
    identity_required = eligible
    minimum_reference_samples = max(3, int(math.floor(minimum_face_frames * 0.50)))
    minimum_temporal_samples = max(1, min(8, minimum_reference_samples - 1))
    checks = {
        "decodedFiveSeconds": expected_duration >= min(5.0, seconds) - (2.0 / max(fps, 1.0)),
        "sourceRateThroughput": processing_fps >= source_fps,
        "scheduledRateThroughput": processing_fps >= fps,
        "faceDetected": face_frames >= minimum_face_frames,
        "transformationApplied": transformation_ratio >= 0.80,
        "identityProof": identity_proof or not identity_required,
        "durationPreserved": abs(probe["durationSeconds"] - expected_duration) <= max(0.12, 2.0 / max(fps, 1.0)),
        "silent": probe["audioStreams"] == 0,
        "singleVideoStream": probe["videoStreams"] == 1,
        "noError": not error,
    }
    if reference_path is not None:
        checks["referenceQuality"] = (
            len(reference_ssim) >= minimum_reference_samples
            and len(temporal_delta_mae) >= minimum_temporal_samples
            and
            statistics.median(reference_ssim) >= 0.92
            and percentile(reference_ssim, 0.10) >= 0.82
            and statistics.median(reference_mae) <= 12.0
            and statistics.median(temporal_delta_mae) <= 12.0
        )
    required_checks = dict(checks)
    if source_frame_stride > 1:
        # Never label decimated output as a source-rate pass. The adaptive
        # policy is separately explicit in every clip's report.
        required_checks.pop('sourceRateThroughput', None)
    if not eligible:
        # These clips still validate silent decode/encode/duration behavior, but
        # they cannot prove a face transformation and never count toward the
        # real-time face-video gate.
        for key in ("faceDetected", "transformationApplied", "identityProof", "referenceQuality"):
            required_checks.pop(key, None)
    if quality_diagnostics:
        gate_passed = eligible and all(required_checks.values())
    else:
        gate_passed = all(
            checks[name]
            for name in (
                "decodedFiveSeconds",
                "scheduledRateThroughput",
                "durationPreserved",
                "silent",
                "singleVideoStream",
                "noError",
            )
        )
    captured_path = ""
    captured_metadata_path = ""
    if capture_restorer_inputs_path is not None and restorer_capture_sink:
        capture_restorer_inputs_path.parent.mkdir(parents=True, exist_ok=True)
        captured = np.stack(restorer_capture_sink).astype(np.float32, copy=False)
        np.save(capture_restorer_inputs_path, captured, allow_pickle=False)
        captured_path = str(capture_restorer_inputs_path)
        if capture_restorer_metadata_path is not None:
            capture_restorer_metadata_path.parent.mkdir(parents=True, exist_ok=True)
            capture_restorer_metadata_path.write_text(
                json.dumps(
                    {
                        "schema": "pong-gpen-restorer-capture-metadata-v1",
                        "inputPath": captured_path,
                        "inputSha256": sha256_file(capture_restorer_inputs_path),
                        "count": len(restorer_capture_sink),
                        "entries": restorer_capture_metadata_sink,
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
            captured_metadata_path = str(capture_restorer_metadata_path)
    stage_decision_samples = list(
        temporal_restorer_context.get("stageDecisionSamples", [])
    )
    hybrid_reference_counts = Counter(
        str((sample.get("metrics") or {}).get("hybridSelectedReason") or "unknown")
        for sample in stage_decision_samples
        if bool((sample.get("metrics") or {}).get("hybridReference", False))
    )
    effective_temporal_options = {
        "continuousResidualWarp": bool(
            benchmark_config["runtime"].get("temporalContinuousResidualWarp", False)
        ),
        "canonicalResidualTransport": bool(
            benchmark_config["runtime"].get("temporalCanonicalResidualTransport", False)
        ),
        "residualReturn": bool(temporal_restorer_context.get("residualReturn", False)),
        "residualReturnWeight": float(
            temporal_restorer_context.get("residualReturnWeight", 1.0)
        ),
        "residualReturnMinimumFaceSize": int(
            temporal_restorer_context.get("residualReturnMinimumFaceSize", 0)
        ),
        "residualParserUsesLegacyAppearance": bool(
            temporal_restorer_context.get(
                "residualParserUsesLegacyAppearance", False
            )
        ),
        "lowFrequencyAnchorStabilization": bool(
            temporal_restorer_context.get(
                "lowFrequencyAnchorStabilization", False
            )
        ),
        "lowFrequencyAnchorStrength": float(
            temporal_restorer_context.get("lowFrequencyAnchorStrength", 0.15)
        ),
        "exactPastebackRoundToNearest": bool(
            temporal_restorer_context.get("exactPastebackRoundToNearest", False)
        ),
        "outputFractionalLevels": int(
            temporal_restorer_context.get("outputFractionalLevels", 0)
        ),
        "faceParserEvidenceQuantizationStep": float(
            temporal_restorer_context.get("faceParserEvidenceQuantizationStep", 0.0)
        ),
        "referenceParserMaskDiagnostic": bool(
            temporal_restorer_context.get("referenceParserMaskDiagnostic", False)
        ),
        "hybridReferenceReasons": list(
            temporal_restorer_context.get("hybridReferenceReasons", ())
        ),
        "hybridReferenceCadenceByReason": dict(
            temporal_restorer_context.get("hybridReferenceCadenceByReason", {})
        ),
    }
    from pong_swap_benchmark_metrics import throughput_consistency
    return {
        "clip": clip_path.name,
        "output": str(output_path),
        "error": error,
        "source": {"width": width, "height": height, "fps": source_fps, "frames": frames},
        "cadence": {"sourceFps": source_fps, "outputFps": fps, "sourceFrameStride": source_frame_stride,
                    "sourceRatePreserved": source_frame_stride == 1},
        "timing": {
            "consistency": throughput_consistency(process_frame_timings, fps, processing_fps),
            "trackingLookaheadHits": lookahead.hits if lookahead is not None else 0,
            "wallSeconds": processing_seconds,
            "benchmarkWallSeconds": benchmark_wall_seconds,
            "qualityDiagnosticSeconds": quality_diagnostic_seconds,
            "frameHashDiagnosticSeconds": frame_hash_diagnostic_seconds,
            "maskBackendParityDiagnosticSeconds": (
                float(mask_backend_probe.elapsed_seconds)
                if mask_backend_probe is not None
                else 0.0
            ),
            "maskPreflight": mask_preflight,
            "processingFps": processing_fps,
            "realtimeHeadroom": processing_fps / max(fps, 0.001),
            "sourceRateHeadroom": processing_fps / max(source_fps, 0.001),
            "processP50Ms": statistics.median(process_ms) if process_ms else 0.0,
            "processP90Ms": percentile(process_ms, 0.90),
            "processP95Ms": percentile(process_ms, 0.95),
            "processFrameTimings": process_frame_timings,
            "decodeP50Ms": statistics.median(decode_ms) if decode_ms else 0.0,
            "downloadP50Ms": statistics.median(download_ms) if download_ms else 0.0,
            "encoderFeedP50Ms": statistics.median(pipe_ms) if pipe_ms else 0.0,
            "stagesP50Ms": {
                name: statistics.median(numeric_values)
                for name, values in stage_diagnostics.items()
                if (
                    numeric_values := [
                        float(value)
                        for value in values
                        if isinstance(value, (int, float))
                        and math.isfinite(float(value))
                    ]
                )
            },
            "stagesP90Ms": {
                name: percentile(numeric_values, 0.90)
                for name, values in stage_diagnostics.items()
                if (
                    numeric_values := [
                        float(value)
                        for value in values
                        if isinstance(value, (int, float))
                        and math.isfinite(float(value))
                    ]
                )
            },
        },
        "transformation": {
            "faceFrames": face_frames,
            "transformedFrames": transformed_frames,
            "transformedFaceFrameRatio": transformation_ratio,
            "medianFacePixelDelta": statistics.median(face_deltas) if face_deltas else 0.0,
            "identityGainSamples": identity_gains,
            "identitySampleAttempts": identity_sample_attempts,
            "identitySampleStrideFrames": identity_sample_stride,
            "medianIdentityGain": statistics.median(identity_gains) if identity_gains else None,
            "exactFrames": exact_frames,
            "reusedFrames": reused_frames,
            "frameProvenance": frame_provenance,
            "frameHashProvenance": {
                "algorithm": "crc32",
                "source": source_frame_crc32,
                "preEncoder": pre_encoder_frame_crc32,
            },
            "maskBackendParity": (
                mask_backend_probe.report()
                if mask_backend_probe is not None
                else None
            ),
            "temporalAnchorHz": temporal_anchor_hz,
            "temporalRestorerHz": temporal_restorer_hz,
            "restorerExactFrames": int(temporal_restorer_context.get("exactFrames", 0)),
            "restorerReusedFrames": int(temporal_restorer_context.get("reusedFrames", 0)),
            "restorerReturnMapVersion": temporal_restorer_context.get("restorerReturnMapVersion"),
            "restorerReturnSamplerVersion": temporal_restorer_context.get("restorerReturnSamplerVersion"),
            "restorerReturnSamplerCacheHits": int(
                temporal_restorer_context.get("restorerReturnSamplerCacheHits", 0)
            ),
            "restorerReturnSamplerCacheMisses": int(
                temporal_restorer_context.get("restorerReturnSamplerCacheMisses", 0)
            ),
            "restorerReturnMapTranslation": temporal_restorer_context.get("restorerReturnMapTranslation"),
            "restorerReturnMapFaceSize": temporal_restorer_context.get("restorerReturnMapFaceSize"),
            "restorerReturnMapOutputSize": temporal_restorer_context.get("restorerReturnMapOutputSize"),
            "restorerInputCapture": {
                "path": captured_path,
                "metadataPath": captured_metadata_path,
                "count": len(restorer_capture_sink),
                "dtype": "float32" if restorer_capture_sink else "",
            },
            "occluderExactFrames": int(temporal_restorer_context.get("occluderExactFrames", 0)),
            "occluderReusedFrames": int(temporal_restorer_context.get("occluderReusedFrames", 0)),
            "dflXSegExactFrames": int(temporal_restorer_context.get("dflXSegExactFrames", 0)),
            "dflXSegReusedFrames": int(temporal_restorer_context.get("dflXSegReusedFrames", 0)),
            "identityResidualExactFrames": int(
                temporal_restorer_context.get("identityResidualExactFrames", 0)
            ),
            "identityResidualReusedFrames": int(
                temporal_restorer_context.get("identityResidualReusedFrames", 0)
            ),
            "faceParserExactFrames": int(temporal_restorer_context.get("faceParserExactFrames", 0)),
            "faceParserReusedFrames": int(temporal_restorer_context.get("faceParserReusedFrames", 0)),
            "fullReuseRejectCounts": dict(sorted(full_reuse_reject_counts.items())),
            "semanticLandmarkRefreshCount": len(semantic_refresh_ms),
            "semanticLandmarkRefreshMs": semantic_refresh_ms,
            "semanticLandmarkRefreshScore": semantic_refresh_scores,
            "stageDecisionCounts": temporal_restorer_context.get("stageDecisionCounts", {}),
            "stageDecisionSamples": stage_decision_samples,
            "effectiveTemporalOptions": effective_temporal_options,
            "experimentalActivationCounts": {
                "hybridReferenceByReason": dict(sorted(hybrid_reference_counts.items())),
                "reuseSampler": dict(sorted(reuse_sampler_counts.items())),
                "reuseTransport": dict(sorted(reuse_transport_counts.items())),
                "residualReturnFrames": int(
                    temporal_restorer_context.get("residualReturnFrames", 0)
                ),
                "residualLegacyParserEvidenceFrames": int(
                    temporal_restorer_context.get(
                        "residualLegacyParserEvidenceFrames", 0
                    )
                ),
                "exactPastebackRoundedFrames": int(
                    temporal_restorer_context.get("exactPastebackRoundedFrames", 0)
                ),
                "outputFractionalFrames": int(
                    temporal_restorer_context.get("outputFractionalFrames", 0)
                ),
                "parserEvidenceQuantizedFrames": int(
                    temporal_restorer_context.get("parserEvidenceQuantizedFrames", 0)
                ),
                "parserEvidenceQuantizedInferenceFrames": int(
                    temporal_restorer_context.get(
                        "parserEvidenceQuantizedInferenceFrames", 0
                    )
                ),
                "referenceParserMaskFrames": int(
                    temporal_restorer_context.get(
                        "referenceParserRestorerFrames", 0
                    )
                ),
                "referenceParserMaskExactFrames": int(
                    (
                        temporal_restorer_context.get(
                            "_referenceParserMaskContext", {}
                        )
                    ).get("faceParserExactFrames", 0)
                ),
                "referenceParserMaskReusedFrames": int(
                    (
                        temporal_restorer_context.get(
                            "_referenceParserMaskContext", {}
                        )
                    ).get("faceParserReusedFrames", 0)
                ),
                "lowFrequencyAnchorStabilizedFrames": int(
                    temporal_restorer_context.get(
                        "lowFrequencyAnchorStabilizedFrames", 0
                    )
                ),
            },
            "pipelinedDecode": pipelined_decode,
            "reference": {
                "path": str(reference_path) if reference_path else "",
                "samples": len(reference_ssim),
                "ssimMedian": statistics.median(reference_ssim) if reference_ssim else None,
                "ssimP10": percentile(reference_ssim, 0.10) if reference_ssim else None,
                "maeMedian": statistics.median(reference_mae) if reference_mae else None,
                "psnrMedian": statistics.median(reference_psnr) if reference_psnr else None,
                "temporalDeltaMaeMedian": statistics.median(temporal_delta_mae) if temporal_delta_mae else None,
                "minimumSamplesRequired": minimum_reference_samples,
                "minimumTemporalSamplesRequired": minimum_temporal_samples,
            },
        },
        "encoded": probe,
        "checks": checks,
        "eligibility": {
            "eligible": eligible,
            "baseline": baseline_evidence,
            "minimumCandidateFaceFrames": minimum_face_frames,
        },
        "passed": gate_passed,
        "timingOnly": not quality_diagnostics,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True)
    parser.add_argument("--seconds", type=float, default=5.25)
    parser.add_argument("--limit", type=int, default=24)
    parser.add_argument("--start-index", type=int, default=1)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--exact-gpen512", action="store_true")
    parser.add_argument("--restorer", choices=("current", "off", "GPEN256", "GPEN512", "GPEN1024"), default="current")
    parser.add_argument("--disable-parser", action="store_true")
    parser.add_argument("--disable-occluder", action="store_true")
    parser.add_argument("--detect-interval", type=int)
    parser.add_argument("--identity-interval", type=int)
    parser.add_argument("--temporal-anchor-hz", type=float, default=0.0)
    parser.add_argument("--temporal-restorer-hz", type=float, default=0.0)
    parser.add_argument("--pipelined-decode", action="store_true")
    parser.add_argument("--tracking-lookahead", action="store_true",
                        help="Overlap identical CPU tracking on large frames; requires pipelined decode")
    parser.add_argument("--minimum-consistent-fps", type=int, choices=(0, 30, 40), default=0,
                        help="Require both end-to-end FPS and every 1/5-second render-work window to pass")
    parser.add_argument("--production-policy", action="store_true", help="Use the live source-workload gate and omit benchmark-only landmark post-warp.")
    parser.add_argument("--temporal-quality", action="store_true", help="Analyze consecutive rendered frames after timing; never included in throughput.")
    parser.add_argument("--reference-dir", type=Path)
    parser.add_argument("--eligibility-report", type=Path, default=DEFAULT_ELIGIBILITY_REPORT)
    parser.add_argument("--capture-restorer-inputs", type=Path)
    parser.add_argument("--capture-restorer-inputs-per-clip", type=int, default=0)
    parser.add_argument(
        "--timing-only",
        action="store_true",
        help="Disable identity/reference diagnostics for an unbiased paired timing run.",
    )
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
    args = parser.parse_args()

    if not MANIFEST_PATH.is_file() or not STOCK_FACE.is_file():
        raise FileNotFoundError("stock corpus or stock test face is missing")
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    manifest_by_name = {
        Path(str(item.get("path") or "")).name: item
        for item in manifest.get("clips", [])
    }
    eligibility_by_clip = load_eligibility_report(
        args.eligibility_report,
        manifest_by_name,
    )
    if not eligibility_by_clip:
        raise FileNotFoundError(
            "an exact-baseline eligibility report is required so no-face clips "
            "cannot create false performance wins"
        )
    all_clip_paths = [CORPUS_ROOT / str(item["path"]) for item in manifest.get("clips", [])]
    start_offset = max(0, int(args.start_index) - 1)
    clip_paths = all_clip_paths[start_offset:start_offset + max(1, args.limit)]
    if len(clip_paths) < min(20, max(1, args.limit)):
        raise RuntimeError("the real-time gate requires at least 20 stock clips")
    verified_source_hashes: dict[Path, str] = {}
    for clip_path in clip_paths:
        expected = str((manifest_by_name.get(clip_path.name) or {}).get("sha256") or "").lower()
        actual = sha256_file(clip_path)
        if len(expected) != 64 or actual != expected:
            raise RuntimeError(
                f"stock fixture provenance mismatch for {clip_path.name}: "
                f"expected {expected or 'missing'}, observed {actual}"
            )
        verified_source_hashes[clip_path] = actual
    missing_evidence = [
        clip_path.name
        for clip_path, source_sha256 in verified_source_hashes.items()
        if source_sha256 not in eligibility_by_clip
    ]
    if missing_evidence:
        raise RuntimeError(
            "exact-baseline eligibility evidence is missing for verified fixtures: "
            + ", ".join(missing_evidence)
        )

    output_dir = (args.output_dir or (CORPUS_ROOT / "runs" / args.label)).resolve()
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
    if args.exact_gpen512:
        config["parameters"]["SwapperTypeTextSel"] = "128"
        config["parameters"]["RestorerSwitch"] = True
        config["parameters"]["RestorerTypeTextSel"] = "GPEN512"
        config["runtime"]["adaptiveRestorer"] = False
    if args.restorer != "current":
        config["parameters"]["RestorerSwitch"] = args.restorer != "off"
        if args.restorer != "off":
            config["parameters"]["RestorerTypeTextSel"] = args.restorer
    if args.disable_parser:
        config["parameters"]["FaceParserSwitch"] = False
    if args.disable_occluder:
        config["parameters"]["OccluderSwitch"] = False
    if args.detect_interval is not None:
        config["runtime"]["targetDetectIntervalFrames"] = max(1, args.detect_interval)
    if args.identity_interval is not None:
        config["runtime"]["identityCheckIntervalFrames"] = max(1, args.identity_interval)
    if args.production_policy:
        config["runtime"]["temporalExactLandmarkLockEnabled"] = False
    engine._config = config
    code_sha256 = {name: sha256_file(ROOT / name) for name in
                   ('pong_swap_engine.py', 'engine/Rope/rope/VideoManager.py', 'benchmark_realtime_corpus.py')}
    configuration_sha256 = hashlib.sha256(
        json.dumps(config, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    model_names = ["inswapper_128.fp16.onnx", "det_10g.onnx", "w600k_r50.onnx"]
    if config["parameters"].get("RestorerSwitch"):
        selected_restorer = str(config["parameters"].get("RestorerTypeTextSel", "GPEN512"))
        if selected_restorer not in {"GPEN256", "GPEN512", "GPEN1024"}:
            raise ValueError(f"Unsupported benchmark restorer: {selected_restorer}")
        model_names.append(f"GPEN-BFR-{selected_restorer.removeprefix('GPEN')}.onnx")
    if config["parameters"].get("OccluderSwitch"):
        model_names.append("occluder.onnx")
    if config["parameters"].get("FaceParserSwitch"):
        model_names.append("faceparser_resnet34.onnx")
    model_sha256 = {
        name: sha256_file(MODELS_DIR / name)
        for name in sorted(set(model_names))
    }

    cold_started = time.perf_counter()
    warm = engine.warm(config=config, allow_create_selected=True)
    engine._compute_stream.synchronize()
    cold_warm_seconds = time.perf_counter() - cold_started
    embedding_started = time.perf_counter()
    source_embedding = engine.embedding_from_images((STOCK_FACE,), config)
    engine._compute_stream.synchronize()
    embedding_seconds = time.perf_counter() - embedding_started

    clips = []
    try:
        for index, clip_path in enumerate(clip_paths, 1):
            # Source-FPS resolution must never mutate the next fixture's base
            # settings or the configuration whose hash appears in the report.
            engine._config = deepcopy(config)
            full_anchor_hz = max(0.0, args.temporal_anchor_hz)
            restorer_hz = max(0.0, args.temporal_restorer_hz)
            if args.production_policy:
                with av.open(str(clip_path)) as source_container:
                    source_stream = source_container.streams.video[0]
                    source_fps = float(source_stream.average_rate or 30)
                    reuse_allowed = PongSwapEngine._foreground_reuse_allowed_for_source(
                        SimpleNamespace(fps=source_fps), config['runtime'],
                        (source_stream.height, source_stream.width, 3))
                full_anchor_hz = float(config['runtime'].get('temporalFullAnchorHz', 3)) if reuse_allowed else 0.0
                restorer_hz = float(config['runtime'].get('temporalRestorerAnchorHz', 2)) if config['runtime'].get('adaptiveRestorer') else 0.0
            source_sha256 = verified_source_hashes[clip_path]
            output_path = output_dir / f"{clip_path.stem}-silent-swapped.mp4"
            output_path.unlink(missing_ok=True)
            result = benchmark_clip(
                engine,
                source_embedding,
                clip_path,
                output_path,
                args.seconds,
                temporal_anchor_hz=full_anchor_hz,
                temporal_restorer_hz=restorer_hz,
                pipelined_decode=args.pipelined_decode,
                tracking_lookahead_enabled=args.tracking_lookahead,
                reference_path=(
                    args.reference_dir / f"{clip_path.stem}-silent-swapped.mp4"
                    if args.reference_dir
                    else None
                ),
                baseline_evidence=eligibility_by_clip.get(source_sha256),
                capture_restorer_inputs_path=(
                    args.capture_restorer_inputs / f"{clip_path.stem}-gpen-inputs-f32.npy"
                    if args.capture_restorer_inputs
                    else None
                ),
                capture_restorer_metadata_path=(
                    args.capture_restorer_inputs / f"{clip_path.stem}-gpen-inputs-f32.json"
                    if args.capture_restorer_inputs
                    else None
                ),
                capture_restorer_inputs_limit=max(
                    0, int(args.capture_restorer_inputs_per_clip)
                ),
                exact_cpu_overlap=bool(
                    config["runtime"].get("exactCpuResidualOverlap", False)
                ),
                quality_diagnostics=not bool(args.timing_only),
            )
            result["ordinal"] = index
            if args.minimum_consistent_fps:
                consistent = bool(result["timing"]["consistency"]["targets"][
                    str(args.minimum_consistent_fps)
                ]["passed"])
                result["checks"]["consistentThroughput"] = consistent
                result["passed"] = bool(result["passed"] and consistent)
            result['effectiveConfiguration'] = deepcopy(engine.config)
            if args.temporal_quality and not result.get('error'):
                from benchmark_temporal_attachment import analyze_pair
                result['temporalQuality'] = analyze_pair(engine, clip_path, output_path,
                    max_seconds=args.seconds, sample_fps=60, occlusion_fixture=False,
                    associate_faces=True,
                    source_frame_stride=result.get('cadence', {}).get('sourceFrameStride', 1),
                    frame_provenance=result.get('transformation', {}).get('frameProvenance'))
            result["sourceSha256"] = source_sha256
            result["outputSha256"] = (
                sha256_file(output_path) if output_path.is_file() else ""
            )
            clips.append(result)
            print(json.dumps({
                "clip": result["clip"], "passed": result["passed"],
                "eligible": result["eligibility"]["eligible"],
                "fps": round(result["timing"]["processingFps"], 3),
                "headroom": round(result["timing"]["realtimeHeadroom"], 3),
                "transformed": round(result["transformation"]["transformedFaceFrameRatio"], 3),
                "error": result["error"],
            }), flush=True)
    finally:
        engine.unload()
        engine.shutdown_gpu_worker()

    eligible_clips = [
        clip for clip in clips if clip["eligibility"]["eligible"]
    ]
    distinct_eligible_by_hash: dict[str, dict] = {}
    for clip in eligible_clips:
        distinct_key = str(clip.get("sourceSha256") or clip.get("clip") or "")
        distinct_eligible_by_hash.setdefault(distinct_key, clip)
    distinct_eligible_clips = list(distinct_eligible_by_hash.values())
    report = {
        "schema": "pong-realtime-corpus-v1",
        "label": args.label,
        "silent": True,
        "timingOnly": bool(args.timing_only),
        "consistencyTargetFps": args.minimum_consistent_fps,
        "stockFace": str(STOCK_FACE),
        "configuration": config,
        "provenance": {
            "codeSha256": code_sha256,
            "configurationSha256": configuration_sha256,
            "modelSha256": model_sha256,
            "eligibilityReport": str(args.eligibility_report.resolve()),
            "eligibilityReportSha256": sha256_file(args.eligibility_report),
            "configOverrides": (
                str(args.config_overrides_json.resolve())
                if args.config_overrides_json is not None else ""
            ),
            "configOverridesSha256": override_sha256,
            "configBaseReport": (
                str(args.config_base_report.resolve())
                if args.config_base_report is not None else ""
            ),
            "configBaseReportSha256": base_report_sha256,
        },
        "startup": {"coldWarmSeconds": cold_warm_seconds, "embeddingSeconds": embedding_seconds},
        "warm": warm,
        "clips": clips,
        "summary": {
            "clipCount": len(clips),
            "eligibleClipCount": len(eligible_clips),
            "distinctEligibleClipCount": len(distinct_eligible_clips),
            "excludedClipCount": len(clips) - len(eligible_clips),
            "passedClips": sum(1 for clip in distinct_eligible_clips if clip["passed"]),
            "failedClips": sum(1 for clip in distinct_eligible_clips if not clip["passed"]),
            "allClipsPassed": (
                len(clips) >= 20 and all(clip["passed"] for clip in clips)
                if args.timing_only
                else len(distinct_eligible_clips) >= 20 and all(
                    clip["passed"] for clip in distinct_eligible_clips
                )
            ),
            "medianProcessingFps": statistics.median(
                clip["timing"]["processingFps"] for clip in clips
            ) if clips else 0.0,
            "p10RealtimeHeadroom": percentile(
                [clip["timing"]["realtimeHeadroom"] for clip in distinct_eligible_clips], 0.10
            ),
        },
    }
    report_path = output_dir / "report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"report": str(report_path), **report["summary"]}, indent=2))
    if not report["summary"]["allClipsPassed"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
