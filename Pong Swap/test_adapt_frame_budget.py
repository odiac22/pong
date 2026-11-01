import unittest
from pathlib import Path
from unittest.mock import Mock
import numpy as np
from pong_three_x import AdaptiveRenderQuality, FaceCorrectionCache
from pong_swap_identity import FairFacePresentationClassifier


class FrameBudgetTests(unittest.TestCase):
    def test_low_buffer_escalates_beyond_compute_limit_and_recovers_only_when_safe(self):
        q=AdaptiveRenderQuality(responsive=True);q.level=4
        for _ in range(2):q.observe(.010,30,2,.08)
        self.assertEqual(q.level,6)
        self.assertEqual(q.reason,'buffer-low')
        for _ in range(100):q.observe(.010,30,2,.6)
        self.assertEqual(q.level,6)
        for _ in range(90):q.observe(.010,30,2,1.5)
        self.assertEqual(q.level,5)

    def test_player_pause_background_stale_feedback_do_not_trigger_catchup(self):
        from types import SimpleNamespace
        import threading,time
        from pong_three_x import ThreeXRenderer
        renderer=object.__new__(ThreeXRenderer);renderer.responsive_adapt=True
        renderer.engine=SimpleNamespace(_playback_headroom_seconds=lambda *a:.08)
        s=renderer.session=SimpleNamespace(prefetch=False,playback_started_at=1,
            playback_paused=False,playback_position_updated_at=time.monotonic(),
            stop=threading.Event(),scrub_suspended=threading.Event())
        self.assertEqual(renderer._playback_buffer(),.08)
        for name in ('prefetch','playback_paused'):
            setattr(s,name,True);self.assertIsNone(renderer._playback_buffer());setattr(s,name,False)
        s.scrub_suspended.set();self.assertIsNone(renderer._playback_buffer());s.scrub_suspended.clear()
        s.playback_position_updated_at=time.monotonic()-3
        self.assertIsNone(renderer._playback_buffer())

    def test_static_people_refresh_on_separate_frames(self):
        from types import SimpleNamespace
        from contextlib import nullcontext
        import threading
        from pong_three_x import ThreeXRenderer
        from pong_tiktok_restorer import session_config_for_profile
        from test_pong_three_x import FakeTensor,row
        frame=np.full((80,100,3),70,np.uint8)
        detections=[(a,p+[0,30],e) for a,p,e in [row(0,20),row(1,50)]]
        calls=[]
        def process(original,source,anchor,**kw):
            calls.append(1);kw['frame_evidence'].swap_applied=True
            return kw['frame_tensor'],None
        engine=SimpleNamespace(_lock=threading.RLock(),
            _torch=SimpleNamespace(uint8=np.uint8,cuda=SimpleNamespace(stream=lambda _:nullcontext())),
            _compute_stream=SimpleNamespace(synchronize=lambda:None),
            _frame_tensor=lambda f:FakeTensor(f.transpose(2,0,1)),_detect=lambda *a,**k:detections,
            _target_detection_score=lambda:.45,process_frame=process,
            _presentation_classifier=SimpleNamespace(classify=lambda *a:SimpleNamespace(known=True,label='female',confidence=.99)))
        config=session_config_for_profile({'parameters':{'RestorerSwitch':True,'RestorerTypeTextSel':'GPEN256'},
            'runtime':{'frameEnhancerEnabled':False}},'tiktok-3x-adapt')
        session=SimpleNamespace(config=config,fps=30,channel='stagger-test',client_epoch='one',id='one',
            source_url='synthetic',candidate_face_ids=('a','b'),stop=threading.Event())
        r=ThreeXRenderer(engine,session,[SimpleNamespace(face_id=k,embedding=e,source_frame=None)
            for k,e in [('a',row(0)[2]),('b',row(1)[2])]],SimpleNamespace)
        r.quality.level=6;r.quality.observe=lambda *a:None
        r._correction_regions=lambda f,pairs,d:[(key,d[index][1],(18+30*index,28,25+30*index,35)) for key,index in pairs]
        exact_counts=[]
        for _ in range(24):
            before=len(calls);_,count=r.render(frame)
            self.assertEqual(count,2);exact_counts.append(len(calls)-before)
        self.assertEqual(exact_counts[0],2)
        self.assertLessEqual(max(exact_counts[1:]),1)
        self.assertGreater(r.staggered_refreshes,0)

    def test_one_or_two_faces_under_pressure_adapt_quickly_then_recover(self):
        for faces in (1,2):
            q = AdaptiveRenderQuality(responsive=True)
            q.observe(.060,30,faces)
            self.assertEqual(q.level,0)
            q.observe(.060,30,faces)
            self.assertEqual(q.level,2)
            for _ in range(4):q.observe(.060,30,faces)
            self.assertEqual(q.level,4)
            for _ in range(100):q.observe(.008,30,faces)
            self.assertLess(q.level,4)
            for _ in range(400):q.observe(.008,30,faces)
            self.assertEqual(q.level,0)

    def test_single_spike_does_not_oscillate(self):
        q = AdaptiveRenderQuality(responsive=True)
        for _ in range(40):q.observe(.012,30,2)
        q.observe(.080,30,2)
        for _ in range(30):q.observe(.012,30,2)
        self.assertEqual(q.level,0)

    def test_longer_reuse_rejects_local_mouth_change(self):
        frame=np.full((80,80,3),70,np.uint8)
        points=np.array([[25,25],[45,25],[35,35],[28,45],[42,45]],np.float32)
        cache=FaceCorrectionCache()
        cache.remember(frame,frame+10,[('person',points,(5,5,65,65))],1)
        changed=frame.copy();changed[42:49,25:32]=130
        # The tiny changed region passes whole-head averages, but the local
        # mouth guard must demand a fresh swap for longer reuse.
        self.assertIsNone(cache.render(changed,[('person',points)],1,max_age=5))

    def test_policy_only_preserves_exact_classifier_input_and_decision(self):
        c=FairFacePresentationClassifier(Path('unused'))
        c.warm=Mock();c._input_name='input';c._gender_output_index=0;c._gender_is_class_id=False
        c._crop=Mock(return_value=np.full((224,224,3),127,np.uint8))
        c._appearance=Mock(return_value=(.5,))
        c._session=Mock();c._session.run.return_value=[np.array([[0.,5.]],np.float32)]
        normal=c.classify(None,None);first=c._session.run.call_args[0][1]['input'].copy()
        c._appearance.reset_mock()
        policy=c.classify_policy(None,None)
        np.testing.assert_array_equal(first,c._session.run.call_args[0][1]['input'])
        self.assertEqual((normal.label,normal.confidence),(policy.label,policy.confidence))
        self.assertEqual(policy.appearance,())
        c._appearance.assert_not_called()


if __name__=='__main__':unittest.main()
