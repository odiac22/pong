"""CPU-only benchmark checks. No engine, CUDA libraries or model files loaded."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location('gpen_benchmark', Path(__file__).with_name('benchmark_gpen_generated.py'))
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


class BenchmarkTests(unittest.TestCase):
    def test_import_is_gpu_and_engine_free(self):
        for name in ('torch', 'onnxruntime', 'tensorrt', 'pong_swap_engine', 'pong_swap_config', 'rope'):
            self.assertNotIn(name, sys.modules)

    def test_generated_fixtures_are_deterministic_contiguous_and_distinct(self):
        for kind in bench.KINDS:
            first = bench.generated_fixture(np, kind, 0)
            second = bench.generated_fixture(np, kind, 1)
            self.assertEqual(first.shape, (1, 3, 512, 512))
            self.assertEqual(first.dtype, np.float32)
            self.assertTrue(first.flags.c_contiguous)
            self.assertGreaterEqual(float(first.min()), -1)
            self.assertLessEqual(float(first.max()), 1)
            self.assertTrue(np.array_equal(first, bench.generated_fixture(np, kind, 0)))
            self.assertFalse(np.array_equal(first, second))

    def test_balanced_alternating_orders(self):
        orders = [bench.arm_order(index) for index in range(2 * len(bench.ARMS))]
        self.assertEqual(orders[:2], [list(bench.ARMS), list(reversed(bench.ARMS))])
        for position in range(len(bench.ARMS)):
            for arm in bench.ARMS:
                self.assertEqual(sum(order[position] == arm for order in orders), 2)

    def test_cuda_only_is_the_safe_default(self):
        args = bench.parser().parse_args(['--output-dir', 'fixture-output'])
        self.assertEqual(args.arms, ['B', 'C'])
        self.assertFalse(args.enable_tensorrt_build)
        self.assertEqual(args.worker_timeout, 120.0)
        self.assertEqual(bench.arm_order(0, args.arms), ['B', 'C'])
        self.assertEqual(bench.arm_order(1, args.arms), ['C', 'B'])

    def test_cuda_graph_provider_option_is_explicit_and_isolated(self):
        owner = object.__new__(bench.Owner)
        owner._shared_compute_stream = SimpleNamespace(cuda_stream=123)
        owner._enable_cuda_graph = False
        self.assertNotIn('enable_cuda_graph', owner._cuda_ep_provider_options())
        owner._enable_cuda_graph = True
        self.assertEqual(owner._cuda_ep_provider_options()['enable_cuda_graph'], '1')

    def test_tensorrt_arm_requires_explicit_opt_in_before_gpu_preflight(self):
        with tempfile.TemporaryDirectory(prefix='generated-gpen-test-') as directory:
            with self.assertRaisesRegex(ValueError, 'explicit --enable-tensorrt-build'):
                bench.main(['--output-dir', directory, '--arms', 'D'])

    def test_timeout_is_hard_bounded_before_gpu_preflight(self):
        with tempfile.TemporaryDirectory(prefix='generated-gpen-test-') as directory:
            with self.assertRaisesRegex(ValueError, 'no more than'):
                bench.main(['--output-dir', directory, '--worker-timeout', '301'])

    def test_direct_worker_entry_requires_supervisor_token_before_gpu_imports(self):
        previous = os.environ.pop(bench.SUPERVISOR_TOKEN_ENV, None)
        try:
            with tempfile.TemporaryDirectory(prefix='generated-gpen-test-') as directory:
                with self.assertRaisesRegex(RuntimeError, 'only under the safety supervisor'):
                    bench.main(['--output-dir', directory, '--worker-arm', 'C'])
            self.assertNotIn('torch', sys.modules)
            self.assertNotIn('onnxruntime', sys.modules)
        finally:
            if previous is not None:
                os.environ[bench.SUPERVISOR_TOKEN_ENV] = previous

    def test_exact_metrics_pass_and_serialize_infinity_safely(self):
        value = bench.generated_fixture(np, 'ramp', 0, edge=32)[0]
        result = bench.numerical_metrics(np, value, value)
        self.assertTrue(result['pass'])
        self.assertTrue(result['exactMatch'])
        self.assertEqual(result['mae'], 0)
        self.assertIsNone(result['psnrDb'])
        self.assertAlmostEqual(result['ssim'], 1)

    def test_known_constant_error(self):
        reference = np.zeros((3, 32, 32), dtype=np.float32)
        candidate = reference + np.float32(2 / 127.5)
        result = bench.numerical_metrics(np, reference, candidate)
        self.assertFalse(result['pass'])
        self.assertAlmostEqual(result['mae'], 2, places=5)
        self.assertAlmostEqual(result['maxAbs'], 2, places=5)
        self.assertAlmostEqual(result['psnrDb'], 20 * np.log10(255 / 2), places=5)

    def test_shape_and_nonfinite_fail(self):
        value = np.zeros((3, 32, 32))
        self.assertFalse(bench.numerical_metrics(np, value, value[:, :20])['pass'])
        value[0, 0, 0] = np.nan
        self.assertFalse(bench.numerical_metrics(np, value, value)['pass'])

    def test_temporal_detects_stale_frame(self):
        previous = np.zeros((3, 32, 32))
        current = previous + 1 / 127.5
        self.assertAlmostEqual(bench.temporal_mae(np, previous, current, previous, previous), 1)
        self.assertEqual(bench.temporal_mae(np, previous, current, previous, current), 0)

    def test_safety_requires_idle_and_free_memory(self):
        self.assertIsNone(bench.safety_reason([{'freeMiB': 10000, 'utilizationPercent': 0}]))
        self.assertIsNotNone(bench.safety_reason([{'freeMiB': 5000, 'utilizationPercent': 0}]))
        self.assertIsNotNone(bench.safety_reason([{'freeMiB': 10000, 'utilizationPercent': 70}]))
        self.assertIsNotNone(bench.safety_reason([]))

    def test_frozen_legacy_session_policy_and_fallback(self):
        calls = []
        fail_trt = False
        def factory(path, **kwargs):
            calls.append(kwargs)
            providers = kwargs['providers']
            names = [p[0] if isinstance(p, tuple) else p for p in providers]
            if fail_trt and 'TensorrtExecutionProvider' in names:
                raise RuntimeError('synthetic TRT failure')
            return SimpleNamespace(get_providers=lambda: names)
        with tempfile.TemporaryDirectory(prefix='generated-gpen-test-') as directory:
            owner = SimpleNamespace(
                ort=SimpleNamespace(InferenceSession=factory),
                _mp=lambda name: str(Path(directory) / name),
                _cuda_ep_provider_options=lambda search: {'user_compute_stream': '123', 'cudnn_conv_algo_search': search},
                _make_session_options=lambda: 'frozen-options')
            bench.legacy_session(owner, 512)
            self.assertEqual(calls[-1], {'providers': ['CUDAExecutionProvider']})
            bench.legacy_session(owner, 256)
            providers = calls[-1]['providers']
            self.assertEqual(calls[-1]['sess_options'], 'frozen-options')
            self.assertNotIn('user_compute_stream', providers[0][1])
            self.assertEqual(providers[0][1]['trt_max_workspace_size'], 3 << 30)
            self.assertTrue(providers[0][1]['trt_fp16_enable'])
            self.assertEqual(providers[0][1]['trt_builder_optimization_level'], 5)
            self.assertEqual(providers[1][1]['user_compute_stream'], '123')
            fail_trt = True
            _, reason = bench.legacy_session(owner, 256)
            self.assertIn('synthetic TRT failure', reason)
            self.assertEqual([p[0] for p in calls[-1]['providers']], ['CUDAExecutionProvider'])

    def test_missing_rounds_cannot_pass_quality(self):
        with tempfile.TemporaryDirectory(prefix='generated-gpen-test-') as directory:
            result = bench.aggregate(np, Path(directory), [], 'smoke')
        self.assertFalse(result['quality']['C']['pass'])
        self.assertFalse(result['quality']['D']['pass'])
        self.assertEqual(result['latencyGate']['C']['status'], 'incomplete')

    def test_copy_ablation_separates_binding_and_wrapper_cost(self):
        samples = [{'iteration': 0, 'variant': key, 'completedMs': value} for key, value in
                   {'primary': 12.3, 'per_call_direct': 10.2, 'persistent_direct': 10,
                    'persistent_copy': 12}.items()]
        result = bench.paired_ablation([{'arm': 'C', 'samples': samples}], 'C')
        self.assertAlmostEqual(result['isolatedMeanDeltasMs']['twoDeviceCopiesMs'], 2)
        self.assertAlmostEqual(result['isolatedMeanDeltasMs']['bindingCreationMs'], .2)
        self.assertAlmostEqual(result['isolatedMeanDeltasMs']['runtimeWrapperMs'], .3)
        self.assertFalse(result['measuredFaster'])


if __name__ == '__main__':
    unittest.main()
