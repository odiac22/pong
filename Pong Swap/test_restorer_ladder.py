"""Synthetic controller checks for the responsive 3X restorer ladder; no media or GPU."""
import unittest
from contextlib import nullcontext
from types import SimpleNamespace
import threading
import numpy as np
from pong_three_x import RestorerLadder, ThreeXRenderer, ladder_rung_for
from pong_tiktok_restorer import (ADAPT_THREE_X_PROFILE, TIKTOK_THREE_X_PROFILE, session_config_for_profile,
    restorer_models, select_restorer, adapt_restorer_ladder)


def warm(ladder, faces=1):
    for _ in range(RestorerLadder.WARMUP_FRAMES):
        ladder.observe(.010, 30, faces, None, fresh_faces=faces)
    return ladder


def cadence_frames(ladder, count, seconds, faces, buffer_seconds, cadence=4, fps=30):
    """Feed frames the way Adapt+1/4 produces them: one fresh generation every ``cadence`` frames."""
    changes = []
    for i in range(count):
        fresh = faces if i % cadence == 0 else 0
        if ladder.observe(seconds, fps, faces, buffer_seconds, fresh_faces=fresh):
            changes.append((i, ladder.model))
    return changes


class LadderControllerTest(unittest.TestCase):
    def test_single_face_opens_at_1024_and_crowd_opens_at_floor(self):
        one = RestorerLadder('GPEN357')
        one.observe(.800, 30, 1, None, fresh_faces=1)  # cold first frame is ignored
        self.assertEqual((one.model, one.switches), ('GPEN1024', 0))
        crowd = RestorerLadder('GPEN1024')
        crowd.observe(.300, 30, 5, None, fresh_faces=5)
        self.assertEqual(crowd.model, 'GPEN357')
        two = RestorerLadder('GPEN1024')
        two.observe(.050, 30, 2, None, fresh_faces=2)
        self.assertEqual(two.model, 'GPEN512')

    def test_single_face_with_headroom_climbs_to_1024_gradually(self):
        ladder = RestorerLadder('GPEN357', start='GPEN357')
        self.assertEqual(ladder.model, 'GPEN357')
        # 12 ms frames at 1/4 cadence: a 1024 rung adds 36 ms * 1 face * 0.25 = 9 ms.
        changes = cadence_frames(ladder, 600, .012, 1, 1.5)
        self.assertEqual([m for _, m in changes], ['GPEN512', 'GPEN1024'])
        self.assertGreaterEqual(changes[1][0] - changes[0][0], RestorerLadder.MIN_FRAMES_BETWEEN_UPS)
        self.assertEqual(ladder.reason, 'headroom')

    def test_more_faces_entering_steps_down_before_a_slow_frame_is_measured(self):
        ladder = warm(RestorerLadder('GPEN1024', start='GPEN1024'))
        cadence_frames(ladder, 40, .020, 1, 1.5)
        self.assertEqual(ladder.model, 'GPEN1024')
        # Four more people arrive: the predicted cost jumps far beyond a 33 ms budget.
        self.assertTrue(ladder.observe(.020, 30, 5, 1.5, fresh_faces=5))
        self.assertEqual(ladder.model, 'GPEN357')
        self.assertIn(ladder.reason, ('faces-entered', 'faces-entered-severe'))

    def test_sustained_over_budget_steps_down_and_buffer_low_is_severe(self):
        ladder = warm(RestorerLadder('GPEN1024', start='GPEN1024'), 2)
        for _ in range(2):
            self.assertFalse(ladder.observe(.031, 30, 2, 1.5, fresh_faces=0))
        self.assertEqual(ladder.model, 'GPEN1024')
        self.assertTrue(ladder.observe(.031, 30, 2, 1.5, fresh_faces=0))
        self.assertEqual(ladder.model, 'GPEN512')
        low = warm(RestorerLadder('GPEN1024', start='GPEN1024'))
        self.assertTrue(low.observe(.010, 30, 1, .2, fresh_faces=1))
        self.assertEqual(low.model, 'GPEN357')
        self.assertEqual(low.reason, 'buffer-low')

    def test_single_spike_and_unknown_buffer_do_not_flap(self):
        ladder = warm(RestorerLadder('GPEN1024', start='GPEN1024'))
        cadence_frames(ladder, 60, .012, 1, None)
        ladder.observe(.090, 30, 1, None, fresh_faces=1)
        cadence_frames(ladder, 30, .012, 1, None)
        self.assertEqual(ladder.model, 'GPEN1024')
        self.assertEqual(ladder.switches, 0)

    def test_down_then_recover_requires_dwell_and_safe_buffer(self):
        ladder = warm(RestorerLadder('GPEN1024', start='GPEN1024'), 3)
        for _ in range(5):
            ladder.observe(.045, 30, 3, 1.5, fresh_faces=3)
        self.assertEqual(ladder.model, 'GPEN357')
        # Cheap frames but an unsafe buffer never recover.
        cadence_frames(ladder, 300, .008, 3, .9)
        self.assertEqual(ladder.model, 'GPEN357')
        changes = cadence_frames(ladder, 600, .008, 3, 1.5)
        self.assertEqual([m for _, m in changes], ['GPEN512', 'GPEN1024'])

    def test_probe_climbs_when_measured_cost_stays_far_under_budget(self):
        # Fresh every frame: the prior says 1024 for one face costs 36 ms, which would never
        # fit a 33 ms budget, but real frames at 9 ms earn a rate-limited probe upward.
        ladder = RestorerLadder('GPEN357', start='GPEN357')
        changes = []
        for i in range(900):
            if ladder.observe(.009, 30, 1, 1.5, fresh_faces=1):
                changes.append((i, ladder.model, ladder.reason))
        self.assertEqual([(m, r) for _, m, r in changes], [('GPEN512', 'probe'), ('GPEN1024', 'probe')])
        self.assertGreaterEqual(changes[1][0] - changes[0][0], RestorerLadder.MIN_FRAMES_BETWEEN_PROBES)
        # A rung that turns out too expensive is reversed within a few frames.
        for i in range(12):
            if ladder.observe(.040, 30, 1, 1.5, fresh_faces=1):
                break
        self.assertLess(i, 12)
        self.assertEqual(ladder.model, 'GPEN512')
        # And a probe that fails immediately is reversed on raw frame evidence.
        probe = RestorerLadder('GPEN357', start='GPEN357')
        for _ in range(RestorerLadder.PROBE_FRAMES + 5):
            if probe.observe(.009, 30, 1, 1.5, fresh_faces=1):
                break
        self.assertEqual((probe.model, probe.reason), ('GPEN512', 'probe'))
        for i in range(RestorerLadder.DOWN_FRAMES):
            probe.observe(.060, 30, 1, 1.5, fresh_faces=1)
        self.assertEqual(probe.model, 'GPEN357')

    def test_only_resident_rungs_are_selected(self):
        ladder = RestorerLadder('GPEN357', ready=lambda m: m != 'GPEN512', start='GPEN357')
        cadence_frames(ladder, 600, .008, 1, 1.5)
        self.assertEqual(ladder.model, 'GPEN1024')
        none_ready = RestorerLadder('GPEN357', ready=lambda m: m == 'GPEN357', start='GPEN357')
        cadence_frames(none_ready, 600, .008, 1, 1.5)
        self.assertEqual(none_ready.model, 'GPEN357')
        self.assertEqual(none_ready.switches, 0)
        # Severe pressure skips to the lowest resident rung even when one rung is absent.
        gap = warm(RestorerLadder('GPEN1024', ready=lambda m: m != 'GPEN512', start='GPEN1024'))
        self.assertTrue(gap.observe(.010, 30, 1, .1, fresh_faces=1))
        self.assertEqual(gap.model, 'GPEN357')

    def test_ceiling_and_floor_narrow_the_ladder(self):
        self.assertEqual(adapt_restorer_ladder({'adaptRestorerCeiling': 'GPEN512'}), ('GPEN512', 'GPEN357'))
        self.assertEqual(adapt_restorer_ladder({'adaptRestorerFloor': 'GPEN512'}), ('GPEN1024', 'GPEN512'))
        self.assertFalse(RestorerLadder('GPEN512', ceiling='GPEN512', floor='GPEN512').active)
        self.assertEqual(ladder_rung_for('GPEN257'), 'GPEN357')
        self.assertIsNone(ladder_rung_for('GFPGAN1.2'))


class LadderPlumbingTest(unittest.TestCase):
    def saved(self, model):
        return {'parameters': {'RestorerSwitch': True, 'RestorerTypeTextSel': model, 'RestorerSlider': 100,
                'SwapperTypeTextSel': '128'}, 'runtime': {'frameEnhancerEnabled': False}}

    def test_adapt_three_x_warms_every_rung_and_honours_ladder_choice(self):
        for model in ('GPEN357', 'GPEN512', 'GPEN1024'):
            session = session_config_for_profile(self.saved(model), ADAPT_THREE_X_PROFILE)
            self.assertEqual(set(restorer_models(session)), {'GPEN256', 'GPEN512', 'GPEN1024'})
            self.assertEqual(restorer_models(session)[0], {'GPEN357': 'GPEN256'}.get(model, model))
            self.assertEqual(select_restorer(session, None), session['parameters']['RestorerTypeTextSel'])
            session['runtime']['crowdRestorerModel'] = 'GPEN1024'
            self.assertEqual(select_restorer(session, None), 'GPEN1024')
            self.assertEqual(session['runtime']['tiktokRestorerState']['modelPolicy'], 'adapt-restorer-ladder')
            session['runtime']['crowdRestorerModel'] = 'GPEN357'
            self.assertEqual(select_restorer(session, None), 'GPEN357')
            self.assertGreaterEqual(session['runtime']['tiktokRestorerState']['GPEN357Frames'], 1)
            self.assertEqual(session['runtime']['tiktokRestorerState']['switches'], 1 if model == 'GPEN1024' else 2)
        gfpgan = session_config_for_profile(self.saved('GFPGAN1.2'), ADAPT_THREE_X_PROFILE)
        self.assertEqual(restorer_models(gfpgan), ('GFPGAN1.2',))

    def test_adapt_off_honours_the_explicit_selection(self):
        fixed = session_config_for_profile(self.saved('GPEN357'), TIKTOK_THREE_X_PROFILE)
        self.assertEqual(restorer_models(fixed), ('GPEN256',))
        fixed['runtime']['crowdRestorerModel'] = 'GPEN1024'
        self.assertEqual(select_restorer(fixed, None), 'GPEN357')

    def renderer(self, profile, detections, calls):
        from test_pong_three_x import FakeTensor, row
        def process(frame, source, anchor, **kw):
            calls.append(select_restorer(kw['config'], None))
            kw['frame_evidence'].swap_applied = True
            return kw['frame_tensor'], None
        engine = SimpleNamespace(_lock=threading.RLock(),
            _torch=SimpleNamespace(uint8=np.uint8, cuda=SimpleNamespace(stream=lambda _: nullcontext())),
            _compute_stream=SimpleNamespace(synchronize=lambda: None),
            _frame_tensor=lambda f: FakeTensor(f.transpose(2, 0, 1)),
            _detect=lambda *a, **k: detections, _target_detection_score=lambda: .45,
            process_frame=process, _presentation_classifier=SimpleNamespace(
                classify=lambda *a: SimpleNamespace(known=True, label='female', confidence=.99)))
        config = session_config_for_profile(self.saved('GPEN357'), profile)
        session = SimpleNamespace(config=config, fps=30, channel='ladder-test', client_epoch=profile, id=profile,
            source_url='synthetic', candidate_face_ids=('a', 'b'), stop=threading.Event())
        return ThreeXRenderer(engine, session, [SimpleNamespace(face_id=k, embedding=row(i)[2], source_frame=None)
            for i, k in enumerate('ab')], SimpleNamespace), session

    def test_renderer_builds_ladder_only_with_adapt_and_reports_it(self):
        from test_pong_three_x import row
        detections = [row(0, 0)]
        calls = []
        renderer, session = self.renderer(TIKTOK_THREE_X_PROFILE, detections, calls)
        self.assertIsNone(renderer.restorer_ladder)
        renderer, session = self.renderer(ADAPT_THREE_X_PROFILE, detections, calls)
        self.assertIsNotNone(renderer.restorer_ladder)
        renderer.quality.observe = lambda *a: None
        frame = np.zeros((8, 48, 3), np.uint8)
        # Force the controller to the top rung and confirm the per-person config follows.
        renderer.restorer_ladder.index = 0
        self.assertEqual(renderer.render(frame)[1], 1)
        self.assertEqual(calls[-1], 'GPEN1024')
        decision = session.multi_face_decision
        self.assertEqual(decision['renderedRestorer'], 'GPEN1024')
        self.assertEqual(decision['restorerLadder']['configured'], 'GPEN357')
        self.assertIn('restorer-ladder', decision['adaptiveController'])
        renderer.restorer_ladder.index = 2
        self.assertEqual(renderer.render(frame)[1], 1)
        self.assertEqual(calls[-1], 'GPEN357')
        # A model change discards reusable patches/temporal history for that person.
        self.assertFalse(renderer.temporal)


if __name__ == '__main__':
    unittest.main()
