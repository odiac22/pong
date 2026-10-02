from __future__ import annotations

import base64
import json
import mimetypes
import os
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit
from urllib.request import ProxyHandler, Request as UrlRequest, build_opener

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from PIL import Image, ImageOps
from pydantic import BaseModel, Field, StrictStr, model_validator
from starlette.concurrency import run_in_threadpool

from pong_swap_config import ROOT, default_config, parameter_schema
from pong_swap_engine import ENGINE, ConfigUpdateConflict, StaleActivationError
from pong_swap_remote import MAX_FRAME_BYTES, RemoteSessionError, RemoteSessionManager, authorized_loopback
from pong_multi_face import MAX_MULTI_FACES
from pong_profile_warmup import ProfileWarmup
from pong_activity_warmth import ActivityWarmth
from pong_playback_credit import PlaybackSessionStopped, apply_ordered_playback
from pong_external_playback_lease import ExternalPlaybackLeases
from pong_remote_gateway import create_remote_gateway
from pong_prefetch_boost import PrefetchBoost
from pong_face_roster import display_name


SERVICE_VERSION = "30.38.6"
app = FastAPI(title="Pong Swap", version=SERVICE_VERSION, docs_url=None, redoc_url=None)
app.include_router(create_remote_gateway(ROOT / "cache" / "tiktok-remote-pairing-token"))
SOURCE_OPEN_DIAGNOSTICS_ENABLED = os.environ.get('PONG_SOURCE_OPEN_DIAGNOSTICS') == '1'
if SOURCE_OPEN_DIAGNOSTICS_ENABLED:
    from experiment_tiktok_source_open_trace import (
        SourceOpenSampler, authorized_source_open_request, source_identity,
    )
    SOURCE_OPEN_SAMPLER = SourceOpenSampler()
else:
    SOURCE_OPEN_SAMPLER = None


def _source_open_cache_snapshot(source_url: str) -> dict[str, Any] | None:
    """Read one opt-in helper record without touching its idle heartbeat."""
    if not SOURCE_OPEN_DIAGNOSTICS_ENABLED:
        return None
    cache_id = source_identity(source_url)['cacheId']
    if not cache_id:
        return None
    try:
        port = int(os.environ.get('PONG_LOCAL_AI_PORT', '8787'))
        if port < 1 or port > 65535:
            return None
        opener = build_opener(ProxyHandler({}))
        request = UrlRequest(
            f'http://127.0.0.1:{port}/video-cache/diagnostics/record?id={cache_id}',
            headers={'Accept': 'application/json'},
        )
        with opener.open(request, timeout=0.20) as response:
            if response.status != 200:
                return None
            body = response.read(2049)
        if len(body) > 2048:
            return None
        result = json.loads(body)
        return result.get('record') if isinstance(result, dict) and isinstance(result.get('record'), dict) else None
    except (OSError, ValueError, TypeError):
        return None
FACE_THUMBNAIL_DIR = ROOT / "cache" / "face-thumbnails-v1"
FACE_THUMBNAIL_LOCK = threading.RLock()
FACE_THUMBNAIL_DATA_URLS: dict[str, str] = {}


def _engine_source_url(raw_url: str) -> str:
    """Translate Android-emulator host aliases for the PC-side decoder.

    A WebView reaches the host PC as ``10.0.2.2`` (or Genymotion's
    ``10.0.3.2``), but the face-swap engine runs on that PC and cannot route
    those guest-only aliases back to Pong's media cache.  Rewrite only Pong's
    known local media endpoints; external URLs and arbitrary emulator-host
    paths are deliberately left untouched.
    """
    value = str(raw_url or "").strip()
    if not value:
        return value
    try:
        parsed = urlsplit(value)
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    except ValueError:
        return value
    path = parsed.path.rstrip("/") or "/"
    local_media_path = (
        path == "/video-cache/stream"
        or path == "/proxy"
        or path.startswith("/media-browser-relay/stream/")
    )
    if (
        parsed.scheme.lower() in {"http", "https"}
        and (parsed.hostname or "").lower() in {"10.0.2.2", "10.0.3.2"}
        and port == 8787
        and local_media_path
    ):
        return urlunsplit(("http", "127.0.0.1:8787", parsed.path, parsed.query, parsed.fragment))
    return value

# Engine modules are also imported by offline benchmarks. Keep destructive cache
# maintenance at service startup so a benchmark cannot disturb a live stream.
ENGINE.cleanup_orphan_spools()
REMOTE_SESSIONS = RemoteSessionManager(ENGINE)
EXTERNAL_PLAYBACK_LEASES = ExternalPlaybackLeases()
TIKTOK_PROFILE_WARMUP = ProfileWarmup(ENGINE, qualified=True)
ACTIVITY_WARMTH = ActivityWarmth(ENGINE)
PREFETCH_BOOST = PrefetchBoost(ENGINE)
REMOTE_TOKEN_PATH = ROOT / "cache" / "remote-bridge-token"
REMOTE_FULL_PATH_WARMUP_ENABLED = os.environ.get("PONG_REMOTE_FULL_PATH_WARMUP") == "1"
REMOTE_FULL_PATH_WARMUP_STATUS: dict[str, int | float | bool] = {"enabled": REMOTE_FULL_PATH_WARMUP_ENABLED,
                                                                "ready": False}
APPROVED_STARTUP_STATUS: dict[str, Any] = {"enabled": False, "ready": False}


def _startup_remote_full_path_preflight() -> None:
    """Opt-in discard-only render, completed before ASGI request admission."""
    global REMOTE_FULL_PATH_WARMUP_STATUS
    from pong_remote_full_path_warmup import warm_and_run_at_startup

    began = time.perf_counter()
    try:
        result = warm_and_run_at_startup(ENGINE, remote_manager=REMOTE_SESSIONS)
        REMOTE_FULL_PATH_WARMUP_STATUS = {
            "enabled": True, "ready": bool(result["primedContexts"]),
            **result,
        }
    except Exception:
        # Trial failures must not make ordinary service startup or the saved
        # quality path unavailable. No exception details, face IDs or pixels
        # enter health; a subsequent normal warm retains baseline behavior.
        REMOTE_FULL_PATH_WARMUP_STATUS = {
            "enabled": True, "ready": False,
            "elapsedMs": round((time.perf_counter() - began) * 1000.0, 3),
        }


def _startup_warm() -> None:
    """Build/load the selected TensorRT graph before the first face tap.

    The service is itself launched on demand and idles out, so doing this once
    per service lifetime does not leave the GPU resident indefinitely.  It does
    move the unavoidable cold graph load ahead of the user's selection instead
    of serializing it with the first visible swapped frame.
    """
    warm = getattr(ENGINE, "warm", None)
    if not callable(warm):
        return
    try:
        warm()
        _startup_prime_approved_identities()
    except Exception:
        # ENGINE.health() already exposes the runtime's lastError. Keep the API
        # reachable so the UI can report/fallback instead of crashing startup.
        pass


def _startup_prime_approved_identities() -> None:
    """Use the engine's existing cancelable, foreground-yielding primer."""
    prime = getattr(ENGINE, "prime_embeddings_async", None)
    if callable(prime):
        prime(delay_seconds=0.0)


def _idle_unload_loop() -> None:
    while True:
        time.sleep(30)
        REMOTE_SESSIONS.prune_idle()
        ENGINE.prune_prefetch_sessions(60)
        idle_limit = max(60, int(ENGINE.config["runtime"].get("idleUnloadSeconds", 900)))
        health = ENGINE.health()
        if not health["ready"] or health["activeSessions"] or ACTIVITY_WARMTH.active():
            continue
        last_used = float(getattr(ENGINE, "_last_used", 0.0) or 0.0)
        if last_used and time.time() - last_used >= idle_limit:
            try:
                ENGINE.unload()
            except ConfigUpdateConflict:
                # A concurrent model transition owns admission. Retry next
                # interval rather than losing idle maintenance permanently.
                continue


_SERVICE_WORKERS_LOCK = threading.Lock()
_SERVICE_WORKERS_STARTED = False


def _external_playback_lease_loop() -> None:
    while True:
        time.sleep(0.5)
        EXTERNAL_PLAYBACK_LEASES.sweep(
            lambda session_id: ENGINE.stop_session(session_id, deferred=True))


_RENDERER_LOCK_HANDLE = None


def _hold_single_renderer_lock() -> None:
    """One renderer per port. A model switch respawns this process while the
    helper may also spawn one; two concurrent GPU startups hung the winner
    (2026-10-02). The loser exits here, before any model loads or the port
    is bound. The lock is released by the OS when the holder exits."""
    global _RENDERER_LOCK_HANDLE
    port = os.environ.get("PONG_SWAP_PORT", "8792")
    path = Path(__file__).resolve().parent / "logs" / f"renderer-{port}.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+b")
    try:
        if os.name == "nt":
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print(f"[pong-swap] another renderer owns port {port}; exiting", flush=True)
        os._exit(0)
    _RENDERER_LOCK_HANDLE = handle


@app.on_event("startup")
def _start_service_workers() -> None:
    """Qualify the exact runtime before model threads or requests can enter.

    Expected qualification mismatches retain the original renderer and expose
    the fallback in health. An unexpected partial-install failure must abort
    startup, not launch workers against uncertain mixed implementations.
    """
    global _SERVICE_WORKERS_STARTED
    with _SERVICE_WORKERS_LOCK:
        if _SERVICE_WORKERS_STARTED:
            return
        _hold_single_renderer_lock()
        from pong_exact_runtime.service_adapter import bootstrap_cold

        bootstrap_cold(ENGINE)
        from pong_approved_startup import enabled, prepare
        if enabled(ENGINE.config):
            APPROVED_STARTUP_STATUS.update(enabled=True)
            try:
                APPROVED_STARTUP_STATUS.update(prepare(ENGINE))
            except Exception as exc:
                # Ordinary playback remains usable if an optional fixture is
                # unavailable. Never claim readiness or expose local identity.
                APPROVED_STARTUP_STATUS.update(ready=False, error=type(exc).__name__)
        if REMOTE_FULL_PATH_WARMUP_ENABLED and not APPROVED_STARTUP_STATUS['ready']:
            _startup_remote_full_path_preflight()
        # A successful trial already warmed the TikTok profile. Calling the
        # baseline warm now would replace its pipeline signature immediately
        # before the first raw frame. The identity primer remains unchanged.
        full_path_ready = bool(APPROVED_STARTUP_STATUS['ready'] or
                               (REMOTE_FULL_PATH_WARMUP_ENABLED and REMOTE_FULL_PATH_WARMUP_STATUS.get('ready')))
        startup_target = _startup_prime_approved_identities if full_path_ready else _startup_warm
        threading.Thread(target=startup_target, name="PongSwapStartupWarm", daemon=True).start()
        threading.Thread(target=_idle_unload_loop, name="PongSwapIdleUnload", daemon=True).start()
        threading.Thread(target=_external_playback_lease_loop, name="PongExternalPlaybackLease", daemon=True).start()
        PREFETCH_BOOST.start()
        _SERVICE_WORKERS_STARTED = True


class SessionRequest(BaseModel):
    channel: str = "pong1"
    sourceUrl: str
    sourceUrls: list[str] = Field(default_factory=list, max_length=2)
    faceId: str
    faceIds: list[str] = Field(default_factory=list, max_length=MAX_MULTI_FACES)
    startSeconds: float = Field(default=0.0, ge=0.0)
    prefetch: bool = False
    externalPlaybackClock: bool = False
    prebufferSeconds: float = Field(default=1.0, ge=0.25, le=5.0)
    # Profiling only (per-stage GPU timings in the session status).
    diagnosticsEnabled: bool = False
    navigationClass: str = "prefetch"
    restorationProfile: Literal["default", "tiktok-face-size", "tiktok-face-size-motion-trial", "tiktok-gpen512"] = "default"
    clientEpoch: str = Field(default="", max_length=96)
    activationSequence: int = Field(default=0, ge=0)
    targetX: float | None = Field(default=None, ge=0.0, le=1.0)
    targetY: float | None = Field(default=None, ge=0.0, le=1.0)
    targetEmbedding: list[float] = Field(default_factory=list, max_length=1024)
    targetPresentationLabel: str = Field(default="", max_length=16)
    targetPresentationConfidence: float = Field(default=0.0, ge=0.0, le=1.0)
    targetAppearance: list[float] = Field(default_factory=list, max_length=16)


class ActivationRequest(BaseModel):
    clientEpoch: str = Field(default="", max_length=96)
    activationSequence: int = Field(default=0, ge=0)


class PlaybackUpdateRequest(BaseModel):
    positionSeconds: float = Field(default=0.0, ge=0.0)
    paused: bool = False
    clientEpoch: str = Field(default="", max_length=96)
    playbackSequence: int = Field(default=0, ge=0, le=2147483647)


class SourcePreparationRequest(BaseModel):
    sourceUrl: str = Field(min_length=1, max_length=16384)


class FramePreviewRequest(BaseModel):
    sourceUrl: str
    faceId: str
    startSeconds: float = Field(default=0.0, ge=0.0)
    frameDataUrl: str = ""
    geometryOnly: bool = False


class DetectionFeedbackRequest(BaseModel):
    index: int = Field(ge=0, le=99)
    token: str = Field(min_length=32, max_length=32)


class MatchFeedbackRequest(DetectionFeedbackRequest):
    faceId: str = Field(min_length=1, max_length=160)


class FramePreviewRenderRequest(BaseModel):
    config: dict[str, Any]
    faceId: str | None = None
    targetX: float | None = Field(default=None, ge=0.0, le=1.0)
    targetY: float | None = Field(default=None, ge=0.0, le=1.0)


class RemoteSessionRequest(BaseModel):
    faceId: StrictStr = Field(min_length=1, max_length=256)
    faceIds: list[StrictStr] | None = Field(
        default=None, min_length=1, max_length=MAX_MULTI_FACES,
    )
    width: int = Field(ge=16, le=4096)
    height: int = Field(ge=16, le=4096)
    fps: float = Field(default=30.0, ge=1.0, le=120.0)
    restorationProfile: Literal["default", "tiktok-face-size"] = "default"

    @model_validator(mode="after")
    def validate_faces(self):
        if self.faceIds is not None and (
            self.faceId not in self.faceIds or len(set(self.faceIds)) != len(self.faceIds)
            or any(not value or len(value) > 256 for value in self.faceIds)
        ):
            raise ValueError("faceIds must be unique approved IDs including faceId")
        return self


class RemoteFaceRequest(BaseModel):
    faceId: str = Field(min_length=1, max_length=256)


def _remote_auth(request: Request) -> None:
    try:
        authorized_loopback(request, REMOTE_TOKEN_PATH)
    except RemoteSessionError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


@app.post("/remote-sessions")
def create_remote_session(request: Request, payload: RemoteSessionRequest) -> dict[str, Any]:
    _remote_auth(request)
    try:
        session = REMOTE_SESSIONS.create(
            payload.faceId, payload.width, payload.height, payload.fps,
            restoration_profile=payload.restorationProfile,
            face_ids=payload.faceIds,
        )
    except RemoteSessionError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc
    return {"ok": True, "session": session.public()}


@app.get("/remote-sessions/{session_id}")
def remote_session_status(request: Request, session_id: str) -> dict[str, Any]:
    _remote_auth(request)
    try:
        return {"ok": True, "session": REMOTE_SESSIONS.get(session_id).public()}
    except RemoteSessionError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


@app.patch("/remote-sessions/{session_id}")
def change_remote_face(request: Request, session_id: str, payload: RemoteFaceRequest) -> dict[str, Any]:
    _remote_auth(request)
    try:
        return {"ok": True, "session": REMOTE_SESSIONS.change_face(session_id, payload.faceId).public()}
    except RemoteSessionError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


@app.delete("/remote-sessions/{session_id}")
def delete_remote_session(request: Request, session_id: str) -> dict[str, Any]:
    _remote_auth(request)
    return {"ok": True, "deleted": REMOTE_SESSIONS.delete(session_id)}


@app.put("/remote-sessions/{session_id}/frame")
async def render_remote_frame(request: Request, session_id: str, seq: int,
                              cut: bool = False, timestampMs: float | None = None):
    _remote_auth(request)
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/octet-stream":
        raise HTTPException(415, "expected raw RGB application/octet-stream")
    try:
        session = REMOTE_SESSIONS.get(session_id)
        expected = session.width * session.height * 3
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > min(expected, MAX_FRAME_BYTES):
                raise HTTPException(413, "RGB frame exceeds session dimensions")
            body.extend(chunk)
        output, metadata = await run_in_threadpool(
            REMOTE_SESSIONS.render, session_id, seq, body,
            cut=cut, timestamp_ms=timestampMs,
        )
    except RemoteSessionError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc
    return Response(
        content=output,
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Pong-Remote-Seq": str(metadata["sequence"]),
            "X-Pong-Remote-Transformed": "1" if metadata["transformed"] else "0",
            "X-Pong-Remote-Reset": "1" if metadata["reset"] else "0",
            "X-Pong-Remote-Render-Ms": str(metadata["renderMs"]),
        },
    )


@app.get("/", response_class=HTMLResponse)
async def control_panel() -> str:
    return (ROOT / "control-panel.html").read_text(encoding="utf-8")


@app.get("/health")
def health() -> dict[str, Any]:
    # warm()/unload() hold the engine lifecycle lock. Run diagnostics in the
    # worker pool so a readiness request waiting on that lock cannot convoy the
    # ASGI loop and delay an unrelated session/stream request.
    result = {**ENGINE.health(), "serviceVersion": SERVICE_VERSION}
    result['approvedStartupPreparation'] = dict(APPROVED_STARTUP_STATUS)
    result['activityWarmth'] = ACTIVITY_WARMTH.snapshot()
    result['prefetchBoost'] = PREFETCH_BOOST.snapshot()
    if REMOTE_FULL_PATH_WARMUP_ENABLED:
        result["remoteFullPathWarmup"] = dict(REMOTE_FULL_PATH_WARMUP_STATUS)
    return result


@app.get('/diagnostics/source-open/{session_id}')
def source_open_diagnostic(request: Request, session_id: str,
                           include_cache: bool = True) -> dict[str, Any]:
    """Opt-in direct-loopback attribution; never expose source URLs or frames."""
    if SOURCE_OPEN_SAMPLER is None:
        raise HTTPException(404, 'diagnostic unavailable')
    host = getattr(getattr(request, 'client', None), 'host', None)
    if not authorized_source_open_request(
        host, session_id, enabled=True,
        proxied=request.headers.get('x-pong-proxy') == '1',
    ):
        raise HTTPException(404, 'diagnostic unavailable')
    try:
        session = ENGINE.session(session_id)
    except KeyError as exc:
        raise HTTPException(404, 'session not found') from exc
    runtime = (session.config or {}).get('runtime', {})
    if runtime.get('tiktokRestorerProfile') != 'tiktok-face-size':
        raise HTTPException(404, 'session not found')
    return {
        'ok': True,
        'diagnostic': SOURCE_OPEN_SAMPLER.sample(
            session, cache_state=(
                _source_open_cache_snapshot(session.source_url) if include_cache else None
            )
        ),
    }


class ActivityRequest(BaseModel):
    clientId: str = Field(min_length=8, max_length=80, pattern=r'^[a-zA-Z0-9_-]+$')
    visible: bool


@app.post("/activity")
def activity(payload: ActivityRequest) -> dict[str, Any]:
    # An explicit expiring UI lease, never inferred from health/status polling.
    return {"ok": True, **ACTIVITY_WARMTH.touch(payload.clientId, payload.visible)}


@app.post("/warm")
def warm(profile: Literal["default", "tiktok-face-size", "tiktok-gpen512"] = "default") -> dict[str, Any]:
    try:
        if profile in ("tiktok-face-size", "tiktok-gpen512"):
            # Optional entry-time work, not a fake ready receipt or a session.
            # The single-flight worker uses a copied profile through the normal
            # qualified GPU lifecycle and never updates the saved preset.
            return TIKTOK_PROFILE_WARMUP.request(profile).result(timeout=45)
        return ENGINE.warm()
    except ConfigUpdateConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, f"{type(exc).__name__}: {exc}") from exc


@app.post("/unload")
def unload() -> dict[str, Any]:
    try:
        ENGINE.unload()
    except ConfigUpdateConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    return ENGINE.health()


@app.get("/settings")
async def settings() -> dict[str, Any]:
    from pong_swap_config import load_config

    try:
        schema = parameter_schema()
        schema_error = ""
    except Exception as exc:
        # Settings must remain usable even if an optional Rope UI metadata
        # module changes shape. Runtime configuration is authoritative.
        schema = []
        schema_error = f"{type(exc).__name__}: {exc}"
    health = ENGINE.health()
    return {
        "ok": True,
        "config": ENGINE.config,
        "baselineConfig": load_config(),
        "defaultConfig": default_config(),
        "configRevision": health["configRevision"],
        "schema": schema,
        "schemaError": schema_error,
    }


@app.put("/settings")
def update_settings(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        config = ENGINE.update_config(payload, persist=True, backup=True)
        return {
            "ok": True,
            "config": config,
            "configRevision": ENGINE.health()["configRevision"],
        }
    except ConfigUpdateConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc


@app.put("/settings/preview")
def preview_settings(payload: dict[str, Any]) -> dict[str, Any]:
    """Apply a live, process-local preview without overwriting the baseline."""
    try:
        config = ENGINE.update_config(payload, persist=False)
        return {
            "ok": True,
            "config": config,
            "configRevision": ENGINE.health()["configRevision"],
            "persisted": False,
        }
    except ConfigUpdateConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc


SWAPPER_LABELS = {"128": "InSwapper 128", "HyperSwap1C": "HyperSwap 256",
                  "AlphaFace": "AlphaFace 256", "256": "InSwapper 256"}


@app.get("/swapper-model")
def get_swapper_model() -> dict[str, Any]:
    from pong_swap_config import PRODUCTION_SWAPPER_OPTIONS
    current = str(ENGINE.config["parameters"].get("SwapperTypeTextSel", "128"))
    return {"ok": True, "model": current, "label": SWAPPER_LABELS.get(current, current),
            "options": [{"model": m, "label": SWAPPER_LABELS.get(m, m)} for m in PRODUCTION_SWAPPER_OPTIONS],
            "ready": bool(ENGINE.health().get("ready"))}


@app.put("/swapper-model")
def set_swapper_model(payload: dict[str, Any]) -> dict[str, Any]:
    """Owner model trial: save the swapper and restart this renderer.

    A hot swapper change under exact acceleration crashed the CUDA context
    (bundle qualified for one model), so the choice is written to the preset
    and a replacement process starts with it. The replacement waits for this
    process to release the port; the helper proxy keeps serving the phone.
    """
    import subprocess
    import sys
    from pong_swap_config import PRODUCTION_SWAPPER_OPTIONS, save_config
    model = str(payload.get("model", ""))
    if model not in PRODUCTION_SWAPPER_OPTIONS:
        raise HTTPException(400, f"model must be one of {list(PRODUCTION_SWAPPER_OPTIONS)}")
    config = ENGINE.config
    if str(config["parameters"].get("SwapperTypeTextSel")) == model:
        return {"ok": True, "model": model, "label": SWAPPER_LABELS.get(model, model), "restarting": False}
    config["parameters"]["SwapperTypeTextSel"] = model
    save_config(config, backup=True)
    logs = Path(__file__).resolve().parent / "logs"
    env = {**os.environ, "PONG_SWAP_RESPAWN_WAIT": "1"}
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    with open(logs / "service-stdout.log", "ab") as out, open(logs / "service-stderr.log", "ab") as err:
        subprocess.Popen([sys.executable, str(Path(__file__).resolve())], cwd=str(Path(__file__).resolve().parent),
                         env=env, stdout=out, stderr=err, stdin=subprocess.DEVNULL, creationflags=flags)
    threading.Timer(0.5, lambda: os._exit(0)).start()
    return {"ok": True, "model": model, "label": SWAPPER_LABELS.get(model, model), "restarting": True}


@app.put("/prefetch-boost")
def tune_prefetch_boost(payload: dict[str, Any]) -> dict[str, Any]:
    """Process-local tuning of the next-video scheduler (not persisted)."""
    try:
        PREFETCH_BOOST.tune(**{key: payload[key] for key in
                               ("boost_frames", "min_foreground_lead", "share_headroom", "startup_frames") if key in payload})
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": True, "prefetchBoost": PREFETCH_BOOST.snapshot()}


@app.get("/faces")
def faces() -> dict[str, Any]:
    # Inventory refreshes stat/hash local files. Keep that work in FastAPI's
    # worker pool so an approved-face folder change cannot block health,
    # session registration, or an already-playing stream on the ASGI loop.
    result = []
    for public_face in ENGINE.faces_public():
        entry = dict(public_face)
        face_id = str(entry.get("id") or "")
        # Owner roster names (Ala, Lau, ...); IDs stay folder-derived.
        entry["name"] = display_name(face_id, str(entry.get("name") or ""))
        if face_id:
            try:
                # Android WebView normally permits only a small number of
                # HTTP/1.1 connections per origin. Eighteen independent image
                # requests can therefore queue the latency-sensitive session
                # POST behind cosmetic thumbnails. Content-addressed face ids
                # make these small cached derivatives safe to inline once in
                # the inventory response, eliminating that connection race.
                entry["thumbnailDataUrl"] = _face_thumbnail_data_url(face_id)
            except (KeyError, OSError, ValueError):
                # Keep the face option and its existing URL fallback even if a
                # damaged source image cannot produce an inline derivative.
                pass
        result.append(entry)
    return {"ok": True, "faces": result, "multiFaceMax": MAX_MULTI_FACES,
            "multiFacePolicy": "multi-face-feature-led-v1"}


@app.delete("/faces/{face_id}")
def delete_face(face_id: str) -> dict[str, Any]:
    """Permanently delete the exact approved identity selected in Pong."""
    try:
        deleted = ENGINE.delete_face(face_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    REMOTE_SESSIONS.purge_face(face_id)
    with FACE_THUMBNAIL_LOCK:
        FACE_THUMBNAIL_DATA_URLS.pop(face_id, None)
        try:
            (FACE_THUMBNAIL_DIR / f"{face_id}.jpg").unlink(missing_ok=True)
        except OSError:
            pass
    return {"ok": True, "deleted": deleted}


def _face_thumbnail_path(face_id: str) -> Path:
    face = ENGINE.face(face_id)
    FACE_THUMBNAIL_DIR.mkdir(parents=True, exist_ok=True)
    path = FACE_THUMBNAIL_DIR / f"{face.id}.jpg"
    with FACE_THUMBNAIL_LOCK:
        if path.is_file() and path.stat().st_size > 0:
            return path
        temporary = path.with_name(f"{path.name}.{threading.get_ident()}.tmp")
        try:
            with Image.open(face.thumbnail) as source:
                oriented = ImageOps.exif_transpose(source).convert("RGB")
                contained = ImageOps.contain(
                    oriented,
                    (128, 128),
                    method=Image.Resampling.LANCZOS,
                )
                thumbnail = Image.new("RGB", (128, 128), (12, 14, 20))
                thumbnail.paste(
                    contained,
                    ((128 - contained.width) // 2, (128 - contained.height) // 2),
                )
                thumbnail.save(
                    temporary,
                    format="JPEG",
                    quality=84,
                    optimize=True,
                    progressive=True,
                )
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    return path


def _face_thumbnail_data_url(face_id: str) -> str:
    with FACE_THUMBNAIL_LOCK:
        cached = FACE_THUMBNAIL_DATA_URLS.get(face_id)
        if cached:
            return cached
        path = _face_thumbnail_path(face_id)
        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
        value = f"data:image/jpeg;base64,{encoded}"
        FACE_THUMBNAIL_DATA_URLS[face_id] = value
        return value


@app.get("/faces/{face_id}/thumbnail")
def face_thumbnail(face_id: str):
    try:
        path = _face_thumbnail_path(face_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    # The picker renders these at 28 CSS pixels. Returning multi-megabyte
    # approved source photos made Android decode the entire face library before
    # it could dispatch the selected session. The face id already includes the
    # source-content digest, so this derivative is both immutable and safely
    # invalidated whenever an approved image changes.
    media_type = mimetypes.guess_type(path.name)[0] or "image/jpeg"
    # Face IDs include a digest of the approved image contents. The URL is
    # therefore immutable, and allowing the WebView to cache it prevents menu
    # reopenings from competing with the latency-sensitive session/stream
    # requests for the browser's small per-origin HTTP connection pool.
    return FileResponse(
        path,
        media_type=media_type,
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )


@app.get("/faces/{face_id}/source")
def face_source(face_id: str):
    """Return the selected approved source photo only when the editor asks for it."""
    try:
        path = ENGINE.face(face_id).thumbnail
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(
        path,
        media_type=media_type,
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )


@app.post("/frame-previews")
def create_frame_preview(payload: FramePreviewRequest) -> dict[str, Any]:
    """Decode one exact source frame for the non-destructive settings editor."""
    try:
        if payload.frameDataUrl:
            header, separator, body = payload.frameDataUrl.partition(",")
            if not separator or not header.lower().startswith("data:image/"):
                raise ValueError("frameDataUrl must be an encoded image")
            preview = ENGINE.create_frame_preview_from_encoded(
                encoded=base64.b64decode(body, validate=True),
                source_url=payload.sourceUrl,
                face_id=payload.faceId,
                start_seconds=payload.startSeconds,
                geometry_only=payload.geometryOnly,
            )
        else:
            if payload.geometryOnly:
                raise ValueError('Geometry-only detection requires a captured display frame')
            preview = ENGINE.create_frame_preview(
                source_url=_engine_source_url(payload.sourceUrl),
                face_id=payload.faceId,
                start_seconds=payload.startSeconds,
            )
    except (KeyError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, f"{type(exc).__name__}: {exc}") from exc
    return {"ok": True, "preview": preview.public()}


@app.put("/frame-previews/{preview_id}")
def render_frame_preview(preview_id: str, payload: FramePreviewRenderRequest):
    """Render one cached frame with temporary controls; never restart video."""
    try:
        encoded, media_type, elapsed_ms = ENGINE.render_frame_preview(
            preview_id,
            payload.config,
            payload.faceId,
            payload.targetX,
            payload.targetY,
        )
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ConfigUpdateConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        # Fixed-frame controls are interactive and the user-facing response is
        # intentionally concise. Preserve the complete server traceback so a
        # live Android failure can be diagnosed without guessing which nested
        # renderer state produced the exception.
        traceback.print_exc()
        raise HTTPException(500, f"{type(exc).__name__}: {exc}") from exc
    return Response(
        content=encoded,
        media_type=media_type,
        headers={
            "Cache-Control": "no-store",
            "X-Pong-Preview-Ms": f"{elapsed_ms:.1f}",
        },
    )


@app.get("/frame-previews/{preview_id}/original")
def original_frame_preview(preview_id: str):
    try:
        encoded, media_type = ENGINE.frame_preview_original(preview_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc
    return Response(content=encoded, media_type=media_type, headers={"Cache-Control": "no-store"})


@app.get("/frame-previews/{preview_id}/faces")
def detect_frame_preview_faces(preview_id: str) -> dict[str, Any]:
    """Detect tappable target faces without changing the frozen preview."""
    try:
        faces = ENGINE.frame_preview_faces(preview_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, f"{type(exc).__name__}: {exc}") from exc
    return {"ok": True, "faces": faces}


@app.delete("/frame-previews/{preview_id}")
def delete_frame_preview(preview_id: str) -> dict[str, Any]:
    return {"ok": True, "deleted": ENGINE.delete_frame_preview(preview_id)}


@app.post("/frame-previews/{preview_id}/confirm-face")
def confirm_detected_face(preview_id: str, payload: DetectionFeedbackRequest):
    try:
        return ENGINE.confirm_detected_face(preview_id, payload.index, payload.token)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/detection-learning")
def detection_learning():
    return ENGINE._detection_calibration.public()


@app.post("/frame-previews/{preview_id}/match-feedback")
def confirm_match_feedback(preview_id: str, payload: MatchFeedbackRequest):
    try:
        return ENGINE.confirm_match_feedback(preview_id, payload.index, payload.token, payload.faceId)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.delete("/detection-learning")
def reset_detection_learning():
    """Explicit reset; does not touch identity or visual-quality presets."""
    return ENGINE._detection_calibration.reset()


@app.post("/sessions")
def create_session(payload: SessionRequest) -> dict[str, Any]:
    # Session registration can briefly wait for a model/embedding inference
    # already in flight.  A synchronous FastAPI handler is dispatched through
    # its worker pool, keeping health, status and existing stream endpoints
    # responsive while the foreground-priority gate takes over from priming.
    try:
        session = ENGINE.create_session(
            diagnostics_enabled=payload.diagnosticsEnabled,
            channel=payload.channel,
            source_url=_engine_source_url(payload.sourceUrl),
            source_urls=[_engine_source_url(value) for value in payload.sourceUrls],
            face_id=payload.faceId,
            face_ids=payload.faceIds,
            start_seconds=payload.startSeconds,
            prefetch=payload.prefetch,
            prebuffer_seconds=payload.prebufferSeconds,
            navigation_class=payload.navigationClass,
            restoration_profile=payload.restorationProfile,
            client_epoch=payload.clientEpoch,
            activation_sequence=payload.activationSequence,
            manual_target_x=payload.targetX,
            manual_target_y=payload.targetY,
            manual_target_embedding=payload.targetEmbedding,
            manual_target_presentation_label=payload.targetPresentationLabel,
            manual_target_presentation_confidence=payload.targetPresentationConfidence,
            manual_target_appearance=payload.targetAppearance,
        )
    except (StaleActivationError, ConfigUpdateConflict) as exc:
        raise HTTPException(409, str(exc)) from exc
    except (KeyError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    if payload.externalPlaybackClock:
        EXTERNAL_PLAYBACK_LEASES.register(session)
    if SOURCE_OPEN_SAMPLER is not None and payload.restorationProfile == 'tiktok-face-size':
        SOURCE_OPEN_SAMPLER.mark_created(session, _source_open_cache_snapshot(session.source_url))
    return {
        "ok": True,
        "session": session.public(),
        "streamUrl": f"/pong-swap/sessions/{session.id}/stream",
    }


@app.get("/sessions")
async def list_sessions() -> dict[str, Any]:
    return {"ok": True, "sessions": ENGINE.sessions_public()}


@app.delete("/sessions")
def stop_all_sessions() -> dict[str, Any]:
    return {"ok": True, "stopped": ENGINE.stop_all_sessions()}


@app.get("/sessions/{session_id}")
async def session_status(session_id: str) -> dict[str, Any]:
    try:
        return {"ok": True, "session": ENGINE.session(session_id).public()}
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.get("/sessions/{session_id}/first-frame")
def session_first_frame(session_id: str, waitMs: int = 4000):
    """Return the exact first-frame bridge while the authoritative fMP4 decodes."""
    try:
        encoded, transformed = ENGINE.session_first_frame_webp(
            session_id,
            wait_seconds=max(0.0, min(8000, int(waitMs or 0))) / 1000.0,
        )
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    if not encoded:
        return Response(
            status_code=425,
            headers={"Cache-Control": "no-store", "Retry-After": "0.1"},
        )
    return Response(
        content=encoded,
        media_type="image/webp",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "X-Pong-Swap-Frame-Timeline": "exact",
            "X-Pong-Swap-Preview-Quality": "100",
            "X-Pong-Swap-Transformed": "1" if transformed else "0",
        },
    )


@app.post("/source/prepare")
def prepare_source(payload: SourcePreparationRequest) -> dict[str, Any]:
    return {"ok": True, **ENGINE.prepare_source(_engine_source_url(payload.sourceUrl))}


@app.delete("/sessions/{session_id}")
def stop_session(
    session_id: str,
    defer: bool = False,
    prefetchOnly: bool = False,
) -> dict[str, Any]:
    # Native decoder/encoder shutdown may block while Windows terminates
    # FFmpeg. Keep even an explicit synchronous stop in FastAPI's worker pool;
    # navigation cleanup uses defer=1 so /activate cannot queue behind it.
    try:
        session = ENGINE.session(session_id)
        # A browser cleanup scheduled while this was speculative can arrive
        # after a swipe has promoted the same session. Never let that stale
        # request delete the foreground stream now visible in TikTok/Pong.
        if prefetchOnly and (session.activation_requested or not session.prefetch):
            return {"ok": True, "stopped": False, "session": session.public()}
        return {
            "ok": True,
            "stopped": True,
            "session": ENGINE.stop_session(session_id, deferred=defer).public(),
        }
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.post("/sessions/{session_id}/activate")
async def activate_session(
    session_id: str,
    payload: ActivationRequest | None = None,
) -> dict[str, Any]:
    try:
        request = payload or ActivationRequest()
        return {
            "ok": True,
            "session": ENGINE.activate_session(
                session_id,
                client_epoch=request.clientEpoch,
                activation_sequence=request.activationSequence,
            ).public(),
        }
    except StaleActivationError as exc:
        raise HTTPException(409, str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.post("/sessions/{session_id}/suspend")
async def suspend_session(session_id: str) -> dict[str, Any]:
    try:
        return {"ok": True, "session": ENGINE.suspend_session(session_id).public()}
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.post("/sessions/{session_id}/resume")
async def resume_session(session_id: str) -> dict[str, Any]:
    try:
        return {"ok": True, "session": ENGINE.resume_session(session_id).public()}
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.post("/sessions/{session_id}/playback")
async def update_playback(
    session_id: str,
    payload: PlaybackUpdateRequest,
) -> dict[str, Any]:
    """Accept sparse, non-media browser position updates for production pacing."""
    try:
        if payload.clientEpoch or payload.playbackSequence:
            if not payload.clientEpoch or not payload.playbackSequence:
                raise HTTPException(400, "incomplete playback ordering")
            session = ENGINE.session(session_id)
            try:
                applied = apply_ordered_playback(
                    session,
                    client_epoch=payload.clientEpoch,
                    sequence=payload.playbackSequence,
                    position_seconds=payload.positionSeconds,
                    paused=payload.paused,
                )
            except PlaybackSessionStopped as exc:
                raise HTTPException(410, str(exc)) from exc
            except ValueError as exc:
                raise HTTPException(409, str(exc)) from exc
            return {"ok": True, "session": session.public(), "staleIgnored": not applied}
        session = ENGINE.update_playback(
            session_id, position_seconds=payload.positionSeconds, paused=payload.paused,
        )
        return {"ok": True, "session": session.public()}
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.get("/sessions/{session_id}/stream")
async def stream_session(session_id: str, request: Request):
    held_attachment = request.query_params.get("attach") == "1"
    finite_preload = request.query_params.get("preload") == "1" and not held_attachment
    activate = not held_attachment and not finite_preload
    try:
        ENGINE.session(session_id)
        # Activation used to happen lazily inside the response iterator, after
        # Starlette had already committed HTTP 200. A superseded swipe could
        # then raise StaleActivationError in the ASGI body task, producing a
        # truncated MP4 and a noisy 500 that the WebView interpreted as a live
        # stream failure/restart. Resolve ownership before response headers so
        # stale readers receive a deterministic conflict and no broken stream.
        if activate:
            try:
                activation_sequence = int(
                    request.query_params.get("activationSequence", "0") or 0
                )
            except (TypeError, ValueError):
                activation_sequence = 0
            ENGINE.activate_session(
                session_id,
                client_epoch=request.query_params.get("clientEpoch", ""),
                activation_sequence=max(0, activation_sequence),
            )
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except StaleActivationError as exc:
        raise HTTPException(409, str(exc)) from exc
    return StreamingResponse(
        ENGINE.stream_session(
            session_id,
            request.headers.get("range", ""),
            # `attach=1` opens the exact reader the WebView will later play.
            # It neither promotes the session nor closes at the prebuffer
            # watermark; POST /activate lets this same response continue.
            activate=False,
            finite_preload=finite_preload,
            media_source=request.query_params.get("transport") == "mse",
        ),
        media_type="video/mp4",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Accept-Ranges": "none",
            "X-Pong-Swap-Shared": "1",
            "X-Content-Type-Options": "nosniff",
        },
    )


if __name__ == "__main__":
    import os
    import uvicorn

    # Keep production on 8792 by default, but let isolated QA run a completely
    # separate service instead of falling back to (or interrupting) the live
    # phone backend when its proxy is configured with PONG_SWAP_PORT.
    service_port = int(os.environ.get("PONG_SWAP_PORT", "8792"))
    if os.environ.pop("PONG_SWAP_RESPAWN_WAIT", "") == "1":
        # Started by PUT /swapper-model: wait for the old renderer to exit.
        import socket
        import time as _time
        deadline = _time.monotonic() + 20
        while _time.monotonic() < deadline:
            with socket.socket() as probe:
                if probe.connect_ex(("127.0.0.1", service_port)) != 0:
                    break
            _time.sleep(0.25)
    uvicorn.run(app, host="127.0.0.1", port=service_port, log_level="info")
