import math
import sys
import unittest
from pathlib import Path
import torch

sys.path.insert(0, str(Path(__file__).parent/'engine'/'Rope'))
from rope.VideoManager import _read_guard_scalars


class GuardReadbackTests(unittest.TestCase):
    def test_float32_flag_and_patch_index_match_separate_reads(self):
        for seed in range(12):
            generator=torch.Generator().manual_seed(seed)
            delta=torch.rand((3,64,64),generator=generator)*255
            local=delta.mean(dim=0,keepdim=True).unsqueeze(0)
            grid=torch.nn.functional.avg_pool2d(local,8,8)
            maximum,index=torch.max(grid.reshape(-1),dim=0)
            values=(torch.isfinite(delta).all(),delta.mean(),maximum,index)
            self.assertEqual(_read_guard_scalars(*values),[v.item() for v in values])

    def test_nonfinite_flags_still_fail_closed(self):
        for value in (float('nan'),float('inf')):
            delta=torch.tensor([1,value],dtype=torch.float32)
            finite,mean=_read_guard_scalars(torch.isfinite(delta).all(),delta.mean())
            self.assertFalse(finite)
            self.assertFalse(math.isfinite(mean))

    def test_scores_at_reuse_boundaries_are_not_rounded(self):
        values=[]
        for threshold in (12.,18.,30.,40.,48.):
            point=torch.tensor(threshold,dtype=torch.float32)
            values.extend((torch.nextafter(point,torch.tensor(float('-inf'))),point,
                           torch.nextafter(point,torch.tensor(float('inf')))))
        self.assertEqual(_read_guard_scalars(*values),[v.item() for v in values])

if __name__=='__main__':unittest.main()
