import threading
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from experiment_tiktok_bootstrap_scheduler import wait_for_speculative_source, install_source_ready_admission


class FakeCondition:
    def __init__(self, on_wait):
        self.waits = 0
        self.on_wait = on_wait
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def wait(self, timeout):
        self.waits += 1
        self.on_wait()


class SourceReadyAdmissionTest(unittest.TestCase):
    def session(self, on_wait=lambda: None):
        return SimpleNamespace(config={'runtime': {'tiktokRestorerProfile': 'tiktok-face-size'}},
            stop=threading.Event(),prefetch=True,activation_requested=False,
            playback_started_at=0,source_opened_at=0,source_opener=SimpleNamespace(is_alive=lambda:True),
            condition=FakeCondition(on_wait))

    def test_ready_source_delegates_to_original_admission_once(self):
        s=self.session();s.condition.on_wait=lambda:setattr(s,'source_opened_at',1)
        calls=[];engine=SimpleNamespace(_acquire_prefetch_admission=lambda s:calls.append(s) or True)
        install_source_ready_admission(engine)
        self.assertTrue(engine._acquire_prefetch_admission(s))
        self.assertEqual(s.condition.waits,1);self.assertEqual(calls,[s])

    def test_promotion_cancellation_and_error_release_wait(self):
        for mutate in [lambda s:setattr(s,'prefetch',False),
            lambda s:setattr(s,'activation_requested',True),
            lambda s:setattr(s,'playback_started_at',1),lambda s:s.stop.set(),
            lambda s:setattr(s,'source_opener',None),
            lambda s:setattr(s.source_opener,'is_alive',lambda:False)]:
            with self.subTest(mutate=mutate):
                s=self.session();s.condition.on_wait=lambda:mutate(s)
                wait_for_speculative_source(s)
                self.assertEqual(s.condition.waits,1)

    def test_known_ready_foreground_and_ordinary_recall_never_wait(self):
        for mutate in [lambda s:setattr(s,'source_opened_at',1),
            lambda s:setattr(s,'activation_requested',True),lambda s:setattr(s,'config',{})]:
            s=self.session();mutate(s);wait_for_speculative_source(s)
            self.assertEqual(s.condition.waits,0)

    def test_wait_has_bounded_deadline_without_reserving_gpu(self):
        now=[0.0];s=self.session();s.condition.on_wait=lambda:now.__setitem__(0,now[0]+.1)
        wait_for_speculative_source(s,clock=lambda:now[0],maximum=.5)
        self.assertEqual(s.condition.waits,5)

    def test_slow_io_cannot_hold_the_slot_needed_by_a_ready_source(self):
        entered=threading.Event();release=threading.Event();admissions=[]
        class ObservedCondition(threading.Condition):
            def wait(self, timeout=None):
                entered.set()
                return super().wait(timeout)
        slow=self.session();slow.condition=ObservedCondition()
        slow.source_opener=SimpleNamespace(is_alive=lambda:True)
        ready=self.session();ready.source_opened_at=1
        def original(s):
            admissions.append(s)
            return True
        engine=SimpleNamespace(_acquire_prefetch_admission=original);install_source_ready_admission(engine)
        def wait_slow():
            engine._acquire_prefetch_admission(slow);release.set()
        worker=threading.Thread(target=wait_slow);worker.start()
        try:
            self.assertTrue(entered.wait(1), 'Slow source did not reach its source wait')
            engine._acquire_prefetch_admission(ready)
            self.assertEqual(admissions,[ready])
        finally:
            with slow.condition:
                slow.stop.set();slow.condition.notify_all()
            worker.join(1)
        self.assertFalse(worker.is_alive());self.assertTrue(release.is_set())

    def test_failed_source_and_deadline_still_delegate_once_to_original(self):
        for failed in [True,False]:
            with self.subTest(failed=failed):
                s=self.session();calls=[]
                if failed:s.source_opener=SimpleNamespace(is_alive=lambda:False)
                engine=SimpleNamespace(_acquire_prefetch_admission=lambda s:calls.append(s) or False)
                install_source_ready_admission(engine)
                original_wait=wait_for_speculative_source
                def bounded_wait(session):
                    return original_wait(session,maximum=0)
                with patch('experiment_tiktok_bootstrap_scheduler.wait_for_speculative_source',bounded_wait):
                    self.assertFalse(engine._acquire_prefetch_admission(s))
                self.assertEqual(calls,[s])


if __name__=='__main__': unittest.main()
