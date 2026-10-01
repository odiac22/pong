"""CPU contracts; CUDA primitive and whole-video parity are separate gates."""
import ast
import inspect
from pathlib import Path
import sys
import textwrap
import unittest

import torch

sys.path.insert(0, str(Path(__file__).parent / 'engine' / 'Rope'))
from rope import VideoManager as module
from experiment_restorer_guard_graph import transform_source


class RestorerGraphContracts(unittest.TestCase):
    def test_source_transform_preserves_decision_logic(self):
        original = textwrap.dedent(inspect.getsource(module.VideoManager._apply_restorer_inner))
        source = transform_source(original)
        ast.parse(source)
        self.assertEqual(source.count('self._isolated_restorer_guard_graph('), 1)
        # No rejection threshold, clock, identity or shot-cut policy is replaced.
        for literal in ("uncertain_fraction <= 0.15", "maxInputMae", "maxInputPatchMae",
                        "forceExactReasons", "nonpositive-age", "invalid-state",
                        "signature", "identity-deadline", "frame-age"):
            self.assertEqual(source.count(literal), original.count(literal))
        with self.assertRaises(RuntimeError):
            transform_source(original.replace('torch.mean(delta)', 'torch.mean(delta) + 1'))

    def test_tensor_history_weight_matches_original_scalar_conversion(self):
        generator = torch.Generator().manual_seed(9403)
        a = torch.rand((3, 19, 21), generator=generator) * 255
        b = torch.rand((3, 19, 21), generator=generator) * 255
        confidence = torch.rand((1, 19, 21), generator=generator)
        for elapsed in (1/60, 1/50, 1/30, 1/25, 1/24, .001, .24999):
            scalar = 0.5 ** (elapsed / .04)
            expected = a + (b - a) * (scalar * confidence)
            weight = torch.empty((), dtype=torch.float32).fill_(scalar)
            actual = a + (b - a) * (weight * confidence)
            self.assertTrue(torch.equal(expected, actual))

    def test_combined_scores_do_not_round_local_confidence(self):
        generator = torch.Generator().manual_seed(5904)
        current = torch.rand((3, 32, 32), generator=generator) * 255
        previous = current + torch.randn((3, 32, 32), generator=generator) * 8
        delta = torch.abs(current - previous)
        patches = torch.nn.functional.avg_pool2d(delta.mean(dim=0, keepdim=True)[None], 8, 8)
        maximum, index = torch.max(patches.reshape(-1), dim=0)
        confidence = module._correction_confidence(current, previous)
        uncertain = (confidence < .25).float().mean()
        scores = (torch.isfinite(delta).all(), delta.mean(), maximum, index, uncertain)
        self.assertEqual(torch.stack(scores).tolist(), [value.item() for value in scores])


if __name__ == '__main__':
    unittest.main()
