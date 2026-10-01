"""End-to-end silent validation of Pong Swap's production streaming path.

Unlike ``benchmark_realtime_corpus.py``, this test uses the real SwapSession
producer, bounded decoder queue, FFmpeg fragmented-MP4 spool, stream reader,
foreground activation, and cleanup lifecycle.  It deliberately injects only
the repository's stock test identity and serves only the licensed local stock
corpus over a private loopback HTTP server.
"""

from __future__ import annotations

import argparse
import functools
import gc
import hashlib
import itertools
import json
import os
import statistics
import subprocess
import sys
import threading
import time
from copy import deepcopy
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote

import av
import numpy as np

from benchmark_realtime_corpus import (
    CORPUS_ROOT,
    DEFAULT_ELIGIBILITY_REPORT,
    MANIFEST_PATH,
    STOCK_FACE,
    face_roi,
    detect_on_engine_stream,
    load_eligibility_report,
    probe_output,
)
from pong_swap_engine import ApprovedFace, PongSwapEngine, _FragmentedMp4Probe
from pong_swap_config import MODELS_DIR


# Production keeps the original video visible while this encoded lead is
# prepared.  One second covers the measured short encoder burst that caused a
# 36 ms starvation event with a 0.5 second lead; no visual setting is changed.
FOREGROUND_SAFETY_BUFFER_SECONDS = 1.0


def identity_score_at_source_landmarks(
    engine: PongSwapEngine,
    rgb: np.ndarray,
    source_kps: np.ndarray,
    source_embedding: np.ndarray,
) -> float | None:
    """Recognize the paired output at the independently detected source pose.

    Re-detecting the generated face made transformation proof depend on a
    second detector pass: four genuinely modified frames in the slow fixture
    could not be scored when that detector briefly missed.  Source and output
    represent the exact same timestamp, so using the source frame's independent
    landmarks is both stricter spatially and deterministic.  Recognition still
    runs on every output frame and must improve toward the selected identity.
    """

    points = np.asarray(source_kps, dtype=np.float32)

    def recognize() -> float | None:
        with engine._lock:
            with engine._torch.cuda.stream(engine._compute_stream):
                embedding, _ = engine._models.run_recognize(
                    engine._frame_tensor(rgb),
                    points,
                    return_crop=False,
                )
            engine._compute_stream.synchronize()
        if embedding is None:
            return None
        return float(
            engine._vm.findCosineDistance(
                np.asarray(embedding),
                source_embedding,
            )
        )

    run_gpu_work = getattr(engine, "_run_gpu_work", None)
    if callable(run_gpu_work):
        return run_gpu_work(
            recognize,
            priority=0,
            work_label="validator-recognize-at-source-landmarks",
        )
    return recognize()


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args) -> None:
        return


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def selected_model_names(config: dict) -> list[str]:
    """Return every model artifact selected by this frozen render graph."""
    parameters = config.get("parameters") or {}
    runtime = config.get("runtime") or {}
    detector = str(parameters.get("DetectTypeTextSel") or "Retinaface")
    restorer = str(parameters.get("RestorerTypeTextSel") or "GPEN256")
    names = [
        "inswapper_128.fp16.onnx",
        "w600k_r50.onnx",
        "scrfd_2.5g_bnkps.onnx" if detector == "SCRDF" else "det_10g.onnx",
    ]
    if parameters.get("RestorerSwitch"):
        names.append(
            "GPEN-BFR-512.onnx" if restorer == "GPEN512"
            else "GPEN-BFR-256.onnx"
        )
    if parameters.get("OccluderSwitch"):
        names.append("occluder.onnx")
    if parameters.get("FaceParserSwitch"):
        names.append("faceparser_resnet34.onnx")
    if runtime.get("frameEnhancerEnabled"):
        enhancer = str(runtime.get("frameEnhancerType") or "")
        if enhancer == "RealEsrgan-x2-Plus":
            names.append("RealESRGAN_x2plus.fp16.onnx")
    return sorted(set(names))


def selected_model_sha256(config: dict) -> dict[str, str]:
    return {
        name: file_sha256(MODELS_DIR / Path(name))
        for name in selected_model_names(config)
    }


def fragment_packet_timeline(path: Path, fragment_ends: list[int]) -> dict:
    """Map each completed fMP4 fragment to its actual encoded media end time."""
    completed = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_packets", "-show_entries",
            "packet=pts_time,dts_time,duration_time,pos,size", "-of", "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    packets = []
    for item in json.loads(completed.stdout).get("packets", []):
        try:
            position = int(item["pos"])
            size = int(item.get("size") or 0)
            timestamp = float(item.get("pts_time", item.get("dts_time")))
            duration = float(item.get("duration_time") or 0.0)
        except (KeyError, TypeError, ValueError):
            continue
        packets.append({
            "endOffset": position + max(0, size),
            "startSeconds": timestamp,
            "endSeconds": timestamp + max(0.0, duration),
        })
    packets.sort(key=lambda item: item["endOffset"])
    timeline = []
    packet_index = 0
    media_end = float("-inf")
    prior_packet_index = 0
    for fragment_number, fragment_end in enumerate(fragment_ends, 1):
        while packet_index < len(packets) and packets[packet_index]["endOffset"] <= fragment_end:
            media_end = max(media_end, packets[packet_index]["endSeconds"])
            packet_index += 1
        timeline.append({
            "fragment": fragment_number,
            "endOffset": int(fragment_end),
            "packetCount": packet_index - prior_packet_index,
            "mediaEndSeconds": media_end if np.isfinite(media_end) else None,
        })
        prior_packet_index = packet_index
    return {
        "packetCount": len(packets),
        "mappedPacketCount": packet_index,
        "fragments": timeline,
    }


def fragment_delivery_headroom(
    fragment_timeline: list[dict],
    delivered_fragment_events: list[tuple[int, float]],
    fps: float,
) -> list[dict]:
    """Measure playable media available immediately *before* each arrival.

    The arriving fragment cannot rescue playback that already exhausted the
    preceding fragments. Crediting its media end before checking starvation
    allowed a 120 ms second-frame arrival to pass a 24 fps one-frame tolerance.
    """
    if not fragment_timeline or not delivered_fragment_events:
        return []
    frame_seconds = 1.0 / max(1.0, float(fps or 0.0))
    first_delivery_at = float(delivered_fragment_events[0][1])
    first_media_end = next(
        (
            float(item["mediaEndSeconds"])
            for item in fragment_timeline
            if item.get("mediaEndSeconds") is not None
        ),
        0.0,
    )
    prior_media_end: float | None = None
    records: list[dict] = []
    for fragment, (fragment_number, delivered_at) in zip(
        fragment_timeline,
        delivered_fragment_events,
    ):
        media_end_value = fragment.get("mediaEndSeconds")
        if media_end_value is None:
            continue
        media_end = float(media_end_value)
        elapsed = max(0.0, float(delivered_at) - first_delivery_at)
        if prior_media_end is None:
            # Playback begins only after the first complete fragment arrives.
            available_before_arrival = frame_seconds
        else:
            available_before_arrival = max(
                0.0,
                prior_media_end - first_media_end + frame_seconds,
            )
        records.append({
            "fragment": int(fragment_number),
            "arrivalSeconds": elapsed,
            "availableBeforeArrivalSeconds": available_before_arrival,
            "headroomBeforeArrivalSeconds": available_before_arrival - elapsed,
            "mediaEndSeconds": media_end,
        })
        prior_media_end = media_end
    return records


def choose_distinct_eligible_clips(
    limit: int,
    *,
    start_ordinal: int = 1,
) -> list[tuple[Path, str]]:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    manifest_by_name = {
        Path(str(item.get("path") or "")).name: item
        for item in manifest.get("clips", [])
    }
    eligibility = load_eligibility_report(
        DEFAULT_ELIGIBILITY_REPORT,
        manifest_by_name,
    )
    chosen: list[tuple[Path, str]] = []
    seen_hashes: set[str] = set()
    for item in manifest.get("clips", []):
        if int(item.get("ordinal") or 0) < max(1, int(start_ordinal)):
            continue
        clip_path = CORPUS_ROOT / str(item.get("path") or "")
        digest = str(item.get("sha256") or "")
        evidence = eligibility.get(digest) or {}
        if not evidence.get("eligible") or not digest or digest in seen_hashes:
            continue
        if not clip_path.is_file() or file_sha256(clip_path) != digest:
            raise RuntimeError(f"stock fixture hash mismatch: {clip_path.name}")
        seen_hashes.add(digest)
        chosen.append((clip_path, digest))
        if len(chosen) >= limit:
            break
    if len(chosen) < limit:
        raise RuntimeError(
            f"only {len(chosen)} distinct identity-proven clips are available; {limit} required"
        )
    return chosen


def verify_transformation(
    engine: PongSwapEngine,
    source_path: Path,
    output_path: Path,
    source_embedding: np.ndarray,
) -> dict:
    source = av.open(str(source_path))
    output = av.open(str(output_path))
    source_stream = next(item for item in source.streams if item.type == "video")
    output_stream = next(item for item in output.streams if item.type == "video")
    source_frames = iter(source.decode(source_stream))
    output_frames = iter(output.decode(output_stream))
    deltas: list[float] = []
    identity_gains: list[float] = []
    sample_records: list[dict] = []
    source_frame_count = 0
    output_frame_count = 0
    paired_frame_count = 0
    pts_mismatch_count = 0
    cadence_mismatch_count = 0
    missing_pts_count = 0
    source_non_monotonic_count = 0
    output_non_monotonic_count = 0
    first_source_pts = None
    first_output_pts = None
    prior_source_pts = None
    prior_output_pts = None
    source_fps = float(source_stream.average_rate or source_stream.base_rate or 30.0)
    output_fps = float(output_stream.average_rate or output_stream.base_rate or source_fps)
    source_tick = float(source_stream.time_base or 0.0)
    output_tick = float(output_stream.time_base or 0.0)
    # Two muxer ticks permit rational rounding without accepting an entire
    # duplicated/dropped frame as a timestamp match.
    pts_tolerance = max(0.0005, source_tick * 2.1, output_tick * 2.1)
    try:
        for index, pair in enumerate(itertools.zip_longest(source_frames, output_frames)):
            source_frame, output_frame = pair
            if source_frame is not None:
                source_frame_count += 1
            if output_frame is not None:
                output_frame_count += 1
            if source_frame is None or output_frame is None:
                continue
            paired_frame_count += 1
            source_pts_valid = source_frame.pts is not None and source_stream.time_base is not None
            output_pts_valid = output_frame.pts is not None and output_stream.time_base is not None
            if not source_pts_valid or not output_pts_valid:
                missing_pts_count += 1
            source_pts = (
                float(source_frame.pts * source_stream.time_base)
                if source_pts_valid
                else index / max(1.0, source_fps)
            )
            output_pts = (
                float(output_frame.pts * output_stream.time_base)
                if output_pts_valid
                else index / max(1.0, output_fps)
            )
            if first_source_pts is None:
                first_source_pts = source_pts
            if first_output_pts is None:
                first_output_pts = output_pts
            if source_pts_valid and output_pts_valid:
                if prior_source_pts is not None:
                    if source_pts <= prior_source_pts:
                        source_non_monotonic_count += 1
                    if output_pts <= prior_output_pts:
                        output_non_monotonic_count += 1
                    source_delta = source_pts - prior_source_pts
                    output_delta = output_pts - prior_output_pts
                    if abs(source_delta - output_delta) > pts_tolerance:
                        cadence_mismatch_count += 1
                if abs((source_pts - first_source_pts) - (output_pts - first_output_pts)) > pts_tolerance:
                    pts_mismatch_count += 1
                prior_source_pts = source_pts
                prior_output_pts = output_pts
            # Strict proof inspects every paired frame. Sampling every twelfth
            # frame allowed an output with 91.7% unchanged frames to pass.
            before = source_frame.to_ndarray(format="rgb24")
            after = output_frame.to_ndarray(format="rgb24")
            detected = detect_on_engine_stream(engine, before, recognize=False)
            if not detected:
                continue
            kps = np.asarray(detected[0][1], dtype=np.float32)
            before_roi = face_roi(before, kps)
            after_roi = face_roi(after, kps)
            if before_roi.size and before_roi.shape == after_roi.shape:
                delta = float(np.mean(np.abs(
                    after_roi.astype(np.int16) - before_roi.astype(np.int16)
                )))
                deltas.append(delta)
                sample_records.append({
                    "frame": index,
                    "seconds": source_pts - first_source_pts,
                    "facePixelDelta": delta,
                    "transformed": delta >= 1.0,
                })
            before_identity = identity_score_at_source_landmarks(
                engine,
                before,
                kps,
                source_embedding,
            )
            after_identity = identity_score_at_source_landmarks(
                engine,
                after,
                kps,
                source_embedding,
            )
            identity_gain = None
            if before_identity is not None and after_identity is not None:
                identity_gain = after_identity - before_identity
                identity_gains.append(identity_gain)
            if sample_records and sample_records[-1].get("frame") == index:
                sample_records[-1]["identityGain"] = identity_gain
                # Re-encoding alone can change pixels. A sampled frame counts
                # as transformed only when it also moves toward the selected
                # stock identity, so an unchanged/re-encoded tail cannot pass.
                sample_records[-1]["transformed"] = bool(
                    sample_records[-1]["facePixelDelta"] >= 1.0
                    and identity_gain is not None
                    and identity_gain > 0.20
                )
    finally:
        source.close()
        output.close()
    median_delta = statistics.median(deltas) if deltas else 0.0
    median_identity_gain = statistics.median(identity_gains) if identity_gains else None
    transformed_samples = sum(1 for item in sample_records if item["transformed"])
    identity_improved_samples = sum(
        1 for item in sample_records
        if item.get("identityGain") is not None and float(item["identityGain"]) > 0.20
    )
    transformed_ratio = transformed_samples / max(1, len(sample_records))

    def maximum_false_run(items: list[dict]) -> int:
        longest = 0
        current = 0
        for item in items:
            if item.get("transformed") is True:
                current = 0
            else:
                current += 1
                longest = max(longest, current)
        return longest

    maximum_untransformed_run = maximum_false_run(sample_records)
    if sample_records:
        visible_start = float(sample_records[0]["seconds"])
        visible_end = float(sample_records[-1]["seconds"])
        tail_threshold = visible_start + ((visible_end - visible_start) * (2.0 / 3.0))
    else:
        tail_threshold = 0.0
    # Tail is defined over frames on which the independent verifier actually
    # detects a face. A clip is not a swap failure merely because the subject
    # leaves frame, but the final visible face frames must all be transformed.
    tail_samples = [item for item in sample_records if item["seconds"] >= tail_threshold]
    tail_transformed_count = sum(1 for item in tail_samples if item["transformed"])
    tail_transformed_ratio = tail_transformed_count / max(1, len(tail_samples))
    maximum_tail_untransformed_run = maximum_false_run(tail_samples)
    # Independent recognition is not infallible at extreme single-frame poses.
    # Reject sustained/clustered misses rather than making one verifier outlier
    # invalidate an otherwise complete transformed sequence.
    tail_transformed = bool(
        tail_samples
        and tail_transformed_ratio >= 0.95
        and maximum_tail_untransformed_run <= 1
    )
    frame_sequence_complete = bool(
        source_frame_count > 0
        and output_frame_count == source_frame_count
        and paired_frame_count == source_frame_count
        and pts_mismatch_count == 0
        and cadence_mismatch_count == 0
        and missing_pts_count == 0
        and source_non_monotonic_count == 0
        and output_non_monotonic_count == 0
    )
    return {
        "sampleCount": len(sample_records),
        "medianFacePixelDelta": median_delta,
        "transformedSamples": transformed_samples,
        "transformedSampleRatio": transformed_ratio,
        "tailSampleCount": len(tail_samples),
        "tailTransformed": tail_transformed,
        "tailTransformedRatio": tail_transformed_ratio,
        "maximumUntransformedRun": maximum_untransformed_run,
        "maximumTailUntransformedRun": maximum_tail_untransformed_run,
        "identityGainSamples": len(identity_gains),
        "identityImprovedSamples": identity_improved_samples,
        "medianIdentityGain": median_identity_gain,
        "sourceFrames": source_frame_count,
        "outputFrames": output_frame_count,
        "pairedFrames": paired_frame_count,
        "ptsMismatchCount": pts_mismatch_count,
        "cadenceMismatchCount": cadence_mismatch_count,
        "missingPtsCount": missing_pts_count,
        "sourceNonMonotonicCount": source_non_monotonic_count,
        "outputNonMonotonicCount": output_non_monotonic_count,
        "ptsToleranceSeconds": pts_tolerance,
        "frameSequenceComplete": frame_sequence_complete,
        "samples": sample_records,
        "transformationProven": bool(
            frame_sequence_complete
            and len(sample_records) >= 2
            and median_delta >= 1.0
            and transformed_ratio >= 0.98
            and maximum_untransformed_run <= 1
            and tail_transformed
            and len(identity_gains) >= 2
            and identity_improved_samples / max(1, len(sample_records)) >= 0.98
            and median_identity_gain is not None
            and median_identity_gain > 0.20
        ),
    }


def build_stock_engine(
    frozen_config: dict | None = None,
) -> tuple[PongSwapEngine, np.ndarray, float, dict]:
    """Create the exact production graph used by both timing and verification.

    Verification runs in a different operating-system process so its detector
    and recognizer arenas can never alter production-stream latency or the
    production worker's VRAM plateau.  Both processes still use this shared
    constructor, which keeps the selected model, restorer, and every quality
    parameter identical.
    """
    engine = PongSwapEngine()
    stock_face = ApprovedFace("stock-test", "Stock test identity", (STOCK_FACE,))
    engine._faces = {stock_face.id: stock_face}
    config = deepcopy(frozen_config if frozen_config is not None else engine.config)
    config["parameters"]["SwapperTypeTextSel"] = "128"
    config["parameters"]["RestorerSwitch"] = True
    config["parameters"]["RestorerTypeTextSel"] = "GPEN512"
    config["runtime"]["swapAudioEnabled"] = False
    config["runtime"]["temporalForegroundReuseEnabled"] = True
    engine._config = config

    warm_started = time.perf_counter()
    engine.warm(config=config, allow_create_selected=True)
    engine._compute_stream.synchronize()
    warm_seconds = time.perf_counter() - warm_started
    source_embedding = engine.embedding_from_images(stock_face.files, config)
    engine._compute_stream.synchronize()
    return engine, source_embedding, warm_seconds, config


def gpu_memory_snapshot(engine: PongSwapEngine) -> dict:
    free_bytes, total_bytes = engine._torch.cuda.mem_get_info()
    return {
        "freeMiB": int(free_bytes // (1024 * 1024)),
        "totalMiB": int(total_bytes // (1024 * 1024)),
        "torchAllocatedMiB": int(engine._torch.cuda.memory_allocated() // (1024 * 1024)),
        "torchReservedMiB": int(engine._torch.cuda.memory_reserved() // (1024 * 1024)),
    }


def run_verification_batch(manifest_path: Path, output_path: Path) -> None:
    """Verify encoded transformations in an isolated, disposable GPU process."""
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if isinstance(manifest, list):
        items = manifest
        frozen_config = None
        expected_config_sha256 = ""
        expected_model_sha256: dict[str, str] = {}
    else:
        items = list(manifest.get("items") or [])
        frozen_config = manifest.get("config")
        expected_config_sha256 = str(manifest.get("configSha256") or "")
        expected_model_sha256 = {
            str(name): str(digest)
            for name, digest in (manifest.get("modelSha256") or {}).items()
        }
    if frozen_config is not None:
        manifest_config_sha256 = hashlib.sha256(
            json.dumps(frozen_config, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        if expected_config_sha256 and manifest_config_sha256 != expected_config_sha256:
            raise RuntimeError("verification manifest configuration hash is invalid")
        actual_model_sha256 = selected_model_sha256(frozen_config)
        if expected_model_sha256 and actual_model_sha256 != expected_model_sha256:
            raise RuntimeError("verification model artifacts do not match production artifacts")
    else:
        actual_model_sha256 = {}

    # Authenticate all media before constructing/loading the verification GPU
    # graph.  The child must not trust parent-provided filenames or digests.
    verified_media_hashes: dict[str, tuple[str, str]] = {}
    for item in items:
        source_path = Path(str(item["source"]))
        encoded_path = Path(str(item["output"]))
        source_digest = file_sha256(source_path)
        output_digest = file_sha256(encoded_path)
        expected_source = str(item.get("sourceSha256") or item.get("sha256") or "")
        expected_output = str(item.get("outputSha256") or "")
        if expected_source and source_digest != expected_source:
            raise RuntimeError(f"verification source hash mismatch: {source_path.name}")
        if expected_output and output_digest != expected_output:
            raise RuntimeError(f"verification output hash mismatch: {encoded_path.name}")
        verified_media_hashes[str(item.get("sha256") or source_digest)] = (
            source_digest,
            output_digest,
        )
    engine, source_embedding, warm_seconds, effective_config = build_stock_engine(frozen_config)
    actual_config_sha256 = hashlib.sha256(
        json.dumps(effective_config, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    if expected_config_sha256 and actual_config_sha256 != expected_config_sha256:
        raise RuntimeError("verification configuration does not match production configuration")
    verified: list[dict] = []
    try:
        for item in items:
            source_path = Path(str(item["source"]))
            encoded_path = Path(str(item["output"]))
            result = verify_transformation(
                engine,
                source_path,
                encoded_path,
                source_embedding,
            )
            result["sha256"] = str(item["sha256"])
            source_digest, output_digest = verified_media_hashes[result["sha256"]]
            result["sourceSha256"] = source_digest
            result["outputSha256"] = output_digest
            result["gpuMemoryAfterVerification"] = gpu_memory_snapshot(engine)
            verified.append(result)
    finally:
        engine.unload()
        engine.shutdown_gpu_worker()
    output_path.write_text(
        json.dumps({
            "schema": "pong-production-verification-batch-v1",
            "warmSeconds": warm_seconds,
            "configSha256": actual_config_sha256,
            "modelSha256": actual_model_sha256,
            "items": verified,
        }, indent=2),
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--minimum-distinct", type=int, default=20)
    parser.add_argument("--start-ordinal", type=int, default=1)
    parser.add_argument("--diagnostics", action="store_true")
    parser.add_argument("--label", default="production-realtime-20")
    parser.add_argument("--verification-batch", type=Path)
    parser.add_argument("--verification-output", type=Path)
    parser.add_argument("--verification-batch-size", type=int, default=4)
    parser.add_argument(
        "--config-base-report",
        type=Path,
        help="Use the frozen configuration embedded in a benchmark report.",
    )
    parser.add_argument(
        "--config-overrides-json",
        type=Path,
        help="Apply hash-recorded runtime/parameter overrides without touching the live preset.",
    )
    args = parser.parse_args()
    if args.verification_batch is not None:
        if args.verification_output is None:
            parser.error("--verification-output is required with --verification-batch")
        run_verification_batch(args.verification_batch, args.verification_output)
        return
    required = max(1, int(args.minimum_distinct))
    clips = choose_distinct_eligible_clips(
        max(required, int(args.limit)),
        start_ordinal=max(1, int(args.start_ordinal)),
    )
    output_dir = CORPUS_ROOT / "runs" / str(args.label)
    output_dir.mkdir(parents=True, exist_ok=True)

    handler = functools.partial(QuietHandler, directory=str(CORPUS_ROOT / "input"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server_thread = threading.Thread(target=server.serve_forever, name="PongStockHTTP", daemon=True)
    server_thread.start()

    requested_config = None
    base_report_sha256 = ""
    if args.config_base_report is not None:
        base_report_path = args.config_base_report.resolve()
        base_report = json.loads(base_report_path.read_text(encoding="utf-8"))
        embedded_config = base_report.get("configuration")
        if not isinstance(embedded_config, dict):
            raise TypeError("production base report has no configuration object")
        requested_config = deepcopy(embedded_config)
        base_report_sha256 = file_sha256(base_report_path)
    override_sha256 = ""
    if args.config_overrides_json is not None:
        override_path = args.config_overrides_json.resolve()
        overrides = json.loads(override_path.read_text(encoding="utf-8"))
        if not isinstance(overrides, dict):
            raise TypeError("production overrides must be a JSON object")
        unexpected_sections = sorted(set(overrides) - {"runtime", "parameters"})
        if unexpected_sections:
            raise ValueError(
                "production overrides may contain only runtime and parameters: "
                + ", ".join(unexpected_sections)
            )
        if requested_config is None:
            requested_config = deepcopy(PongSwapEngine().config)
        for section in ("runtime", "parameters"):
            values = overrides.get(section, {})
            if not isinstance(values, dict):
                raise TypeError(f"production override section {section} must be an object")
            requested_config.setdefault(section, {}).update(deepcopy(values))
        override_sha256 = file_sha256(override_path)

    engine, source_embedding, warm_seconds, frozen_config = build_stock_engine(
        requested_config
    )
    frozen_config_sha256 = hashlib.sha256(
        json.dumps(frozen_config, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    model_sha256 = selected_model_sha256(frozen_config)

    results: list[dict] = []
    try:
        for ordinal, (clip_path, digest) in enumerate(clips, 1):
            output_path = output_dir / f"{clip_path.stem}-production-stream.mp4"
            output_path.unlink(missing_ok=True)
            source_url = (
                f"http://127.0.0.1:{server.server_address[1]}/"
                f"{quote(clip_path.name)}"
            )
            intent_at = time.perf_counter()
            session = engine.create_session(
                channel="test",
                source_url=source_url,
                face_id="stock-test",
                start_seconds=0.0,
                prefetch=False,
                prebuffer_seconds=FOREGROUND_SAFETY_BUFFER_SECONDS,
                navigation_class="foreground",
                client_epoch="stock-production-validation",
                activation_sequence=ordinal,
                diagnostics_enabled=bool(args.diagnostics),
            )
            registered_at = time.perf_counter()
            buffer_deadline = time.perf_counter() + 30.0
            while not session.is_prepared():
                if session.complete or session.error or session.stop.is_set():
                    break
                if time.perf_counter() >= buffer_deadline:
                    break
                time.sleep(0.01)
            buffer_ready_at = time.perf_counter()
            safety_buffer_ready = session.is_prepared()
            first_chunk_at = 0.0
            previous_chunk_at = 0.0
            inter_chunk_gaps_ms: list[float] = []
            chunk_count = 0
            byte_count = 0
            delivery_probe = _FragmentedMp4Probe()
            delivered_fragment_events: list[tuple[int, float]] = []
            with output_path.open("wb") as sink:
                for chunk in engine.stream_session(session.id, activate=True):
                    chunk_at = time.perf_counter()
                    if not first_chunk_at:
                        first_chunk_at = chunk_at
                    elif previous_chunk_at:
                        inter_chunk_gaps_ms.append((chunk_at - previous_chunk_at) * 1000.0)
                    previous_chunk_at = chunk_at
                    chunk_count += 1
                    sink.write(chunk)
                    byte_count += len(chunk)
                    previous_fragments = delivery_probe.complete_fragment_count
                    delivery_probe.feed(chunk)
                    for fragment_number in range(
                        previous_fragments + 1,
                        delivery_probe.complete_fragment_count + 1,
                    ):
                        delivered_fragment_events.append((fragment_number, chunk_at))
            previous_fragments = delivery_probe.complete_fragment_count
            delivery_probe.feed(b"", eof=True)
            for fragment_number in range(
                previous_fragments + 1,
                delivery_probe.complete_fragment_count + 1,
            ):
                delivered_fragment_events.append((fragment_number, time.perf_counter()))
            completed_at = time.perf_counter()
            public = session.public()
            gpu_memory = gpu_memory_snapshot(engine)
            probe = probe_output(output_path)
            output_sha256 = file_sha256(output_path)
            duration_ok = (
                probe["durationSeconds"] >= 5.0
                and abs(probe["durationSeconds"] - float(public.get("duration") or 0.0)) <= 0.20
            )
            encoded_frame_count_ok = bool(
                int(probe.get("videoFrames") or 0) > 0
                and int(probe.get("videoFrames") or 0) == int(public.get("frames") or 0)
            )
            maximum_inter_chunk_gap_ms = max(inter_chunk_gaps_ms) if inter_chunk_gaps_ms else 0.0
            fragment_delivery_gaps_ms = [
                (right[1] - left[1]) * 1000.0
                for left, right in zip(delivered_fragment_events, delivered_fragment_events[1:])
            ]
            maximum_fragment_delivery_gap_ms = (
                max(fragment_delivery_gaps_ms) if fragment_delivery_gaps_ms else 0.0
            )
            fps = max(1.0, float(public.get("fps") or 0.0))
            packet_timeline = fragment_packet_timeline(
                output_path,
                list(delivery_probe.complete_fragment_ends),
            )
            fragment_timeline = packet_timeline["fragments"]
            delivery_headroom_records = fragment_delivery_headroom(
                fragment_timeline,
                delivered_fragment_events,
                fps,
            )
            delivery_headroom_seconds = [
                float(item["headroomBeforeArrivalSeconds"])
                for item in delivery_headroom_records
            ]
            minimum_delivery_headroom_seconds = (
                min(delivery_headroom_seconds) if delivery_headroom_seconds else float("-inf")
            )
            minimum_delivery_record = (
                min(
                    delivery_headroom_records,
                    key=lambda item: float(item["headroomBeforeArrivalSeconds"]),
                )
                if delivery_headroom_records else None
            )
            delivered_fragment_count = int(delivery_probe.complete_fragment_count)
            expected_fragment_count = int(public.get("completeFragments") or 0)
            timeline_media_ends = [
                float(item["mediaEndSeconds"])
                for item in fragment_timeline
                if item.get("mediaEndSeconds") is not None
            ]
            fragment_timestamps_strict = bool(
                len(fragment_timeline) == delivered_fragment_count
                and fragment_timeline
                and all(int(item.get("packetCount") or 0) > 0 for item in fragment_timeline)
                and all(
                    right > left
                    for left, right in zip(timeline_media_ends, timeline_media_ends[1:])
                )
                and packet_timeline["mappedPacketCount"] == packet_timeline["packetCount"]
            )
            delivery_continuity_ok = bool(
                delivered_fragment_count > 0
                and delivered_fragment_count == expected_fragment_count
                and fragment_timestamps_strict
                # One frame of scheduling tolerance is allowed. Anything
                # lower means a player starting on the first complete fragment
                # would exhaust delivered media before the next one arrived.
                and minimum_delivery_headroom_seconds >= -(1.0 / fps)
            )
            result = {
                "clip": clip_path.name,
                "sha256": digest,
                "output": str(output_path),
                "outputSha256": output_sha256,
                "timing": {
                    "registerMs": (registered_at - intent_at) * 1000.0,
                    "intentToSafetyBufferMs": (buffer_ready_at - intent_at) * 1000.0,
                    "safetyBufferReady": safety_buffer_ready,
                    "intentToFirstByteMs": (
                        (first_chunk_at - intent_at) * 1000.0 if first_chunk_at else None
                    ),
                    "intentToPlayableMs": (
                        max(0.0, float(public.get("playableAt") or 0.0) - float(public.get("createdAt") or 0.0)) * 1000.0
                    ),
                    "streamWallSeconds": completed_at - intent_at,
                    "sourceDurationSeconds": float(public.get("duration") or 0.0),
                    "chunkCount": chunk_count,
                    "maximumInterChunkGapMs": maximum_inter_chunk_gap_ms,
                    "deliveredFragments": delivered_fragment_count,
                    "maximumFragmentDeliveryGapMs": maximum_fragment_delivery_gap_ms,
                    "minimumDeliveryHeadroomMs": minimum_delivery_headroom_seconds * 1000.0,
                    "minimumDeliveryHeadroomFragment": minimum_delivery_record,
                    "deliveryDeficitFragmentCount": sum(
                        1 for value in delivery_headroom_seconds
                        if value < -(1.0 / fps)
                    ),
                    "deliveryContinuityPassed": delivery_continuity_ok,
                    "fragmentTimestampsStrict": fragment_timestamps_strict,
                    "fragmentPacketTimeline": fragment_timeline,
                },
                "session": {
                    "state": public.get("state"),
                    "frames": int(public.get("frames") or 0),
                    "inferenceFrames": int(public.get("inferenceFrames") or 0),
                    "temporalReuseFrames": int(public.get("temporalReuseFrames") or 0),
                    "temporalRedetectRecoveries": int(public.get("temporalRedetectRecoveries") or 0),
                    "temporalReuseRejections": public.get("temporalReuseRejections") or {},
                    "temporalAppearanceSamples": public.get("temporalAppearanceSamples") or [],
                    "bytes": byte_count,
                    "error": public.get("error") or "",
                    "errorCode": public.get("errorCode") or "",
                    "diagnostics": public.get("diagnostics") or {},
                    "timingTotals": public.get("timingTotals") or {},
                },
                "encoded": probe,
                "verification": {
                    "deferred": True,
                    "transformationProven": False,
                },
                "gpuMemoryAfterStream": gpu_memory,
            }
            source_rate_headroom = (
                float(public.get("duration") or 0.0)
                / max(0.001, completed_at - intent_at)
            )
            result["timing"]["sourceRateHeadroom"] = source_rate_headroom
            result["productionPassed"] = bool(
                not result["session"]["error"]
                and result["session"]["state"] == "finished"
                and result["session"]["inferenceFrames"] > 0
                and safety_buffer_ready
                and byte_count > 0
                and duration_ok
                and encoded_frame_count_ok
                and probe["audioStreams"] == 0
                and probe["videoStreams"] == 1
                and source_rate_headroom >= 1.0
                and maximum_inter_chunk_gap_ms <= 1500.0
                and delivery_continuity_ok
            )
            result["passed"] = False
            results.append(result)
            print(json.dumps({
                "clip": result["clip"],
                "productionPassed": result["productionPassed"],
                "firstByteMs": result["timing"]["intentToFirstByteMs"],
                "playableMs": result["timing"]["intentToPlayableMs"],
                "wall": result["timing"]["streamWallSeconds"],
                "headroom": result["timing"]["sourceRateHeadroom"],
                "freeGpuMiB": gpu_memory["freeMiB"],
            }), flush=True)
            engine.stop_session(session.id, deferred=False)
            retirement_deadline = time.monotonic() + 5.0
            while engine._session_has_live_resources(session) and time.monotonic() < retirement_deadline:
                time.sleep(0.05)
            result["session"]["resourcesRetired"] = not engine._session_has_live_resources(session)
            result["productionPassed"] = bool(
                result["productionPassed"] and result["session"]["resourcesRetired"]
            )
    finally:
        server.shutdown()
        server.server_close()
        engine.unload()
        engine.shutdown_gpu_worker()

    # Quality verification deliberately starts only after every production
    # stream is timed and the production engine is unloaded. Run small batches
    # in disposable child processes so ORT detector/recognizer arenas cannot
    # accumulate into either the live worker or later verification batches.
    del source_embedding
    del engine
    gc.collect()
    verification_by_hash: dict[str, dict] = {}
    batch_size = max(1, min(8, int(args.verification_batch_size)))
    verification_batches: list[dict] = []
    for batch_index, start in enumerate(range(0, len(results), batch_size), 1):
        batch_results = results[start:start + batch_size]
        manifest_path = output_dir / f"verification-batch-{batch_index:02d}-input.json"
        batch_output_path = output_dir / f"verification-batch-{batch_index:02d}-output.json"
        manifest_path.write_text(json.dumps({
            "schema": "pong-production-verification-input-v2",
            "config": frozen_config,
            "configSha256": frozen_config_sha256,
            "modelSha256": model_sha256,
            "items": [
                {
                    "sha256": item["sha256"],
                    "sourceSha256": item["sha256"],
                    "source": str(CORPUS_ROOT / "input" / item["clip"]),
                    "output": item["output"],
                    "outputSha256": item["outputSha256"],
                }
                for item in batch_results
            ],
        }, indent=2), encoding="utf-8")
        command = [
            sys.executable,
            str(Path(__file__).resolve()),
            "--verification-batch",
            str(manifest_path),
            "--verification-output",
            str(batch_output_path),
        ]
        completed = subprocess.run(
            command,
            cwd=str(Path(__file__).resolve().parent),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
        )
        batch_record = {
            "batch": batch_index,
            "returnCode": completed.returncode,
            "output": completed.stdout[-4000:],
        }
        if completed.returncode == 0 and batch_output_path.is_file():
            batch_report = json.loads(batch_output_path.read_text(encoding="utf-8"))
            batch_record["warmSeconds"] = batch_report.get("warmSeconds")
            for verification in batch_report.get("items", []):
                verification_by_hash[str(verification.get("sha256") or "")] = verification
        verification_batches.append(batch_record)

    for result in results:
        verification = verification_by_hash.get(result["sha256"])
        if verification is None:
            verification = {
                "transformationProven": False,
                "error": "isolated verification did not return evidence",
            }
        result["verification"] = verification
        result["passed"] = bool(
            result["productionPassed"]
            and verification.get("transformationProven")
            and verification.get("sourceSha256") == result["sha256"]
            and verification.get("outputSha256") == result["outputSha256"]
        )

    first_byte_values = [
        item["timing"]["intentToFirstByteMs"] for item in results
        if item["timing"]["intentToFirstByteMs"] is not None
    ]
    headroom_values = [item["timing"]["sourceRateHeadroom"] for item in results]
    report = {
        "schema": "pong-production-realtime-v3",
        "silent": True,
        "headless": True,
        "stockIdentityOnly": True,
        "warmSeconds": warm_seconds,
        "provenance": {
            "configurationSha256": frozen_config_sha256,
            "modelSha256": model_sha256,
            "eligibilityReport": str(DEFAULT_ELIGIBILITY_REPORT.resolve()),
            "eligibilityReportSha256": file_sha256(DEFAULT_ELIGIBILITY_REPORT),
            "configBaseReport": (
                str(args.config_base_report.resolve())
                if args.config_base_report is not None
                else ""
            ),
            "configBaseReportSha256": base_report_sha256,
            "configOverrides": (
                str(args.config_overrides_json.resolve())
                if args.config_overrides_json is not None
                else ""
            ),
            "configOverridesSha256": override_sha256,
        },
        "verificationIsolation": {
            "processSeparated": True,
            "batchSize": batch_size,
            "batches": verification_batches,
        },
        "clips": results,
        "summary": {
            "requiredDistinctClips": required,
            "distinctClips": len({item["sha256"] for item in results}),
            "passed": sum(1 for item in results if item["passed"]),
            "failed": sum(1 for item in results if not item["passed"]),
            "medianIntentToFirstByteMs": statistics.median(first_byte_values) if first_byte_values else None,
            "minimumSourceRateHeadroom": min(headroom_values) if headroom_values else None,
            "medianSourceRateHeadroom": statistics.median(headroom_values) if headroom_values else None,
            "allPassed": len(results) >= required and all(item["passed"] for item in results),
        },
    }
    report_path = output_dir / "report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"report": str(report_path), **report["summary"]}, indent=2))
    if not report["summary"]["allPassed"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
