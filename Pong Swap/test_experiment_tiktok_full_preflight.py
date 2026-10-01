"""CPU-only safety contracts for the offline full-path preflight."""

import sys
import threading
import types
import unittest
from unittest import mock

import numpy as np

from experiment_tiktok_full_preflight import run_on_owner
from pong_tiktok_restorer import PROFILE, session_config_for_profile


class _FakeOutput:
    def cpu(self):
        return self

    def numpy(self):
        return np.zeros((160, 160, 3), dtype=np.uint8)


class _FakeVM:
    def __init__(self):
        self.parameters = {"prior": True}
        self.color_match_cuda_graph_enabled = False


class _FakeEngine:
    def __init__(self):
        self._gpu_worker_ident = threading.get_ident()
        self._lock = threading.RLock()
        self._vm = _FakeVM()
        self._models = object()
        self._config = {
            "parameters": {"RestorerSwitch": True,
                           "RestorerTypeTextSel": "GPEN1024"},
            "runtime": {"adaptiveRestorer": True},
        }
        self._pipeline_warm_signature = ("qualified",)
        self.active = 0
        self.calls = []

    def _active_session_count(self):
        return self.active

    def _pipeline_signature(self, config):
        return ("qualified",)

    def process_frame(self, frame, embedding, anchor, **kwargs):
        self.calls.append(kwargs)
        self._vm.parameters = {"RestorerTypeTextSel": "GPEN512"}
        self._vm.color_match_cuda_graph_enabled = True
        kwargs["diagnostics"]["cuda_swap_preRestorer_to_postRestorerMs"] = [31.0]
        kwargs["tracking_state"]["kps"] = "local-only"
        kwargs["temporal_context"]["anchor"] = "local-only"
        return _FakeOutput(), None


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.engine = _FakeEngine()
        self.frame = np.zeros((160, 160, 3), dtype=np.uint8)
        self.embedding = np.ones(512, dtype=np.float32)
        self.builder = mock.patch.dict(sys.modules, {
            "pong_swap_engine": types.SimpleNamespace(
                build_temporal_restorer_context=lambda runtime, enabled: {
                    "enabled": enabled,
                },
            ),
        })
        self.builder.start()
        self.addCleanup(self.builder.stop)

    def run_preflight(self):
        return run_on_owner(
            self.engine, self.frame, self.embedding,
            session_config_for_profile(self.engine._config, PROFILE),
        )

    def test_fresh_local_state_and_restore(self):
        original = self.engine._vm.parameters
        first = self.run_preflight()
        second = self.run_preflight()
        self.assertEqual(first["outputSha256"], second["outputSha256"])
        self.assertEqual(first["restorerCudaMs"], 31.0)
        self.assertIs(self.engine._vm.parameters, original)
        self.assertFalse(self.engine._vm.color_match_cuda_graph_enabled)
        self.assertIsNot(
            self.engine.calls[0]["tracking_state"],
            self.engine.calls[1]["tracking_state"],
        )
        self.assertIsNot(
            self.engine.calls[0]["temporal_context"],
            self.engine.calls[1]["temporal_context"],
        )
        self.assertTrue(self.engine.calls[0]["temporal_context"]["forceExact"])

    def test_active_or_wrong_owner_rejected_before_processing(self):
        self.engine.active = 1
        with self.assertRaisesRegex(RuntimeError, "zero active"):
            self.run_preflight()
        self.engine.active = 0
        self.engine._gpu_worker_ident = -1
        with self.assertRaisesRegex(RuntimeError, "GPU owner"):
            self.run_preflight()
        self.assertEqual(self.engine.calls, [])

    def test_config_and_input_mismatch_rejected(self):
        stale = session_config_for_profile(self.engine._config, PROFILE)
        stale["parameters"]["RestorerSwitch"] = False
        with self.assertRaisesRegex(RuntimeError, "differs"):
            run_on_owner(self.engine, self.frame, self.embedding, stale)
        with self.assertRaisesRegex(ValueError, "RGB uint8"):
            run_on_owner(self.engine, self.frame[:, ::2], self.embedding,
                         session_config_for_profile(self.engine._config, PROFILE))
        self.assertEqual(self.engine.calls, [])

    def test_failure_restores_vm_and_no_restorer_rejects(self):
        def no_restorer(*args, **kwargs):
            self.engine._vm.parameters = {"RestorerTypeTextSel": "GPEN512"}
            return _FakeOutput(), None
        self.engine.process_frame = no_restorer
        original = self.engine._vm.parameters
        with self.assertRaisesRegex(RuntimeError, "did not reach"):
            self.run_preflight()
        self.assertIs(self.engine._vm.parameters, original)

    def test_pending_side_work_is_drained(self):
        future = mock.Mock()
        stream = mock.Mock()
        self.engine._vm._isolated_mask_overlap = {
            "pending": {"future": future}, "guardPending": None,
            "retired": [], "stream": stream,
        }
        self.run_preflight()
        future.result.assert_called_once()
        stream.synchronize.assert_called_once()


if __name__ == "__main__":
    unittest.main()
