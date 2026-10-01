"""Bounded raw-RGB remote sessions on the existing Pong Swap engine.

The caller owns capture, ROI selection, compositing and transport. This module
only receives a selected video crop and returns an equally sized RGB crop.
"""
from __future__ import annotations

import math
import os
import secrets
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from pong_swap_engine import FrameEvidence, build_temporal_restorer_context
from pong_swap_identity import CandidateIdentity
from pong_multi_face import MAX_MULTI_FACES
from pong_tiktok_restorer import restorer_models, session_config_for_profile


MAX_FRAME_BYTES = 16 * 1024 * 1024
MAX_SESSIONS = 2
IDLE_SECONDS = 120
MAX_FRAME_DIAGNOSTIC_RECORDS = 32


class RemoteSessionError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


class RemoteRestorerLeases:
    """Add raw-session requirements to the engine's existing residency query.

    The exact-acceleration engine source is frozen. This instance-local adapter
    keeps its original method intact and only unions live raw requirements.
    The engine's existing RLock guards ordinary sessions and the added leases.
    No restorer is changed, loaded, or unloaded by this adapter itself.
    """

    def __init__(self, engine: Any):
        self.engine = engine
        self._lock = engine._sessions_lock
        self._original = engine._session_restorers
        self._leases: dict[str, tuple[str, ...]] = {}
        engine._session_restorers = self.required

    def required(self, config: dict[str, Any]) -> tuple[str, ...]:
        with self._lock:
            ordinary = self._original(config)
            if not self._leases:
                return ordinary
            required = set(ordinary)
            for leased in self._leases.values():
                required.update(leased)
            return tuple(sorted(required))

    def acquire(self, lease_id: str, config: dict[str, Any]) -> None:
        required = tuple(restorer_models(config))
        with self._lock:
            if lease_id in self._leases:
                raise RuntimeError("remote restorer lease already exists")
            self._leases[lease_id] = required

    def release(self, lease_id: str) -> None:
        with self._lock:
            self._leases.pop(lease_id, None)


def authorized_loopback(request: Any, token_path: Path) -> None:
    """Require a service-private bearer and the direct loopback hop."""
    host = getattr(getattr(request, "client", None), "host", None)
    if host not in {"127.0.0.1", "::1"}:
        raise RemoteSessionError(403, "remote frame API requires loopback")
    try:
        expected = token_path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise RemoteSessionError(503, "remote frame API token is unavailable") from exc
    if len(expected) < 32:
        raise RemoteSessionError(503, "remote frame API token is invalid")
    header = request.headers.get("authorization", "")
    supplied = header[7:] if header.startswith("Bearer ") else ""
    if not secrets.compare_digest(supplied, expected):
        raise RemoteSessionError(401, "remote frame API token is invalid")


def _tracking_state(runtime: dict[str, Any], generation: int) -> dict[str, Any]:
    return {
        "trackGeneration": generation,
        "sharedLandmarkEstimator": bool(runtime.get("temporalDetectorLkFusionEnabled", False)),
        "disableLkSmoothing": bool(runtime.get("temporalDisableLkSmoothing", False)),
    }


def _temporal_context(config: dict[str, Any]) -> dict[str, Any]:
    runtime = config["runtime"]
    parameters = config["parameters"]
    return build_temporal_restorer_context(
        runtime,
        enabled=bool(
            runtime.get("adaptiveRestorer", False)
            and parameters.get("RestorerSwitch", False)
            and str(parameters.get("RestorerTypeTextSel", "")) in {"GPEN256", "GPEN512", "GPEN1024"}
        ),
    )


@dataclass
class RemoteSession:
    id: str
    face_id: str
    restoration_profile: str
    width: int
    height: int
    fps: float
    config: dict[str, Any]
    config_revision: int
    candidate: CandidateIdentity | None
    face_ids: tuple[str, ...] = ()
    candidates: tuple[CandidateIdentity, ...] = ()
    selected_face_id: str = ""
    frame_diagnostics_enabled: bool = False
    frame_diagnostics: list[dict[str, int | float | bool]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)
    cancel: threading.Event = field(default_factory=threading.Event)
    closed: bool = False
    last_sequence: int = -1
    frames: int = 0
    transformed_frames: int = 0
    resets: int = 0
    anchor: np.ndarray | None = None
    tracking: dict[str, Any] = field(default_factory=dict)
    temporal: dict[str, Any] = field(default_factory=dict)
    last_capture_ms: float | None = None
    first_capture_ms: float | None = None
    previous_sample: np.ndarray | None = None
    last_used: float = field(default_factory=time.monotonic)

    def public(self) -> dict[str, Any]:
        # select_restorer updates the profile's diagnostic state during render.
        # Snapshot it with the same per-session lock to avoid torn status data.
        with self.lock:
            result = {
                "id": self.id, "faceId": self.face_id,
                "faceIds": list(self.face_ids), "selectedFaceId": self.selected_face_id or None,
                "restorationProfile": self.restoration_profile,
                "restorerModels": list(restorer_models(self.config)),
                "adaptiveRestoration": dict(self.config.get("runtime", {}).get("tiktokRestorerState", {})),
                "width": self.width, "height": self.height, "fps": self.fps,
                "configRevision": self.config_revision,
                "lastSequence": self.last_sequence, "frames": self.frames,
                "transformedFrames": self.transformed_frames, "resets": self.resets,
                "identityLocked": self.anchor is not None, "closed": self.closed,
            }
            if self.frame_diagnostics_enabled:
                result["frameDiagnostics"] = {
                    "maxRecords": MAX_FRAME_DIAGNOSTIC_RECORDS,
                    "records": [dict(record) for record in self.frame_diagnostics],
                }
            return result

    def reset(self, reason: str) -> None:
        generation = int(self.tracking.get("trackGeneration", 0)) + 1
        # A new scene or approved face must not inherit the prior scene's
        # 512/1024 hysteresis, though cumulative diagnostics can remain.
        restorer_state = self.config["runtime"].get("tiktokRestorerState")
        if isinstance(restorer_state, dict):
            restorer_state.pop("model", None)
            restorer_state.pop("sourceFaceCropPixels", None)
        self.anchor = None
        self.tracking = _tracking_state(self.config["runtime"], generation)
        self.temporal = _temporal_context(self.config)
        self.temporal["forceExact"] = True
        self.temporal["lastInvalidationReason"] = reason
        self.temporal["pendingInvalidationReasons"] = [reason]
        self.previous_sample = None
        self.resets += 1


class RemoteSessionManager:
    def __init__(self, engine: Any):
        self.engine = engine
        with engine._config_lock:
            adapter = getattr(engine, "_remote_restorer_lease_adapter", None)
            if adapter is None:
                adapter = RemoteRestorerLeases(engine)
                engine._remote_restorer_lease_adapter = adapter
        self._restorer_leases = adapter
        self._lock = threading.Lock()
        self._sessions: dict[str, RemoteSession] = {}
        self._pending_creates = 0
        self._pending_face_sets: dict[str, tuple[str, ...]] = {}
        self._purged_pending: set[str] = set()
        self._pending_changes: dict[str, str] = {}
        self._purged_changes: set[str] = set()
        self._frame_diagnostics_enabled = os.environ.get("PONG_REMOTE_FRAME_DIAGNOSTICS") == "1"

    def _lease_snapshot(self, lease_id: str,
                        restoration_profile: str) -> tuple[dict[str, Any], int]:
        # The engine already uses this lease to prevent graph changes/unload
        # while a fixed-frame render owns model references. Extend that same
        # lifecycle contract across each continuous remote session.
        with self.engine._config_lock:
            base_config, revision = self.engine._config_snapshot()
            config = session_config_for_profile(base_config, restoration_profile)
            self._restorer_leases.acquire(lease_id, config)
            try:
                with self.engine._frame_previews_lock:
                    self.engine._frame_preview_render_leases += 1
            except Exception:
                self._restorer_leases.release(lease_id)
                raise
        return config, revision

    def _release_lease(self, lease_id: str) -> None:
        # Remove model requirements only after the raw render lock is released;
        # retain the existing lifecycle lease until that removal completes.
        self._restorer_leases.release(lease_id)
        with self.engine._frame_previews_lock:
            self.engine._frame_preview_render_leases = max(
                0, self.engine._frame_preview_render_leases - 1,
            )

    def _prepare_face(self, face_id: str, config: dict[str, Any], *, warm: bool = True) -> CandidateIdentity:
        self.engine.face(face_id)
        if warm:
            self.engine._run_gpu_work(
                self.engine.warm, config=config, allow_create_selected=True,
                priority=0, work_label="remote-session-warm",
            )
        with self.engine._foreground_embedding_priority():
            embedding = self.engine.embedding_for_face(face_id, config)
            source_frame = self.engine.source_frame_for_face(face_id, config)
            presentation = self.engine.presentation_for_face(face_id, config)
        return CandidateIdentity(
            face_id=face_id,
            embedding=np.asarray(embedding, dtype=np.float32),
            presentation=presentation,
            source_frame=source_frame,
        )

    def create(self, face_id: str, width: int, height: int, fps: float = 30.0,
               restoration_profile: str = "default",
               face_ids: list[str] | tuple[str, ...] | None = None) -> RemoteSession:
        if not face_id or len(face_id) > 256:
            raise RemoteSessionError(422, "an approved faceId is required")
        if face_ids is None:
            requested_faces = (face_id,)
        else:
            if (not isinstance(face_ids, (list, tuple)) or not 1 <= len(face_ids) <= MAX_MULTI_FACES
                    or any(not isinstance(value, str) or not value or len(value) > 256
                           for value in face_ids)
                    or len(set(face_ids)) != len(face_ids) or face_id not in face_ids):
                raise RemoteSessionError(422, "faceIds must be unique approved IDs including faceId")
            requested_faces = tuple(face_ids)
        if (type(width) is not int or type(height) is not int or width < 16 or height < 16
                or width > 4096 or height > 4096 or width * height * 3 > MAX_FRAME_BYTES):
            raise RemoteSessionError(422, "unsupported RGB crop dimensions")
        if not math.isfinite(fps) or not 1 <= fps <= 120:
            raise RemoteSessionError(422, "fps must be between 1 and 120")
        if restoration_profile not in {"default", "tiktok-face-size"}:
            raise RemoteSessionError(422, "unsupported remote restoration profile")
        self.prune_idle()
        lease_id = secrets.token_urlsafe(24)
        with self._lock:
            if len(self._sessions) + self._pending_creates >= MAX_SESSIONS:
                raise RemoteSessionError(429, "remote session limit reached")
            self._pending_creates += 1
            self._pending_face_sets[lease_id] = requested_faces
        leased = False
        published = False
        try:
            config, revision = self._lease_snapshot(lease_id, restoration_profile)
            leased = True
            candidates = tuple(
                self._prepare_face(candidate_id, config, warm=index == 0)
                for index, candidate_id in enumerate(requested_faces)
            )
            candidate = next(candidate for candidate in candidates if candidate.face_id == face_id)
            session = RemoteSession(
                id=lease_id, face_id=face_id,
                restoration_profile=restoration_profile,
                width=width, height=height, fps=float(fps),
                config=config, config_revision=revision, candidate=candidate,
                face_ids=requested_faces, candidates=candidates,
                frame_diagnostics_enabled=self._frame_diagnostics_enabled,
                tracking=_tracking_state(config["runtime"], 0),
                temporal=_temporal_context(config),
            )
            with self._lock:
                if lease_id in self._purged_pending:
                    raise RemoteSessionError(410, "approved face was removed during session creation")
                self._sessions[session.id] = session
            published = True
            return session
        except KeyError as exc:
            raise RemoteSessionError(404, "approved face was not found") from exc
        finally:
            with self._lock:
                self._pending_creates -= 1
                self._pending_face_sets.pop(lease_id, None)
                self._purged_pending.discard(lease_id)
            if leased and not published:
                self._release_lease(lease_id)

    def get(self, session_id: str) -> RemoteSession:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None or session.closed:
            raise RemoteSessionError(404, "remote session was not found")
        return session

    def change_face(self, session_id: str, face_id: str) -> RemoteSession:
        session = self.get(session_id)
        if not face_id or len(face_id) > 256:
            raise RemoteSessionError(422, "an approved faceId is required")
        if not session.lock.acquire(blocking=False):
            raise RemoteSessionError(429, "remote frame already in flight")
        registered = False
        try:
            if session.closed:
                raise RemoteSessionError(404, "remote session was not found")
            if face_id != session.face_id or session.face_ids != (face_id,):
                with self._lock:
                    if self._sessions.get(session_id) is not session or session.cancel.is_set():
                        raise RemoteSessionError(410, "remote session was stopped")
                    self._pending_changes[session_id] = face_id
                    registered = True
                candidate = self._prepare_face(face_id, session.config)
                with self._lock:
                    if (session_id in self._purged_changes
                            or self._sessions.get(session_id) is not session
                            or session.cancel.is_set()):
                        raise RemoteSessionError(410, "approved face was removed during face change")
                    session.candidate = candidate
                    session.candidates = (candidate,)
                    session.face_ids = (face_id,)
                    session.selected_face_id = ""
                    session.face_id = face_id
                session.reset("approved-face-change")
            session.last_used = time.monotonic()
            return session
        except KeyError as exc:
            raise RemoteSessionError(404, "approved face was not found") from exc
        finally:
            if registered:
                with self._lock:
                    self._pending_changes.pop(session_id, None)
                    self._purged_changes.discard(session_id)
            session.lock.release()

    def delete(self, session_id: str) -> bool:
        with self._lock:
            session = self._sessions.pop(session_id, None)
            self._pending_changes.pop(session_id, None)
            self._purged_changes.discard(session_id)
        if session is None:
            return False
        session.cancel.set()
        with session.lock:
            session.closed = True
            session.anchor = None
            session.tracking.clear()
            session.temporal.clear()
            session.previous_sample = None
            session.candidate = None
            session.candidates = ()
            session.selected_face_id = ""
            session.frame_diagnostics.clear()
        self._release_lease(session_id)
        return True

    def purge_face(self, face_id: str) -> int:
        """Retire raw sessions referencing an approved face after its deletion.

        Snapshot under the manager lock, then use normal delete outside it so an
        in-flight render can finish/cancel without holding the manager lock.
        """
        with self._lock:
            self._purged_pending.update(
                sid for sid, faces in self._pending_face_sets.items() if face_id in faces
            )
            self._purged_changes.update(
                sid for sid, changing_to in self._pending_changes.items()
                if changing_to == face_id
            )
            ids = [sid for sid, session in self._sessions.items()
                   if face_id in session.face_ids or sid in self._purged_changes]
        return sum(bool(self.delete(sid)) for sid in ids)

    def prune_idle(self) -> None:
        now = time.monotonic()
        with self._lock:
            expired = [sid for sid, s in self._sessions.items()
                       if now - s.last_used > IDLE_SECONDS and not s.lock.locked()]
        for sid in expired:
            self.delete(sid)

    def render(self, session_id: str, sequence: int, body: bytes,
               *, cut: bool = False, timestamp_ms: float | None = None) -> tuple[bytes, dict[str, Any]]:
        session = self.get(session_id)
        if type(sequence) is not int or not 0 <= sequence <= 2**53 - 1:
            raise RemoteSessionError(422, "invalid frame sequence")
        if len(body) != session.width * session.height * 3:
            raise RemoteSessionError(422, "RGB frame has wrong shape")
        if timestamp_ms is not None and (not math.isfinite(timestamp_ms) or timestamp_ms < 0):
            raise RemoteSessionError(422, "invalid capture timestamp")
        if not session.lock.acquire(blocking=False):
            raise RemoteSessionError(429, "remote frame already in flight")
        try:
            if session.closed:
                raise RemoteSessionError(404, "remote session was not found")
            if sequence <= session.last_sequence:
                raise RemoteSessionError(409, "stale frame sequence")
            if timestamp_ms is not None and session.last_capture_ms is not None and timestamp_ms <= session.last_capture_ms:
                raise RemoteSessionError(409, "stale capture timestamp")
            started = time.perf_counter()
            diagnostic_enabled = session.frame_diagnostics_enabled
            frame = np.frombuffer(body, dtype=np.uint8).reshape(session.height, session.width, 3)
            if not frame.flags.writeable:
                frame = frame.copy()
            sample = cv2.resize(frame, (32, 32), interpolation=cv2.INTER_AREA)
            runtime = session.config["runtime"]
            discontinuity = False
            if timestamp_ms is not None and session.last_capture_ms is not None:
                maximum_gap_ms = max(3500.0 / session.fps, 1000.0 * float(runtime.get("temporalMaxPtsGapSeconds", .25)))
                discontinuity = timestamp_ms - session.last_capture_ms > maximum_gap_ms
            pts_gap_ms = (
                timestamp_ms - session.last_capture_ms
                if diagnostic_enabled and timestamp_ms is not None and session.last_capture_ms is not None
                else 0.0
            )
            scene_cut = bool(session.previous_sample is not None and
                             np.mean(np.abs(sample.astype(np.int16) - session.previous_sample.astype(np.int16))) > 55)
            reset = bool(cut or discontinuity or scene_cut)
            if reset:
                session.reset("explicit-cut" if cut else "pts-discontinuity" if discontinuity else "scene-cut")
            frame_delta = (
                (timestamp_ms - session.last_capture_ms) / 1000.0
                if not reset and timestamp_ms is not None and session.last_capture_ms is not None
                else 1.0 / session.fps
            )
            session.last_sequence = sequence
            session.last_used = time.monotonic()
            if timestamp_ms is not None:
                if session.first_capture_ms is None or reset:
                    session.first_capture_ms = timestamp_ms
                session.last_capture_ms = timestamp_ms
                media_seconds = max(0.0, (timestamp_ms - session.first_capture_ms) / 1000.0)
            else:
                media_seconds = session.frames / session.fps
            session.tracking["frameDeltaSeconds"] = max(.001, frame_delta)
            index = session.frames
            evidence = FrameEvidence(
                frame_index=index, media_time_seconds=media_seconds,
                prior_track_revision=int(session.tracking.get("trackRevision", 0)),
            )
            temporal = session.temporal
            temporal["frameIndex"] = index
            temporal["mediaTimeSeconds"] = media_seconds
            temporal["nominalFrameSeconds"] = max(.001, frame_delta)
            temporal["frameDependencyAnchorFrame"] = index
            temporal["frameDependencyAnchorTimeSeconds"] = media_seconds
            temporal["frameHadStageReuse"] = False
            temporal["maxAnchorFrames"] = max(1, int(math.ceil(session.fps /
                max(.25, float(runtime.get("temporalRestorerAnchorHz", 3.0))))))
            identity_interval = min(
                max(1, int(runtime.get("identityCheckIntervalFrames", 12))),
                max(1, int(math.ceil(session.fps /
                    max(.25, float(runtime.get("temporalFullAnchorHz", 5.0)))))),
            )
            verify_identity = bool(index % identity_interval == 0 or reset)
            reasons = list(temporal.pop("pendingInvalidationReasons", []))
            if verify_identity:
                reasons.append("identity-deadline")
            temporal["forceExactReasons"] = list(dict.fromkeys(reasons))
            temporal["forceExact"] = bool(temporal["forceExactReasons"])
            force_exact_requested = bool(temporal["forceExact"]) if diagnostic_enabled else False
            force_reason_count = len(temporal["forceExactReasons"]) if diagnostic_enabled else 0
            selection_ms = 0.0
            acquisition_attempted = False
            processing_timing: dict[str, float] | None = {} if diagnostic_enabled else None
            exact_before = int(temporal.get("exactFrames", 0)) if diagnostic_enabled else 0
            reused_before = int(temporal.get("reusedFrames", 0)) if diagnostic_enabled else 0
            selection_accepted = False

            try:
                for candidate_id in session.face_ids:
                    self.engine.face(candidate_id)
                if session.anchor is None:
                    source_choices = (session.candidate,) if session.selected_face_id else session.candidates
                    acquisition_attempted = True
                    selection_started = time.perf_counter() if diagnostic_enabled else 0.0
                    selection = self.engine._run_gpu_work(
                        self.engine._select_compatible_identity_for_frame,
                        frame, source_choices, session.config, evidence,
                        session.cancel, None, priority=0,
                        queue_cancel_event=session.cancel,
                        work_label="remote-identity-compatibility",
                    )
                    if diagnostic_enabled:
                        selection_ms = (time.perf_counter() - selection_started) * 1000.0
                        selection_accepted = selection is not None
                    if selection is None:
                        output = bytes(body)
                        transformed = False
                    else:
                        selected_id = selection.candidate.face_id
                        selected_candidate = next((candidate for candidate in source_choices
                            if candidate.face_id == selected_id), None)
                        if selected_candidate is None:
                            raise RuntimeError("identity selection returned an unrequested face")
                        session.candidate = selected_candidate
                        session.selected_face_id = selected_id
                        session.anchor = np.asarray(selection.target.embedding, dtype=np.float32).reshape(-1).copy()
                        session.tracking["targetIdentityAnchor"] = session.anchor.copy()
                        session.tracking["targetIdentityGallery"] = [session.anchor.copy()]
                        session.tracking["targetPresentation"] = selection.target.presentation
                        session.tracking["sourcePresentation"] = selection.candidate.presentation
                        session.tracking["lastTargetVerifiedFrame"] = index
                        output, transformed = self._render_locked(
                            session, frame, evidence, True, processing_timing,
                        )
                else:
                    output, transformed = self._render_locked(
                        session, frame, evidence, verify_identity, processing_timing,
                    )
            except KeyError as exc:
                session.reset("approved-face-removed")
                raise RemoteSessionError(410, "approved face is no longer available") from exc
            except Exception:
                session.reset("render-error")
                raise
            session.frames += 1
            session.transformed_frames += int(transformed)
            session.previous_sample = sample
            total_ms = (time.perf_counter() - started) * 1000.0
            if diagnostic_enabled:
                record: dict[str, int | float | bool] = {
                    "frameIndex": index,
                    "firstFrame": index == 0,
                    "acquisitionAttempted": acquisition_attempted,
                    "selectionAccepted": selection_accepted,
                    "selectionMs": round(selection_ms, 3),
                    "processingMs": round((processing_timing or {}).get("processingMs", 0.0), 3),
                    "totalMs": round(total_ms, 3),
                    "hasCapturePts": timestamp_ms is not None,
                    "ptsGapMs": round(pts_gap_ms, 3),
                    "ptsDiscontinuity": discontinuity,
                    "explicitCut": bool(cut),
                    "sceneCut": scene_cut,
                    "reset": reset,
                    "identityVerification": verify_identity,
                    "temporalEnabled": bool(temporal.get("enabled")),
                    "forceExactRequested": force_exact_requested,
                    "forceExactReasonCount": force_reason_count,
                    "detectionAttempted": bool(evidence.detection_attempted),
                    "detections": len(evidence.detections),
                    "recognitionComplete": bool(evidence.recognition_complete),
                    "matchSelected": evidence.selected_target_embedding is not None,
                    "rejectionCount": len(evidence.rejection_reasons),
                    "lkAttempted": bool(evidence.lk_attempted),
                    "exactFrames": int(temporal.get("exactFrames", 0)),
                    "reusedFrames": int(temporal.get("reusedFrames", 0)),
                    "exactDelta": int(temporal.get("exactFrames", 0)) - exact_before,
                    "reuseDelta": int(temporal.get("reusedFrames", 0)) - reused_before,
                }
                session.frame_diagnostics.append(record)
                if len(session.frame_diagnostics) > MAX_FRAME_DIAGNOSTIC_RECORDS:
                    del session.frame_diagnostics[:-MAX_FRAME_DIAGNOSTIC_RECORDS]
            return output, {
                "sequence": sequence, "transformed": transformed, "reset": reset,
                "renderMs": round(total_ms, 3),
            }
        finally:
            session.lock.release()

    def _render_locked(self, session: RemoteSession, frame: np.ndarray,
                       evidence: FrameEvidence, verify_identity: bool,
                       processing_timing: dict[str, float] | None = None) -> tuple[bytes, bool]:
        if session.candidate is None:
            raise RemoteSessionError(410, "remote session was stopped")
        processing_started = time.perf_counter() if processing_timing is not None else 0.0
        output, anchor = self.engine._run_gpu_work(
            self.engine._process_frame_to_rgb,
            frame, session.candidate.embedding, session.anchor,
            priority=0, queue_cancel_event=session.cancel,
            cancelled_value=(None, session.anchor),
            work_label="remote-frame-render",
            source_frame=session.candidate.source_frame,
            verify_identity=verify_identity,
            tracking_state=session.tracking,
            cancel_event=session.cancel,
            config=session.config,
            temporal_context=session.temporal if session.temporal.get("enabled") else None,
            frame_evidence=evidence,
        )
        if output is None or session.cancel.is_set():
            raise RemoteSessionError(410, "remote session was stopped")
        if output.shape != frame.shape or output.dtype != np.uint8:
            raise RuntimeError("swap engine returned an invalid RGB frame")
        session.anchor = anchor
        output = np.ascontiguousarray(output)
        transformed = bool(np.any(output != frame))
        output_bytes = output.tobytes()
        if processing_timing is not None:
            processing_timing["processingMs"] = (time.perf_counter() - processing_started) * 1000.0
        return output_bytes, transformed
