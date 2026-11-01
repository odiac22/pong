"""Synthetic crowd/load transitions only; no media or model inference."""
from copy import deepcopy
import unittest
import numpy as np
from pong_three_x import CrowdQuality, apply_quality_policy, FaceCorrectionCache
from pong_tiktok_restorer import (ADAPT_THREE_X_PROFILE, TIKTOK_THREE_X_PROFILE,
    session_config_for_profile, restorer_models, select_restorer)


class CrowdAdaptTest(unittest.TestCase):
    def config(self, model='GPEN1024', profile=ADAPT_THREE_X_PROFILE):
        return session_config_for_profile({'parameters': {'RestorerSwitch': True,
            'RestorerTypeTextSel': model, 'RestorerSlider': 50, 'SwapperTypeTextSel': '512'},
            'runtime': {'maximumFps': 30, 'maximumWidth': 1920}}, profile)

    def test_requires_sustained_actual_crowd_and_pressure_then_recovers(self):
        q = CrowdQuality()
        for _ in range(20):
            self.assertFalse(q.update(4, 0, True))
        self.assertTrue(q.update(4, 1, True))
        for _ in range(29):
            self.assertTrue(q.update(2, 1, True))
        self.assertFalse(q.update(2, 1, True))
        for _ in range(7):
            self.assertFalse(q.update(3, 1, True))
        self.assertTrue(q.update(3, 1, True))
        self.assertFalse(q.update(3, 0, True))
        self.assertFalse(q.update(4, 3, False))

    def test_one_model_step_only_and_preset_unchanged(self):
        for model, expected in [('GPEN1024','GPEN512'), ('GPEN512','GPEN256'),
                                ('GPEN256','GPEN256'), ('GFPGAN1.2','GFPGAN1.2')]:
            saved = self.config(model)
            before = deepcopy(saved)
            config = deepcopy(saved)
            for level in (1, 2, 3):
                apply_quality_policy(config, saved, level, crowd_pressure=True)
                self.assertEqual(select_restorer(config, None), expected)
                self.assertEqual(config['parameters'], saved['parameters'])
                self.assertIn(expected, restorer_models(saved))
            apply_quality_policy(config, saved, 3, crowd_pressure=False)
            self.assertEqual(select_restorer(config, None), model)
            self.assertEqual(saved, before)
            self.assertEqual(session_config_for_profile(config), session_config_for_profile(saved))

    def test_off_and_no_load_cannot_downgrade_or_enable_restoration(self):
        for profile, level in [(TIKTOK_THREE_X_PROFILE, 3), (ADAPT_THREE_X_PROFILE, 0)]:
            saved = self.config(profile=profile)
            config = deepcopy(saved)
            apply_quality_policy(config, saved, level, True)
            self.assertEqual(select_restorer(config, None), 'GPEN1024')
        saved = self.config()
        saved['parameters']['RestorerSwitch'] = False
        config = deepcopy(saved)
        apply_quality_policy(config, saved, 3, True)
        self.assertFalse(config['parameters']['RestorerSwitch'])
        self.assertNotIn('crowdRestorerModel', config['runtime'])

    def test_extra_reuse_is_bounded_and_rejects_changed_appearance(self):
        frame = np.full((80,80,3), 70, np.uint8)
        points = np.array([[25,25],[45,25],[35,35],[28,45],[42,45]], np.float32)
        cache = FaceCorrectionCache()
        cache.remember(frame, frame + 10, [('person',points,(15,15,55,55))], 1)
        for _ in range(3):
            self.assertIsNotNone(cache.render(frame, [('person',points)], 1, max_age=3))
        for _ in range(4):
            self.assertIsNotNone(cache.render(frame, [('person',points)], 1, max_age=100))
        self.assertIsNone(cache.render(frame, [('person',points)], 1, max_age=100))
        cache.remember(frame, frame + 10, [('person',points,(15,15,55,55))], 1)
        self.assertIsNone(cache.render(frame + 50, [('person',points)], 1, max_age=3))

    def test_renderer_four_distinct_sources_recover_cleanly(self):
        from contextlib import nullcontext
        from types import SimpleNamespace
        import threading
        from pong_three_x import ThreeXRenderer
        from test_pong_three_x import row, FakeTensor
        calls = []
        detections = [row(i, i*10) for i in range(4)]
        def process(frame, source, anchor, **kw):
            context = kw['temporal_context']
            calls.append((select_restorer(kw['config'], None), id(context)))
            kw['frame_evidence'].swap_applied = True
            return kw['frame_tensor'], None
        engine = SimpleNamespace(_lock=threading.RLock(),
            _torch=SimpleNamespace(uint8=np.uint8, cuda=SimpleNamespace(stream=lambda _: nullcontext())),
            _compute_stream=SimpleNamespace(synchronize=lambda: None),
            _frame_tensor=lambda f: FakeTensor(f.transpose(2,0,1)),
            _detect=lambda *a, **k: detections, _target_detection_score=lambda: .45,
            process_frame=process, _presentation_classifier=SimpleNamespace(
                classify=lambda *a: SimpleNamespace(known=True,label='female',confidence=.99)))
        session = SimpleNamespace(config=self.config(), fps=30, channel='crowd-test', client_epoch='crowd-test',
            id='crowd', source_url='synthetic', candidate_face_ids=tuple('abcd'), stop=threading.Event())
        renderer = ThreeXRenderer(engine, session,
            [SimpleNamespace(face_id=key, embedding=np.ones(32), source_frame=None) for key in 'abcd'], SimpleNamespace)
        renderer.quality.level = 1
        # Count pressure only; no timers, real images, decoding or GPU needed.
        renderer.quality.observe = lambda *a: None
        frame = np.zeros((8,48,3), np.uint8)
        for _ in range(8):
            self.assertEqual(renderer.render(frame)[1], 4)
        self.assertEqual([m for m,_ in calls[-4:]], ['GPEN512']*4)
        self.assertEqual(len({c for _,c in calls[-4:]}), 4)
        self.assertTrue(session.multi_face_decision['crowdQualityActive'])
        old_contexts = list(renderer.temporal.values())
        renderer.quality.level = 0
        self.assertEqual(renderer.render(frame)[1], 4)
        self.assertEqual([m for m,_ in calls[-4:]], ['GPEN1024']*4)
        self.assertFalse(renderer.temporal)
        self.assertFalse(renderer.corrections)
        self.assertFalse(session.multi_face_decision['crowdQualityActive'])
        self.assertEqual(session.multi_face_decision['gpenMode'], 'GPEN1024')


if __name__ == '__main__':
    unittest.main()
