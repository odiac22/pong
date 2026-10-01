from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

import numpy as np


ROPE_ROOT = Path(__file__).resolve().parent / "engine" / "Rope"
if str(ROPE_ROOT) not in sys.path:
    sys.path.insert(0, str(ROPE_ROOT))

import rope.Models as models_module
from pong_swap_engine import PongSwapEngine


class FakeStream:
    def __init__(self, stream_id: int) -> None:
        self.cuda_stream = stream_id


def bare_models(*, mode: str = "Shared", bound_stream_id=None):
    models = models_module.Models.__new__(models_module.Models)
    models._model_session_mode = mode
    models._shared_compute_stream_id = bound_stream_id
    return models


class SharedComputeStreamTests(unittest.TestCase):
    def test_shared_session_skips_drain_only_on_exact_bound_stream(self) -> None:
        models = bare_models(bound_stream_id=1234)
        with mock.patch.object(
            models_module.torch.cuda,
            "current_stream",
            return_value=FakeStream(1234),
        ):
            self.assertFalse(models._should_drain_syncvec())

        with mock.patch.object(
            models_module.torch.cuda,
            "current_stream",
            return_value=FakeStream(9999),
        ):
            self.assertTrue(models._should_drain_syncvec())

    def test_shared_session_without_recorded_binding_keeps_safe_drain(self) -> None:
        models = bare_models(bound_stream_id=None)
        with mock.patch.object(
            models_module.torch.cuda,
            "current_stream",
            return_value=FakeStream(1234),
        ):
            self.assertTrue(models._should_drain_syncvec())

    def test_provider_options_receive_recorded_native_stream_pointer(self) -> None:
        models = bare_models(bound_stream_id=5678)

        options = models._set_provider_compute_stream({"existing": "value"})

        self.assertEqual(options["existing"], "value")
        self.assertEqual(options["user_compute_stream"], "5678")

    def test_rebinding_loaded_shared_session_is_rejected(self) -> None:
        models = bare_models(bound_stream_id=1234)
        models.swapper_model = object()

        with self.assertRaisesRegex(RuntimeError, "Unload Shared model sessions"):
            models.set_shared_compute_stream(FakeStream(5678))

        # Re-registering the same stream is safe and intentionally idempotent.
        models.set_shared_compute_stream(FakeStream(1234))

    def test_cancelled_frame_never_uploads_to_cuda(self) -> None:
        engine = PongSwapEngine.__new__(PongSwapEngine)
        engine._lock = threading.RLock()
        engine._config = {"runtime": {}, "parameters": {}}
        engine._torch = models_module.torch
        engine.warm = mock.Mock()
        engine._frame_tensor = mock.Mock(side_effect=AssertionError("uploaded"))
        cancelled = threading.Event()
        cancelled.set()
        anchor = np.ones((4,), dtype=np.float32)

        result, returned_anchor = engine.process_frame(
            np.zeros((8, 8, 3), dtype=np.uint8),
            np.zeros((512,), dtype=np.float32),
            anchor,
            cancel_event=cancelled,
        )

        self.assertIsNone(result)
        self.assertIs(returned_anchor, anchor)
        engine._frame_tensor.assert_not_called()


if __name__ == "__main__":
    unittest.main()
