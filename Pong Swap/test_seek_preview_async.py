import threading,unittest,time
from unittest import mock
import cv2,numpy as np
from pong_swap_engine import SwapSession,_start_seek_preview,PongSwapEngine

class AsyncPreviewTests(unittest.TestCase):
    def session(self):return SwapSession(id='preview',channel='test',source_url='fixture',face_id='approved',start_seconds=1)
    def wait(self,s):
        with s.condition:self.assertTrue(s.condition.wait_for(lambda:not s.first_rendered_frame_pending,timeout=5))
    def test_bytes_equal_synchronous_quality100(self):
        s=self.session();rgb=np.random.default_rng(4).integers(0,256,(96,128,3),dtype=np.uint8)
        expected=cv2.imencode('.webp',cv2.cvtColor(rgb,cv2.COLOR_RGB2BGR),[cv2.IMWRITE_WEBP_QUALITY,100])[1].tobytes()
        self.assertTrue(_start_seek_preview(s,rgb,True));self.wait(s)
        self.assertEqual(s.first_rendered_frame_webp,expected);self.assertTrue(s.first_rendered_frame_transformed)
    def test_nonblocking_single_owner_and_cancelled_publication(self):
        s=self.session();started=threading.Event();release=threading.Event();pixels=[]
        def slow(*args):
            started.set();release.wait(3);pixels.append(args[1].copy());return True,np.array([1,2,3],np.uint8)
        rgb=np.full((8,8,3),80,np.uint8)
        with mock.patch('pong_swap_engine.cv2.imencode',side_effect=slow):
            before=time.perf_counter();self.assertTrue(_start_seek_preview(s,rgb,True))
            self.assertLess(time.perf_counter()-before,.5);self.assertTrue(started.wait(1))
            self.assertFalse(_start_seek_preview(s,rgb,True));rgb[:]=0;s.stop.set();release.set();self.wait(s)
        self.assertTrue(np.all(pixels[0]==80));self.assertEqual(s.first_rendered_frame_webp,b'')
    def test_encoding_failure_does_not_poison_session(self):
        s=self.session()
        with mock.patch('pong_swap_engine.cv2.imencode',side_effect=RuntimeError('fixture failure')):
            _start_seek_preview(s,np.zeros((8,8,3),np.uint8),False);self.wait(s)
        self.assertEqual(s.first_rendered_frame_webp,b'');self.assertFalse(s.stop.is_set())
    def test_completed_session_waits_for_pending_preview(self):
        s=self.session();s.complete=True;s.first_rendered_frame_pending=True
        engine=PongSwapEngine.__new__(PongSwapEngine)
        engine.session=lambda _:s
        def publish():
            with s.condition:
                s.first_rendered_frame_webp=b'finished'
                s.first_rendered_frame_pending=False
                s.condition.notify_all()
        timer=threading.Timer(.03,publish);timer.start()
        self.assertEqual(engine.session_first_frame_webp(s.id,wait_seconds=1)[0],b'finished')
        timer.join()

if __name__=='__main__':unittest.main()
