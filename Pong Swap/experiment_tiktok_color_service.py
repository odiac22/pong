"""Disposable TikTok-only exact LAB color scheduling trial.

Run this entrypoint instead of pong_swap_service.py in an owned test renderer.
The ordinary ASGI startup still performs frozen qualification. After that
bootstrap, only GPU-owner frames carrying the immutable TikTok restoration
profile may use the original LAB operations eagerly for uncached crop sizes.
Other sessions and previews retain the original color graph implementation.
"""

import argparse
import threading
from types import MethodType
import weakref

from experiment_color_graph_adaptive import install_on_vm, status as color_status


TIKTOK_PROFILE = "tiktok-face-size"
DECISION_COUNT_KEYS = (
    "selection", "reason:candidate", "reason:best-available-close-match",
    "reason:no-confident-match", "reason:chooser-not-reached",
    "consensus", "consensus:pending", "consensus:reset", "consensus:locked",
    "detectedRows", "recognizedRows", "targets", "sourceChoices",
    "candidatePairs", "invalidTargetEmbedding", "invalidSourceEmbedding",
    "hairRejected", "sourceAdmissionRejected",
    "sourceAdmissionUnknownPresentation", "sourceAdmissionLowConfidence",
    "maleSourceRestricted", "presentationRejected",
    "sourcePresentationUnknown", "presentationMismatch",
    "presentationConfidenceBelowStrictness", "nonFiniteOrNegativeRanking",
    "rankedPairs", "rawSimilarityFloorRejected",
    "nonPositiveArcfaceRejected", "eligiblePairs", "chooserNotReached",
)


def is_tiktok_config(config):
    return (isinstance(config, dict) and
            config.get("runtime", {}).get("tiktokRestorerProfile") == TIKTOK_PROFILE)


class ColorGraphTrial:
    def __init__(self, engine, app, *, color_enabled=True,
                 multi_face_decisions=False):
        self.engine = engine
        self.color_enabled = bool(color_enabled)
        self.multi_face_decisions = bool(multi_face_decisions)
        self.local = threading.local()
        self.installed = False
        self.closed = False
        self.vm_installs = 0
        self._original_health = None
        self._original_health_instance = None
        self._original_process_instance = None
        self._decision_handle = None

    def _handle_active(self):
        binding = getattr(self.engine, "_pong_exact_bootstrap", None)
        return bool(binding and binding[0].installed)

    def _enabled_for_call(self):
        return bool(self.color_enabled and getattr(self.local, "tiktok", False)
                    and self._handle_active())

    def _ensure_vm(self):
        vm = getattr(self.engine, "_vm", None)
        if vm is None:
            return
        if getattr(vm, "_adaptive_color_graph_state", None) is not None:
            return
        from rope import VideoManager as module
        trial_ref = weakref.ref(self)

        def scoped():
            trial = trial_ref()
            return trial is not None and trial._enabled_for_call()

        install_on_vm(vm, self.engine._torch, module._match_lab_color,
                      enabled_for_call=scoped)
        self.vm_installs += 1

    def status(self):
        vm = getattr(self.engine, "_vm", None)
        state = None if vm is None else getattr(vm, "_adaptive_color_graph_state", None)
        return {
            "installed": self.color_enabled and self.installed and not self.closed,
            "active": self.color_enabled and self.installed and not self.closed
                      and self._handle_active(),
            "scope": TIKTOK_PROFILE,
            "vmInstalls": self.vm_installs,
            "currentVm": None if state is None else color_status(state),
        }

    def decision_status(self):
        handle = self._decision_handle
        values = {} if handle is None else handle.snapshot()
        return {
            "installed": handle is not None and not self.closed,
            "active": handle is not None and not self.closed and self._handle_active(),
            "counts": {key: int(values.get(key, 0)) for key in DECISION_COUNT_KEYS},
        }

    def _install_decisions(self):
        import experiment_multi_face_decisions as diagnostics
        import pong_hair_policy
        import pong_multi_face
        import pong_swap_engine
        import pong_swap_identity
        return diagnostics.install(pong_swap_engine, pong_multi_face,
                                   pong_swap_identity, pong_hair_policy)

    def startup(self):
        if self.installed:
            return
        if not self._handle_active():
            raise RuntimeError("TikTok color trial requires the qualified frozen runtime")
        with self.engine._sessions_lock:
            if self.engine._sessions:
                raise RuntimeError("TikTok color trial must install before sessions")
        if self.multi_face_decisions:
            # Qualification has already completed in the service's earlier
            # startup handler. Diagnostic hooks never participate in its
            # source-hash guard and are installed only while no sessions exist.
            self._decision_handle = self._install_decisions()
        trial = self
        engine = self.engine
        self._original_health = engine.health
        self._original_health_instance = engine.__dict__.get("health")
        self._original_process_instance = engine.__dict__.get("process_frame")

        def health(_engine, *args, **kwargs):
            result = trial._original_health(*args, **kwargs)
            result["colorGraphTrial"] = trial.status()
            result["multiFaceDecisionTrial"] = trial.decision_status()
            return result

        def process_frame(_engine, *args, **kwargs):
            config = kwargs.get("config") or _engine.config
            enabled = bool(
                trial.color_enabled and trial.installed and not trial.closed
                and trial._handle_active()
                and is_tiktok_config(config)
                and threading.get_ident() == getattr(_engine, "_gpu_worker_ident", None)
            )
            prior = getattr(trial.local, "tiktok", False)
            trial.local.tiktok = enabled
            try:
                if enabled:
                    if _engine._vm is None:
                        # This is the same warm boundary the original
                        # process_frame would take. Do it before installing
                        # the VM-local adapter so the first post-idle frame
                        # is scoped too, without creating a second VM.
                        _engine.warm(config=config)
                    # New VMs after idle unload get their own adapter. The
                    # wrapper and counters live only on that VM, so no stale
                    # graph or model resource survives an unload.
                    trial._ensure_vm()
                # Resolve the current class implementation on every call.
                # If a backend change retires frozen acceleration, do not
                # retain a bound pointer to its old generated method.
                return type(_engine).process_frame(_engine, *args, **kwargs)
            finally:
                trial.local.tiktok = prior

        try:
            engine.health = MethodType(health, engine)
            if self.color_enabled:
                engine.process_frame = MethodType(process_frame, engine)
            self.installed = True
        except Exception:
            if self._original_health_instance is None:
                engine.__dict__.pop("health", None)
            else:
                engine.health = self._original_health_instance
            if self._original_process_instance is None:
                engine.__dict__.pop("process_frame", None)
            else:
                engine.process_frame = self._original_process_instance
            if self._decision_handle is not None:
                self._decision_handle.uninstall()
                self._decision_handle = None
            self._original_health = None
            self._original_health_instance = None
            self._original_process_instance = None
            raise

    def close(self):
        if self.closed:
            return
        self.closed = True
        if self._decision_handle is not None:
            self._decision_handle.uninstall()
            self._decision_handle = None
        if self.installed:
            if self._original_health_instance is None:
                self.engine.__dict__.pop("health", None)
            else:
                self.engine.health = self._original_health_instance
            if self.color_enabled:
                if self._original_process_instance is None:
                    self.engine.__dict__.pop("process_frame", None)
                else:
                    self.engine.process_frame = self._original_process_instance
            self._original_health = None
            self._original_health_instance = None
            self._original_process_instance = None
            if getattr(self.engine, "_tiktok_color_graph_trial", None) is self:
                del self.engine._tiktok_color_graph_trial


def install(engine, app, *, color_enabled=True, multi_face_decisions=False):
    existing = getattr(engine, "_tiktok_color_graph_trial", None)
    if existing is not None:
        if (existing.color_enabled != bool(color_enabled) or
                existing.multi_face_decisions != bool(multi_face_decisions)):
            raise RuntimeError("TikTok diagnostic trial already installed in another mode")
        return existing
    trial = ColorGraphTrial(engine, app, color_enabled=color_enabled,
                            multi_face_decisions=multi_face_decisions)
    trial_ref = weakref.ref(trial)

    def startup():
        current = trial_ref()
        if current is not None:
            current.startup()

    def shutdown():
        current = trial_ref()
        if current is not None:
            current.close()

    app.router.add_event_handler("startup", startup)
    app.router.add_event_handler("shutdown", shutdown)
    engine._tiktok_color_graph_trial = trial
    return trial


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8792)
    parser.add_argument("--multi-face-decisions", action="store_true")
    parser.add_argument("--no-color-graph", action="store_true")
    args = parser.parse_args()
    import pong_swap_service
    import uvicorn

    if args.no_color_graph and not args.multi_face_decisions:
        parser.error("--no-color-graph requires --multi-face-decisions")
    install(pong_swap_service.ENGINE, pong_swap_service.app,
            color_enabled=not args.no_color_graph,
            multi_face_decisions=args.multi_face_decisions)
    uvicorn.run(pong_swap_service.app, host="127.0.0.1",
                port=args.port, log_level="info")


if __name__ == "__main__":
    main()
