"""CPU-only admission and original-fallback contracts for the unwired adapter."""

import copy
import os
from pathlib import Path
import queue
import threading
import time
import unittest
from unittest import mock
from types import SimpleNamespace

from pong_exact_runtime.install import model_binding_token
from pong_exact_runtime.service_adapter import ExactServiceAdapter, bootstrap_cold


MODEL_DIR = Path(__file__).parent / 'runtime' / 'models'


def _config(backend='trt', blend=25, detector='SCRDF',
            swapper='128', restorer='GPEN-1024'):
    return {'runtime': {'backend': backend,
                        'restorerBackendPreference': 'native-trt',
                        'maskBackendPreference': 'trt',
                        'orderedGpuSubmission': True},
            'parameters': {'ModelSessionsTextSel': 'Shared',
                           'DetectTypeTextSel': detector,
                           'DetectInputSizeTextSel': '640',
                           'SwapperTypeTextSel': swapper,
                           'RestorerTypeTextSel': restorer,
                           'BlendSlider': blend}}


class _Gate:
    def __init__(self):
        self.started = False

    def status(self):
        return {'started': self.started}


class _Handle:
    def __init__(self, token):
        self.binding_token = token
        self.installed = True
        self.gate = _Gate()
        self.reason = 'installed-cold'
        self.retired = None
        self.adapter = None

    def status(self):
        return {'installed': self.installed, 'reason': self.reason}

    def binding_matches(self, token):
        return self.installed and token == self.binding_token

    def mark_started(self):
        self.gate.started = True

    def note_warm_binding(self, engine):
        self.retired = engine._vm

    def rollback_cold(self):
        self.installed = False
        self.reason = 'cold-rollback'

    def deactivate_after_unload(self, engine, *, retired_vm):
        assert retired_vm is self.retired
        assert engine._vm is None and engine._models is None
        assert engine._gpu_worker_thread is None
        assert engine._gpu_worker_queue.empty()
        # Instance admission gate must outlive class method restoration.
        assert engine.__dict__['_run_gpu_work'] is not self.adapter._original['_run_gpu_work']
        assert self.adapter.status()['transitioning']
        self.installed = False
        self.reason = 'original-fallback-after-quiescent-unload'


class _Engine:
    def __init__(self):
        self._config = _config()
        self._vm = None
        self._models = None
        self._gpu_worker_ident = -1
        self._gpu_worker_thread = None
        self._gpu_worker_queue = queue.Queue()
        self._lock = threading.RLock()
        self.active_sessions = 0
        self.create_calls = 0
        self.create_kwargs = []
        self.warm_calls = 0
        self.unload_calls = 0
        self.shutdown_result = True

    @property
    def config(self):
        return copy.deepcopy(self._config)

    def _normalized_config(self, candidate):
        return copy.deepcopy(candidate)

    def _model_lifecycle_changed(self, before, after):
        for section, key in (('runtime', 'backend'),
                             ('parameters', 'DetectTypeTextSel'),
                             ('parameters', 'DetectInputSizeTextSel')):
            if before[section][key] != after[section][key]:
                return True
        return False

    def _active_session_count(self):
        return self.active_sessions

    def _run_gpu_work(self, callback, *args, **kwargs):
        return callback(*args)

    def create_session(self, *args, **kwargs):
        self.create_calls += 1
        self.create_kwargs.append(kwargs)
        self.active_sessions += 1
        return object()

    def warm(self, *args, **kwargs):
        self.warm_calls += 1
        self._vm = object()
        self._models = object()
        return {'ready': True}

    def update_config(self, candidate, *args, **kwargs):
        lifecycle_changed = self._model_lifecycle_changed(self._config, candidate)
        self._config = copy.deepcopy(candidate)
        if lifecycle_changed:
            self._vm = None
            self._models = None
        return self.config

    def unload(self):
        self.unload_calls += 1
        self._vm = None
        self._models = None

    def shutdown_gpu_worker(self, *, timeout):
        return self.shutdown_result

    def health(self):
        return {'ready': True}


class ServiceAdapterTests(unittest.TestCase):
    def _attached(self):
        engine = _Engine()
        handle = _Handle(model_binding_token(engine.config, MODEL_DIR))
        adapter = ExactServiceAdapter(engine, handle, MODEL_DIR,
                                      drain_timeout=1.0).attach()
        handle.adapter = adapter
        return engine, handle, adapter

    def test_quality_edit_keeps_acceleration_and_backend_edit_falls_back(self):
        engine, handle, adapter = self._attached()
        engine.warm()
        changed_quality = _config(blend=80)
        engine.update_config(changed_quality, persist=False)
        self.assertTrue(handle.installed)
        self.assertEqual(engine.config['parameters']['BlendSlider'], 80)
        engine.update_config(_config(backend='onnx', blend=80), persist=False)
        self.assertFalse(handle.installed)
        self.assertEqual(engine.unload_calls, 1)
        self.assertFalse(adapter.status()['restartRequired'])
        self.assertEqual(engine.health()['exactAcceleration']['acceleration']['reason'],
                         'original-fallback-after-quiescent-unload')
        self.assertEqual(engine.update_config(_config(backend='cuda'))['runtime']['backend'],
                         'cuda')

    def test_active_session_conflicts_before_closing_admissions(self):
        engine, handle, adapter = self._attached()
        engine.warm()
        engine.active_sessions = 1
        with self.assertRaisesRegex(Exception, 'Stop active sessions'):
            engine.update_config(_config(backend='onnx'))
        self.assertFalse(adapter.status()['transitioning'])
        self.assertTrue(handle.installed)
        self.assertEqual(engine.unload_calls, 0)

    def test_session_diagnostics_default_off_but_explicit_debug_respected(self):
        engine, _, _ = self._attached()
        engine.create_session()
        engine.create_session(diagnostics_enabled=True)
        self.assertEqual(engine.create_kwargs[0]['diagnostics_enabled'], False)
        self.assertEqual(engine.create_kwargs[1]['diagnostics_enabled'], True)

    def test_detector_lifecycle_and_hot_model_choices_retire_to_original(self):
        for changed in (_config(detector='RetinaFace'),
                        _config(swapper='256'),
                        _config(restorer='GFPGAN')):
            with self.subTest(changed=changed['parameters']):
                engine, handle, adapter = self._attached()
                engine.warm()
                self.assertEqual(model_binding_token(changed, MODEL_DIR),
                                 handle.binding_token)
                engine.update_config(changed, persist=False)
                self.assertFalse(handle.installed)
                self.assertFalse(adapter.status()['restartRequired'])
                self.assertEqual(engine.config, changed)
                self.assertEqual(engine.unload_calls, 1)

    def test_same_token_postcommit_failure_stays_closed(self):
        engine, handle, adapter = self._attached()
        engine.warm()
        engine.shutdown_result = False
        with self.assertRaisesRegex(RuntimeError, 'did not stop'):
            engine.update_config(_config(detector='RetinaFace'))
        self.assertTrue(adapter.status()['restartRequired'])
        with self.assertRaisesRegex(Exception, 'transition is in progress'):
            engine.create_session()

    def test_owner_prewarms_once_per_vm(self):
        engine, _, adapter = self._attached()
        engine._gpu_worker_ident = threading.get_ident()
        engine._vm = SimpleNamespace(parameters={})
        from pong_exact_runtime.vendor import (
            experiment_color_lut as color,
            experiment_identity_blend as blend,
            experiment_identity_delta_kernel as delta,
            experiment_mask_overlap as overlap,
            experiment_u8_grid_sample as sampler,
        )
        with (mock.patch.object(color, 'prewarm') as color_warm,
              mock.patch.object(blend, 'prewarm') as blend_warm,
              mock.patch.object(delta, 'prewarm') as delta_warm,
              mock.patch.object(overlap, 'prewarm') as overlap_warm,
              mock.patch.object(sampler, 'prewarm') as sampler_warm):
            adapter._prewarm_on_owner(engine)
            adapter._prewarm_on_owner(engine)
            self.assertEqual([call.call_count for call in (
                color_warm, blend_warm, delta_warm,
                overlap_warm, sampler_warm)], [1] * 5)
            engine._vm = SimpleNamespace(parameters={})
            adapter._prewarm_on_owner(engine)
            self.assertEqual(color_warm.call_count, 2)

    def test_transition_does_not_reject_gpu_owner_nested_admission(self):
        engine, _, adapter = self._attached()
        engine._gpu_worker_ident = threading.get_ident()
        with adapter._condition:
            adapter._transitioning = True
            adapter._control_thread = -1
        adapter._enter(long=True)
        try:
            self.assertEqual(adapter.status()['admittedCalls'], 1)
        finally:
            adapter._leave(long=True)

    def test_bootstrap_failed_qualification_keeps_original_calls(self):
        from pong_exact_runtime import install as frozen
        engine = _Engine()
        original_warm = engine.warm
        handle = _Handle(model_binding_token(engine.config, MODEL_DIR))
        handle.installed = False
        handle.reason = 'qualification-mismatch'
        observed_policy = []
        def install(*args, **kwargs):
            observed_policy.append(os.environ.get('PONG_MASK_OVERLAP_POLICY'))
            return handle
        with (mock.patch.dict(os.environ, {}, clear=True),
              mock.patch.object(frozen, '_ACTIVE_HANDLE', None),
              mock.patch.object(frozen, 'install_cold_for_engine', side_effect=install)):
            self.assertEqual(bootstrap_cold(engine, requested=True), (handle, None))
            self.assertEqual(observed_policy, ['guarded'])
            self.assertIs(engine.warm.__func__, original_warm.__func__)
            self.assertEqual(engine.health()['exactAcceleration']['reason'],
                             'qualification-mismatch')
            self.assertTrue(engine.health()['exactAcceleration']['performanceQualifiedPolicy'])
            self.assertEqual(bootstrap_cold(engine, requested=True), (handle, None))

    def test_bootstrap_preserves_explicit_nonqualified_mask_policy(self):
        from pong_exact_runtime import install as frozen
        engine = _Engine()
        handle = _Handle(model_binding_token(engine.config, MODEL_DIR))
        handle.installed = False
        with (mock.patch.dict(os.environ, {'PONG_MASK_OVERLAP_POLICY': 'all'}, clear=True),
              mock.patch.object(frozen, '_ACTIVE_HANDLE', None),
              mock.patch.object(frozen, 'install_cold_for_engine', return_value=handle)):
            bootstrap_cold(engine, requested=True)
            self.assertEqual(os.environ['PONG_MASK_OVERLAP_POLICY'], 'all')
            self.assertFalse(engine.health()['exactAcceleration']['performanceQualifiedPolicy'])

    def test_bootstrap_skips_existing_isolated_install(self):
        from pong_exact_runtime import install as frozen
        engine = _Engine()
        handle = _Handle(model_binding_token(engine.config, MODEL_DIR))
        with (mock.patch.object(frozen, '_ACTIVE_HANDLE', handle),
              mock.patch.object(frozen, 'install_cold_for_engine') as install):
            self.assertEqual(bootstrap_cold(engine), (handle, None))
            install.assert_not_called()

    def test_admitted_gpu_call_drains_and_new_admission_fails_fast(self):
        engine, handle, adapter = self._attached()
        engine.warm()
        entered = threading.Event()
        release = threading.Event()
        gpu_done = []
        transition_done = []

        def long_call():
            entered.set()
            release.wait(2.0)
            return 'done'

        gpu = threading.Thread(target=lambda: gpu_done.append(
            engine._run_gpu_work(long_call)))
        gpu.start()
        self.assertTrue(entered.wait(1.0))
        transition = threading.Thread(target=lambda: transition_done.append(
            engine.update_config(_config(backend='onnx'))))
        transition.start()
        deadline = time.monotonic() + 1.0
        while not adapter.status()['transitioning'] and time.monotonic() < deadline:
            time.sleep(0.005)
        self.assertTrue(adapter.status()['transitioning'])
        with self.assertRaisesRegex(Exception, 'transition is in progress'):
            engine.create_session()
        release.set()
        gpu.join(2.0)
        transition.join(2.0)
        self.assertEqual(gpu_done, ['done'])
        self.assertEqual(len(transition_done), 1)
        self.assertFalse(handle.installed)

    def test_failed_post_commit_teardown_requires_restart(self):
        engine, handle, adapter = self._attached()
        engine.warm()
        engine.shutdown_result = False
        with self.assertRaisesRegex(RuntimeError, 'did not stop'):
            engine.update_config(_config(backend='onnx'))
        self.assertTrue(adapter.status()['restartRequired'])
        self.assertTrue(adapter.status()['transitioning'])
        with self.assertRaisesRegex(Exception, 'transition is in progress'):
            engine.create_session()


if __name__ == '__main__':
    unittest.main()
