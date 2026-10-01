import threading
import unittest
from types import SimpleNamespace
from experiment_tiktok_bootstrap_scheduler import bootstrap_target, foreground_needs_gpu

TIKTOK = {'runtime': {'tiktokRestorerProfile': 'tiktok-face-size', 'minimumHeadroom': 2}}


class BootstrapTests(unittest.TestCase):
    def test_only_speculative_tiktok_depth_changes(self):
        original=lambda p,r,c: r+2
        self.assertEqual(bootstrap_target(original,True,1,TIKTOK),.5)
        self.assertEqual(bootstrap_target(original,False,1,TIKTOK),3)
        self.assertEqual(bootstrap_target(original,True,1,{'runtime':{}}),3)
        self.assertEqual(TIKTOK['runtime']['minimumHeadroom'],2)

    def fixture(self, lead, config=TIKTOK):
        session=SimpleNamespace(id='viewed',complete=False,stop=threading.Event(),
            subscribers=1,prefetch=False,activation_requested=True,playback_started_at=1,fps=30,complete_fragments=1,config=config)
        return SimpleNamespace(_sessions_lock=threading.Lock(),_sessions={'viewed':session},
            _active_by_channel={'c':'viewed'},_playback_headroom_seconds=lambda s,t:lead),session

    def test_critical_current_video_still_wins(self):
        e,_=self.fixture(.74)
        self.assertTrue(foreground_needs_gpu(e,'next',10))
        e,_=self.fixture(.76)
        self.assertFalse(foreground_needs_gpu(e,'next',10))

    def test_ordinary_pong_keeps_two_seconds(self):
        e,_=self.fixture(1.9,{'runtime':{'minimumHeadroom':2}})
        self.assertTrue(foreground_needs_gpu(e,'next',10))

    def test_inactive_complete_cancelled_or_unread_streams_do_not_block(self):
        for field,value in [('complete',True),('activation_requested',False)]:
            e,s=self.fixture(0)
            setattr(s,field,value)
            self.assertFalse(foreground_needs_gpu(e,'next',10))
        e,s=self.fixture(0);s.stop.set()
        self.assertFalse(foreground_needs_gpu(e,'next',10))

    def test_active_cold_reader_is_protected(self):
        for field,value in [('subscribers',0),('prefetch',True),('complete_fragments',0)]:
            e,s=self.fixture(0)
            setattr(s,field,value)
            self.assertTrue(foreground_needs_gpu(e,'next',10))


if __name__=='__main__':unittest.main()
