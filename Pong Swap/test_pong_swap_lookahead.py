import threading
import unittest
import numpy as np
from pong_swap_lookahead import TrackingLookahead


class TrackingLookaheadTests(unittest.TestCase):
    def fixture(self):
        state={'gray':np.zeros((24,24),np.uint8),'rawKps':np.ones((5,2),np.float32),'trackGeneration':4}
        return state,np.zeros((24,24,3),np.uint8)

    def test_exact_owned_observation_is_reused_once(self):
        state,frame=self.fixture();sentinel=object();calls=[]
        def track(*a,**kw):calls.append((a,kw));return sentinel
        helper=TrackingLookahead(track, minimum_pixels=0)
        try:
            helper.prepare(state,frame)
            gray,evidence=helper.consume(frame,state)
            self.assertIs(evidence,sentinel);self.assertEqual(gray.shape,(24,24))
            self.assertEqual(helper.hits,1);self.assertIsNone(helper.consume(frame,state))
            self.assertTrue(calls[0][1]['return_evidence'])
        finally:helper.close()

    def test_stale_frame_pose_generation_and_gray_fail_closed(self):
        for change in ('frame','points','generation','gray'):
            with self.subTest(change=change):
                state,frame=self.fixture();helper=TrackingLookahead(lambda *a,**kw:object(), minimum_pixels=0)
                try:
                    helper.prepare(state,frame)
                    if change=='frame':frame=frame.copy()
                    if change=='points':state['rawKps'][0,0]+=1
                    if change=='generation':state['trackGeneration']+=1
                    if change=='gray':state['gray']=state['gray'].copy()
                    self.assertIsNone(helper.consume(frame,state));self.assertEqual(helper.hits,0)
                finally:helper.close()

    def test_failed_tracking_is_preserved_not_mistaken_for_cache_miss(self):
        state,frame=self.fixture();helper=TrackingLookahead(lambda *a,**kw:None, minimum_pixels=0)
        try:
            helper.prepare(state,frame);self.assertIsNone(helper.consume(frame,state)[1])
        finally:helper.close()

    def test_exception_falls_back(self):
        state,frame=self.fixture()
        def fail(*a,**kw):raise RuntimeError('test')
        helper=TrackingLookahead(fail, minimum_pixels=0)
        try:
            helper.prepare(state,frame);self.assertIsNone(helper.consume(frame,state))
        finally:helper.close()

    def test_rejected_running_work_cannot_accumulate(self):
        state,frame=self.fixture();started=threading.Event();release=threading.Event();calls=[]
        def slow(*a,**kw):calls.append(1);started.set();release.wait(3)
        helper=TrackingLookahead(slow, minimum_pixels=0)
        try:
            helper.prepare(state,frame);self.assertTrue(started.wait(1))
            self.assertIsNone(helper.consume(frame.copy(),state))
            for _ in range(30):helper.prepare(state,frame.copy())
            self.assertEqual(len(calls),1);self.assertIsNone(helper._pending)
        finally:release.set();helper.close()
        helper.prepare(state,frame);self.assertIsNone(helper._pending)

    def test_small_frames_do_not_start_speculative_work(self):
        state,frame=self.fixture();calls=[]
        helper=TrackingLookahead(lambda *a,**kw:calls.append(1))
        try:
            helper.prepare(state,frame)
            self.assertIsNone(helper.consume(frame,state))
            self.assertEqual(calls,[])
        finally:helper.close()

    def test_unavailable_worker_falls_back_without_failing_frame(self):
        state,frame=self.fixture()
        helper=TrackingLookahead(lambda *a,**kw:None, minimum_pixels=0)
        helper._pool.shutdown()
        try:
            helper.prepare(state,frame)
            self.assertIsNone(helper.consume(frame,state))
        finally:helper.close()

if __name__=='__main__':unittest.main()
