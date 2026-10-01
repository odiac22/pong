from __future__ import annotations

import math
import unittest

import numpy as np
import torch

from rope.VideoManager import VideoManager


class RestorerReturnMapTests(unittest.TestCase):
    def compose(self, params, out_size, face_size):
        return VideoManager._restorer_return_sample_matrix(
            params,
            out_size=out_size,
            face_size=face_size,
            pixel_center_correct=True,
        ).astype(np.float64)

    def assert_map_matches_formula(self, params, out_size, face_size):
        matrix = self.compose(params, out_size, face_size)
        scale = out_size / float(face_size)
        half = np.array([0.5, 0.5], dtype=np.float64)
        for point in (
            np.array([0.0, 0.0]),
            np.array([1.25, 7.75]),
            np.array([face_size * 0.5, face_size * 0.75]),
            np.array([face_size - 1.0, face_size - 1.0]),
        ):
            expected = scale * (
                params[:2, :2] @ (point + half) + params[:2, 2]
            ) - half
            actual = matrix[:2, :2] @ point + matrix[:2, 2]
            np.testing.assert_allclose(actual, expected, atol=1e-3, rtol=0.0)

    def test_identity_equal_sizes_is_identity(self):
        result = self.compose(np.eye(3), 512, 512)
        np.testing.assert_allclose(result, np.eye(3), atol=1e-7, rtol=0.0)

    def test_identity_downsample_has_half_pixel_translation(self):
        result = self.compose(np.eye(3), 512, 256)
        expected = np.array(
            [[2.0, 0.0, 0.5], [0.0, 2.0, 0.5], [0.0, 0.0, 1.0]]
        )
        np.testing.assert_allclose(result, expected, atol=1e-7, rtol=0.0)

    def test_translations_rotations_and_scales_match_contract(self):
        for angle_degrees, zoom, translation, face_size in (
            (0.0, 1.0, (3.0, -2.25), 256),
            (13.0, 0.91, (7.5, 4.125), 217),
            (-21.0, 1.12, (-5.75, 9.0), 241),
        ):
            angle = math.radians(angle_degrees)
            linear = zoom * np.array(
                [[math.cos(angle), -math.sin(angle)],
                 [math.sin(angle), math.cos(angle)]],
                dtype=np.float64,
            )
            params = np.eye(3, dtype=np.float64)
            params[:2, :2] = linear
            params[:2, 2] = np.asarray(translation, dtype=np.float64)
            self.assert_map_matches_formula(params, 512, face_size)

    def test_linear_ramp_coordinates_follow_composed_map(self):
        params = np.eye(3, dtype=np.float64)
        params[:2, 2] = (1.25, -0.75)
        matrix = self.compose(params, 512, 256)
        point = np.array([37.0, 81.0], dtype=np.float64)
        sampled = matrix[:2, :2] @ point + matrix[:2, 2]
        # A ramp f(x,y)=3x+5y is exactly determined by its sample coordinate
        # away from borders under bilinear interpolation.
        actual_ramp = 3.0 * sampled[0] + 5.0 * sampled[1]
        scale = 2.0
        expected_point = scale * (point + 0.5 + params[:2, 2]) - 0.5
        expected_ramp = 3.0 * expected_point[0] + 5.0 * expected_point[1]
        self.assertAlmostEqual(actual_ramp, expected_ramp, places=5)

    def test_legacy_contract_remains_unchanged(self):
        params = np.eye(3, dtype=np.float64)
        legacy = VideoManager._restorer_return_sample_matrix(
            params,
            out_size=512,
            face_size=256,
            pixel_center_correct=False,
        )
        expected = np.array(
            [[2.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 1.0]]
        )
        np.testing.assert_allclose(legacy, expected, atol=1e-7, rtol=0.0)

    def test_fused_input_identity_matches_half_pixel_bilinear_resize(self):
        if not torch.cuda.is_available():
            self.skipTest('CUDA is required for the production input warp')
        source = torch.arange(
            3 * 23 * 23, device='cuda:0', dtype=torch.float32
        ).reshape(1, 3, 23, 23).remainder(251)
        out_size = 46
        aligned_to_input = np.eye(3, dtype=np.float32)
        actual = VideoManager._restorer_input_affine_resize(
            source,
            aligned_to_input,
            aligned_size=23,
            out_size=out_size,
        )
        expected = torch.nn.functional.interpolate(
            source, size=(out_size, out_size), mode='bilinear', align_corners=False,
        )
        torch.testing.assert_close(actual, expected, atol=1e-3, rtol=0.0)

    def test_residual_return_is_exact_identity_for_zero_correction(self):
        current = torch.tensor(
            [[[0.0, 64.0], [192.0, 255.0]]] * 3,
            dtype=torch.float32,
        )
        returned_current = torch.tensor(
            [[[9.25, 70.5], [181.75, 240.0]]] * 3,
            dtype=torch.float32,
        )
        actual = VideoManager._compose_restorer_residual_return(
            current,
            returned_current.clone(),
            returned_current,
            1.0,
        )
        torch.testing.assert_close(actual, current, atol=0.0, rtol=0.0)

    def test_residual_return_preserves_signed_correction_and_clips(self):
        current = torch.tensor([[[5.0, 250.0], [100.0, 100.0]]], dtype=torch.float32)
        returned_current = torch.full_like(current, 80.0)
        correction = torch.tensor([[[-20.0, 20.0], [12.0, -8.0]]], dtype=torch.float32)
        actual = VideoManager._compose_restorer_residual_return(
            current,
            returned_current + correction,
            returned_current,
            0.5,
        )
        expected = torch.tensor([[[0.0, 255.0], [106.0, 96.0]]], dtype=torch.float32)
        torch.testing.assert_close(actual, expected, atol=0.0, rtol=0.0)

if __name__ == '__main__':
    unittest.main()
