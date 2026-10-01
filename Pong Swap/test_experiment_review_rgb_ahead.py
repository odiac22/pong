import unittest
import threading
import numpy as np
from experiment_review_rgb_ahead import ReadyRGBFrame, RGBSource, RGBCandidateContainer
from experiment_tiktok_decode_ahead import DecodeAhead
from test_experiment_tiktok_decode_ahead import _Container, _Frame


class RGBTests(unittest.TestCase):
    def test_pixels_pts_and_single_owner(self):
        c=_Container(41);q=DecodeAhead(RGBSource(c),object());q.start()
        frames=list(q.frames());self.assertTrue(q.close())
        self.assertEqual(len(frames),41)
        for i,f in enumerate(frames):
            self.assertEqual(f.pts,i*40)
            np.testing.assert_array_equal(f.to_ndarray(format='rgb24'),_Frame(i).to_ndarray(format='rgb24'))
        self.assertEqual(c.owner,c.close_owner)
        self.assertNotEqual(c.owner,threading.get_ident())

    def test_metadata_ready_before_worker_and_cancel(self):
        c=_Container(100)
        proxy=RGBCandidateContainer.prepare(c,lambda x:x.streams[1])
        self.assertEqual(proxy.stream_metadata.codec_context.width,720)
        proxy.start();list(proxy.decode(proxy.stream_metadata));proxy.close()
        self.assertEqual(c.close_count,1)

    def test_conversion_only_once(self):
        calls=[];f=_Frame(3);original=f.to_ndarray
        f.to_ndarray=lambda **kw:(calls.append(kw),original(**kw))[1]
        ready=ReadyRGBFrame(f)
        self.assertIs(ready.to_ndarray(format='rgb24'),ready.to_ndarray(format='rgb24'))
        self.assertEqual(len(calls),1)
        with self.assertRaises(ValueError):ready.to_ndarray(format='bgr24')


if __name__=='__main__':unittest.main()
