"""Opt-in coordinator design for discard-only TikTok entry-time preflight.

Not installed by production. A future service hook may call ``request`` only
after ProfileWarmup has completed, with the currently selected approved face
ID. The call never waits for image preparation or GPU work. A missing selection
or embedding cache is a skip, not a reason to start GPU identity preparation.
"""

from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor
import hashlib
import threading
import weakref

import numpy as np

from experiment_tiktok_full_preflight import run_on_owner
from pong_tiktok_restorer import PROFILE, session_config_for_profile


def _done(value):
    result = Future()
    result.set_result(value)
    return result


def cached_approved_frame(engine, face_id: str, profile: dict, max_edge: int = 480):
    """Read one current catalog image and an already-cached embedding only."""
    import cv2

    with engine._lock:
        profile_key = engine._embedding_profile_key(profile)
        embedding = engine._embedding_cache.get((face_id, profile_key))
        if embedding is None:
            return None
        embedding = np.asarray(embedding, dtype=np.float32).copy()
    face = engine.face(face_id)
    for path in face.files:
        image = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if image is not None and min(image.shape[:2]) >= 128:
            break
    else:
        return None
    height, width = image.shape[:2]
    if max(height, width) > max_edge:
        scale = max_edge / max(height, width)
        image = cv2.resize(
            image, (max(128, round(width * scale)), max(128, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
    return np.ascontiguousarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB)), embedding


class FullPathPrimeCoordinator:
    def __init__(self, engine, *, frame_provider=cached_approved_frame,
                 prime=run_on_owner):
        self.engine = engine
        self.frame_provider = frame_provider
        self.prime = prime
        self._lock = threading.RLock()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="PongFullPrime")
        self._pending = {}
        self._completed = {}

    def request(self, face_id: str, warm_result: dict) -> Future:
        """Schedule after profile warm, never on the face-click critical path."""
        if not face_id or not warm_result.get("ready") or warm_result.get("profile") != PROFILE:
            return _done({"status": "skipped", "reason": "no-ready-selected-face"})
        revision = warm_result.get("configRevision")
        engine = self.engine
        with engine._config_lock:
            if engine._config_revision != revision or engine._vm is None:
                return _done({"status": "skipped", "reason": "generation-changed"})
            vm = engine._vm
        key = (id(vm), revision)
        with self._lock:
            completed = self._completed.get(key)
            if completed is not None and completed[0]() is vm:
                return _done(completed[1])
            pending = self._pending.get(key)
            if pending is not None:
                return pending
            future = self._executor.submit(self._prepare_and_dispatch, face_id, vm, revision)
            self._pending[key] = future
            future.add_done_callback(
                lambda done: self._finish(key, vm, done)
            )
            return future

    def _finish(self, key, vm, future):
        try:
            result = future.result()
        except BaseException:
            result = {"status": "error", "reason": "unexpected-worker-failure"}
        with self._lock:
            if self._pending.get(key) is future:
                self._pending.pop(key, None)
            if result.get("status") == "primed":
                self._completed[key] = (weakref.ref(vm), result)

    def _prepare_and_dispatch(self, face_id, vm, revision):
        engine = self.engine
        try:
            # This first check avoids even approved-file I/O when a session
            # arrived while the background job waited in the executor.
            with engine._config_lock:
                if engine._config_revision != revision or engine._vm is not vm:
                    return {"status": "skipped", "reason": "generation-changed"}
                if engine._active_session_count():
                    return {"status": "skipped", "reason": "session-active"}
                profile = session_config_for_profile(engine._config, PROFILE)
            fixture = self.frame_provider(engine, face_id, profile)
            if fixture is None:
                return {"status": "skipped", "reason": "no-cached-approved-frame"}
            frame, embedding = fixture
            # Speculative priority cannot preempt a foreground GPU job. The
            # final zero-session and generation checks happen on GPU owner.
            return engine._run_gpu_work(
                self._prime_on_owner, face_id, vm, revision, frame, embedding,
                priority=20, work_label="tiktok-idle-full-prime",
            )
        except Exception as exc:
            return {"status": "error", "reason": type(exc).__name__}

    def _prime_on_owner(self, face_id, vm, revision, frame, embedding):
        engine = self.engine
        if threading.get_ident() != getattr(engine, "_gpu_worker_ident", None):
            return {"status": "error", "reason": "wrong-gpu-owner"}
        # create_session registers under _config_lock; holding it across this
        # one bounded discard-only frame makes zero-active at execution exact.
        # Lock order remains config -> model -> sessions as in update_config.
        with engine._config_lock:
            if engine._config_revision != revision or engine._vm is not vm:
                return {"status": "skipped", "reason": "generation-changed"}
            if engine._active_session_count():
                return {"status": "skipped", "reason": "session-active"}
            profile = session_config_for_profile(engine._config, PROFILE)
            try:
                result = self.prime(engine, frame, embedding, profile)
            except RuntimeError as exc:
                if "selected a different restorer" in str(exc):
                    return {"status": "skipped", "reason": "unsuitable-gpen512-image"}
                if "Preflight config differs" in str(exc) or "signature is not warm" in str(exc):
                    return {"status": "skipped", "reason": "generation-changed"}
                return {"status": "error", "reason": type(exc).__name__}
        return {
            "status": "primed", "revision": revision,
            "vmGeneration": id(vm),
            "faceIdSha256": hashlib.sha256(face_id.encode("utf-8")).hexdigest(),
            "elapsedMs": result["elapsedMs"],
            "restorerCudaMs": result["restorerCudaMs"],
        }

    def shutdown(self):
        self._executor.shutdown(wait=True, cancel_futures=False)
