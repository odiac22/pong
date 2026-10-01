"""Offline, opt-in cold full-path preflight for an approved cached face frame.

This is a diagnostic experiment, not a service hook.  It never creates a
session or changes a preset.  The caller must supply a licensed/cached RGB
frame and its approved source embedding, then run this only on an otherwise
idle, already-qualified engine's GPU owner thread.  The output is discarded.

The preflight uses *fresh* tracking and temporal state.  It can initialize
lazy fixed-shape kernels/graphs on the actual VM, but it cannot promise hits
for shape-dependent graphs in later videos.  Test cold latency and later
pixel/temporal parity in separate, identically configured processes.
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import threading
import time
from typing import Any

import numpy as np
from pong_tiktok_restorer import PROFILE, session_config_for_profile


def _validate_inputs(engine: Any, frame: np.ndarray, embedding: np.ndarray,
                     config: dict[str, Any]) -> None:
    if threading.get_ident() != getattr(engine, "_gpu_worker_ident", None):
        raise RuntimeError("Preflight requires the engine GPU owner thread")
    if getattr(engine, "_vm", None) is None or getattr(engine, "_models", None) is None:
        raise RuntimeError("Preflight requires an already-warm engine")
    if engine._active_session_count() != 0:
        raise RuntimeError("Preflight requires zero active sessions")
    if config != session_config_for_profile(engine._config, PROFILE):
        raise RuntimeError("Preflight config differs from the TikTok session profile")
    if engine._pipeline_signature(config) != engine._pipeline_warm_signature:
        raise RuntimeError("Preflight pipeline signature is not warm")
    params = config.get("parameters", {})
    if not params.get("RestorerSwitch"):
        raise RuntimeError("Preflight requires restoration enabled")
    if config.get("runtime", {}).get("tiktokRestorerProfile") != PROFILE:
        raise RuntimeError("Preflight requires the TikTok face-size profile")
    if (not isinstance(frame, np.ndarray) or frame.dtype != np.uint8
            or frame.ndim != 3 or frame.shape[2] != 3
            or min(frame.shape[:2]) < 128 or not frame.flags.c_contiguous):
        raise ValueError("Expected contiguous RGB uint8 HWC frame")
    if (not isinstance(embedding, np.ndarray) or embedding.dtype != np.float32
            or embedding.shape != (512,) or not np.isfinite(embedding).all()):
        raise ValueError("Expected finite float32 approved 512-D embedding")


def _fence_side_work(vm: Any) -> None:
    """Include side-mask work in cold timing before admitting a real session."""
    state = getattr(vm, "_isolated_mask_overlap", None)
    if not isinstance(state, dict):
        return
    entries = [state.get("pending"), state.get("guardPending")]
    entries.extend(state.get("retired") or ())
    for entry in entries:
        if isinstance(entry, dict):
            future = entry.get("future")
            if future is not None:
                future.result()
    stream = state.get("stream")
    if stream is not None:
        stream.synchronize()


def run_on_owner(engine: Any, frame: np.ndarray, embedding: np.ndarray,
                 config: dict[str, Any]) -> dict[str, Any]:
    """Run one discard-only first-anchor frame; never use its output in UI.

    The engine lock serializes this with model operations.  A standalone
    benchmark must still prevent new service admissions around the call; the
    two zero-session checks are safeguards, not a service admission barrier.
    """
    _validate_inputs(engine, frame, embedding, config)
    from pong_swap_engine import build_temporal_restorer_context

    effective = deepcopy(config)
    runtime = effective["runtime"]
    context = build_temporal_restorer_context(
        runtime,
        enabled=bool(runtime.get("adaptiveRestorer", False)),
    )
    context.update(
        frameIndex=0, mediaTimeSeconds=0.0,
        nominalFrameSeconds=1.0 / 30.0,
        frameDependencyAnchorFrame=0,
        frameDependencyAnchorTimeSeconds=0.0,
        frameHadStageReuse=False,
        maxAnchorFrames=1,
        forceExact=True,
        forceExactReasons=["identity-deadline"],
    )
    tracking: dict[str, Any] = {}
    diagnostics: dict[str, list[float]] = {}
    started = time.perf_counter()
    with engine._lock:
        _validate_inputs(engine, frame, embedding, config)
        vm = engine._vm
        prior_parameters = vm.parameters
        prior_color_graph = getattr(vm, "color_match_cuda_graph_enabled", None)
        try:
            output, _anchor = engine.process_frame(
                frame, embedding, None, verify_identity=True,
                tracking_state=tracking, config=effective,
                diagnostics=diagnostics, temporal_context=context,
            )
            if output is None:
                raise RuntimeError("Preflight produced no frame")
            if vm.parameters.get("RestorerTypeTextSel") != "GPEN512":
                raise RuntimeError("Approved frame selected a different restorer")
            # The owned stream must finish before the temporary frame can be
            # released; this also makes the reported wall time honest.
            pixels = output.cpu().numpy()
            _fence_side_work(vm)
        finally:
            vm.parameters = prior_parameters
            vm.color_match_cuda_graph_enabled = prior_color_graph
    if engine._active_session_count() != 0:
        raise RuntimeError("A session was admitted during offline preflight")
    if "cuda_swap_preRestorer_to_postRestorerMs" not in diagnostics:
        raise RuntimeError("Approved frame did not reach the restorer path")
    if vm.parameters is not prior_parameters:
        raise AssertionError("VM parameters were not restored")
    return {
        "elapsedMs": (time.perf_counter() - started) * 1000.0,
        "frameSha256": hashlib.sha256(frame.tobytes()).hexdigest(),
        "embeddingSha256": hashlib.sha256(embedding.tobytes()).hexdigest(),
        "outputSha256": hashlib.sha256(pixels.tobytes()).hexdigest(),
        "outputShape": list(pixels.shape),
        "restorerCudaMs": diagnostics["cuda_swap_preRestorer_to_postRestorerMs"][0],
        "trackingKeys": sorted(tracking),
        "temporalKeys": sorted(context),
        "diagnostics": {key: list(value) for key, value in diagnostics.items()
                        if key.endswith("Ms")},
    }
