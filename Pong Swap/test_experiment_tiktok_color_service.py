"""CPU-only scope, cold-start and VM lifecycle tests for the trial entrypoint."""

import sys
import gc
import threading
import types
import unittest
import weakref
from unittest import mock

import experiment_tiktok_color_service as trial_module


class _VM:
    pass


class _Engine:
    def __init__(self):
        self._sessions_lock = threading.RLock()
        self._sessions = {}
        self._gpu_worker_ident = threading.get_ident()
        self._vm = _VM()
        self._torch = object()
        self.config = {"runtime": {"tiktokRestorerProfile": "default"}}
        self._pong_exact_bootstrap = (types.SimpleNamespace(installed=True), None)
        self.observed = []
        self.warm_calls = []

    def health(self):
        return {"ready": True}

    def warm(self, *, config):
        self.warm_calls.append(config)
        self._vm = _VM()

    def process_frame(self, *args, **kwargs):
        value = self._tiktok_color_graph_trial._enabled_for_call()
        self.observed.append(value)
        return value


class _App:
    def __init__(self):
        self.events = {}
        self.router = self

    def add_event_handler(self, kind, callback):
        self.events.setdefault(kind, []).append(callback)


class TikTokColorServiceTests(unittest.TestCase):
    def _installed(self):
        engine, app = _Engine(), _App()
        trial = trial_module.install(engine, app)
        with mock.patch.object(trial, "_ensure_vm") as ensure:
            app.events["startup"][0]()
        return engine, app, trial, ensure

    def test_startup_requires_qualified_frozen_runtime(self):
        engine, app = _Engine(), _App()
        engine._pong_exact_bootstrap[0].installed = False
        trial_module.install(engine, app)
        with self.assertRaisesRegex(RuntimeError, "qualified frozen runtime"):
            app.events["startup"][0]()
        self.assertNotIn("process_frame", engine.__dict__)

    def test_only_tiktok_gpu_owner_frame_is_enabled(self):
        engine, app, trial, _ = self._installed()
        with mock.patch.object(trial, "_ensure_vm") as ensure:
            self.assertFalse(engine.process_frame(config={"runtime": {"tiktokRestorerProfile": "default"}}))
            self.assertTrue(engine.process_frame(config={"runtime": {"tiktokRestorerProfile": "tiktok-face-size"}}))
            self.assertFalse(engine.process_frame(config={"runtime": {"tiktokRestorerProfile": "default"}}))
            self.assertEqual(ensure.call_count, 1)
            engine._gpu_worker_ident = -1
            self.assertFalse(engine.process_frame(config={"runtime": {"tiktokRestorerProfile": "tiktok-face-size"}}))
        self.assertFalse(trial._enabled_for_call())
        self.assertTrue(engine.health()["colorGraphTrial"]["active"])
        app.events["shutdown"][0]()
        self.assertNotIn("process_frame", engine.__dict__)

    def test_backend_retirement_calls_current_class_method(self):
        engine, app, trial, _ = self._installed()
        original = _Engine.process_frame
        try:
            _Engine.process_frame = lambda self, *a, **kw: "current-original-fallback"
            engine._pong_exact_bootstrap[0].installed = False
            self.assertEqual(engine.process_frame(
                config={"runtime": {"tiktokRestorerProfile": "tiktok-face-size"}}),
                "current-original-fallback")
            self.assertFalse(engine.health()["colorGraphTrial"]["active"])
        finally:
            _Engine.process_frame = original
            app.events["shutdown"][0]()

    def test_first_post_idle_frame_warms_before_vm_install(self):
        engine, app, trial, _ = self._installed()
        engine._vm = None
        cfg = {"runtime": {"tiktokRestorerProfile": "tiktok-face-size"}}
        with mock.patch.object(trial, "_ensure_vm") as ensure:
            self.assertTrue(engine.process_frame(config=cfg))
            self.assertEqual(engine.warm_calls, [cfg])
            ensure.assert_called_once()
            self.assertIsNotNone(engine._vm)
        app.events["shutdown"][0]()

    def test_exception_resets_tiktok_scope(self):
        engine, app, trial, _ = self._installed()
        original = _Engine.process_frame
        try:
            def failing(_engine, *args, **kwargs):
                self.assertTrue(trial._enabled_for_call())
                raise RuntimeError("diagnostic failure")
            _Engine.process_frame = failing
            with mock.patch.object(trial, "_ensure_vm"):
                with self.assertRaisesRegex(RuntimeError, "diagnostic failure"):
                    engine.process_frame(config={"runtime": {
                        "tiktokRestorerProfile": "tiktok-face-size"}})
            self.assertFalse(trial._enabled_for_call())
        finally:
            _Engine.process_frame = original
            app.events["shutdown"][0]()

    def test_new_vm_gets_new_scoped_adapter_without_holding_old_vm(self):
        engine, app, trial, _ = self._installed()
        rope = types.SimpleNamespace(VideoManager=types.SimpleNamespace(_match_lab_color=lambda *a: None))
        installed = []

        def fake_install(vm, torch, lab, **kwargs):
            vm._adaptive_color_graph_state = {"eagerMisses": 0, "graphHits": 0,
                                              "originalFallbacks": 0, "eagerSizes": {},
                                              "lock": threading.Lock()}
            installed.append(vm)

        with mock.patch.dict(sys.modules, {"rope": rope}), mock.patch.object(
                trial_module, "install_on_vm", side_effect=fake_install):
            cfg = {"runtime": {"tiktokRestorerProfile": "tiktok-face-size"}}
            engine.process_frame(config=cfg)
            engine.process_frame(config=cfg)
            self.assertEqual(len(installed), 1)
            previous_vm = engine._vm
            engine._vm = _VM()
            engine.process_frame(config=cfg)
            self.assertEqual(len(installed), 2)
            self.assertIsNot(engine._vm, previous_vm)
            self.assertEqual(engine.health()["colorGraphTrial"]["vmInstalls"], 2)
        app.events["shutdown"][0]()

    def test_count_only_decisions_are_default_off_and_health_is_bounded(self):
        engine, app, trial, _ = self._installed()
        status = engine.health()["multiFaceDecisionTrial"]
        self.assertFalse(status["installed"])
        self.assertEqual(len(status["counts"]), len(trial_module.DECISION_COUNT_KEYS))
        self.assertTrue(all(type(value) is int for value in status["counts"].values()))
        app.events["shutdown"][0]()

    def test_decision_only_mode_installs_after_preflight_and_restores_on_close(self):
        engine, app = _Engine(), _App()
        handle = mock.Mock()
        handle.snapshot.return_value = {
            "detectedRows": 8, "sourceAdmissionLowConfidence": 3,
            "reason:no-confident-match": 2, "secret-face-id": 999,
        }
        trial = trial_module.install(engine, app, color_enabled=False,
                                     multi_face_decisions=True)
        with mock.patch.object(trial, "_install_decisions", return_value=handle) as install:
            app.events["startup"][0]()
        install.assert_called_once()
        self.assertNotIn("process_frame", engine.__dict__)
        status = engine.health()["multiFaceDecisionTrial"]
        self.assertTrue(status["installed"])
        self.assertEqual(status["counts"]["detectedRows"], 8)
        self.assertEqual(status["counts"]["reason:no-confident-match"], 2)
        self.assertNotIn("secret-face-id", str(status))
        self.assertFalse(engine.health()["colorGraphTrial"]["installed"])
        app.events["shutdown"][0]()
        handle.uninstall.assert_called_once()
        self.assertNotIn("_tiktok_color_graph_trial", engine.__dict__)

    def test_decision_install_rejects_active_session_before_patching(self):
        engine, app = _Engine(), _App()
        engine._sessions["already-active"] = object()
        trial = trial_module.install(engine, app, color_enabled=False,
                                     multi_face_decisions=True)
        with mock.patch.object(trial, "_install_decisions") as install:
            with self.assertRaisesRegex(RuntimeError, "before sessions"):
                app.events["startup"][0]()
        install.assert_not_called()
        self.assertNotIn("health", engine.__dict__)

    def test_closed_trial_does_not_keep_engine_alive_without_gc(self):
        engine, app = _Engine(), _App()
        trial = trial_module.install(engine, app, color_enabled=False,
                                     multi_face_decisions=False)
        app.events["startup"][0]()
        app.events["shutdown"][0]()
        reference = weakref.ref(engine)
        was_enabled = gc.isenabled()
        gc.disable()
        try:
            del engine, trial, app
            self.assertIsNone(reference())
        finally:
            if was_enabled:
                gc.enable()


if __name__ == "__main__":
    unittest.main()
