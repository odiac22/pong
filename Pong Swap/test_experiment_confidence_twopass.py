"""CPU-only fallback contracts for the two-pass confidence experiment."""

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent / 'engine' / 'Rope'))

import torch
import experiment_confidence_twopass as experiment


class ConfidenceTwoPassTests(unittest.TestCase):
    def test_cpu_fallback_and_idempotent_install(self):
        from rope import VideoManager as module

        original = module._correction_confidence
        try:
            a = torch.arange(3 * 5 * 7, dtype=torch.float32).reshape(3, 5, 7)
            b = a + 2
            expected = original(a, b)
            experiment.install()
            patched = module._correction_confidence
            self.assertTrue(torch.equal(patched(a, b), expected))
            experiment.install()
            self.assertIs(module._correction_confidence, patched)
            with self.assertRaises(RuntimeError):
                patched(torch.empty((3, 0, 7)), torch.empty((3, 0, 7)))
        finally:
            module._correction_confidence = original


if __name__ == '__main__':
    unittest.main()
