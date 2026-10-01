from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np
import torch


ROOT = Path(__file__).resolve().parent
ROPE_ROOT = ROOT / "engine" / "Rope"
for path in (ROOT, ROPE_ROOT):
    value = str(path)
    if value not in sys.path:
        sys.path.insert(0, value)

import pong_swap_engine
from rope.Models import _center_weighted_face_values
from rope.VideoManager import (
    VideoManager,
    _affine_crop_needs_padding,
    _masked_channel_stats,
)


class DetectorSelectionTests(unittest.TestCase):
    def test_numpy_selection_uses_original_frame_center(self) -> None:
        boxes = np.asarray(
            [
                [0.0, 0.0, 80.0, 80.0],
                [180.0, 80.0, 220.0, 120.0],
            ],
            dtype=np.float32,
        )
        values = _center_weighted_face_values(boxes, 400, 200)
        self.assertEqual(int(np.argmax(values)), 1)

    def test_torch_selection_matches_numpy_and_does_not_swap_axes(self) -> None:
        boxes = np.asarray(
            [
                [175.0, 85.0, 215.0, 125.0],
                [75.0, 175.0, 115.0, 215.0],
            ],
            dtype=np.float32,
        )
        expected = _center_weighted_face_values(boxes, 400, 300)
        actual = _center_weighted_face_values(torch.from_numpy(boxes), 400, 300)
        np.testing.assert_allclose(actual.numpy(), expected)
        self.assertEqual(int(torch.argmax(actual)), 0)


class ClippedFaceMaskTests(unittest.TestCase):
    def test_padding_check_keeps_fully_in_frame_crop_on_fast_path(self) -> None:
        matrix = np.asarray([[1.0, 0.0, 8.0], [0.0, 1.0, 12.0]], dtype=np.float32)
        self.assertFalse(_affine_crop_needs_padding(matrix, (16, 16), (64, 64)))

    def test_padding_check_detects_rotated_or_translated_offscreen_crop(self) -> None:
        translated = np.asarray(
            [[1.0, 0.0, -1.0], [0.0, 1.0, 0.0]],
            dtype=np.float32,
        )
        self.assertTrue(_affine_crop_needs_padding(translated, (16, 16), (64, 64)))

    def test_masked_lab_stats_ignore_zero_padding(self) -> None:
        values = torch.tensor(
            [
                [[10.0, 0.0], [14.0, 0.0]],
                [[20.0, 0.0], [24.0, 0.0]],
                [[30.0, 0.0], [34.0, 0.0]],
            ],
            dtype=torch.float32,
        )
        valid = torch.tensor([[[1.0, 0.0], [1.0, 0.0]]], dtype=torch.float32)
        mean, std = _masked_channel_stats(values, valid)
        np.testing.assert_allclose(mean.flatten().numpy(), [12.0, 22.0, 32.0])
        np.testing.assert_allclose(
            std.flatten().numpy(),
            [np.sqrt(8.0), np.sqrt(8.0), np.sqrt(8.0)],
        )

    @unittest.skipUnless(torch.cuda.is_available(), "CUDA is required by the live warp helper")
    def test_warp_returns_geometry_mask_for_offscreen_samples(self) -> None:
        manager = VideoManager.__new__(VideoManager)
        source = torch.ones((3, 4, 4), dtype=torch.uint8, device="cuda") * 255
        # Output x=0 samples input x=-1 (padding); x=1..3 are image-backed.
        matrix = np.asarray([[1.0, 0.0, -1.0], [0.0, 1.0, 0.0]], dtype=np.float32)
        sampled, valid = manager._warp_grid_sample(
            source,
            matrix,
            (4, 4),
            return_valid_mask=True,
        )
        self.assertEqual(tuple(sampled.shape), (3, 4, 4))
        expected = torch.tensor(
            [[0.0, 1.0, 1.0, 1.0]] * 4,
            dtype=torch.float32,
            device="cuda",
        ).unsqueeze(0)
        torch.testing.assert_close(valid, expected)


class EnhancerRoiTests(unittest.TestCase):
    def test_face_enhancer_detection_miss_preserves_declared_dimensions(self) -> None:
        engine = pong_swap_engine.PongSwapEngine.__new__(pong_swap_engine.PongSwapEngine)
        engine._torch = torch
        frame = torch.zeros((3, 24, 32), dtype=torch.uint8)
        config = {
            "runtime": {
                "frameEnhancerEnabled": True,
                "frameEnhancerScope": "face",
                "frameEnhancerDownscale": True,
            }
        }

        output = engine._enhance_frame(frame, kps=None, config=config)

        self.assertEqual(tuple(output.shape), (3, 24, 32))
        self.assertEqual(engine.output_dimensions(32, 24, config), (32, 24))

        config["runtime"]["frameEnhancerDownscale"] = False
        output = engine._enhance_frame(frame, kps=None, config=config)
        self.assertEqual(tuple(output.shape), (3, 48, 64))
        self.assertEqual(engine.output_dimensions(32, 24, config), (64, 48))

    def test_roi_shifts_inward_at_right_and_bottom_edges(self) -> None:
        bounds = pong_swap_engine._bounded_square_roi(
            640,
            480,
            630.0,
            470.0,
            128,
            vertical_anchor=0.55,
        )
        self.assertEqual(bounds, (512, 352, 640, 480))
        left, top, right, bottom = bounds
        self.assertEqual(right - left, 128)
        self.assertEqual(bottom - top, 128)

    def test_roi_shrinks_only_when_frame_cannot_hold_requested_square(self) -> None:
        left, top, right, bottom = pong_swap_engine._bounded_square_roi(
            80,
            120,
            0.0,
            0.0,
            128,
            vertical_anchor=0.55,
        )
        self.assertEqual((left, top), (0, 0))
        self.assertEqual(right - left, 80)
        self.assertEqual(bottom - top, 80)


if __name__ == "__main__":
    unittest.main()
