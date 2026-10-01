"""CPU-only parity and source contract for sharing mask guard probes."""

import ast
import inspect
from pathlib import Path
import sys
import textwrap
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent / 'engine' / 'Rope'))

import torch
from rope.VideoManager import v2
from experiment_mask_overlap import _compute_guards, _guard_probe


class SharedMaskProbeTests(unittest.TestCase):
    def test_one_probe_precedes_all_entry_reductions(self):
        tree = ast.parse(textwrap.dedent(inspect.getsource(_compute_guards)))
        loop = next(node for node in ast.walk(tree) if isinstance(node, ast.For))
        calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Name)
                 and node.func.id == '_guard_probe']
        self.assertEqual(len(calls), 1)
        self.assertFalse(any(node is calls[0] for node in ast.walk(loop)))
        self.assertTrue(any(isinstance(node, ast.IfExp) and calls[0] in ast.walk(node)
                            for node in ast.walk(tree)))

    def test_shared_probe_and_per_anchor_guard_values_are_bit_exact(self):
        torch.manual_seed(3042)
        for dtype in (torch.uint8, torch.float32):
            source = torch.randint(0, 256, (3, 1024, 1024), dtype=torch.uint8)
            if dtype == torch.float32:
                source = source.to(dtype)
            shared = _guard_probe(source)
            original = v2.functional.resize(
                source.to(torch.float32), [64, 64],
                interpolation=v2.InterpolationMode.BILINEAR, antialias=False,
            )
            self.assertTrue(torch.equal(shared, original))
            for _ in range(2):
                prior = torch.randn_like(shared)
                self.assertTrue(torch.equal(torch.abs(shared - prior),
                                            torch.abs(original - prior)))


if __name__ == '__main__':
    unittest.main()
