import gc
import threading
import unittest
import weakref
from pathlib import Path
from tempfile import TemporaryDirectory

from experiment_tiktok_stage_service import install, main


class FakeEngine:
    def __init__(self):
        self._sessions_lock = threading.RLock()
        self._sessions = {}
        self._gpu_worker_thread = None
        self.created = []

    def create_session(self, *args, **kwargs):
        self.created.append((args, dict(kwargs)))
        return dict(kwargs)

    def health(self):
        return {'ready': True}

    def _foreground_playback_needs_gpu(self, *_args, **_kwargs):
        return True


class StageOnlyTests(unittest.TestCase):
    def test_fixed_512_tiktok_profile_also_collects_stages_without_quality_changes(self):
        engine = FakeEngine()
        install(engine)
        result = engine.create_session(restoration_profile='tiktok-gpen512',
                                       diagnostics_enabled=False, face_id='fixture')
        self.assertEqual(result, {'restoration_profile': 'tiktok-gpen512',
                                 'diagnostics_enabled': True, 'face_id': 'fixture'})
        self.assertEqual(engine.health()['stageDiagnosticsTrial']['tiktokSessions'], 1)

    def test_tiktok_only_and_bootstrap_default_false_composition(self):
        engine = FakeEngine()
        original_schedule = engine._foreground_playback_needs_gpu.__func__
        trial = install(engine)
        self.assertIs(trial, install(engine))
        self.assertIs(engine._foreground_playback_needs_gpu.__func__, original_schedule)
        # The frozen production adapter sets this default before calling the
        # method it captured at cold attach; the stage trial must override it.
        captured = engine.create_session
        def adapter_call(**kwargs):
            kwargs.setdefault('diagnostics_enabled', False)
            return captured(**kwargs)
        result = adapter_call(restoration_profile='tiktok-face-size',
                              face_id='fixture', prefetch=True)
        self.assertTrue(result['diagnostics_enabled'])
        self.assertEqual(result['face_id'], 'fixture')
        self.assertTrue(result['prefetch'])
        self.assertFalse(adapter_call(restoration_profile='ordinary')['diagnostics_enabled'])
        self.assertTrue(engine.create_session(
            restoration_profile='ordinary', diagnostics_enabled=True,
        )['diagnostics_enabled'])
        self.assertEqual(len(engine.created), 3)
        health = engine.health()
        self.assertTrue(health['ready'])
        self.assertEqual(health['stageDiagnosticsTrial']['tiktokSessions'], 1)
        self.assertEqual(health['stageDiagnosticsTrial']['otherSessions'], 2)
        self.assertFalse(health['stageDiagnosticsTrial']['performanceQualification'])
        self.assertNotIn('departureTrial', health)

    def test_cold_guards_leave_original_methods_untouched(self):
        for change in ('session', 'worker', 'existing_adapter'):
            with self.subTest(change=change):
                engine = FakeEngine()
                if change == 'session':
                    engine._sessions['fixture'] = object()
                elif change == 'worker':
                    engine._gpu_worker_thread = type('Worker', (), {'is_alive': lambda self: True})()
                else:
                    engine.create_session = lambda **kwargs: kwargs
                before_create = engine.create_session
                before_health = engine.health
                with self.assertRaises(RuntimeError):
                    install(engine)
                if change == 'existing_adapter':
                    self.assertIs(engine.create_session, before_create)
                else:
                    self.assertNotIn('create_session', engine.__dict__)
                    self.assertIs(engine.create_session.__func__, before_create.__func__)
                self.assertIs(engine.health.__func__, before_health.__func__)

    def test_wrappers_do_not_retain_dead_engine(self):
        engine = FakeEngine()
        install(engine)
        create = engine.create_session
        health = engine.health
        ref = weakref.ref(engine)
        del engine
        gc.collect()
        self.assertIsNone(ref())
        with self.assertRaisesRegex(RuntimeError, 'released'):
            create(restoration_profile='tiktok-face-size')
        with self.assertRaisesRegex(RuntimeError, 'released'):
            health()

    def test_live_port_is_explicit_and_dedicated_cache_forbidden(self):
        with TemporaryDirectory() as temporary:
            fresh = str(Path(temporary) / 'fresh')
            for args in (
                ['--port', '8792', '--output-dir', fresh],
                ['--live-attribution', '--port', '8812', '--output-dir', fresh],
                ['--live-attribution', '--port', '8792', '--output-dir', fresh,
                 '--cache-dir', str(Path(temporary) / 'cache')],
            ):
                with self.subTest(args=args), self.assertRaises(SystemExit) as error:
                    main(args)
                self.assertEqual(error.exception.code, 2)
                self.assertFalse(Path(fresh).exists())


if __name__ == '__main__':
    unittest.main()
