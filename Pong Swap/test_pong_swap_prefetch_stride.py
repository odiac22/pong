from __future__ import annotations

import unittest
from unittest import mock

import cv2
import numpy as np
import pong_swap_engine

from pong_swap_config import default_config
from pong_swap_engine import (
    PongSwapEngine,
    SwapSession,
    _advance_prefetch_tracking,
    _full_frame_reuse_appearance_is_safe,
    _warp_prior_swap_residual,
)


def make_session(*, frames: int, promoted: bool = False) -> SwapSession:
    return SwapSession(
        id="prefetch",
        channel="test",
        source_url="https://example.invalid/video.mp4",
        face_id="test1",
        start_seconds=0.0,
        frames=frames,
        fps=24.0,
        prefetch=not promoted,
        activation_requested=promoted,
        playback_started_at=1.0 if promoted else 0.0,
        config=default_config(),
    )


class PrefetchInferenceStrideTests(unittest.TestCase):
    def test_default_is_conservative_full_inference(self) -> None:
        config = default_config()
        session = make_session(frames=1)
        self.assertEqual(config["runtime"]["prefetchInferenceStride"], 1)
        self.assertFalse(
            PongSwapEngine._prefetch_frame_may_reuse(
                session,
                config["runtime"],
                verify_identity=False,
            )
        )

    def test_opt_in_halves_expensive_calls_for_24_output_frames(self) -> None:
        runtime = {"prefetchInferenceStride": 2}
        decisions = []
        for frame_index in range(24):
            session = make_session(frames=frame_index)
            decisions.append(
                PongSwapEngine._prefetch_frame_may_reuse(
                    session,
                    runtime,
                    verify_identity=False,
                )
            )
        self.assertEqual(sum(decisions), 12)
        self.assertEqual(len(decisions) - sum(decisions), 12)

    def test_identity_boundary_and_promotion_force_full_inference(self) -> None:
        runtime = {"prefetchInferenceStride": 2}
        hidden = make_session(frames=1)
        promoted = make_session(frames=1, promoted=True)
        self.assertFalse(
            PongSwapEngine._prefetch_frame_may_reuse(
                hidden,
                runtime,
                verify_identity=True,
            )
        )
        self.assertFalse(
            PongSwapEngine._prefetch_frame_may_reuse(
                promoted,
                runtime,
                verify_identity=False,
            )
        )

    def test_residual_warp_preserves_current_background_and_tracks_face(self) -> None:
        height, width = 180, 240
        previous = np.full((height, width, 3), 40, dtype=np.uint8)
        current = np.full((height, width, 3), 60, dtype=np.uint8)
        # A non-face background mark must remain the current frame's value.
        current[10:20, 10:20] = (7, 8, 9)
        previous_swapped = previous.copy()
        previous_swapped[65:115, 85:135] = (180, 120, 90)
        prior_kps = np.asarray(
            [[95, 78], [125, 78], [110, 92], [100, 105], [120, 105]],
            dtype=np.float32,
        )
        current_kps = prior_kps + np.asarray([12.0, 4.0], dtype=np.float32)

        output = _warp_prior_swap_residual(
            current,
            previous,
            previous_swapped,
            prior_kps,
            current_kps,
        )

        self.assertIsNotNone(output)
        np.testing.assert_array_equal(output[10:20, 10:20], current[10:20, 10:20])
        # The swapped residual moved with the tracked face instead of remaining
        # at its old coordinates.
        self.assertGreater(float(output[90, 122, 0]), float(current[90, 122, 0]))
        np.testing.assert_array_equal(output[30:40, 200:210], current[30:40, 200:210])

    def test_tracking_failure_is_a_full_inference_fallback(self) -> None:
        frame = np.zeros((120, 160, 3), dtype=np.uint8)
        state = {
            "rawKps": np.asarray(
                [[30, 30], [70, 30], [50, 50], [36, 70], [64, 70]],
                dtype=np.float32,
            ),
            "kps": np.asarray(
                [[30, 30], [70, 30], [50, 50], [36, 70], [64, 70]],
                dtype=np.float32,
            ),
            "gray": cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY),
            # A due detector means the cheap lane must decline the frame.
            "sinceDetect": 6,
        }
        before = dict(state)
        self.assertIsNone(_advance_prefetch_tracking(frame, state, 6))
        self.assertEqual(state["sinceDetect"], before["sinceDetect"])

    def test_full_reuse_rejects_reconstructed_landmark_without_committing_state(self) -> None:
        frame = np.zeros((120, 160, 3), dtype=np.uint8)
        prior = np.asarray(
            [[30, 30], [70, 30], [50, 50], [36, 70], [64, 70]],
            dtype=np.float32,
        )
        state = {
            "rawKps": prior.copy(),
            "kps": prior.copy(),
            "gray": cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY),
            "sinceDetect": 1,
        }
        evidence = pong_swap_engine.LandmarkTrackEvidence(
            points=prior + 1.0,
            observed_mask=np.asarray([1, 1, 1, 1, 0], dtype=bool),
            reverse_errors=np.zeros(5, dtype=np.float32),
            reconstructed=True,
            fit_residual=0.0,
        )
        with mock.patch.object(
            pong_swap_engine,
            "_track_landmarks_lk",
            return_value=evidence,
        ):
            result = _advance_prefetch_tracking(
                frame,
                state,
                6,
                require_all_observed=True,
                commit=False,
                return_advance=True,
            )
        self.assertIsNone(result)
        np.testing.assert_array_equal(state["rawKps"], prior)
        self.assertEqual(state["sinceDetect"], 1)

    def test_local_occlusion_rejects_full_frame_residual_reuse(self) -> None:
        height, width = 180, 240
        prior = np.full((height, width, 3), 110, dtype=np.uint8)
        current = prior.copy()
        kps = np.asarray(
            [[95, 78], [125, 78], [110, 92], [100, 105], [120, 105]],
            dtype=np.float32,
        )
        self.assertTrue(
            _full_frame_reuse_appearance_is_safe(
                current,
                prior,
                kps,
                kps,
            )
        )
        # A narrow hand/hair-like obstruction must be visible to the patch
        # guard even though it occupies little of the complete frame.
        current[82:108, 106:114] = 0
        self.assertFalse(
            _full_frame_reuse_appearance_is_safe(
                current,
                prior,
                kps,
                kps,
            )
        )

    def test_non_finite_appearance_fails_closed(self) -> None:
        frame = np.full((180, 240, 3), 110.0, dtype=np.float32)
        frame[90, 110, 0] = np.nan
        kps = np.asarray(
            [[95, 78], [125, 78], [110, 92], [100, 105], [120, 105]],
            dtype=np.float32,
        )
        self.assertFalse(
            _full_frame_reuse_appearance_is_safe(frame, frame.copy(), kps, kps)
        )

    def test_residual_warp_declines_unsafe_scale(self) -> None:
        frame = np.zeros((180, 240, 3), dtype=np.uint8)
        kps = np.asarray(
            [[95, 78], [125, 78], [110, 92], [100, 105], [120, 105]],
            dtype=np.float32,
        )
        self.assertIsNone(
            _warp_prior_swap_residual(
                frame,
                frame,
                frame,
                kps,
                kps * 1.8,
            )
        )


if __name__ == "__main__":
    unittest.main()
