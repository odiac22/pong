from __future__ import annotations

import unittest
from unittest import mock

import numpy as np
from types import SimpleNamespace

import pong_swap_engine


class LandmarkTrackingTests(unittest.TestCase):
    def test_reacquisition_uses_immutable_anchor_after_viewpoint_adaptation(self):
        engine = pong_swap_engine.PongSwapEngine.__new__(pong_swap_engine.PongSwapEngine)
        engine._config = {'parameters': {'DetectScoreSlider': 45}}
        original = np.zeros(4, dtype=np.float32); original[0] = 1
        drifted = np.zeros(4, dtype=np.float32); drifted[1] = 1
        returning = original.copy()
        evidence = pong_swap_engine.FrameEvidence(
            detection_attempted=True,
            recognition_complete=True,
            detections=((100, self.prior, returning),),
        )
        def similarity(candidate, locked):
            return 90.0 if np.allclose(locked, original) else 20.0
        with mock.patch.object(pong_swap_engine, 'rope_similarity', side_effect=similarity):
            result, retained = engine._choose_target(
                None, drifted, verify_identity=False, prior_kps=None,
                frame_shape=self.frame_shape, frame_evidence=evidence,
                reacquisition_anchors=(original,),
            )
        np.testing.assert_allclose(result, self.prior)
        np.testing.assert_allclose(retained, original)

    def test_reacquisition_still_rejects_bystander_against_immutable_anchor(self):
        engine = pong_swap_engine.PongSwapEngine.__new__(pong_swap_engine.PongSwapEngine)
        engine._config = {'parameters': {'DetectScoreSlider': 45}}
        original = np.zeros(4, dtype=np.float32); original[0] = 1
        drifted = np.zeros(4, dtype=np.float32); drifted[1] = 1
        bystander = np.zeros(4, dtype=np.float32); bystander[2] = 1
        evidence = pong_swap_engine.FrameEvidence(
            detection_attempted=True,
            recognition_complete=True,
            detections=((100, self.prior, bystander),),
        )
        with mock.patch.object(pong_swap_engine, 'rope_similarity', return_value=20):
            result, retained = engine._choose_target(
                None, drifted, verify_identity=False, prior_kps=None,
                frame_shape=self.frame_shape, frame_evidence=evidence,
                reacquisition_anchors=(original,),
            )
        self.assertIsNone(result)
        np.testing.assert_allclose(retained, original)

    def test_reacquisition_accepts_verified_identity_gallery_view(self):
        engine = pong_swap_engine.PongSwapEngine.__new__(pong_swap_engine.PongSwapEngine)
        engine._config = {'parameters': {'DetectScoreSlider': 45}}
        original = np.zeros(4, dtype=np.float32); original[0] = 1
        verified_profile = np.zeros(4, dtype=np.float32); verified_profile[1] = 1
        returning_profile = verified_profile.copy()
        evidence = pong_swap_engine.FrameEvidence(
            detection_attempted=True,
            recognition_complete=True,
            detections=((100, self.prior, returning_profile),),
        )
        def similarity(candidate, locked):
            return 90.0 if np.allclose(locked, verified_profile) else 20.0
        with mock.patch.object(pong_swap_engine, 'rope_similarity', side_effect=similarity):
            result, retained = engine._choose_target(
                None, original, verify_identity=False, prior_kps=None,
                frame_shape=self.frame_shape, frame_evidence=evidence,
                reacquisition_anchors=(original, verified_profile),
            )
        np.testing.assert_allclose(result, self.prior)
        np.testing.assert_allclose(retained, original)
        self.assertEqual(evidence.best_target_raw_similarity, 90.0)

    def test_lost_target_is_recognized_without_waiting_for_periodic_deadline(self):
        engine = pong_swap_engine.PongSwapEngine.__new__(pong_swap_engine.PongSwapEngine)
        engine._config = {'parameters': {'DetectScoreSlider': 45}}
        anchor = np.ones(512, dtype=np.float32)
        engine._models = SimpleNamespace(run_recognize=mock.Mock(return_value=(anchor, None)))
        engine._detect = mock.Mock(return_value=[(100, self.prior, None)])
        for prior in (None, np.full((5, 2), np.nan, dtype=np.float32)):
            with self.subTest(prior_missing=prior is None):
                result, retained = engine._choose_target(None, anchor, verify_identity=False,
                    prior_kps=prior, frame_shape=self.frame_shape)
                np.testing.assert_allclose(result, self.prior)
                self.assertIs(retained, anchor)
        self.assertEqual(engine._models.run_recognize.call_count, 2)
        with mock.patch.object(pong_swap_engine, 'rope_similarity', return_value=20):
            result, retained = engine._choose_target(None, anchor, verify_identity=False,
                prior_kps=None, frame_shape=self.frame_shape)
            self.assertIsNone(result, 'reacquisition must still reject a different identity')
            self.assertIs(retained, anchor)

    def test_restorer_recovery_requires_identity_small_motion_and_fresh_evidence(self):
        p = np.array([[30,30],[70,30],[50,50],[36,70],[64,70]], dtype=np.float32)
        safe = pong_swap_engine._restorer_detector_recovery_is_safe
        self.assertTrue(safe(p, p + 1, 90, 1/30))
        for score in (74, None, float('nan')):
            self.assertFalse(safe(p, p + 1, score, 1/30))
        for seconds in (0, -.01, .2, float('nan')):
            self.assertFalse(safe(p, p + 1, 90, seconds))
        self.assertFalse(safe(p, None, 90, 1/30))
        self.assertFalse(safe(p, p + 30, 90, 1/30))
        self.assertFalse(safe(p, p * 1.3, 90, 1/30))
        deformed = p.copy(); deformed[2] += 5
        self.assertFalse(safe(p, deformed, 90, 1/30))
    def test_impossible_reacquisition_skips_appearance_but_continuity_is_preserved(self):
        engine = pong_swap_engine.PongSwapEngine.__new__(pong_swap_engine.PongSwapEngine)
        engine._config = {'parameters': {'DetectScoreSlider': 45}}
        classifier = mock.Mock(return_value=pong_swap_engine.FacePresentation('unknown', 0))
        engine._presentation_classifier = SimpleNamespace(classify=classifier)
        anchor = np.ones(512, dtype=np.float32)
        points = np.array([[30,30],[70,30],[50,50],[36,70],[64,70]],dtype=np.float32)
        def evidence():
            return SimpleNamespace(detection_attempted=True, recognition_complete=True, rejection_reasons=[],
                                   detections=((100,points,anchor),))
        required = pong_swap_engine.FacePresentation('female', .99)
        with mock.patch.object(pong_swap_engine, 'rope_similarity', return_value=30):
            result,_ = engine._choose_target(None, anchor, frame_evidence=evidence(),
                frame_rgb=np.zeros((120,160,3),dtype=np.uint8),required_presentation=required)
            self.assertIsNone(result)
            classifier.assert_not_called()
            engine._choose_target(None,anchor,frame_evidence=evidence(),prior_kps=points,
                frame_rgb=np.zeros((120,160,3),dtype=np.uint8),required_presentation=required)
            classifier.assert_called_once()

    def setUp(self) -> None:
        # Conventional five-point layout: eyes, nose, and mouth corners.
        self.prior = np.asarray(
            [
                [30.0, 30.0],
                [70.0, 30.0],
                [50.0, 50.0],
                [36.0, 70.0],
                [64.0, 70.0],
            ],
            dtype=np.float32,
        )
        self.good_status = np.ones((5, 1), dtype=np.uint8)
        self.frame_shape = (120, 160, 3)

    def valid(self, candidate, backtracked=None, forward_status=None, backward_status=None):
        return pong_swap_engine._tracked_landmarks_are_valid(
            self.prior,
            np.asarray(candidate, dtype=np.float32),
            self.prior if backtracked is None else np.asarray(backtracked, dtype=np.float32),
            self.good_status if forward_status is None else forward_status,
            self.good_status if backward_status is None else backward_status,
            self.frame_shape,
        )

    def test_rigid_translation_with_consistent_reverse_track_is_valid(self) -> None:
        self.assertTrue(self.valid(self.prior + np.asarray([3.0, 2.0], dtype=np.float32)))

    def test_forward_backward_mismatch_is_rejected(self) -> None:
        reverse = self.prior.copy()
        reverse[2] += np.asarray([7.0, 0.0], dtype=np.float32)
        self.assertFalse(self.valid(self.prior + 2.0, backtracked=reverse))

    def test_one_occluded_landmark_is_allowed_but_fewer_than_three_are_rejected(self) -> None:
        one_missing = self.good_status.copy()
        one_missing[3] = 0
        self.assertTrue(self.valid(self.prior + 2.0, forward_status=one_missing))
        self.assertTrue(self.valid(self.prior + 2.0, backward_status=one_missing))

        three_missing = self.good_status.copy()
        three_missing[2:] = 0
        self.assertFalse(self.valid(self.prior + 2.0, forward_status=three_missing))
        self.assertFalse(self.valid(self.prior + 2.0, backward_status=three_missing))

    def test_collapsed_or_sheared_landmark_geometry_is_rejected(self) -> None:
        collapsed = self.prior.copy()
        collapsed[3:] = collapsed[2]
        self.assertFalse(self.valid(collapsed))

        sheared = self.prior.copy()
        sheared[4] += np.asarray([35.0, 0.0], dtype=np.float32)
        self.assertFalse(self.valid(sheared))

    def test_track_that_leaves_frame_tolerance_is_rejected(self) -> None:
        outside = self.prior.copy()
        outside[:, 0] -= 45.0
        self.assertFalse(self.valid(outside))

    def test_lk_wrapper_runs_forward_and_reverse_pass(self) -> None:
        translated = self.prior + np.asarray([2.0, 1.0], dtype=np.float32)
        gray = np.zeros(self.frame_shape[:2], dtype=np.uint8)
        with mock.patch.object(
            pong_swap_engine.cv2,
            "calcOpticalFlowPyrLK",
            side_effect=[
                (translated.reshape(-1, 1, 2), self.good_status, np.zeros((5, 1))),
                (self.prior.reshape(-1, 1, 2), self.good_status, np.zeros((5, 1))),
            ],
        ) as flow:
            result = pong_swap_engine._track_landmarks_lk(
                gray,
                gray,
                self.prior,
                self.frame_shape,
            )

        self.assertEqual(flow.call_count, 2)
        np.testing.assert_allclose(result, translated)

    def test_reconstructed_landmark_evidence_cannot_claim_five_observations(self) -> None:
        translated = self.prior + np.asarray([2.0, 1.0], dtype=np.float32)
        one_missing = self.good_status.copy()
        one_missing[4] = 0
        gray = np.zeros(self.frame_shape[:2], dtype=np.uint8)
        with mock.patch.object(
            pong_swap_engine.cv2,
            "calcOpticalFlowPyrLK",
            side_effect=[
                (translated.reshape(-1, 1, 2), one_missing, np.zeros((5, 1))),
                (self.prior.reshape(-1, 1, 2), one_missing, np.zeros((5, 1))),
            ],
        ):
            evidence = pong_swap_engine._track_landmarks_lk(
                gray,
                gray,
                self.prior,
                self.frame_shape,
                return_evidence=True,
            )

        self.assertIsInstance(evidence, pong_swap_engine.LandmarkTrackEvidence)
        self.assertTrue(evidence.reconstructed)
        self.assertEqual(int(np.count_nonzero(evidence.observed_mask)), 4)
        self.assertTrue(np.isfinite(evidence.fit_residual))

    def test_local_motion_recovery_remains_distinct_from_direct_observation(self) -> None:
        offsets = np.asarray(
            [[-4.0, 0.0], [4.0, 0.0], [0.0, -4.0], [0.0, 4.0]],
            dtype=np.float32,
        )
        auxiliary = (self.prior[:, None, :] + offsets[None, :, :]).reshape(-1, 2)
        all_points = np.concatenate([self.prior, auxiliary], axis=0)
        translated = all_points + np.asarray([2.0, 1.0], dtype=np.float32)
        reverse = all_points + np.asarray([0.25, 0.0], dtype=np.float32)
        status = np.ones((25, 1), dtype=np.uint8)
        status[4] = 0
        gray = np.zeros(self.frame_shape[:2], dtype=np.uint8)
        with mock.patch.object(
            pong_swap_engine.cv2,
            "calcOpticalFlowPyrLK",
            side_effect=[
                (translated.reshape(-1, 1, 2), status, np.zeros((25, 1))),
                (reverse.reshape(-1, 1, 2), status, np.zeros((25, 1))),
            ],
        ):
            evidence = pong_swap_engine._track_landmarks_lk(
                gray,
                gray,
                self.prior,
                self.frame_shape,
                return_evidence=True,
            )

        self.assertIsInstance(evidence, pong_swap_engine.LandmarkTrackEvidence)
        self.assertEqual(int(np.count_nonzero(evidence.observed_mask)), 4)
        self.assertTrue(bool(evidence.locally_recovered_mask[4]))
        self.assertGreater(float(evidence.reverse_errors[4]), 0.0)

    def test_inconsistent_auxiliary_motion_cannot_recover_semantic_landmark(self) -> None:
        offsets = np.asarray(
            [[-4.0, 0.0], [4.0, 0.0], [0.0, -4.0], [0.0, 4.0]],
            dtype=np.float32,
        )
        auxiliary = (self.prior[:, None, :] + offsets[None, :, :]).reshape(-1, 2)
        all_points = np.concatenate([self.prior, auxiliary], axis=0)
        translated = all_points + np.asarray([2.0, 1.0], dtype=np.float32)
        # The four samples around landmark 4 individually reverse-track, but
        # disagree on forward motion enough that they cannot represent one
        # semantic landmark.
        translated[21:25] += np.asarray(
            [[-4.0, 0.0], [4.0, 0.0], [0.0, -4.0], [0.0, 4.0]],
            dtype=np.float32,
        )
        status = np.ones((25, 1), dtype=np.uint8)
        status[4] = 0
        gray = np.zeros(self.frame_shape[:2], dtype=np.uint8)
        with mock.patch.object(
            pong_swap_engine.cv2,
            "calcOpticalFlowPyrLK",
            side_effect=[
                (translated.reshape(-1, 1, 2), status, np.zeros((25, 1))),
                (all_points.reshape(-1, 1, 2), status, np.zeros((25, 1))),
            ],
        ):
            evidence = pong_swap_engine._track_landmarks_lk(
                gray,
                gray,
                self.prior,
                self.frame_shape,
                return_evidence=True,
            )

        self.assertIsInstance(evidence, pong_swap_engine.LandmarkTrackEvidence)
        self.assertFalse(bool(evidence.locally_recovered_mask[4]))
        self.assertTrue(evidence.reconstructed)

    def test_dark_pixels_remain_valid_appearance_evidence(self) -> None:
        dark = np.zeros(self.frame_shape, dtype=np.uint8)
        self.assertTrue(
            pong_swap_engine._full_frame_reuse_appearance_is_safe(
                dark,
                dark.copy(),
                self.prior,
                self.prior,
            )
        )

    def test_similarity_pose_round_trip_preserves_rotation_scale_and_translation(self) -> None:
        angle = np.deg2rad(17.0)
        scale = 1.35
        transform = np.asarray(
            [
                [np.cos(angle) * scale, -np.sin(angle) * scale, 24.0],
                [np.sin(angle) * scale, np.cos(angle) * scale, -11.0],
            ],
            dtype=np.float32,
        )
        points = pong_swap_engine.cv2.transform(
            pong_swap_engine._POSE_CANONICAL.reshape(1, -1, 2),
            transform,
        )[0]
        fitted = pong_swap_engine._fit_similarity_pose(points)
        self.assertIsNotNone(fitted)
        pose, fitted_matrix = fitted
        np.testing.assert_allclose(
            pong_swap_engine._pose_matrix(pose)[:2],
            fitted_matrix,
            atol=1e-4,
            rtol=1e-5,
        )

    def test_stationary_rotated_pose_is_not_changed_by_filter(self) -> None:
        angle = np.deg2rad(-23.0)
        transform = np.asarray(
            [
                [np.cos(angle), -np.sin(angle), 82.0],
                [np.sin(angle), np.cos(angle), 41.0],
            ],
            dtype=np.float32,
        )
        points = pong_swap_engine.cv2.transform(
            pong_swap_engine._POSE_CANONICAL.reshape(1, -1, 2),
            transform,
        )[0]
        state = {"trackGeneration": 3, "kps": points.copy()}
        first, pose = pong_swap_engine._propose_render_landmarks(
            state,
            points,
            media_time_seconds=1.0,
        )
        state["renderPose"] = pose
        state["kps"] = first
        second, _ = pong_swap_engine._propose_render_landmarks(
            state,
            points,
            media_time_seconds=1.0 + 1.0 / 30.0,
        )
        np.testing.assert_allclose(first, points, atol=1e-4, rtol=1e-5)
        np.testing.assert_allclose(second, points, atol=1e-4, rtol=1e-5)

    def test_lk_wrapper_returns_none_when_reverse_pass_is_inconsistent(self) -> None:
        translated = self.prior + np.asarray([2.0, 1.0], dtype=np.float32)
        bad_reverse = self.prior.copy()
        bad_reverse[0] += np.asarray([8.0, 0.0], dtype=np.float32)
        gray = np.zeros(self.frame_shape[:2], dtype=np.uint8)
        with mock.patch.object(
            pong_swap_engine.cv2,
            "calcOpticalFlowPyrLK",
            side_effect=[
                (translated.reshape(-1, 1, 2), self.good_status, np.zeros((5, 1))),
                (bad_reverse.reshape(-1, 1, 2), self.good_status, np.zeros((5, 1))),
            ],
        ):
            result = pong_swap_engine._track_landmarks_lk(
                gray,
                gray,
                self.prior,
                self.frame_shape,
            )

        self.assertIsNone(result)

    def test_lk_wrapper_uses_one_shared_interior_roi_and_restores_global_coordinates(self) -> None:
        frame_shape = (720, 1280, 3)
        prior = self.prior + np.asarray([590.0, 300.0], dtype=np.float32)
        translated = prior + np.asarray([3.0, -2.0], dtype=np.float32)
        gray = np.zeros(frame_shape[:2], dtype=np.uint8)
        roi = pong_swap_engine._landmark_tracking_roi(gray, gray, prior, frame_shape)
        self.assertIsNotNone(roi)
        left, top, right, bottom = roi
        offset = np.asarray([left, top], dtype=np.float32)
        calls = []

        def flow(previous, current, points, _next, **_options):
            calls.append((previous.shape, current.shape, points.copy()))
            if len(calls) == 1:
                local = translated - offset
            else:
                local = prior - offset
            return local.reshape(-1, 1, 2), self.good_status, np.zeros((5, 1))

        with mock.patch.object(
            pong_swap_engine.cv2,
            "calcOpticalFlowPyrLK",
            side_effect=flow,
        ):
            result = pong_swap_engine._track_landmarks_lk(
                gray,
                gray,
                prior,
                frame_shape,
            )

        self.assertEqual(len(calls), 2)
        expected_shape = (bottom - top, right - left)
        self.assertEqual(calls[0][0], expected_shape)
        self.assertEqual(calls[0][1], expected_shape)
        self.assertEqual(calls[1][0], expected_shape)
        self.assertEqual(calls[1][1], expected_shape)
        self.assertLess(expected_shape[0] * expected_shape[1], frame_shape[0] * frame_shape[1])
        self.assertEqual(calls[0][2].reshape(-1, 2).shape, (25, 2))
        np.testing.assert_allclose(calls[0][2].reshape(-1, 2)[:5], prior - offset)
        np.testing.assert_allclose(calls[1][2].reshape(-1, 2), translated - offset)
        np.testing.assert_allclose(result, translated)

    def test_lk_wrapper_falls_back_to_full_frame_when_roi_would_touch_boundary(self) -> None:
        frame_shape = (720, 1280, 3)
        prior = self.prior.copy()
        translated = prior + np.asarray([2.0, 1.0], dtype=np.float32)
        gray = np.zeros(frame_shape[:2], dtype=np.uint8)
        self.assertIsNone(
            pong_swap_engine._landmark_tracking_roi(gray, gray, prior, frame_shape)
        )
        calls = []

        def flow(previous, current, points, _next, **_options):
            calls.append((previous.shape, current.shape, points.copy()))
            values = translated if len(calls) == 1 else prior
            return values.reshape(-1, 1, 2), self.good_status, np.zeros((5, 1))

        with mock.patch.object(
            pong_swap_engine.cv2,
            "calcOpticalFlowPyrLK",
            side_effect=flow,
        ):
            result = pong_swap_engine._track_landmarks_lk(
                gray,
                gray,
                prior,
                frame_shape,
            )

        self.assertEqual(len(calls), 2)
        self.assertTrue(all(previous == frame_shape[:2] for previous, _, _ in calls))
        self.assertTrue(all(current == frame_shape[:2] for _, current, _ in calls))
        self.assertEqual(calls[0][2].reshape(-1, 2).shape, (25, 2))
        np.testing.assert_allclose(calls[0][2].reshape(-1, 2)[:5], prior)
        np.testing.assert_allclose(result, translated)

    def test_roi_rejects_mismatched_frame_geometry(self) -> None:
        prior_gray = np.zeros((720, 1280), dtype=np.uint8)
        current_gray = np.zeros((719, 1280), dtype=np.uint8)
        prior = self.prior + np.asarray([590.0, 300.0], dtype=np.float32)
        self.assertIsNone(
            pong_swap_engine._landmark_tracking_roi(
                prior_gray,
                current_gray,
                prior,
                (720, 1280, 3),
            )
        )

    def test_smoothing_reduces_jitter_but_does_not_lag_fast_motion(self) -> None:
        slow = self.prior + np.asarray([1.0, 0.0], dtype=np.float32)
        smoothed = pong_swap_engine._smooth_tracked_landmarks(self.prior, slow)
        self.assertTrue(np.all(smoothed[:, 0] > self.prior[:, 0]))
        self.assertTrue(np.all(smoothed[:, 0] < slow[:, 0]))

        fast = self.prior + np.asarray([8.0, 0.0], dtype=np.float32)
        unsmoothed = pong_swap_engine._smooth_tracked_landmarks(self.prior, fast)
        np.testing.assert_allclose(unsmoothed, fast)

    def test_detector_shape_continuity_preserves_local_shape_at_global_pose(self) -> None:
        detected = self.prior + np.asarray([7.0, -3.0], dtype=np.float32)
        predicted = self.prior.copy()
        predicted[3:5, 1] += 1.0
        diagnostics = {}
        reconciled = pong_swap_engine._reconcile_detector_pose_with_lk_shape(
            detected,
            predicted,
            detector_detail_weight=0.20,
            max_local_residual_ratio=0.10,
            diagnostics=diagnostics,
        )
        self.assertEqual(diagnostics.get("detectorShapeContinuityReason"), "accepted")
        self.assertLess(
            abs(float((reconciled[4, 1] - reconciled[3, 1]) - (predicted[4, 1] - predicted[3, 1]))),
            abs(float((detected[4, 1] - detected[3, 1]) - (predicted[4, 1] - predicted[3, 1]))) + 1e-6,
        )
        self.assertAlmostEqual(
            float(np.mean(reconciled[:, 0])),
            float(np.mean(detected[:, 0])),
            delta=1.0,
        )

    def test_detector_shape_continuity_rejects_large_local_disagreement(self) -> None:
        detected = self.prior.copy()
        predicted = self.prior.copy()
        predicted[4] += np.asarray([18.0, -12.0], dtype=np.float32)
        diagnostics = {}
        reconciled = pong_swap_engine._reconcile_detector_pose_with_lk_shape(
            detected,
            predicted,
            max_local_residual_ratio=0.03,
            diagnostics=diagnostics,
        )
        np.testing.assert_allclose(reconciled, detected)
        self.assertEqual(
            diagnostics.get("detectorShapeContinuityReason"),
            "local-disagreement",
        )

    def test_whole_output_transport_rejects_nonrigid_feature_motion(self) -> None:
        current = np.full(self.frame_shape, 90, dtype=np.uint8)
        previous = current.copy()
        swapped = np.full(self.frame_shape, 110, dtype=np.uint8)
        rigid = self.prior + np.asarray([3.0, 2.0], dtype=np.float32)
        self.assertIsNotNone(
            pong_swap_engine._warp_prior_swap_residual(
                current,
                previous,
                swapped,
                self.prior,
                rigid,
                max_landmark_residual_ratio=0.03,
            )
        )

        nonrigid = rigid.copy()
        nonrigid[4] += np.asarray([10.0, -4.0], dtype=np.float32)
        diagnostics = {}
        self.assertIsNone(
            pong_swap_engine._warp_prior_swap_residual(
                current,
                previous,
                swapped,
                self.prior,
                nonrigid,
                max_landmark_residual_ratio=0.03,
                diagnostics=diagnostics,
            )
        )
        self.assertEqual(diagnostics.get("reason"), "nonrigid-landmark-motion")
        self.assertGreater(diagnostics.get("landmarkResidualRatio", 0.0), 0.03)

    def test_pose_aware_affine_transport_accepts_bounded_yaw_foreshortening(self) -> None:
        current = np.full(self.frame_shape, 90, dtype=np.uint8)
        previous = current.copy()
        swapped = np.full(self.frame_shape, 110, dtype=np.uint8)
        center = np.mean(self.prior, axis=0)
        yaw = np.asarray([[0.94, 0.035], [0.0, 1.02]], dtype=np.float32)
        target = (self.prior - center) @ yaw.T + center + np.asarray(
            [3.0, 2.0], dtype=np.float32
        )
        diagnostics = {}
        plan = pong_swap_engine._plan_prior_swap_residual(
            current,
            previous,
            swapped,
            self.prior,
            target,
            max_landmark_residual_ratio=1.0,
            pose_aware_affine=True,
            pose_aware_affine_max_anisotropy=1.12,
            pose_aware_affine_min_improvement=0.10,
            pose_aware_affine_min_residual_ratio=0.001,
            diagnostics=diagnostics,
        )
        self.assertIsNotNone(plan)
        self.assertEqual(diagnostics.get("transportMode"), "pose-aware-affine")
        self.assertTrue(diagnostics.get("poseAwareAffineAccepted"))
        self.assertLessEqual(diagnostics.get("poseAwareAffineAnisotropy"), 1.12)

    def test_pose_aware_affine_transport_rejects_excessive_anisotropy(self) -> None:
        current = np.full(self.frame_shape, 90, dtype=np.uint8)
        previous = current.copy()
        swapped = np.full(self.frame_shape, 110, dtype=np.uint8)
        center = np.mean(self.prior, axis=0)
        target = (self.prior - center) @ np.asarray(
            [[0.65, 0.0], [0.0, 1.10]], dtype=np.float32
        ).T + center
        diagnostics = {}
        plan = pong_swap_engine._plan_prior_swap_residual(
            current,
            previous,
            swapped,
            self.prior,
            target,
            max_landmark_residual_ratio=1.0,
            pose_aware_affine=True,
            pose_aware_affine_max_anisotropy=1.12,
            pose_aware_affine_min_improvement=0.0,
            pose_aware_affine_min_residual_ratio=0.0,
            diagnostics=diagnostics,
        )
        self.assertIsNotNone(plan)
        self.assertNotEqual(diagnostics.get("transportMode"), "pose-aware-affine")
        self.assertFalse(diagnostics.get("poseAwareAffineAccepted"))


if __name__ == "__main__":
    unittest.main()
