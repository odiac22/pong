"""CPU-only startup order and HTTP admission contracts; never load live models."""

import sys
import types
import unittest
from unittest import mock

from fastapi import HTTPException
from test_pong_swap_lifecycle import LifecycleTests, RecordingServiceEngine


class ExactServiceStartupTests(unittest.TestCase):
    def load(self):
        engine = RecordingServiceEngine()
        service = LifecycleTests._load_service_with_engine(engine)
        return engine, service

    def test_bootstrap_precedes_workers_and_startup_is_idempotent(self):
        engine, service = self.load()
        events = []
        bootstrap = mock.Mock(side_effect=lambda e: events.append('bootstrap'))
        module = types.ModuleType('pong_exact_runtime.service_adapter')
        module.bootstrap_cold = bootstrap
        with mock.patch.dict(sys.modules, {module.__name__: module}), \
                mock.patch.object(service.threading, 'Thread') as thread:
            thread.return_value.start.side_effect = lambda: events.append('start')
            service._start_service_workers()
            service._start_service_workers()
        bootstrap.assert_called_once_with(engine)
        self.assertEqual(events, ['bootstrap', 'start', 'start', 'start'])
        self.assertEqual(thread.call_count, 3)
        self.assertIn(service._start_service_workers, service.app.router.on_startup)

    def test_failed_bootstrap_does_not_start_uncertain_workers(self):
        _engine, service = self.load()
        module = types.ModuleType('pong_exact_runtime.service_adapter')
        module.bootstrap_cold = mock.Mock(side_effect=RuntimeError('cold failure'))
        with mock.patch.dict(sys.modules, {module.__name__: module}), \
                mock.patch.object(service.threading, 'Thread') as thread:
            with self.assertRaisesRegex(RuntimeError, 'cold failure'):
                service._start_service_workers()
            thread.assert_not_called()
        self.assertFalse(service._SERVICE_WORKERS_STARTED)

    def test_startup_primes_approved_identities_after_warm(self):
        engine, service = self.load()
        events = []
        engine.warm = mock.Mock(side_effect=lambda: events.append('warm'))
        engine.prime_embeddings_async = mock.Mock(side_effect=lambda **kw: events.append('prime'))
        service._startup_warm()
        self.assertEqual(events, ['warm', 'prime'])
        engine.prime_embeddings_async.assert_called_once_with(delay_seconds=0.0)

    def test_failed_warm_does_not_start_identity_primer(self):
        engine, service = self.load()
        engine.warm = mock.Mock(side_effect=RuntimeError('not warm'))
        engine.prime_embeddings_async = mock.Mock()
        service._startup_warm()
        engine.prime_embeddings_async.assert_not_called()

    def test_approved_preparation_finishes_before_workers(self):
        engine, service = self.load()
        events = []
        module = types.ModuleType('pong_exact_runtime.service_adapter')
        module.bootstrap_cold = mock.Mock(side_effect=lambda e: events.append('bootstrap'))
        with mock.patch.dict(sys.modules, {module.__name__: module}), \
                mock.patch('pong_approved_startup.enabled', return_value=True), \
                mock.patch('pong_approved_startup.prepare', side_effect=lambda e: (events.append('prepared') or {'ready': True})), \
                mock.patch.object(service.threading, 'Thread') as thread:
            thread.return_value.start.side_effect = lambda: events.append('worker')
            service._start_service_workers()
        self.assertEqual(events, ['bootstrap', 'prepared', 'worker', 'worker', 'worker'])
        self.assertTrue(service.APPROVED_STARTUP_STATUS['ready'])
        self.assertEqual(thread.call_args_list[0].kwargs['target'], service._startup_prime_approved_identities)

    def test_failed_optional_preparation_retains_normal_warm(self):
        _, service = self.load()
        module = types.ModuleType('pong_exact_runtime.service_adapter')
        module.bootstrap_cold = mock.Mock()
        with mock.patch.dict(sys.modules, {module.__name__: module}), \
                mock.patch('pong_approved_startup.enabled', return_value=True), \
                mock.patch('pong_approved_startup.prepare', side_effect=RuntimeError('private detail')), \
                mock.patch.object(service.threading, 'Thread') as thread:
            service._start_service_workers()
        self.assertEqual(service.APPROVED_STARTUP_STATUS['error'], 'RuntimeError')
        self.assertFalse(service.APPROVED_STARTUP_STATUS['ready'])
        self.assertEqual(thread.call_args_list[0].kwargs['target'], service._startup_warm)

    def test_health_reports_loaded_service_version_without_mutating_engine(self):
        engine, service = self.load()
        original = {'ready': True, 'exactAcceleration': {'installed': True}}
        engine.health = mock.Mock(return_value=original)
        result = service.health()
        self.assertEqual(result['serviceVersion'], service.SERVICE_VERSION)
        self.assertEqual(result['exactAcceleration'], original['exactAcceleration'])
        self.assertNotIn('serviceVersion', original)

    def test_model_transition_conflicts_are_409_not_stream_failures(self):
        engine, service = self.load()
        conflict = service.ConfigUpdateConflict('busy')
        engine.warm = mock.Mock(side_effect=conflict)
        engine.unload = mock.Mock(side_effect=conflict)
        engine.create_session = mock.Mock(side_effect=conflict)
        calls = (
            lambda: service.warm(),
            lambda: service.unload(),
            lambda: service.create_session(service.SessionRequest(
                sourceUrl='https://example.invalid/silent.mp4', faceId='fixture')),
        )
        for call in calls:
            with self.subTest(call=call), self.assertRaises(HTTPException) as raised:
                call()
            self.assertEqual(raised.exception.status_code, 409)

    def test_idle_worker_retries_admission_conflict(self):
        engine, service = self.load()
        engine._last_used = 1
        engine.prune_prefetch_sessions = mock.Mock()
        engine.health = mock.Mock(return_value={'ready': True, 'activeSessions': 0})
        engine.unload = mock.Mock(side_effect=service.ConfigUpdateConflict('busy'))
        with mock.patch.object(service.time, 'time', return_value=10000), \
                mock.patch.object(service.time, 'sleep', side_effect=[None, StopIteration]):
            with self.assertRaises(StopIteration):
                service._idle_unload_loop()
        engine.unload.assert_called_once()


if __name__ == '__main__':
    unittest.main()
