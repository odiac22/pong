"""Opt-in, startup-only raw-frame preflight on an approved local portrait.

This is a diagnostic trial, not a quality or model setting. Run it before ASGI
starts admitting requests. All frame/identity/tracking data stay local and are
discarded; callers receive only numeric and boolean readiness information.
"""
from __future__ import annotations

from copy import deepcopy
import threading
import time
from typing import Any

import cv2
import numpy as np

from pong_swap_engine import build_temporal_restorer_context
from pong_tiktok_restorer import PROFILE, restorer_models, session_config_for_profile


PORTRAIT_WIDTH = 720
PORTRAIT_HEIGHT = 1280
MAX_PREFLIGHT_FRAMES = 2
MAX_PREFLIGHT_SECONDS = 10.0


class PreflightSkipped(RuntimeError):
    """Expected, nonfatal qualification or idle-state mismatch."""


def _portrait(image: np.ndarray, scale: float) -> np.ndarray:
    if (not isinstance(image, np.ndarray) or image.ndim != 3 or image.shape[2] != 3
            or image.dtype != np.uint8 or min(image.shape[:2]) < 16):
        raise PreflightSkipped("approved image was not a usable RGB portrait")
    height, width = image.shape[:2]
    # Different approved photographs can place the face at very different
    # scales. Two bounded geometry variants may exercise 512 and 1024, but
    # the real selector remains authoritative; never force a model choice.
    factor = min(PORTRAIT_WIDTH / width, PORTRAIT_HEIGHT / height) * scale
    target_w = max(16, int(round(width * factor)))
    target_h = max(16, int(round(height * factor)))
    resized = cv2.resize(image, (target_w, target_h), interpolation=cv2.INTER_LINEAR)
    output = np.zeros((PORTRAIT_HEIGHT, PORTRAIT_WIDTH, 3), dtype=np.uint8)
    crop_x = max(0, (target_w - PORTRAIT_WIDTH) // 2)
    crop_y = max(0, (target_h - PORTRAIT_HEIGHT) // 2)
    visible_w = min(PORTRAIT_WIDTH, target_w)
    visible_h = min(PORTRAIT_HEIGHT, target_h)
    left = (PORTRAIT_WIDTH - visible_w) // 2
    top = (PORTRAIT_HEIGHT - visible_h) // 2
    output[top:top + visible_h, left:left + visible_w] = resized[
        crop_y:crop_y + visible_h, crop_x:crop_x + visible_w,
    ]
    return output


def _idle_binding(engine: Any, config: dict[str, Any], revision: int,
                  vm: Any, models: Any, *, remote_manager: Any = None) -> None:
    if threading.get_ident() != getattr(engine, "_gpu_worker_ident", None):
        raise PreflightSkipped("GPU owner changed")
    if engine._active_session_count() != 0:
        raise PreflightSkipped("ordinary session admitted")
    if remote_manager is not None:
        with remote_manager._lock:
            if remote_manager._sessions or remote_manager._pending_creates:
                raise PreflightSkipped("remote session admitted")
    # Never take config_lock under the model lock: updates use config -> model.
    # Startup has closed admissions; the revision read is a conservative gate.
    if getattr(engine, "_config_revision", None) != revision:
        raise PreflightSkipped("config revision changed")
    if (engine._vm is not vm or engine._models is not models
            or engine._pipeline_signature(config) != engine._pipeline_warm_signature):
        raise PreflightSkipped("model binding changed")


def _fence_side_work(vm: Any) -> None:
    state = getattr(vm, "_isolated_mask_overlap", None)
    if not isinstance(state, dict):
        return
    pending = [state.get("pending"), state.get("guardPending"), *(state.get("retired") or ())]
    for entry in pending:
        if isinstance(entry, dict) and entry.get("future") is not None:
            entry["future"].result()
    stream = state.get("stream")
    if stream is not None:
        stream.synchronize()


def _run_on_owner(engine: Any, frames: tuple[np.ndarray, ...], embedding: np.ndarray,
                  source_frame: Any, config: dict[str, Any], revision: int,
                  vm: Any, models: Any, remote_manager: Any) -> dict[str, int | float | bool]:
    # Startup admission is closed, but retain the engine's lifecycle lock for
    # the entire disposable pass so an already-queued unload cannot replace the
    # VM between a frame and the restoration of its mutable parameters.
    with engine._lock:
        _idle_binding(engine, config, revision, vm, models, remote_manager=remote_manager)
        prior_parameters = vm.parameters
        prior_color_graph = getattr(vm, "color_match_cuda_graph_enabled", None)
        primed: set[str] = set()
        attempted = 0
        began = time.perf_counter()
        try:
            for frame in frames[:MAX_PREFLIGHT_FRAMES]:
                if attempted and time.perf_counter() - began >= MAX_PREFLIGHT_SECONDS:
                    break
                _idle_binding(engine, config, revision, vm, models, remote_manager=remote_manager)
                effective = deepcopy(config)
                runtime = effective["runtime"]
                context = build_temporal_restorer_context(
                    runtime,
                    enabled=bool(runtime.get("adaptiveRestorer", False)
                                 and effective["parameters"].get("RestorerSwitch", False)),
                )
                context.update(frameIndex=0, mediaTimeSeconds=0.0,
                               nominalFrameSeconds=1.0 / 30.0,
                               frameDependencyAnchorFrame=0,
                               frameDependencyAnchorTimeSeconds=0.0,
                               frameHadStageReuse=False, maxAnchorFrames=1,
                               forceExact=True,
                               forceExactReasons=["identity-deadline"])
                tracking: dict[str, Any] = {}
                output, _ = engine.process_frame(
                    frame, embedding, None, source_frame=source_frame,
                    verify_identity=True, tracking_state=tracking,
                    config=effective, temporal_context=context,
                )
                attempted += 1
                if output is not None:
                    # The normal remote path downloads output to CPU. Prime
                    # that transfer, then immediately discard synthetic pixels.
                    discarded = output.cpu().numpy()
                    del discarded, output
                _fence_side_work(vm)
                state = runtime.get("tiktokRestorerState") or {}
                selected = state.get("model")
                if selected in {"GPEN512", "GPEN1024"} and int(context.get("exactFrames", 0)) > 0:
                    primed.add(selected)
                _idle_binding(engine, config, revision, vm, models, remote_manager=remote_manager)
                if len(primed) == 2:
                    break
        finally:
            try:
                _fence_side_work(vm)
            finally:
                vm.parameters = prior_parameters
                vm.color_match_cuda_graph_enabled = prior_color_graph
    return {
        "attemptedFrames": attempted,
        "primedContexts": len(primed),
        "gpen512Primed": "GPEN512" in primed,
        "gpen1024Primed": "GPEN1024" in primed,
        "elapsedMs": round((time.perf_counter() - began) * 1000.0, 3),
    }


def run_startup_preflight(engine: Any, *, remote_manager: Any = None,
                          qualified: bool = False) -> dict[str, int | float | bool]:
    """Run at most two discard-only frames before ASGI startup completes.

    The caller must first perform ordinary qualified TikTok profile warmup.
    No GPU job is queued until image, config, binding and idle checks pass.
    Startup admission closure is the only guarantee that a new foreground
    request cannot arrive after those checks; do not call this from /warm.
    """
    if not qualified:
        raise PreflightSkipped("qualified exact runtime required")
    if engine._active_session_count() != 0:
        raise PreflightSkipped("ordinary session active")
    if remote_manager is not None:
        with remote_manager._lock:
            if remote_manager._sessions or remote_manager._pending_creates:
                raise PreflightSkipped("remote session active")
    baseline, revision = engine._config_snapshot()
    config = session_config_for_profile(baseline, PROFILE)
    if engine._model_lifecycle_changed(baseline, config):
        raise PreflightSkipped("profile would change model lifecycle")
    vm, models = getattr(engine, "_vm", None), getattr(engine, "_models", None)
    if vm is None or models is None or engine._pipeline_signature(config) != engine._pipeline_warm_signature:
        raise PreflightSkipped("profile models not warm")
    faces = tuple(sorted(getattr(engine, "_faces", {}).values(), key=lambda face: face.id))
    if not faces:
        raise PreflightSkipped("no approved local image")
    face = faces[0]
    image = None
    for path in face.files:
        bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if bgr is not None:
            image = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            break
    if image is None:
        raise PreflightSkipped("approved local image unreadable")
    frames = (_portrait(image, .80), _portrait(image, 1.25))
    embedding = np.asarray(engine.embedding_for_face(face.id, config), dtype=np.float32).reshape(-1)
    if embedding.shape != (512,) or not np.isfinite(embedding).all():
        raise PreflightSkipped("approved embedding unavailable")
    source_frame = engine.source_frame_for_face(face.id, config)
    if engine._config_snapshot()[1] != revision or engine._active_session_count() != 0:
        raise PreflightSkipped("state changed before preflight")
    # Startup runs before request admission. Background priority still keeps
    # this behind any GPU work already queued by the engine during warmup.
    return engine._run_gpu_work(
        _run_on_owner, engine, frames, embedding, source_frame, config, revision,
        vm, models, remote_manager, priority=2, work_label="remote-full-path-startup-preflight",
    )


def warm_and_run_at_startup(engine: Any, *, remote_manager: Any = None) -> dict[str, int | float | bool]:
    """Synchronous opt-in profile warm and disposable render before admission.

    This must be called from ASGI startup, not a request or background warmup.
    The configured preset is copied; neither the saved nor live config changes.
    """
    status = engine.health().get("exactAcceleration", {})
    if not status.get("acceleration", {}).get("installed"):
        raise PreflightSkipped("qualified exact runtime unavailable")
    if engine._active_session_count() != 0:
        raise PreflightSkipped("ordinary session active")
    baseline, revision = engine._config_snapshot()
    candidate = session_config_for_profile(baseline, PROFILE)
    if engine._model_lifecycle_changed(baseline, candidate):
        raise PreflightSkipped("profile would change model lifecycle")
    if engine._config_snapshot()[1] != revision:
        raise PreflightSkipped("configuration changed before profile warm")
    began = time.perf_counter()
    result = engine.warm(config=candidate, allow_create_selected=True)
    for model in restorer_models(candidate):
        if not result.get("restorers", {}).get(model.removeprefix("GPEN"), {}).get("ready"):
            raise PreflightSkipped("profile restorer unavailable")
    if not result.get("ready") or engine._config_snapshot()[1] != revision:
        raise PreflightSkipped("profile warm became stale")
    profile_warm_ms = round((time.perf_counter() - began) * 1000.0, 3)
    preflight = run_startup_preflight(engine, remote_manager=remote_manager, qualified=True)
    return {**preflight, "profileWarmMs": profile_warm_ms}
