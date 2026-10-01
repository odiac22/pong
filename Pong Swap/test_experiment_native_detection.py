"""CPU-only lifecycle contracts for frozen native detector experiments."""

from collections import OrderedDict
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent / 'engine' / 'Rope'))

import experiment_native_detection as experiment


class _Fence:
    def __init__(self):
        self.calls = 0

    def synchronize(self):
        self.calls += 1


class NativeDetectionTests(unittest.TestCase):
    def test_individual_unload_drains_only_affected_graphs(self):
        from rope.Models import Models

        old_run = Models._run_owned_gpu_binding
        old_delete = Models.delete_models
        old_unload = Models.unload_model
        calls = []
        try:
            Models._run_owned_gpu_binding = lambda *args: 'fallback'
            Models.delete_models = lambda self: calls.append('delete')
            Models.unload_model = lambda self, attr: calls.append(attr)
            experiment.install()
            detector_fence, recognition_fence = _Fence(), _Fence()
            owner = object.__new__(Models)
            owner._isolated_native_detection = OrderedDict({
                ('retinaface', 1): {'done': detector_fence, 'stream': _Fence(), 'calls': 1},
                ('recognition', 2): {'done': recognition_fence, 'stream': _Fence(), 'calls': 1},
            })
            Models.unload_model(owner, 'retinaface_model')
            self.assertEqual(detector_fence.calls, 1)
            self.assertEqual(recognition_fence.calls, 0)
            self.assertEqual(len(owner._isolated_native_detection), 1)
            self.assertEqual(calls, ['retinaface_model'])
            Models.delete_models(owner)
            self.assertEqual(recognition_fence.calls, 1)
            self.assertEqual(len(owner._isolated_native_detection), 0)
            self.assertEqual(calls[-1], 'delete')
        finally:
            Models._run_owned_gpu_binding = old_run
            Models.delete_models = old_delete
            Models.unload_model = old_unload

    def test_unsupported_sm_uses_original_runner(self):
        import torch
        from rope.Models import Models

        old_run = Models._run_owned_gpu_binding
        old_delete = Models.delete_models
        old_unload = Models.unload_model
        old_capability = torch.cuda.get_device_capability
        try:
            Models._run_owned_gpu_binding = lambda *args: 'fallback'
            Models.delete_models = lambda self: None
            Models.unload_model = lambda self, attr: None
            experiment.install()
            torch.cuda.get_device_capability = lambda device=0: (8, 0)
            owner = object.__new__(Models)
            session = object()
            owner.retinaface_model = session
            owner.recognition_model = None
            owner._ordered_gpu_submission = True
            owner._retinaface_uses_trt = True
            owner._persistent_shared_io_enabled = lambda: True
            self.assertEqual(
                Models._run_owned_gpu_binding(owner, session, None, object()),
                'fallback',
            )
        finally:
            torch.cuda.get_device_capability = old_capability
            Models._run_owned_gpu_binding = old_run
            Models.delete_models = old_delete
            Models.unload_model = old_unload

    def test_nonqualified_input_shape_uses_original_runner(self):
        import torch
        from rope.Models import Models

        old_run = Models._run_owned_gpu_binding
        old_delete = Models.delete_models
        old_unload = Models.unload_model
        old_capability = torch.cuda.get_device_capability

        class Device:
            index = 0

        class Buffer:
            is_cuda = True
            device = Device()
            dtype = torch.float32
            shape = (1, 3, 320, 320)

            def is_contiguous(self):
                return True

        try:
            Models._run_owned_gpu_binding = lambda *args: 'fallback'
            Models.delete_models = lambda self: None
            Models.unload_model = lambda self, attr: None
            experiment.install()
            torch.cuda.get_device_capability = lambda device=0: (8, 9)
            owner = object.__new__(Models)
            session = object()
            owner.retinaface_model = session
            owner.recognition_model = None
            owner._ordered_gpu_submission = True
            owner._retinaface_uses_trt = True
            owner._persistent_shared_io_enabled = lambda: True
            self.assertEqual(
                Models._run_owned_gpu_binding(
                    owner, session, None, *(Buffer() for _ in range(10))
                ),
                'fallback',
            )
        finally:
            torch.cuda.get_device_capability = old_capability
            Models._run_owned_gpu_binding = old_run
            Models.delete_models = old_delete
            Models.unload_model = old_unload


if __name__ == '__main__':
    unittest.main()
