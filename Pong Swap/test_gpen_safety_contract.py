"""Source/fake-only safety regression checks; no GPU imports or saved presets."""
import gc
import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest import mock
import weakref

ROOT = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bench = load('gpen_safety_benchmark', ROOT / 'benchmark_gpen_generated.py')


class SafetyContracts(unittest.TestCase):
    def test_bootstrap_retains_dll_registration_after_return_and_gc(self):
        with mock.patch.dict(os.environ):
            native = load('gpen_native_subject', ROOT / 'engine' / 'Rope' / 'rope' / '_native_dlls.py')
        refs = []
        class Handle:
            pass
        def register(directory):
            handle = Handle()
            refs.append(weakref.ref(handle))
            return handle
        with mock.patch.object(native.sys, 'platform', 'win32'), \
             mock.patch.object(native.importlib, 'import_module', return_value=SimpleNamespace(__file__='/synthetic/trt/__init__.py')), \
             mock.patch.object(native.os.path, 'isdir', return_value=True), \
             mock.patch.object(native.os, 'add_dll_directory', side_effect=register, create=True) as add:
            self.assertEqual(len(native.ensure_native_dll_search_path()), 1)
            gc.collect()
            self.assertIsNotNone(refs[0]())
            self.assertEqual(native.ensure_native_dll_search_path(), [])
            self.assertEqual(add.call_count, 1)
            self.assertIs(native._NATIVE_DLL_DIRECTORY_HANDLES[0], refs[0]())

    def test_cuda_bootstrap_never_discovers_or_loads_tensorrt(self):
        ort = SimpleNamespace(set_default_logger_severity=mock.Mock())
        with mock.patch.dict(sys.modules, {'numpy': SimpleNamespace(), 'torch': SimpleNamespace(), 'onnxruntime': ort}), \
             mock.patch.dict(os.environ), \
             mock.patch.object(bench.importlib.util, 'find_spec', side_effect=AssertionError('TRT discovery')), \
             mock.patch.object(bench.ctypes, 'WinDLL', side_effect=AssertionError('TRT load'), create=True):
            *_, handles = bench.bootstrap_libraries(enable_tensorrt=False)
            self.assertIs(handles, bench._DLL_HANDLES)
            self.assertEqual(handles, [])

    def test_cuda_preference_covers_both_sizes_including_diagnostic_arm_f(self):
        torch = SimpleNamespace(empty=mock.Mock(), float32='float32',
                                cuda=SimpleNamespace(Stream=lambda **kw: SimpleNamespace(cuda_stream=123)))
        owner = bench.Owner(torch, None, Path('/models'), Path('/cache'), 'onnx')
        for edge in (256, 512):
            self.assertEqual(owner.get_backend_preference(f'GPEN_{edge}_model'), 'onnx')

    def test_cuda_factory_rejects_trt_and_implicit_selection_before_ort(self):
        factory = mock.Mock()
        timed = bench.TimedOrt(SimpleNamespace(InferenceSession=factory))
        for providers in ([], ['TensorrtExecutionProvider'], [('TensorrtExecutionProvider', {})]):
            with self.subTest(providers=providers), self.assertRaisesRegex(RuntimeError, 'unapproved'):
                timed.InferenceSession('/synthetic/model.onnx', providers=providers)
        factory.assert_not_called()
        timed.InferenceSession('/synthetic/model.onnx', providers=['CUDAExecutionProvider'])
        factory.assert_called_once()

    def test_tokens_alone_cannot_release_worker_without_supervisor_pipe(self):
        with mock.patch.dict(os.environ, {bench.SUPERVISOR_TOKEN_ENV: 'synthetic-token'}), \
             mock.patch.object(bench.os, 'fstat', return_value=SimpleNamespace(st_mode=stat.S_IFREG)), \
             mock.patch.object(bench, 'worker', side_effect=AssertionError('GPU worker started')):
            with self.assertRaisesRegex(RuntimeError, 'supervisor pipe'):
                bench.main(['--output-dir', 'unused-output', '--worker-arm', 'C',
                            '--supervisor-token', 'synthetic-token'])

    def test_nan_and_infinite_limits_and_headroom_fail_closed(self):
        for value in ('nan', 'inf', '0', '-1', '1801'):
            with self.subTest(value=value), self.assertRaises(ValueError), \
                 mock.patch.object(bench, 'query_gpu', side_effect=AssertionError('GPU queried')):
                bench.main(['--output-dir', 'unused-output', '--run-timeout', value])
        for value in (float('nan'), float('inf'), -1):
            self.assertIsNotNone(bench.safety_reason([{'freeMiB': value, 'utilizationPercent': 0}]))

    def test_wrong_device_and_invalid_telemetry_are_rejected(self):
        for row in ('0, another GPU, 12000, 1000, 11000, 0',
                    '0, NVIDIA GeForce RTX 4070, 12000, 1000, nan, 0',
                    '0, NVIDIA GeForce RTX 4070, 12000, 1000, 13000, 0',
                    '0, NVIDIA GeForce RTX 4070, 12000, 1000, 11000, 101'):
            with self.subTest(row=row), mock.patch.object(bench.subprocess, 'run',
                    return_value=subprocess.CompletedProcess([], 0, row)), self.assertRaises(RuntimeError):
                bench.query_gpu()

    def test_no_gpu_or_production_module_was_imported(self):
        for name in ('torch', 'onnxruntime', 'tensorrt', 'pong_swap_engine', 'pong_swap_config', 'rope'):
            self.assertNotIn(name, sys.modules)


if __name__ == '__main__':
    unittest.main()
