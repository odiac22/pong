"""Optional asynchronous, session-local profile warmup before TikTok admission.

This module has no service hook. A qualified caller may request it when the
TikTok surface opens, before a swap is submitted. The engine's existing
``warm(config=...)`` owns all GPU work and stream/model lifecycle. No preset is
updated and no session is created here. Warmup readiness expires with model
unload, so a later entry may request another idempotent warm.
"""

from concurrent.futures import Future
import threading

from pong_tiktok_restorer import PROFILE, FIXED_512_PROFILE, restorer_models, session_config_for_profile


class ProfileWarmup:
    def __init__(self, engine, *, qualified=False):
        if not qualified:
            raise RuntimeError("profile warmup requires an explicitly qualified caller")
        self.engine = engine
        self._lock = threading.Lock()
        self._pending: dict[str, Future] = {}

    def request(self, profile=PROFILE) -> Future:
        """Return a single-flight future; never hold a control lock during GPU work."""
        if profile not in (PROFILE, FIXED_512_PROFILE):
            raise ValueError("unsupported profile warmup")
        with self._lock:
            pending = self._pending.get(profile)
            if pending is not None and not pending.done():
                return pending
            future = Future()
            self._pending[profile] = future
            threading.Thread(target=self._run, args=(profile, future),
                             name="PongTikTokProfileWarmup", daemon=True).start()
            return future

    def _run(self, profile, future):
        try:
            engine = self.engine
            status = engine.health().get("exactAcceleration", {})
            if not status.get("acceleration", {}).get("installed"):
                raise RuntimeError("qualified acceleration is not installed")
            if engine._active_session_count():
                raise RuntimeError("profile warmup requires no active sessions")
            baseline, revision = engine._config_snapshot()
            candidate = session_config_for_profile(baseline, profile)
            if engine._model_lifecycle_changed(baseline, candidate):
                raise RuntimeError("profile warmup would change model lifecycle")
            # A settings update between the snapshot and dispatch must not
            # prime an obsolete preset. The engine still validates lifecycle
            # again inside warm() if a subsequent update races this check.
            if engine._config_snapshot()[1] != revision:
                raise RuntimeError("configuration changed before profile warmup")
            if engine._active_session_count():
                raise RuntimeError("session started before profile warmup")
            result = engine.warm(config=candidate, allow_create_selected=True)
            restorers = result.get("restorers", {})
            for model in restorer_models(candidate):
                edge = model.removeprefix("GPEN")
                if not restorers.get(edge, {}).get("ready"):
                    raise RuntimeError(f"profile restorer {model} is not ready")
            if not result.get("ready"):
                raise RuntimeError("profile warmup did not report ready")
            if engine._config_snapshot()[1] != revision:
                raise RuntimeError("configuration changed during profile warmup")
            future.set_result({"profile": profile, "configRevision": revision,
                               "restorers": tuple(restorer_models(candidate)), "ready": True})
        except BaseException as exc:
            future.set_exception(exc)
