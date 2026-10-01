import gc
import threading
import time
import unittest
import weakref
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

from experiment_tiktok_prefetch_priority import install, uninstall
from experiment_tiktok_priority_service import main


def session(*, prefetch=True, profile='tiktok-face-size'):
    return SimpleNamespace(
        id='fixture', prefetch=prefetch, activation_requested=not prefetch,
        playback_started_at=0, stop=threading.Event(),
        condition=threading.Condition(),
        config={'runtime': {'tiktokRestorerProfile': profile},
                'parameters': {'SwapperTypeTextSel': '128'}},
    )


class FakeEngine:
    def __init__(self):
        self._sessions = {}
        self._sessions_lock = threading.RLock()
        self._gpu_worker_thread = None
        self._config = {'parameters': {'SwapperTypeTextSel': '128'}}
        self._embedding_cache = {}
        self._presentation_cache = {}
        self._source_frame_cache = {}
        self.embedding_lock = threading.Lock()
        self.need_foreground = False
        self.jobs = []
        self.prep_calls = []

    def _foreground_playback_needs_gpu(self, *_args):
        return self.need_foreground

    def _embedding_profile_key(self, _config):
        return 'profile'

    def _presentation_profile_key(self, _config):
        return 'profile'

    def _run_gpu_work(self, callback, *args, **kwargs):
        self.jobs.append((kwargs.get('work_label'), kwargs.get('priority', 0)))
        return callback(*args)

    def _produce_session(self, current):
        self._run_gpu_work(lambda: None, priority=10, work_label='session-warm',
                           cancelled_value=None)
        if current.stop.is_set():
            return 'stopped'
        self.embedding_for_face('face', current.config)
        self.presentation_for_face('face', current.config)
        self.source_frame_for_face('face', current.config)
        return 'completed'

    def embedding_for_face(self, face_id, config=None, **_kwargs):
        with self.embedding_lock:
            self.prep_calls.append('embedding')
            self._run_gpu_work(lambda: None, priority=0, work_label='embedding-warm')
            self._run_gpu_work(lambda: None, priority=0, work_label='embedding-images')
            self._embedding_cache[(face_id, 'profile')] = 1

    def presentation_for_face(self, face_id, config=None, **_kwargs):
        self.prep_calls.append('presentation')
        self._run_gpu_work(lambda: None, priority=0, work_label='presentation-warm')
        self._run_gpu_work(lambda: None, priority=0, work_label='source-presentation')
        self._presentation_cache[(face_id, 'profile')] = 1

    def source_frame_for_face(self, face_id, config=None):
        self.prep_calls.append('source-frame')
        if config['parameters']['SwapperTypeTextSel'] == 'UniFace':
            self._run_gpu_work(lambda: None, priority=0, work_label='source-frame')
            self._source_frame_cache[(face_id, 'profile')] = 1

    def health(self):
        return {'ready': True}


class PrefetchPriorityTests(unittest.TestCase):
    def test_prefetch_nested_helpers_are_background_priority(self):
        engine = FakeEngine()
        trial = install(engine)
        current = session()
        current.config['parameters'] = {'SwapperTypeTextSel': 'UniFace'}
        self.assertEqual(engine._produce_session(current), 'completed')
        self.assertEqual([priority for _label, priority in engine.jobs], [10] * 6)
        self.assertEqual(trial.status()['priorityRaisedJobs'], 5)
        self.assertEqual(trial.status()['waits'], 0)
        self.assertTrue(engine.health()['prefetchPriorityTrial']['active'])
        self.assertEqual(engine._run_gpu_work(lambda: 7, priority=0,
                                              work_label='frame-render'), 7)
        self.assertEqual(trial.status()['foregroundFrameQueueWaits'], 1)
        uninstall(engine)
        self.assertNotIn('_run_gpu_work', engine.__dict__)

    def test_foreground_and_non_tiktok_keep_original_results_and_priority(self):
        engine = FakeEngine()
        install(engine)
        for current in (session(prefetch=False), session(profile='default')):
            self.assertEqual(engine._produce_session(current), 'completed')
        self.assertEqual(engine.jobs[0:5], [
            ('session-warm', 10), ('embedding-warm', 0),
            ('embedding-images', 0), ('presentation-warm', 0),
            ('source-presentation', 0),
        ])
        self.assertEqual(engine.jobs[5:10], engine.jobs[0:5])
        self.assertEqual(engine.health()['prefetchPriorityTrial']['speculativeGpuJobs'], 0)

    def test_wait_is_before_face_lock_and_releases_on_foreground_recovery(self):
        engine = FakeEngine()
        engine.need_foreground = True
        trial = install(engine, max_wait_seconds=1.0)
        current = session()
        result = []
        thread = threading.Thread(target=lambda: result.append(engine._produce_session(current)))
        thread.start()
        time.sleep(0.06)
        self.assertTrue(thread.is_alive())
        self.assertTrue(engine.embedding_lock.acquire(blocking=False))
        engine.embedding_lock.release()
        self.assertEqual(engine.prep_calls, [])
        engine.need_foreground = False
        with current.condition:
            current.condition.notify_all()
        thread.join(timeout=1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result, ['completed'])
        self.assertGreater(trial.status()['waitMs'], 0)
        self.assertEqual(trial.status()['timedOutPrefetches'], 0)

    def test_wait_cancels_optional_prefetch_boundedly(self):
        engine = FakeEngine()
        engine.need_foreground = True
        trial = install(engine, max_wait_seconds=0.1)
        current = session()
        started = time.monotonic()
        self.assertEqual(engine._produce_session(current), 'stopped')
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertTrue(current.stop.is_set())
        self.assertEqual(engine.jobs, [])
        self.assertEqual(trial.status()['timedOutPrefetches'], 1)

    def test_promotion_ends_wait_without_cancel_and_restores_foreground_priority(self):
        engine = FakeEngine()
        engine.need_foreground = True
        install(engine, max_wait_seconds=1.0)
        current = session()
        result = []
        thread = threading.Thread(target=lambda: result.append(engine._produce_session(current)))
        thread.start()
        time.sleep(0.05)
        current.prefetch = False
        current.activation_requested = True
        with current.condition:
            current.condition.notify_all()
        thread.join(timeout=1)
        self.assertEqual(result, ['completed'])
        self.assertFalse(current.stop.is_set())
        self.assertEqual(engine.jobs[1][1], 0)

    def test_cold_rejection_is_atomic_and_uninstall_requires_direct_owner(self):
        for kind in ('session', 'worker', 'models', 'prior_adapter'):
            engine = FakeEngine()
            if kind == 'session':
                engine._sessions['x'] = object()
            elif kind == 'worker':
                engine._gpu_worker_thread = SimpleNamespace(is_alive=lambda: True)
            elif kind == 'models':
                engine._models = object()
            else:
                engine._run_gpu_work = lambda *a, **kw: None
            before = engine.__dict__.copy()
            with self.assertRaises(RuntimeError):
                install(engine)
            self.assertEqual(engine.__dict__.keys(), before.keys())
        engine = FakeEngine()
        install(engine)
        engine.health = lambda: {}
        with self.assertRaisesRegex(RuntimeError, 'another adapter'):
            uninstall(engine)

    def test_later_qualified_class_producer_is_used_not_captured_baseline(self):
        class QualifiedEngine(FakeEngine):
            pass

        engine = QualifiedEngine()
        install(engine)
        original = QualifiedEngine._produce_session
        try:
            QualifiedEngine._produce_session = lambda self, current: 'qualified-producer'
            self.assertEqual(engine._produce_session(session(prefetch=False)),
                             'qualified-producer')
        finally:
            QualifiedEngine._produce_session = original

    def test_wrappers_do_not_retain_engine_after_teardown(self):
        engine = FakeEngine()
        install(engine)
        reference = weakref.ref(engine)
        uninstall(engine)
        del engine
        gc.collect()
        self.assertIsNone(reference())

    def test_service_port_guard_fails_before_touching_files(self):
        with TemporaryDirectory() as temporary:
            output = str(Path(temporary) / 'fresh')
            for args in (
                ['--port', '8792', '--output-dir', output],
                ['--live-priority', '--port', '8812', '--output-dir', output],
                ['--live-priority', '--port', '8792', '--output-dir', output,
                 '--cache-dir', str(Path(temporary) / 'cache')],
            ):
                with self.subTest(args=args), self.assertRaises(SystemExit) as error:
                    main(args)
                self.assertEqual(error.exception.code, 2)
                self.assertFalse(Path(output).exists())


if __name__ == '__main__':
    unittest.main()
