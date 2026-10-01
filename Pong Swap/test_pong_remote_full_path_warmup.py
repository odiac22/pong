"""CPU-only contract tests for the opt-in, startup-before-admission trial."""
from __future__ import annotations

from copy import deepcopy
import threading
import types
import unittest
from unittest import mock

import numpy as np

import pong_remote_full_path_warmup as trial
import test_pong_swap_lifecycle as lifecycle


class _Output:
    def cpu(self):
        return self

    def numpy(self):
        return np.zeros((1,), dtype=np.uint8)


class _Engine:
    def __init__(self):
        self._lock = threading.RLock()
        self._gpu_worker_ident = threading.get_ident()
        self._config_revision = 4
        self._config = {"runtime": {"adaptiveRestorer": True},
                        "parameters": {"RestorerSwitch": True}}
        self._pipeline_warm_signature = "same"
        self._vm = types.SimpleNamespace(parameters={"original": True},
                                         color_match_cuda_graph_enabled=True)
        self._models = object()
        self.active = 0
        self.calls = 0

    def _active_session_count(self):
        return self.active

    def _config_snapshot(self):
        return deepcopy(self._config), self._config_revision

    def _pipeline_signature(self, _config):
        return "same"

    def process_frame(self, frame, embedding, anchor, *, config, temporal_context, **kwargs):
        self.calls += 1
        config["runtime"]["tiktokRestorerState"] = {"model": "GPEN512"}
        temporal_context["exactFrames"] = 1
        self._vm.parameters = {"changed": True}
        self._vm.color_match_cuda_graph_enabled = False
        return _Output(), anchor


class FullPathWarmupTests(unittest.TestCase):
    @staticmethod
    def _service(engine):
        return lifecycle.LifecycleTests._load_service_with_engine(engine)

    def test_bounded_owner_pass_discards_output_and_restores_vm_state(self):
        engine = _Engine()
        original = engine._vm.parameters
        frames = (np.zeros((1280, 720, 3), dtype=np.uint8),) * 3
        with mock.patch.object(trial, 'build_temporal_restorer_context', return_value={}):
            result = trial._run_on_owner(engine, frames, np.zeros(512, dtype=np.float32),
                                         None, engine._config, 4, engine._vm,
                                         engine._models, None)
        self.assertEqual(engine.calls, 2)
        self.assertEqual(result['primedContexts'], 1)
        self.assertTrue(result['gpen512Primed'])
        self.assertFalse(result['gpen1024Primed'])
        self.assertIs(engine._vm.parameters, original)
        self.assertTrue(engine._vm.color_match_cuda_graph_enabled)

    def test_mismatch_before_frame_never_processes(self):
        engine = _Engine()
        frames = (np.zeros((1280, 720, 3), dtype=np.uint8),)
        for change in (lambda: setattr(engine, 'active', 1),
                       lambda: setattr(engine, '_config_revision', 5),
                       lambda: setattr(engine, '_models', object()),
                       lambda: setattr(engine, '_gpu_worker_ident', -1)):
            engine = _Engine()
            models = engine._models
            change()
            with self.assertRaises(trial.PreflightSkipped):
                trial._run_on_owner(engine, frames, np.zeros(512, dtype=np.float32),
                                    None, engine._config, 4, engine._vm, models, None)
            self.assertEqual(engine.calls, 0)

    def test_exception_restores_vm_state(self):
        engine = _Engine()
        prior = engine._vm.parameters
        engine.process_frame = mock.Mock(side_effect=RuntimeError('synthetic failure'))
        with mock.patch.object(trial, 'build_temporal_restorer_context', return_value={}):
            with self.assertRaisesRegex(RuntimeError, 'synthetic failure'):
                trial._run_on_owner(engine, (np.zeros((1280, 720, 3), dtype=np.uint8),),
                                    np.zeros(512, dtype=np.float32), None, engine._config,
                                    4, engine._vm, engine._models, None)
        self.assertIs(engine._vm.parameters, prior)

    def test_side_worker_failure_still_restores_vm_state(self):
        engine = _Engine()
        prior = engine._vm.parameters
        with mock.patch.object(trial, 'build_temporal_restorer_context', return_value={}), \
                mock.patch.object(trial, '_fence_side_work', side_effect=RuntimeError('side worker')):
            with self.assertRaisesRegex(RuntimeError, 'side worker'):
                trial._run_on_owner(engine, (np.zeros((1280, 720, 3), dtype=np.uint8),),
                                    np.zeros(512, dtype=np.float32), None, engine._config,
                                    4, engine._vm, engine._models, None)
        self.assertIs(engine._vm.parameters, prior)
        self.assertTrue(engine._vm.color_match_cuda_graph_enabled)

    def test_portrait_is_bounded_and_does_not_mutate_approved_image(self):
        image = np.ones((300, 240, 3), dtype=np.uint8)
        original = image.copy()
        for scale in (.8, 1.25):
            frame = trial._portrait(image, scale)
            self.assertEqual(frame.shape, (1280, 720, 3))
            self.assertEqual(frame.dtype, np.uint8)
        np.testing.assert_array_equal(image, original)

    def test_profile_warm_is_checked_before_any_disposable_frame(self):
        engine = _Engine()
        engine.health = lambda: {"exactAcceleration": {"acceleration": {"installed": True}}}
        engine._model_lifecycle_changed = lambda _before, _after: False
        engine.warm = mock.Mock(return_value={"ready": True, "restorers": {
            "512": {"ready": True}, "1024": {"ready": True},
        }})
        with mock.patch.object(trial, 'session_config_for_profile', return_value=engine._config), \
                mock.patch.object(trial, 'restorer_models', return_value=('GPEN512', 'GPEN1024')), \
                mock.patch.object(trial, 'run_startup_preflight', return_value={
                    "attemptedFrames": 1, "primedContexts": 1,
                    "gpen512Primed": True, "gpen1024Primed": False, "elapsedMs": 1.0,
                }) as render:
            result = trial.warm_and_run_at_startup(engine)
        engine.warm.assert_called_once_with(config=engine._config, allow_create_selected=True)
        render.assert_called_once_with(engine, remote_manager=None, qualified=True)
        self.assertIn('profileWarmMs', result)

    def test_unready_profile_never_submits_disposable_frame(self):
        engine = _Engine()
        engine.health = lambda: {"exactAcceleration": {"acceleration": {"installed": True}}}
        engine._model_lifecycle_changed = lambda _before, _after: False
        engine.warm = mock.Mock(return_value={"ready": True, "restorers": {
            "512": {"ready": False}, "1024": {"ready": True},
        }})
        with mock.patch.object(trial, 'session_config_for_profile', return_value=engine._config), \
                mock.patch.object(trial, 'restorer_models', return_value=('GPEN512', 'GPEN1024')), \
                mock.patch.object(trial, 'run_startup_preflight') as render:
            with self.assertRaises(trial.PreflightSkipped):
                trial.warm_and_run_at_startup(engine)
        render.assert_not_called()

    def test_service_trial_is_flagged_and_finishes_before_workers(self):
        engine = lifecycle.RecordingServiceEngine()
        service = self._service(engine)
        events = []
        adapter = types.ModuleType('pong_exact_runtime.service_adapter')
        adapter.bootstrap_cold = lambda _engine: events.append('bootstrap')
        with mock.patch.dict('sys.modules', {adapter.__name__: adapter}), \
                mock.patch.object(service, 'REMOTE_FULL_PATH_WARMUP_ENABLED', True), \
                mock.patch.object(service, '_startup_remote_full_path_preflight',
                                  side_effect=lambda: events.append('preflight')), \
                mock.patch.object(service.threading, 'Thread') as thread:
            thread.return_value.start.side_effect = lambda: events.append('worker')
            service._start_service_workers()
        self.assertEqual(events, ['bootstrap', 'preflight', 'worker', 'worker'])

    def test_successful_trial_primes_identities_without_baseline_rewarm(self):
        engine = lifecycle.RecordingServiceEngine()
        service = self._service(engine)
        adapter = types.ModuleType('pong_exact_runtime.service_adapter')
        adapter.bootstrap_cold = mock.Mock()
        def ready():
            service.REMOTE_FULL_PATH_WARMUP_STATUS = {"enabled": True, "ready": True}
        with mock.patch.dict('sys.modules', {adapter.__name__: adapter}), \
                mock.patch.object(service, 'REMOTE_FULL_PATH_WARMUP_ENABLED', True), \
                mock.patch.object(service, '_startup_remote_full_path_preflight', side_effect=ready), \
                mock.patch.object(service.threading, 'Thread') as thread:
            service._start_service_workers()
        self.assertIs(thread.call_args_list[0].kwargs['target'],
                      service._startup_prime_approved_identities)
        self.assertIsNot(thread.call_args_list[0].kwargs['target'], service._startup_warm)

    def test_failed_trial_retains_baseline_warm(self):
        engine = lifecycle.RecordingServiceEngine()
        service = self._service(engine)
        adapter = types.ModuleType('pong_exact_runtime.service_adapter')
        adapter.bootstrap_cold = mock.Mock()
        with mock.patch.dict('sys.modules', {adapter.__name__: adapter}), \
                mock.patch.object(service, 'REMOTE_FULL_PATH_WARMUP_ENABLED', True), \
                mock.patch.object(service, '_startup_remote_full_path_preflight'), \
                mock.patch.object(service.threading, 'Thread') as thread:
            service._start_service_workers()
        self.assertIs(thread.call_args_list[0].kwargs['target'], service._startup_warm)

    def test_failed_trial_keeps_baseline_startup_and_numeric_health(self):
        engine = lifecycle.RecordingServiceEngine()
        service = self._service(engine)
        service.REMOTE_FULL_PATH_WARMUP_ENABLED = True
        module = types.ModuleType('pong_remote_full_path_warmup')
        module.warm_and_run_at_startup = mock.Mock(side_effect=RuntimeError('private path'))
        with mock.patch.dict('sys.modules', {module.__name__: module}):
            service._startup_remote_full_path_preflight()
        self.assertEqual(service.REMOTE_FULL_PATH_WARMUP_STATUS['ready'], False)
        self.assertNotIn('private path', str(service.REMOTE_FULL_PATH_WARMUP_STATUS))


if __name__ == '__main__':
    unittest.main()
