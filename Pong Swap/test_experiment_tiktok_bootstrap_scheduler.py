import threading
import unittest
from types import SimpleNamespace
from experiment_tiktok_bootstrap_scheduler import foreground_needs_gpu, bootstrap_target, install_cold_priority


class SchedulerGuardTest(unittest.TestCase):
    def candidate(self, **updates):
        value = dict(id='live', complete=False, stop=threading.Event(),
                     activation_requested=True, prefetch=False, subscribers=1,
                     playback_started_at=1, fps=30, complete_fragments=2,
                     config={'runtime': {'tiktokRestorerProfile': 'tiktok-face-size'}})
        value.update(updates)
        return SimpleNamespace(**value)

    def needs(self, candidate, lead=1.0, active=True):
        engine = SimpleNamespace(_sessions_lock=threading.Lock(),
                                 _sessions={'live': candidate},
                                 _active_by_channel={2: 'live'} if active else {},
                                 _playback_headroom_seconds=lambda *args: lead)
        return foreground_needs_gpu(engine, 'next', 10)

    def test_cold_foreground_is_protected_before_reader_and_clock(self):
        for changes in ({'subscribers': 0}, {'playback_started_at': 0},
                        {'fps': 0}, {'complete_fragments': 0}, {'prefetch': True}):
            with self.subTest(changes=changes):
                self.assertTrue(self.needs(self.candidate(**changes)))

    def test_only_muxed_foreground_headroom_permits_bootstrap(self):
        self.assertTrue(self.needs(self.candidate(), lead=.74))
        self.assertFalse(self.needs(self.candidate(), lead=.75))

    def test_retired_or_cancelled_owners_do_not_block(self):
        self.assertFalse(self.needs(self.candidate(), active=False))
        stopped=self.candidate();stopped.stop.set()
        self.assertFalse(self.needs(stopped))
        self.assertFalse(self.needs(self.candidate(complete=True)))
        self.assertFalse(self.needs(self.candidate(activation_requested=False)))

    def test_ordinary_pong_keeps_original_headroom(self):
        ordinary=self.candidate(config={'runtime': {'minimumHeadroom': 2}})
        self.assertTrue(self.needs(ordinary, lead=1.9))
        self.assertFalse(self.needs(ordinary, lead=2))
        ordinary.subscribers=0
        self.assertFalse(self.needs(ordinary, lead=0))

    def test_bootstrap_target_is_tiktok_speculation_only(self):
        original=lambda *_args: 2
        self.assertEqual(bootstrap_target(original, True, 2, self.candidate().config), .5)
        self.assertEqual(bootstrap_target(original, False, 2, self.candidate().config), 2)
        self.assertEqual(bootstrap_target(original, True, 2, {}), 2)

    def test_cold_only_trial_protects_first_fragment_then_delegates_unchanged(self):
        calls=[]
        candidate=self.candidate(complete_fragments=0,subscribers=0,playback_started_at=0)
        engine=SimpleNamespace(_sessions_lock=threading.Lock(),_sessions={'live':candidate},
            _active_by_channel={2:'live'},
            _foreground_playback_needs_gpu=lambda excluded,**kw:calls.append((excluded,kw)) or False)
        install_cold_priority(engine)
        self.assertTrue(engine._foreground_playback_needs_gpu('next',now=10))
        self.assertEqual(calls,[])
        candidate.complete_fragments=1
        self.assertFalse(engine._foreground_playback_needs_gpu('next',now=11))
        self.assertEqual(calls,[('next',{'now':11})])
        candidate.complete_fragments=0;candidate.stop.set()
        self.assertFalse(engine._foreground_playback_needs_gpu('next'))


if __name__ == '__main__':
    unittest.main()
