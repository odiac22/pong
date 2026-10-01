"""CPU fallback and opt-in contract; GPU primitives run only when scheduled."""

import inspect
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock

import torch

import experiment_identity_delta_kernel as kernel
from experiment_identity_delta_kernel import _qualified, mean_abs_delta, SOURCE
import experiment_identity_guard_overlap as overlap


class IdentityDeltaKernelTests(unittest.TestCase):
    def test_cpu_and_unsupported_layouts_use_original_expression(self):
        torch.manual_seed(3061)
        for dtype in (torch.uint8, torch.float32):
            if dtype == torch.uint8:
                source = torch.randint(0, 256, (3, 9, 13), dtype=dtype)
                prior = torch.randint(0, 256, (3, 9, 13), dtype=dtype)
            else:
                source = torch.randn((3, 9, 13), dtype=dtype)
                prior = torch.randn((3, 9, 13), dtype=dtype)
                source[0, 0, 0] = float('nan')
            for current, old in ((source, prior),
                                 (source.transpose(1, 2), prior.transpose(1, 2))):
                self.assertFalse(_qualified(current, old))
                expected = torch.mean(torch.abs(current.to(torch.float32)
                                                - old.to(torch.float32)),
                                      dim=0, keepdim=True)
                actual = mean_abs_delta(current, old)
                torch.testing.assert_close(actual, expected, rtol=0, atol=0,
                                           equal_nan=True)

    def test_kernel_is_explicitly_opt_in_and_preserves_scalar_order(self):
        signature = inspect.signature(overlap.install)
        self.assertIs(signature.parameters['fused_delta'].default, False)
        self.assertIn('mean_abs_delta(current, prior) if fused_delta',
                      inspect.getsource(overlap.install))
        self.assertEqual(SOURCE.count('((x + y) + z) * 0.3333333432674407958984375f'), 2)

    def test_compile_cache_is_idempotent_without_cuda(self):
        with mock.patch.object(kernel, '_module', None), mock.patch(
                'experiment_cuda_module.CudaModule') as compiler:
            first = kernel._ensure_module()
            self.assertIs(first, kernel._ensure_module())
            compiler.assert_called_once()

    def test_identity_install_is_idempotent_and_mode_locked(self):
        script = (
            "import sys; sys.path.insert(0, 'engine/Rope'); "
            "import experiment_identity_guard_overlap as e; "
            "first=e.install(fused_delta=True); "
            "assert e.install(fused_delta=True) is first\n"
            "try:\n e.install(fused_delta=False)\n"
            "except RuntimeError: pass\n"
            "else: raise AssertionError('mode switch accepted')\n"
        )
        result = subprocess.run(
            [sys.executable, '-c', script],
            cwd=Path(__file__).resolve().parent,
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
