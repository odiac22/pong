"""CPU-only races for the not-installed TikTok full-prime coordinator."""

from copy import deepcopy
import threading
import time
import sys
import types
import unittest
from unittest import mock

import numpy as np

from experiment_tiktok_full_prime_coordinator import (
    FullPathPrimeCoordinator, cached_approved_frame,
)
from pong_tiktok_restorer import PROFILE


class _VM:
    pass


class _Engine:
    def __init__(self):
        self._config_lock = threading.RLock()
        self._lock = threading.RLock()
        self._config_revision = 7
        self._vm = _VM()
        self._config = {
            "runtime": {},
            "parameters": {"RestorerSwitch": True,
                           "RestorerTypeTextSel": "GPEN1024"},
        }
        self.active = 0
        self._gpu_worker_ident = 0
        self.gpu_calls = 0
        self.dispatch_gate = None

    def _active_session_count(self):
        return self.active

    def _run_gpu_work(self, callback, *args, **kwargs):
        self.gpu_calls += 1
        if self.dispatch_gate is not None:
            self.dispatch_gate.wait(timeout=2)
        self._gpu_worker_ident = threading.get_ident()
        return callback(*args)


def _fixture(*_args):
    return np.zeros((160, 160, 3), dtype=np.uint8), np.ones(512, dtype=np.float32)


def _prime(*_args):
    return {"elapsedMs": 149.0, "restorerCudaMs": 35.0}


class CoordinatorTests(unittest.TestCase):
    def setUp(self):
        self.engine = _Engine()
        self.warm_result = {"ready": True, "profile": PROFILE, "configRevision": 7}
        self.prime_calls = 0

        def prime(*args):
            self.prime_calls += 1
            return _prime(*args)

        self.coordinator = FullPathPrimeCoordinator(
            self.engine, frame_provider=_fixture, prime=prime,
        )
        self.addCleanup(self.coordinator.shutdown)

    def test_success_is_singleflight_per_vm_revision_without_config_mutation(self):
        baseline = deepcopy(self.engine._config)
        entered = threading.Event()
        release = threading.Event()

        def provider(*_args):
            entered.set()
            release.wait(timeout=2)
            return _fixture()

        self.coordinator.frame_provider = provider
        first = self.coordinator.request("approved", self.warm_result)
        self.assertTrue(entered.wait(2))
        self.assertIs(first, self.coordinator.request("approved", self.warm_result))
        release.set()
        self.assertEqual(first.result(timeout=2)["status"], "primed")
        self.assertEqual(self.coordinator.request("approved", self.warm_result).result()["status"], "primed")
        self.assertEqual(self.prime_calls, 1)
        self.assertEqual(self.engine._config, baseline)

    def test_session_started_before_gpu_execution_skips(self):
        gate = self.engine.dispatch_gate = threading.Event()
        future = self.coordinator.request("approved", self.warm_result)
        deadline = time.monotonic() + 2
        while self.engine.gpu_calls == 0 and time.monotonic() < deadline:
            time.sleep(0.001)
        self.assertEqual(self.engine.gpu_calls, 1)
        self.engine.active = 1
        gate.set()
        self.assertEqual(future.result(timeout=2),
                         {"status": "skipped", "reason": "session-active"})
        self.assertEqual(self.prime_calls, 0)

    def test_unload_or_config_change_before_gpu_execution_skips(self):
        for change in ("unload", "revision"):
            engine = _Engine()
            gate = engine.dispatch_gate = threading.Event()
            coordinator = FullPathPrimeCoordinator(
                engine, frame_provider=_fixture, prime=_prime,
            )
            try:
                future = coordinator.request("approved", self.warm_result)
                deadline = time.monotonic() + 2
                while engine.gpu_calls == 0 and time.monotonic() < deadline:
                    time.sleep(0.001)
                if change == "unload":
                    engine._vm = None
                else:
                    engine._config_revision += 1
                gate.set()
                self.assertEqual(future.result(timeout=2)["reason"],
                                 "generation-changed")
            finally:
                coordinator.shutdown()

    def test_no_face_or_missing_cache_skips_without_gpu(self):
        self.assertEqual(self.coordinator.request("", self.warm_result).result()["reason"],
                         "no-ready-selected-face")
        self.coordinator.frame_provider = lambda *_: None
        self.assertEqual(self.coordinator.request("approved", self.warm_result).result(timeout=2)["reason"],
                         "no-cached-approved-frame")
        self.assertEqual(self.engine.gpu_calls, 0)

    def test_unsuitable_model_is_reported_not_downgraded(self):
        def unsuitable(*_args):
            raise RuntimeError("Approved frame selected a different restorer")

        self.coordinator.prime = unsuitable
        result = self.coordinator.request("approved", self.warm_result).result(timeout=2)
        self.assertEqual(result, {"status": "skipped", "reason": "unsuitable-gpen512-image"})
        self.assertEqual(self.engine._config["parameters"]["RestorerTypeTextSel"], "GPEN1024")

    def test_admission_lock_protects_entire_prime(self):
        entered = threading.Event()
        release = threading.Event()
        registered = threading.Event()

        def slow_prime(*_args):
            entered.set()
            release.wait(timeout=2)
            return _prime()

        self.coordinator.prime = slow_prime
        future = self.coordinator.request("approved", self.warm_result)
        self.assertTrue(entered.wait(2))

        def register():
            with self.engine._config_lock:
                self.engine.active = 1
                registered.set()

        thread = threading.Thread(target=register)
        thread.start()
        self.assertFalse(registered.wait(0.02))
        release.set()
        self.assertEqual(future.result(timeout=2)["status"], "primed")
        self.assertTrue(registered.wait(2))
        thread.join(timeout=2)

    def test_actual_provider_uses_only_cached_embedding(self):
        engine = self.engine
        embedding = np.ones(512, dtype=np.float32)
        engine._embedding_cache = {("approved", "profile-key"): embedding}
        engine._embedding_profile_key = lambda _profile: "profile-key"
        engine.face = lambda _face_id: types.SimpleNamespace(files=("approved.png",))
        engine.embedding_for_face = mock.Mock(side_effect=AssertionError("no inference"))
        image = np.zeros((240, 320, 3), dtype=np.uint8)
        fake_cv2 = types.SimpleNamespace(
            IMREAD_COLOR=1, COLOR_BGR2RGB=2, INTER_AREA=3,
            imread=mock.Mock(return_value=image),
            cvtColor=lambda value, _code: value[:, :, ::-1],
        )
        with mock.patch.dict(sys.modules, {"cv2": fake_cv2}):
            frame, cached = cached_approved_frame(engine, "approved", {}, 480)
            self.assertEqual(frame.shape, (240, 320, 3))
            self.assertTrue(frame.flags.c_contiguous)
            self.assertIsNot(cached, embedding)
            engine._embedding_cache.clear()
            self.assertIsNone(cached_approved_frame(engine, "approved", {}, 480))
        engine.embedding_for_face.assert_not_called()


if __name__ == "__main__":
    unittest.main()
