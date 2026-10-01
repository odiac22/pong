from __future__ import annotations

import concurrent.futures
import inspect
import threading
import unittest
from unittest import mock

import cv2
import numpy as np
import torch

from pong_swap_config import default_config
from pong_swap_engine import (
    MaskMotionPreflight,
    PongSwapEngine,
    SwapSession,
    _record_adaptive_mask_motion,
    _selected_adaptive_mask_backend,
    _apply_source_fps_runtime_cadence,
    _compose_canonical_motion_transform,
    _discard_residual_future_for_promotion,
    _stabilize_exact_output_with_prior,
    _stabilize_exact_mouth_with_prior,
    _time_normalized_current_weight,
    _quality_preserving_output_cadence,
    _warp_prior_swap_residual,
    build_temporal_restorer_context,
)
from rope.VideoManager import VideoManager
from rope.Models import Models


def make_session(*, frames: int = 8, fps: float = 30.0) -> SwapSession:
    return SwapSession(
        id="temporal-test",
        channel="test",
        source_url="https://example.invalid/video.mp4",
        face_id="stock-test",
        start_seconds=0.0,
        frames=frames,
        fps=fps,
        config=default_config(),
    )


class TemporalSafetyTests(unittest.TestCase):
    def test_full_quality_cadence_keeps_time_and_uniform_spacing(self):
        for source, expected, stride in ((24,24,1),(25,25,1),(30,30,1),(50,25,2),(60,30,2),(59.94,29.97,2)):
            actual, step = _quality_preserving_output_cadence(source, 30)
            self.assertAlmostEqual(actual, expected)
            self.assertEqual(step, stride)
            self.assertAlmostEqual(300/source, (300/step)/actual)
        self.assertEqual(_quality_preserving_output_cadence(60,0),(60,1))
        with self.assertRaises(ValueError):_quality_preserving_output_cadence(float('nan'),30)
    @staticmethod
    def _identity_landmarks() -> np.ndarray:
        return np.asarray(
            [[48, 52], [80, 52], [64, 68], [52, 84], [76, 84]],
            dtype=np.float32,
        )

    def test_fixed_frame_restorer_normalizes_absent_temporal_context(self) -> None:
        source = inspect.getsource(VideoManager._apply_restorer_inner)
        self.assertIn("temporal_context = temporal_context or {}", source)

    def test_time_normalized_blend_has_equal_wall_clock_decay_across_fps(self) -> None:
        remaining = []
        for fps in (24.0, 25.0, 30.0, 50.0, 60.0):
            weight = _time_normalized_current_weight(0.68, 1.0 / fps, 0.020)
            remaining.append((1.0 - weight) ** round(fps * 0.50))
        self.assertLess(max(remaining) - min(remaining), 1e-6)

    def test_source_fps_resolves_detection_identity_and_parser_cadence(self) -> None:
        expected = {
            24.0: (3, 38, 1),
            25.0: (3, 40, 1),
            30.0: (4, 48, 2),
            50.0: (7, 80, 4),
            60.0: (8, 96, 5),
        }
        for fps, values in expected.items():
            runtime = {
                "targetDetectHz": 7.5,
                "identityCheckHz": 0.625,
                "temporalFaceParserHz": 10.0,
            }
            resolved = _apply_source_fps_runtime_cadence(runtime, fps)
            self.assertEqual(
                (
                    resolved["targetDetectIntervalFrames"],
                    resolved["identityCheckIntervalFrames"],
                    resolved["temporalFaceParserSkipFrames"],
                ),
                values,
            )

    def test_exact_output_confidence_yields_to_any_changed_region(self) -> None:
        points = self._identity_landmarks()
        previous = np.full((128, 128, 3), 80, dtype=np.uint8)
        current = previous.copy()
        current[48:60, 48:60] = 180
        prior_swap = np.full((128, 128, 3), 150, dtype=np.uint8)
        exact = np.full((128, 128, 3), 220, dtype=np.uint8)
        diagnostics = {}
        result = _stabilize_exact_output_with_prior(
            current,
            exact,
            previous,
            prior_swap,
            points,
            points,
            current_weight=0.68,
            max_face_mae=255.0,
            max_face_p90=255.0,
            max_patch_mae=255.0,
            delta_seconds=1.0 / 30.0,
            half_life_seconds=0.020,
            motion_low_per_second=1.0,
            motion_high_per_second=2.0,
            diagnostics=diagnostics,
        )
        self.assertEqual(diagnostics.get("exactStabilizationReason"), "accepted")
        self.assertLess(int(result[72, 72, 0]), int(exact[72, 72, 0]))
        self.assertGreaterEqual(int(result[54, 54, 0]), 216)

    def test_exact_output_fast_motion_keeps_current_without_warp_work(self) -> None:
        previous_points = self._identity_landmarks()
        current_points = previous_points + np.asarray([12.0, 0.0], dtype=np.float32)
        frame = np.full((128, 128, 3), 80, dtype=np.uint8)
        exact = np.full((128, 128, 3), 170, dtype=np.uint8)
        diagnostics = {}
        result = _stabilize_exact_output_with_prior(
            frame,
            exact,
            frame,
            exact,
            previous_points,
            current_points,
            delta_seconds=1.0 / 30.0,
            diagnostics=diagnostics,
        )
        self.assertIs(result, exact)
        self.assertEqual(
            diagnostics.get("exactStabilizationReason"),
            "high-motion-current",
        )

    def test_exact_mouth_stabilizer_changes_only_a_compact_safe_island(self) -> None:
        points = self._identity_landmarks()
        current = np.full((128, 128, 3), 80, dtype=np.uint8)
        previous = current.copy()
        prior_swap = current.copy()
        prior_swap[76:96, 42:86] = 150
        exact = current.copy()
        exact[76:96, 42:86] = 220
        diagnostics = {}
        result = _stabilize_exact_mouth_with_prior(
            current,
            exact,
            previous,
            prior_swap,
            points,
            points,
            current_weight=0.75,
            diagnostics=diagnostics,
        )
        self.assertEqual(diagnostics.get("exactMouthReason"), "accepted")
        self.assertTrue(np.array_equal(result[:48], exact[:48]))
        self.assertLess(int(result[84, 64, 0]), int(exact[84, 64, 0]))

    def test_exact_mouth_stabilizer_rejects_a_new_mouth_occluder(self) -> None:
        points = self._identity_landmarks()
        previous = np.full((128, 128, 3), 80, dtype=np.uint8)
        current = previous.copy()
        current[74:98, 38:90] = 245
        prior_swap = previous.copy()
        prior_swap[76:96, 42:86] = 150
        exact = current.copy()
        diagnostics = {}
        result = _stabilize_exact_mouth_with_prior(
            current,
            exact,
            previous,
            prior_swap,
            points,
            points,
            diagnostics=diagnostics,
        )
        self.assertEqual(diagnostics.get("exactMouthReason"), "appearance")
        self.assertTrue(np.array_equal(result, exact))

    def test_shared_temporal_context_propagates_experimental_options(self) -> None:
        runtime = default_config()["runtime"]
        runtime.update(
            temporalContinuousResidualWarp=True,
            temporalCanonicalResidualTransport=True,
            restorerResidualReturn=True,
            exactPastebackRoundToNearest=True,
            restorerOutputFractionalLevels=32,
            faceParserEvidenceQuantizationStep=2.0,
            restorerHybridReferenceReasons=["frame-age"],
            restorerHybridReferenceCadenceByReason={"frame-age": 7},
            temporalRestorerSpatialBlendEnabled=True,
            temporalRestorerSpatialBlendTriggerReasons=[
                "lower-center-disagreement"
            ],
            temporalRestorerSpatialBlendTriggerMaxGapFrames=30,
            temporalRestorerSpatialBlendTriggerMinimumEvents=1,
            temporalRestorerSpatialBlendTriggerMinimumPatchToMeanRatio=15.0,
            temporalRestorerSpatialBlendBurstHoldFrames=60,
            temporalRestorerSpatialBlendCurrentWeight=0.5,
            temporalRestorerSpatialBlendChangeLow=1.0,
            temporalRestorerSpatialBlendChangeHigh=8.0,
            temporalRestorerSpatialBlendEdgeGuardFraction=0.03,
        )
        context = build_temporal_restorer_context(
            runtime,
            enabled=True,
            extras={"sentinel": "benchmark"},
        )
        self.assertTrue(context["enabled"])
        self.assertTrue(context["residualReturn"])
        self.assertTrue(context["exactPastebackRoundToNearest"])
        self.assertEqual(context["outputFractionalLevels"], 32)
        self.assertEqual(context["faceParserEvidenceQuantizationStep"], 2.0)
        self.assertEqual(context["hybridReferenceReasons"], ("frame-age",))
        self.assertEqual(
            context["hybridReferenceCadenceByReason"], {"frame-age": 7}
        )
        self.assertTrue(context["spatialExactBlendEnabled"])
        self.assertEqual(
            context["spatialExactBlendTriggerReasons"],
            ("lower-center-disagreement",),
        )
        self.assertEqual(context["spatialExactBlendTriggerMaxGapFrames"], 30)
        self.assertEqual(context["spatialExactBlendTriggerMinimumEvents"], 1)
        self.assertEqual(
            context["spatialExactBlendTriggerMinimumPatchToMeanRatio"], 15.0
        )
        self.assertEqual(context["spatialExactBlendBurstHoldFrames"], 60)
        self.assertEqual(context["spatialExactBlendCurrentWeight"], 0.5)
        self.assertEqual(context["spatialExactBlendEdgeGuardFraction"], 0.03)
        self.assertEqual(context["sentinel"], "benchmark")

    def test_adaptive_mask_backend_locks_once_per_tracking_generation(self) -> None:
        runtime = default_config()["runtime"]
        runtime.update(
            maskAdaptiveBackendEnabled=True,
            maskAdaptiveResidualThreshold=0.008,
            maskAdaptiveMinimumSamples=3,
        )
        tracking = {"trackGeneration": 4}
        for residual in (0.004, 0.006, 0.007):
            _record_adaptive_mask_motion(
                runtime,
                tracking,
                {"landmarkResidualRatio": residual},
            )
        self.assertEqual(_selected_adaptive_mask_backend(runtime, tracking), "trt")
        # A later high-motion sample cannot flip an already-visible track.
        _record_adaptive_mask_motion(
            runtime,
            tracking,
            {"landmarkResidualRatio": 0.5},
        )
        self.assertEqual(_selected_adaptive_mask_backend(runtime, tracking), "trt")
        self.assertEqual(len(tracking["maskAdaptiveBackend"]["samples"]), 3)

        # A real cut/seek/target-loss generation starts conservatively again.
        tracking["trackGeneration"] = 5
        self.assertEqual(_selected_adaptive_mask_backend(runtime, tracking), "cuda")
        for residual in (0.02, 0.03, 0.015):
            _record_adaptive_mask_motion(
                runtime,
                tracking,
                {"landmarkResidualRatio": residual},
            )
        self.assertEqual(_selected_adaptive_mask_backend(runtime, tracking), "cuda")

    def test_mask_motion_preflight_is_identical_for_rgb_and_bgr_inputs(self) -> None:
        rgb_classifier = MaskMotionPreflight(
            frame_count=5,
            flow_p90_threshold=0.8,
        )
        bgr_classifier = MaskMotionPreflight(
            frame_count=5,
            flow_p90_threshold=0.8,
        )
        for index in range(5):
            frame = np.zeros((180, 320, 3), dtype=np.uint8)
            left = 12 + index * 17
            cv2.rectangle(
                frame,
                (left, 35),
                (left + 70, 145),
                (225, 47, 139),
                -1,
            )
            rgb_classifier.add(frame, rgb=True)
            bgr_classifier.add(frame[:, :, ::-1], rgb=False)
        rgb_result = rgb_classifier.result()
        bgr_result = bgr_classifier.result()
        self.assertEqual(rgb_result["backend"], bgr_result["backend"])
        self.assertEqual(rgb_result["sampleCount"], 4)
        self.assertEqual(rgb_result["frameCount"], 5)
        self.assertAlmostEqual(
            rgb_result["medianFlowP90"],
            bgr_result["medianFlowP90"],
            places=6,
        )

    def test_promotion_joins_and_discards_inflight_residual(self) -> None:
        started = threading.Event()
        release = threading.Event()
        discard_complete = threading.Event()

        def render():
            started.set()
            self.assertTrue(release.wait(timeout=2.0))
            return np.full((2, 2, 3), 99, dtype=np.uint8)

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(render)
            self.assertTrue(started.wait(timeout=1.0))

            def discard():
                _discard_residual_future_for_promotion(future)
                discard_complete.set()

            thread = threading.Thread(target=discard)
            thread.start()
            self.assertFalse(discard_complete.wait(timeout=0.05))
            release.set()
            self.assertTrue(discard_complete.wait(timeout=1.0))
            thread.join(timeout=1.0)
            self.assertFalse(thread.is_alive())
            self.assertTrue(future.done())

    def test_mask_backend_family_keys_are_canonicalized(self) -> None:
        models = object.__new__(Models)
        models._mask_backend_preference = "cuda"
        models._mask_runtime_backend = {
            "occluder": "trt",
            "faceParser": "trt",
        }
        self.assertEqual(models._mask_backend_for_call("occluder"), "trt")
        self.assertEqual(models._mask_backend_for_call("faceparser"), "trt")

    def test_temporal_reuse_requires_monotonic_media_time(self) -> None:
        session = make_session(frames=4)
        runtime = default_config()["runtime"]
        self.assertTrue(
            PongSwapEngine._session_temporal_frame_may_reuse(
                session,
                runtime,
                verify_identity=False,
                last_exact_frame=0,
                current_timeline_seconds=4.0 / 30.0,
                last_exact_timeline_seconds=0.0,
                timeline_reliable=True,
            )
        )
        for current, anchor, reliable in (
            (None, 0.0, False),
            (0.0, 0.0, True),
            (-0.1, 0.0, True),
            (1.0, 0.0, True),
        ):
            self.assertFalse(
                PongSwapEngine._session_temporal_frame_may_reuse(
                    session,
                    runtime,
                    verify_identity=False,
                    last_exact_frame=0,
                    current_timeline_seconds=current,
                    last_exact_timeline_seconds=anchor,
                    timeline_reliable=reliable,
                )
            )

    def test_high_load_reuse_gate_keeps_small_or_25fps_sources_fresh(self) -> None:
        runtime = default_config()["runtime"]
        runtime.update(
            temporalForegroundReuseEnabled=True,
            temporalForegroundReuseHighLoadOnly=True,
            temporalForegroundReuseMinimumPixels=700000,
            temporalForegroundReuseMinimumFps=27.0,
        )
        high_resolution = make_session(fps=30.0)
        phone_resolution = make_session(fps=30.0)
        twenty_five_fps = make_session(fps=25.0)
        self.assertTrue(
            PongSwapEngine._foreground_reuse_allowed_for_source(
                high_resolution,
                runtime,
                (720, 1280, 3),
            )
        )
        self.assertFalse(
            PongSwapEngine._foreground_reuse_allowed_for_source(
                phone_resolution,
                runtime,
                (960, 506, 3),
            )
        )
        self.assertFalse(
            PongSwapEngine._foreground_reuse_allowed_for_source(
                twenty_five_fps,
                runtime,
                (720, 1280, 3),
            )
        )

    def test_pixel_rate_gate_adapts_jointly_to_resolution_and_fps(self) -> None:
        runtime = default_config()["runtime"]
        runtime.update(
            temporalForegroundReuseEnabled=True,
            temporalForegroundReuseHighLoadOnly=True,
            temporalForegroundReuseMinimumPixelRate=16_000_000,
        )
        high_resolution_24 = make_session(fps=24.0)
        phone_30 = make_session(fps=30.0)
        self.assertTrue(PongSwapEngine._foreground_reuse_allowed_for_source(
            high_resolution_24, runtime, (1280, 720, 3)
        ))
        self.assertFalse(PongSwapEngine._foreground_reuse_allowed_for_source(
            phone_30, runtime, (960, 506, 3)
        ))

    def test_reused_stage_never_renews_original_anchor(self) -> None:
        context = {
            "frameIndex": 8,
            "frameDependencyAnchorFrame": 8,
            "mediaTimeSeconds": 8 / 30,
            "frameDependencyAnchorTimeSeconds": 8 / 30,
        }
        original_anchor = {
            "frameIndex": 0,
            "anchorFrameIndex": 0,
            "anchorMediaTimeSeconds": 0.0,
        }
        VideoManager._mark_temporal_dependency(context, original_anchor)
        self.assertEqual(context["frameDependencyAnchorFrame"], 0)
        self.assertEqual(context["frameDependencyAnchorTimeSeconds"], 0.0)

        # A frame produced at 8 and considered again at 15 still depends on
        # frame 0. It cannot silently become a fresh anchor at either hop.
        inherited = {
            "frameIndex": 8,
            "anchorFrameIndex": context["frameDependencyAnchorFrame"],
            "anchorMediaTimeSeconds": context["frameDependencyAnchorTimeSeconds"],
        }
        context.update(
            frameIndex=15,
            frameDependencyAnchorFrame=15,
            mediaTimeSeconds=0.5,
            frameDependencyAnchorTimeSeconds=0.5,
            frameHadStageReuse=False,
        )
        VideoManager._mark_temporal_dependency(context, inherited)
        self.assertEqual(context["frameDependencyAnchorFrame"], 0)
        self.assertEqual(context["frameDependencyAnchorTimeSeconds"], 0.0)

    def test_external_interrupt_does_not_close_decoder_owned_container(self) -> None:
        engine = object.__new__(PongSwapEngine)
        session = make_session()
        session.container = mock.Mock()
        session.lifecycle_lock = threading.RLock()
        engine._interrupt_session_resources(session)
        session.container.close.assert_not_called()

    def test_canonical_motion_composition_recovers_known_similarity(self) -> None:
        angle = np.deg2rad(11.0)
        scale = 1.08
        motion = np.asarray(
            [
                [scale * np.cos(angle), -scale * np.sin(angle), 13.25],
                [scale * np.sin(angle), scale * np.cos(angle), -7.5],
                [0.0, 0.0, 1.0],
            ],
            dtype=np.float64,
        )
        source_to_canonical = np.asarray(
            [[1.7, 0.0, 20.0], [0.0, 1.7, 35.0], [0.0, 0.0, 1.0]],
            dtype=np.float64,
        )
        target_to_canonical = source_to_canonical @ np.linalg.inv(motion)
        composed = _compose_canonical_motion_transform(
            source_to_canonical,
            target_to_canonical,
        )
        self.assertIsNotNone(composed)
        np.testing.assert_allclose(composed, motion[:2], rtol=0.0, atol=1e-9)

    def test_canonical_motion_composition_rejects_singular_target(self) -> None:
        source = np.eye(3, dtype=np.float64)
        target = np.zeros((3, 3), dtype=np.float64)
        self.assertIsNone(_compose_canonical_motion_transform(source, target))

    def test_canonical_face_geometry_matches_historical_exact_transform(self) -> None:
        vm = object.__new__(VideoManager)
        vm.arcface_dst = np.asarray(
            [
                [38.2946, 51.6963],
                [73.5318, 51.5014],
                [56.0252, 71.7366],
                [41.5493, 92.3655],
                [70.7299, 92.2041],
            ],
            dtype=np.float32,
        )
        points = self._identity_landmarks()
        parameters = {
            "SwapperTypeTextSel": "128",
            "DetailTransferSlider": 0,
            "FaceAdjSwitch": False,
            "KPSXSlider": 0,
            "KPSYSlider": 0,
            "KPSScaleSlider": 0,
        }
        matrix, pipeline_size = vm.canonical_face_transform_matrix(points, parameters)
        self.assertEqual(pipeline_size, 128)
        mapped = cv2.transform(points.reshape(1, -1, 2), matrix[:2])[0]
        expected = vm.arcface_dst.copy()
        expected[:, 0] += 8.0
        self.assertLess(float(np.mean(np.linalg.norm(mapped - expected, axis=1))), 1.5)

    def test_exact_pasteback_rounding_is_explicit_and_saturating(self) -> None:
        values = torch.tensor([-0.6, 0.49, 0.51, 254.51, 255.6], dtype=torch.float32)
        rounded = VideoManager._quantize_exact_pasteback(
            values,
            round_to_nearest=True,
        )
        np.testing.assert_array_equal(
            rounded.cpu().numpy(),
            np.asarray([0, 0, 1, 255, 255], dtype=np.uint8),
        )



if __name__ == "__main__":
    unittest.main()
