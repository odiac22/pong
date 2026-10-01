"""CPU-only integrity checks for the frozen exact candidate snapshot."""

import importlib
import inspect
import json
import gc
from pathlib import Path
import queue
import sys
import subprocess
import unittest
from unittest import mock
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'engine' / 'Rope'))

from pong_exact_acceleration import bind_static_method  # noqa: E402
from pong_exact_runtime import frozen_factories, frozen_methods  # noqa: E402
from pong_exact_runtime import install as runtime_install  # noqa: E402


class FrozenRuntimeTests(unittest.TestCase):
    def setUp(self):
        # Earlier lifecycle tests use PongSwapEngine.__new__ test doubles with
        # deliberately populated _vm/_models fields. Their assertion/mock
        # reference cycles can outlive the test method until a cyclic GC pass;
        # production's cold guard correctly counts every still-reachable
        # engine, so collect only these abandoned CPU fixtures before testing
        # a fresh cold install. Never weaken the runtime guard itself.
        gc.collect()

    def test_bundle_integrity(self):
        self.assertEqual(runtime_install.verify_bundle(), 'qualified')

    def test_frozen_methods_include_current_production_changes(self):
        # Capture in another process: experiment installers mutate classes.
        result = subprocess.run([sys.executable, str(ROOT / 'pong_exact_runtime' / 'build_frozen.py'), '--check'],
                                cwd=ROOT, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_all_generated_sources_are_importable_and_hash_matched(self):
        manifest = json.loads((ROOT / 'pong_exact_runtime' / 'frozen_manifest.json').read_text())
        for row in manifest:
            if not row['captured']:
                continue
            self.assertTrue(hasattr(frozen_methods, row['method']))

    def test_static_candidates_bind_against_original_signatures(self):
        manifest = json.loads((ROOT / 'pong_exact_runtime' / 'frozen_manifest.json').read_text())
        extras = {
            '_detect_retinaface_inner': {'_isolated_retinaface_compact'},
            '_produce_session': {'AsyncReadbackLease', '_account_output_segments',
                                 '_drain_abandoned_outputs'},
            '_match_lab_color': {'_isolated_lab_transfer'},
        }
        for row in manifest:
            if not row['captured'] or row['method'].endswith('_core'):
                continue
            module = importlib.import_module(row['module'])
            owner = getattr(module, row['owner']) if row['owner'] else module
            with self.subTest(method=row['method']):
                bound = bind_static_method(
                    getattr(owner, row['method']),
                    getattr(frozen_methods, row['method']),
                    extra_global_names=extras.get(row['method'], ()),
                )
                self.assertIs(bound.__globals__, getattr(owner, row['method']).__globals__)

    def test_generated_factories_create_closures_without_gpu_work(self):
        from rope import VideoManager as vm
        import pong_swap_engine

        for name, call in (
            ('prefix', lambda: frozen_factories.make_prefix()),
            ('mask_tail', lambda: frozen_factories.make_mask_tail()),
            ('restorer_prepare', lambda: frozen_factories.make_restorer_prepare()),
            ('mask_overlap', lambda: frozen_factories.make_mask_overlap(
                vm, vm.VideoManager._temporal_mask_result)),
            ('identity_guard', lambda: frozen_factories.make_identity_guard()),
            ('async_readback', lambda: frozen_factories.make_async_readback(
                pong_swap_engine.PongSwapEngine)),
            ('lab_inverse', lambda: frozen_factories.make_lab_inverse()),
        ):
            with self.subTest(factory=name):
                result = call()
                self.assertTrue(result)
                self.assertTrue(all(callable(value) for value in result.values()))

    def test_cold_install_then_rollback_restores_every_owner(self):
        class FakeGate:
            def __init__(self):
                self.started = False

            def qualify_cold(self):
                return {'features': {name: 'qualified' for name in
                                     runtime_install.REQUIRED_FEATURES}}

            def status(self):
                return {'started': self.started}

            def start(self):
                self.started = True

        from rope import VideoManager as vm
        from rope import Models as models
        from rope import gpen_runtime as gpen
        import pong_swap_engine
        from pong_exact_runtime.vendor import experiment_color_lut as color
        from pong_exact_runtime.vendor import experiment_mask_overlap as overlap

        owners = (vm, models, gpen, pong_swap_engine,
                  vm.VideoManager, models.Models, gpen.GPENRuntime,
                  pong_swap_engine.PongSwapEngine, color)
        before = [dict(vars(owner)) for owner in owners]
        handle = runtime_install.install_cold(
            ROOT / 'models', binding_token=('test',), gate=FakeGate(),
        )
        try:
            self.assertTrue(handle.installed)
            self.assertEqual(handle.reason, 'installed-cold')
            self.assertTrue(handle.binding_matches(('test',)))
            self.assertFalse(handle.binding_matches(('changed',)))
            self.assertIs(models.Models._detect_retinaface_inner.__globals__[
                '_isolated_retinaface_compact'],
                vars(models)['_isolated_retinaface_compact'])
            self.assertIn('_isolated_lab_transfer',
                          vm._match_lab_color.__globals__)
            self.assertIs(color._original, before[0]['_rgb_chw_to_lab'])
            self.assertIs(vm.VideoManager._isolated_mask_overlap_launch,
                          overlap._launch)
            self.assertIn('identityPending',
                          vm.VideoManager._isolated_mask_overlap_launch.__code__.co_consts)
            for name in ('AsyncReadbackLease', '_account_output_segments',
                         '_drain_abandoned_outputs'):
                self.assertIn(name,
                              pong_swap_engine.PongSwapEngine._produce_session.__globals__)
        finally:
            handle.rollback_cold()
        for owner, original in zip(owners, before):
            self.assertEqual(set(vars(owner)), set(original))
            self.assertTrue(all(vars(owner)[key] is value
                                for key, value in original.items()))

    def test_mid_install_exception_rolls_back_cold_assignments(self):
        from rope import VideoManager as vm
        from pong_exact_runtime.vendor import experiment_confidence_twopass as confidence

        class FakeGate:
            def qualify_cold(self):
                return {'features': {name: 'qualified' for name in
                                     runtime_install.REQUIRED_FEATURES}}

            def status(self):
                return {'started': False}

        before = dict(vars(vm))
        with mock.patch.object(confidence, 'install', side_effect=RuntimeError('test failure')):
            with self.assertRaisesRegex(RuntimeError, 'test failure'):
                runtime_install.install_cold(
                    ROOT / 'models', binding_token=('test',), gate=FakeGate(),
                )
        self.assertEqual(set(vars(vm)), set(before))
        self.assertTrue(all(vars(vm)[key] is value for key, value in before.items()))

    def test_qualification_mismatch_never_mutates_methods(self):
        from rope.VideoManager import VideoManager

        class FakeGate:
            def qualify_cold(self):
                return {'features': {name: 'unsupported-sm' for name in
                                     runtime_install.REQUIRED_FEATURES}}

            def status(self):
                return {'started': False}

        original = VideoManager.swap_core
        handle = runtime_install.install_cold(
            ROOT / 'models', binding_token=('test',), gate=FakeGate(),
        )
        self.assertFalse(handle.installed)
        self.assertEqual(handle.reason, 'qualification-mismatch')
        self.assertIs(VideoManager.swap_core, original)

    def test_model_binding_token_ignores_quality_but_detects_provider_change(self):
        base = {'runtime': {'backend': 'trt', 'maskBackendPreference': 'trt',
                            'restorerBackendPreference': 'native-trt'},
                'parameters': {'ModelSessionsTextSel': 'Shared',
                               'BlendSlider': 25}}
        first = runtime_install.model_binding_token(base, ROOT / 'models')
        base['parameters']['BlendSlider'] = 75
        self.assertEqual(runtime_install.model_binding_token(base, ROOT / 'models'), first)
        base['runtime']['backend'] = 'cuda'
        self.assertNotEqual(runtime_install.model_binding_token(base, ROOT / 'models'), first)

    def test_repeat_install_rejected_and_no_runtime_source_rewrite(self):
        class FakeGate:
            def qualify_cold(self):
                return {'features': {name: 'qualified' for name in
                                     runtime_install.REQUIRED_FEATURES}}

            def status(self):
                return {'started': False}

        # Importing Python modules may use CPython's loader machinery. Block
        # source rewrite only after the frozen Python modules are loaded.
        import pong_exact_runtime.vendor.experiment_color_lut
        import pong_exact_runtime.vendor.experiment_restorer_guard_graph
        import pong_exact_runtime.vendor.experiment_native_detection
        import pong_exact_runtime.vendor.experiment_native_swapper
        import pong_exact_runtime.vendor.experiment_confidence_twopass
        import pong_exact_runtime.vendor.experiment_input_warp_graph
        import pong_exact_runtime.vendor.experiment_pasteback_matrix
        import pong_exact_runtime.vendor.experiment_restorer_display_graph
        import pong_exact_runtime.vendor.experiment_frame_transfers
        with (mock.patch.object(inspect, 'getsource', side_effect=AssertionError('getsource')),
              mock.patch('builtins.compile', side_effect=AssertionError('compile')),
              mock.patch('builtins.exec', side_effect=AssertionError('exec'))):
            handle = runtime_install.install_cold(
                ROOT / 'models', binding_token=('test',), gate=FakeGate(),
            )
        try:
            self.assertTrue(handle.installed)
            with self.assertRaisesRegex(RuntimeError, 'already installed'):
                runtime_install.install_cold(
                    ROOT / 'models', binding_token=('test',), gate=FakeGate(),
                )
        finally:
            handle.rollback_cold()

    def test_started_fallback_requires_full_quiescence_and_restores_originals(self):
        from rope.VideoManager import VideoManager

        class FakeGate:
            started = False

            def qualify_cold(self):
                return {'features': {name: 'qualified' for name in
                                     runtime_install.REQUIRED_FEATURES}}

            def status(self):
                return {'started': self.started}

            def start(self):
                self.started = True

            def close(self):
                return True

        original_swap = VideoManager.swap_core
        handle = runtime_install.install_cold(
            ROOT / 'models', binding_token=('test',), gate=FakeGate(),
        )
        handle.mark_started()
        engine = SimpleNamespace(
            _models=None, _vm=None, _compute_stream=None,
            _warming_models=None, _warming_stream=None,
            _pipeline_warm_signature=None,
            _gpu_worker_thread=SimpleNamespace(is_alive=lambda: True),
            _gpu_worker_inflight=0, _gpu_worker_queue=queue.Queue(),
            _sessions={}, _session_has_live_resources=lambda session: False,
        )
        retired_vm = SimpleNamespace(_isolated_mask_overlap=None,
                                     _experimental_swap_prefix_graphs={},
                                     _experimental_mask_tail_graphs={})
        engine._vm = retired_vm
        engine._models = object()
        handle.note_warm_binding(engine)
        engine._vm = None
        engine._models = None
        self.assertIsNot(VideoManager.swap_core, original_swap)
        with self.assertRaisesRegex(RuntimeError, 'GPU worker'):
            handle.deactivate_after_unload(engine, retired_vm=retired_vm)
        self.assertTrue(handle.installed)
        engine._gpu_worker_thread = None
        with self.assertRaisesRegex(RuntimeError, 'side workers'):
            retired_vm._isolated_mask_overlap = {'pending': object()}
            handle.deactivate_after_unload(engine, retired_vm=retired_vm)
        retired_vm._isolated_mask_overlap = None
        handle.deactivate_after_unload(engine, retired_vm=retired_vm)
        self.assertFalse(handle.installed)
        self.assertEqual(handle.reason, 'original-fallback-after-quiescent-unload')
        self.assertIs(VideoManager.swap_core, original_swap)
        with self.assertRaisesRegex(RuntimeError, 'already installed'):
            runtime_install.install_cold(ROOT / 'models', binding_token=('test',),
                                         gate=FakeGate())


if __name__ == '__main__':
    unittest.main()
