"""CPU-only ownership/provenance regressions for process-local overlap."""

import unittest

from experiment_identity_guard_overlap import _retire_identity_pending
from experiment_mask_overlap import (
    _bound_retired, _guard_requests_exact, _mask_pending_matches,
)


class FakeTensor:
    shape = (3, 128, 128)
    dtype = "uint8"
    device = "cuda:0"

    def __init__(self):
        self._version = 0

    def stride(self):
        return (16384, 128, 1)

    def data_ptr(self):
        return 12345


class FakeEvent:
    def __init__(self, ready=False):
        self.ready = ready
        self.synchronized = False

    def query(self):
        return self.ready

    def synchronize(self):
        self.synchronized = True
        self.ready = True


class FakeFuture:
    def __init__(self, event, error=None):
        self.event = event
        self.error = error

    def done(self):
        return self.event.ready

    def exception(self):
        return self.error

    def result(self):
        self.event.ready = True
        if self.error:
            raise self.error


class FakeStream:
    def __init__(self):
        self.synchronizations = 0

    def synchronize(self):
        self.synchronizations += 1


class OwnershipTests(unittest.TestCase):
    def setUp(self):
        self.tensor = FakeTensor()
        self.context = {"frameIndex": 7, "mediaTimeSeconds": 0.24}
        self.backend = {"occluder": "trt", "dflXSeg": "trt"}
        self.pending = {
            "keys": {"occluder", "dflXSeg"}, "used": set(),
            "context": self.context, "frameIndex": 7, "mediaTimeSeconds": 0.24,
            "input": self.tensor, "inputPtr": self.tensor.data_ptr(),
            "inputVersion": 0, "inputShape": self.tensor.shape,
            "inputStride": self.tensor.stride(), "inputDtype": self.tensor.dtype,
            "inputDevice": self.tensor.device, "occluderSlider": 100,
            "dflSize": 256, "dflBlur": 3, "runtimeBackend": self.backend,
        }

    def match(self, key="occluder", *, signature=None, parameters=None,
              context=None, tensor=None, backend=None):
        if signature is None and key == "occluder":
            signature = ("occluder", 100, "trt")
        return _mask_pending_matches(
            self.pending, key,
            self.context if context is None else context,
            self.tensor if tensor is None else tensor,
            signature, parameters,
            self.backend if backend is None else backend,
        )

    def test_matching_policy_and_direct_masks(self):
        self.assertTrue(self.match())
        self.assertTrue(self.match("dflXSeg", signature=("dflXSeg", 256, 3)))
        self.assertTrue(self.match("dflXSeg", parameters={
            "DFLXSegSizeSlider": 256, "DFLXSegBlurSlider": 3,
        }))

    def test_frame_config_and_input_mismatch_fall_back(self):
        self.assertFalse(self.match(context=dict(self.context)))
        self.context["frameIndex"] = 8
        self.assertFalse(self.match())
        self.context["frameIndex"] = 7
        self.context["mediaTimeSeconds"] = 0.28
        self.assertFalse(self.match())
        self.context["mediaTimeSeconds"] = 0.24
        self.assertFalse(self.match(tensor=FakeTensor()))
        self.tensor._version += 1
        self.assertFalse(self.match())
        self.tensor._version = 0
        self.assertFalse(self.match(signature=("occluder", 101, "trt")))
        self.assertFalse(self.match(backend={"occluder": "cuda"}))
        self.assertFalse(self.match("dflXSeg", parameters={
            "DFLXSegSizeSlider": 256, "DFLXSegBlurSlider": 4,
        }))
        self.pending["used"].add("occluder")
        self.assertFalse(self.match())

    def test_retained_until_cuda_completion_and_bounded(self):
        state = {}
        owners = []
        for _ in range(5):
            event = FakeEvent()
            pending = {"future": FakeFuture(event), "done": event,
                       "result": (object(), object())}
            owners.append(pending)
            _retire_identity_pending(state, pending)
        self.assertEqual(len(state["identityRetired"]), 4)
        self.assertTrue(owners[0]["done"].synchronized)
        self.assertNotIn(owners[0], state["identityRetired"])
        owners[1]["done"].ready = True
        _retire_identity_pending(state, None)
        # No new owner is enqueued by None; stale owners are pruned on the
        # next real retirement and always before the bounded cap is checked.
        new_event = FakeEvent()
        _retire_identity_pending(state, {"future": FakeFuture(new_event),
                                         "done": new_event, "result": None})
        self.assertNotIn(owners[1], state["identityRetired"])

    def test_mask_retired_queue_is_bounded(self):
        state = {"retired": []}
        owners = []
        for _ in range(10):
            event = FakeEvent()
            pending = {"future": FakeFuture(event), "done": event}
            owners.append(pending)
            state["retired"].append(pending)
            _bound_retired(state)
        self.assertEqual(len(state["retired"]), 8)
        self.assertTrue(owners[0]["done"].synchronized)
        self.assertTrue(owners[1]["done"].synchronized)
        self.assertNotIn(owners[0], state["retired"])

    def test_failed_worker_keeps_owners_until_stream_drain(self):
        stream = FakeStream()
        mask_state = {"retired": [], "stream": stream}
        for _ in range(9):
            event = FakeEvent(ready=True)
            mask_state["retired"].append({
                "future": FakeFuture(event, RuntimeError("worker failed")),
                "done": event,
            })
        _bound_retired(mask_state)
        self.assertEqual(len(mask_state["retired"]), 8)
        self.assertEqual(stream.synchronizations, 1)

        identity_state = {"stream": stream}
        for _ in range(5):
            event = FakeEvent(ready=True)
            _retire_identity_pending(identity_state, {
                "future": FakeFuture(event, RuntimeError("worker failed")),
                "done": event, "result": (object(), object()),
            })
        self.assertEqual(len(identity_state["identityRetired"]), 4)
        self.assertEqual(stream.synchronizations, 2)

    def test_guard_guided_prediction_uses_original_strict_thresholds(self):
        entry = {"localGuard": False, "maxInputMae": 16.0,
                 "maxPatchMae": 30.0, "maxLocalPatchMae": 30.0}
        self.assertFalse(_guard_requests_exact([1.0, 16.0, 30.0], entry))
        self.assertTrue(_guard_requests_exact([1.0, 16.001, 30.0], entry))
        self.assertTrue(_guard_requests_exact([1.0, 16.0, 30.001], entry))
        self.assertTrue(_guard_requests_exact([0.0, 0.0, 0.0], entry))
        self.assertTrue(_guard_requests_exact([1.0, float('nan'), 0.0], entry))
        self.assertFalse(_guard_requests_exact([1.0, 0.0], entry))
        entry["localGuard"] = True
        self.assertFalse(_guard_requests_exact([1.0, 0.0, 0.0, 30.0], entry))
        self.assertTrue(_guard_requests_exact([1.0, 0.0, 0.0, 30.001], entry))


if __name__ == "__main__":
    unittest.main()
