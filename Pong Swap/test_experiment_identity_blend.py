"""CPU fallback coverage; full CUDA primitive checks are explicitly scheduled."""
import unittest
from unittest.mock import patch
import torch
import experiment_identity_blend as blend
from experiment_identity_graph import _ops


class IdentityBlendTests(unittest.TestCase):
    def test_unsupported_cpu_and_layout_use_original(self):
        torch.manual_seed(3089)
        for transpose in (False, True):
            a=torch.rand((3,7,11))*255
            b=torch.randn_like(a)*20
            c=torch.randn_like(a)*20
            d=torch.rand((1,7,11))*30
            if transpose:
                a,b,c,d=[t.transpose(1,2) for t in (a,b,c,d)]
            with patch.object(blend,'prewarm',side_effect=AssertionError('unexpected GPU')):
                actual=blend.apply(a,b,c,d,.731,2.,14.)
            expected=_ops(a,b,c,d,.731,2.,14.)
            for x,y in zip(actual,expected):
                self.assertTrue(torch.equal(x,y))

    def test_prewarmer_is_idempotent(self):
        with patch.object(blend,'_module',None), patch.object(blend,'CudaModule') as constructor:
            blend.prewarm()
            blend.prewarm()
            constructor.assert_called_once()


if __name__=='__main__':
    unittest.main()
