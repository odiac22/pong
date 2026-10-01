"""CPU-only ownership tests for isolated asynchronous guard evidence."""
import copy
from concurrent.futures import Future
from types import SimpleNamespace
import unittest

from experiment_mask_overlap import _guard_pending


class TensorStub:
    shape = (3, 1024, 1024)
    dtype = 'float32'
    device = 'cuda:0'
    _version = 0

    def data_ptr(self):
        return 100

    def stride(self):
        return (1024*1024, 1024, 1)


class GuardOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.image = TensorStub()
        self.prior = TensorStub()
        self.anchor = {'probe': self.prior}
        self.context = {'frameIndex': 9, 'mediaTimeSeconds': 0.36,
                        'occluderAnchor': self.anchor}
        self.probe = object()
        self.result = {'probe': self.probe, 'host': [1, 2, 3]}
        self.future = Future()
        self.future.set_result({'occluder': self.result})
        self.pending = {
            'context': self.context, 'frameIndex': 9,
            'mediaTimeSeconds': 0.36, 'input': self.image,
            'inputPtr': 100, 'inputShape': self.image.shape,
            'inputVersion': 0,
            'inputStride': self.image.stride(), 'inputDtype': self.image.dtype,
            'inputDevice': self.image.device,
            'entries': {'occluder': {'anchor': self.anchor, 'priorProbe': self.prior,
                                     'priorVersion': 0, 'localGuard': False}},
            'results': None, 'future': self.future,
        }
        self.owner = SimpleNamespace(_isolated_mask_overlap={'guardPending': self.pending})

    def match(self, **kwargs):
        return _guard_pending(self.owner, self.context, 'occluder', self.image, **kwargs)

    def test_only_same_frame_and_owned_history_consumed(self):
        matched, result = self.match(anchor=self.anchor, prior_probe=self.prior,
                                     probe=self.probe, local_guard=False)
        self.assertIs(matched, self.pending)
        self.assertIs(result, self.result)

    def test_each_source_contract_change_falls_back(self):
        for key, altered in [('frameIndex', 10), ('mediaTimeSeconds', 0.40),
                             ('input', TensorStub()), ('inputPtr', 101),
                             ('inputVersion', 1),
                             ('inputShape', (3, 512, 512)), ('inputStride', (1, 2, 3)),
                             ('inputDtype', 'float16'), ('inputDevice', 'cuda:1')]:
            with self.subTest(key=key):
                saved = self.pending[key]
                self.pending[key] = altered
                self.assertIsNone(self.match())
                self.pending[key] = saved

    def test_equal_but_unowned_context_is_rejected(self):
        self.assertIsNone(_guard_pending(self.owner, dict(self.context), 'occluder', self.image))

    def test_replaced_or_mutated_history_is_rejected(self):
        self.context['occluderAnchor'] = dict(self.anchor)
        self.assertIsNone(self.match())
        self.context['occluderAnchor'] = self.anchor
        self.prior._version = 1
        self.assertIsNone(self.match())

    def test_mutated_current_crop_or_time_is_rejected(self):
        self.image._version = 1
        self.assertIsNone(self.match())
        self.image._version = 0
        self.context['mediaTimeSeconds'] = 0.40
        self.assertIsNone(self.match())

    def test_local_guard_mode_and_probe_identity_cannot_change(self):
        self.assertIsNone(self.match(local_guard=True))
        self.assertIsNone(self.match(probe=object()))
        self.assertIsNone(self.match(anchor=dict(self.anchor)))
        self.assertIsNone(self.match(prior_probe=TensorStub()))

    def test_missing_pending_or_stage_falls_back(self):
        self.assertIsNone(_guard_pending(self.owner, self.context, 'dflXSeg', self.image))
        self.owner._isolated_mask_overlap['guardPending'] = None
        self.assertIsNone(self.match())


if __name__ == '__main__':
    unittest.main()
