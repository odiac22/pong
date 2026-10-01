"""History age/reset regressions independent of CUDA or external footage."""
import unittest
from unittest.mock import Mock
import torch
import numpy as np
import pong_swap_engine  # initializes local Rope imports
from rope.VideoManager import (VideoManager, _temporal_elapsed_seconds,
    _correction_confidence, _stabilize_restorer_correction, _binary_mask_morphology)


class StageHistoryTests(unittest.TestCase):
    def test_verified_identity_check_preserves_other_invalidation_reasons(self):
        points=np.array([[20,20],[50,20],[35,35],[25,50],[45,50]],dtype=np.float32)
        for extras in ([],['scene-cut'],['pts-discontinuity'],['approved-source-switch'],['target-loss']):
            context={'forceExact':True,'forceExactReasons':['identity-deadline',*extras]}
            released=pong_swap_engine._release_verified_identity_deadline(context,points,points,90,1/30)
            self.assertTrue(released)
            self.assertEqual(context['forceExactReasons'],extras)
            self.assertEqual(context['forceExact'],bool(extras))

    def test_identity_deadline_stays_exact_on_missing_weak_or_displaced_evidence(self):
        points=np.array([[20,20],[50,20],[35,35],[25,50],[45,50]],dtype=np.float32)
        for current,similarity,elapsed in ((None,90,.03),(points,60,.03),(points+30,90,.03),(points,90,.5),(points,float('nan'),.03)):
            context={'forceExact':True,'forceExactReasons':['identity-deadline']}
            self.assertFalse(pong_swap_engine._release_verified_identity_deadline(context,points,current,similarity,elapsed))
            self.assertTrue(context['forceExact'])

    def test_thin_occlusion_refreshes_in_every_region_at_each_source_rate(self):
        vm = object.__new__(VideoManager)
        for fps in (24, 25, 30, 50, 60):
            for x, y in ((7,7), (31,7), (7,31), (55,55)):
                for key in ('occluder', 'dflXSeg'):
                    source = torch.zeros((3,64,64)) + 80
                    mask = torch.ones((1,64,64))
                    context = {'enabled':True, 'frameIndex':0, 'mediaTimeSeconds':0.,
                        'maxAnchorFrames':60, 'maskAnchorHz':10,
                        'maskLocalChangeGuardEnabled':True}
                    vm._temporal_mask_result(context,key,source,(),lambda:mask)
                    context.update(frameIndex=1,mediaTimeSeconds=1/fps)
                    source[:,y:y+2,x:x+2] += 90
                    actual=vm._temporal_mask_result(context,key,source,(),lambda:mask*0)
                    self.assertTrue(torch.equal(actual,mask*0))
                    self.assertIn('local-patch-disagreement', context['lastStageDecisions'][key]['knownReasons'])

    def test_unchanged_visibility_still_reuses_before_deadline(self):
        vm=object.__new__(VideoManager)
        source=torch.zeros((3,64,64)); mask=torch.ones((1,64,64))
        context={'enabled':True,'frameIndex':0,'mediaTimeSeconds':0.,'maxAnchorFrames':30,'maskAnchorHz':10,'maskLocalChangeGuardEnabled':True}
        vm._temporal_mask_result(context,'occluder',source,(),lambda:mask)
        context.update(frameIndex=1,mediaTimeSeconds=1/30)
        result=vm._temporal_mask_result(context,'occluder',source,(),lambda:self.fail('Unnecessary refresh'))
        self.assertTrue(torch.equal(result,mask))

    def test_binary_morphology_matches_original_including_edges(self):
        torch.manual_seed(1)
        masks=[torch.zeros((1,16,16)),torch.ones((1,16,16)),(torch.rand(1,16,16)>.8).float()]
        edge=torch.zeros((1,16,16));edge[0,0,0]=1;masks.append(edge)
        kernel=torch.ones((1,1,3,3))
        for mask in masks:
            for amount in (-20,-6,-2,-1,0,1,2,6,20):
                expected=1-mask if amount<0 else mask.clone()
                for _ in range(abs(amount)):
                    expected=torch.nn.functional.conv2d(expected,kernel,padding=1).clamp(0,1)
                if amount<0: expected=1-expected
                self.assertTrue(torch.equal(expected,_binary_mask_morphology(mask,amount)))

    def test_restorer_local_rejection_applies_to_every_quadrant(self):
        source = torch.full((3,64,64), 80.)
        for x,y in ((8,8), (40,8), (8,40), (40,40)):
            changed = source.clone()
            changed[:,y:y+8,x:x+8] += 40
            confidence = _correction_confidence(changed, source)
            self.assertEqual(float(confidence[0,y+4,x+4]), 0.)
            self.assertEqual(float(confidence[0,32,32]), 1.)

    def test_restorer_refresh_blends_correction_not_current_image(self):
        source = torch.full((3,32,32), 80.)
        context = {'frameIndex': 0, 'mediaTimeSeconds': 0.}
        _stabilize_restorer_correction(source, source*0+20, context, ())
        context.update(frameIndex=1, mediaTimeSeconds=.04)
        result = _stabilize_restorer_correction(source, source*0+60, context, ())
        self.assertTrue(torch.allclose(result, source*0+40))

    def test_restorer_display_history_resets_on_cut(self):
        source = torch.full((3,32,32), 80.)
        context = {'frameIndex': 0, 'mediaTimeSeconds': 0.}
        _stabilize_restorer_correction(source, source*0+20, context, ())
        context.update(frameIndex=1, mediaTimeSeconds=.04, forceExact=True,
                       forceExactReasons=['scene-cut'])
        result = _stabilize_restorer_correction(source, source*0+60, context, ())
        self.assertTrue(torch.allclose(result, source*0+60))

    def test_uncertain_reuse_cannot_reintroduce_displayed_history(self):
        source = torch.full((3,32,32), 80.)
        context = {'frameIndex': 0, 'mediaTimeSeconds': 0.}
        _stabilize_restorer_correction(source, source*0+20, context, ())
        context.update(frameIndex=1, mediaTimeSeconds=.04)
        result = _stabilize_restorer_correction(source, source*0, context, (),
                                                torch.zeros((1,32,32)))
        self.assertTrue(torch.equal(result, source*0))

    def test_detector_order_does_not_replace_locked_identity(self):
        engine = object.__new__(pong_swap_engine.PongSwapEngine)
        engine._config = {'parameters': {'DetectScoreSlider': 53}}
        points = np.array([[20,20], [50,20], [35,35], [25,50], [45,50]], dtype=np.float32)
        embedding = np.array([1.,0.,0.,0.], dtype=np.float32)
        target = (100., points, embedding)
        other = (1000., points + 100, np.array([0.,1.,0.,0.], dtype=np.float32))
        for ordering in ((target, other), (other, target)):
            evidence = pong_swap_engine.FrameEvidence(detection_attempted=True,
                recognition_complete=True, detections=ordering)
            selected, anchor = engine._choose_target(None, embedding, verify_identity=True,
                prior_kps=points, frame_shape=(400,400,3), frame_evidence=evidence)
            np.testing.assert_array_equal(selected, points)
            np.testing.assert_array_equal(anchor, embedding)

    def test_unverified_missing_history_cannot_select_detector_index_zero(self):
        engine = object.__new__(pong_swap_engine.PongSwapEngine)
        engine._config = {'parameters': {}}
        # Missing geometric history now forces an identity check even between
        # periodic verification ticks. Model that check explicitly; an absent
        # test model is not evidence of a tracker failure.
        engine._models = Mock()
        engine._models.run_recognize.return_value = (
            np.array([0.,1.,0.,0.], dtype=np.float32), None)
        points = np.array([[20,20], [50,20], [35,35], [25,50], [45,50]], dtype=np.float32)
        embedding = np.array([1.,0.,0.,0.], dtype=np.float32)
        evidence = pong_swap_engine.FrameEvidence(detection_attempted=True,
            detections=((100., points, None),))
        selected, _ = engine._choose_target(None, embedding, verify_identity=False,
            prior_kps=None, frame_evidence=evidence)
        self.assertIsNone(selected)
        engine._models.run_recognize.assert_called_once()
        self.assertTrue(evidence.recognition_complete)

    def test_evidence_age_is_independent_of_source_fps(self):
        for fps in (24, 25, 30, 50, 60):
            context = {'mediaTimeSeconds': 1.2, 'nominalFrameSeconds': 1 / fps}
            self.assertAlmostEqual(_temporal_elapsed_seconds(context, {'mediaTimeSeconds': 1.0}), .2)

    def test_identity_history_cannot_cross_reset_with_identical_pixels(self):
        source = torch.full((3, 32, 32), 80.)
        first = source + 20
        current = source + 60
        context = {'identityResidualStabilizationEnabled': True, 'nominalFrameSeconds': 1/30}
        vm = object.__new__(VideoManager)
        vm._temporal_identity_residual(first, source, {}, context)
        context['forceExact'] = True
        result = vm._temporal_identity_residual(current, source, {}, context)
        self.assertTrue(torch.equal(current, result))
        self.assertEqual(context['identityResidualReason'], 'temporal-reset')

    def test_parser_force_reset_never_blends_old_mask(self):
        vm = object.__new__(VideoManager)
        source = torch.full((3, 64, 64), 80.)
        mask = torch.zeros((1, 64, 64))
        context = {'enabled': True, 'frameIndex': 0, 'mediaTimeSeconds': 0.,
                   'maxAnchorFrames': 60, 'maskExactParserBlendEnabled': True,
                   'maskExactParserBlendHalfLifeSeconds': .2}
        vm._temporal_mask_result(context, 'faceParser', source, (), lambda: mask)
        context.update(frameIndex=1, mediaTimeSeconds=1/60, forceExact=True)
        result = vm._temporal_mask_result(context, 'faceParser', source, (), lambda: mask + 1)
        self.assertTrue(torch.equal(result, mask + 1))

    def test_mask_uses_own_deadline_not_gpen_deadline(self):
        vm = object.__new__(VideoManager)
        source = torch.full((3, 64, 64), 80.)
        mask = torch.zeros((1, 64, 64))
        context = {'enabled': True, 'frameIndex': 0, 'mediaTimeSeconds': 0.,
                   'maxAnchorFrames': 30, 'maskAnchorHz': 10}
        vm._temporal_mask_result(context, 'faceParser', source, (), lambda: mask)
        context.update(frameIndex=6, mediaTimeSeconds=.1)
        result = vm._temporal_mask_result(context, 'faceParser', source, (), lambda: mask + 1)
        self.assertTrue(torch.equal(result, mask + 1))
        self.assertEqual(context['faceParserExactFrames'], 2)

    def test_moving_region_rejects_parser_history(self):
        vm = object.__new__(VideoManager)
        source = torch.full((3, 64, 64), 80.)
        mask = torch.zeros((1, 64, 64))
        context = {'enabled': True, 'frameIndex': 0, 'mediaTimeSeconds': 0.,
                   'maxAnchorFrames': 1, 'maskExactParserBlendEnabled': True,
                   'maskExactParserBlendHalfLifeSeconds': .2}
        vm._temporal_mask_result(context, 'faceParser', source, (), lambda: mask)
        context.update(frameIndex=1, mediaTimeSeconds=1/60)
        source[:, 16:32, 16:32] += 80
        result = vm._temporal_mask_result(context, 'faceParser', source, (), lambda: mask + 1)
        self.assertEqual(float(result[0, 24, 24]), 1.)
        self.assertLess(float(result[0, 48, 48]), .1)


if __name__ == '__main__':
    unittest.main()
