import unittest

import torch

import pong_swap_engine  # noqa: F401 - initializes Rope's local import path
from rope.VideoManager import VideoManager


class IdentityResidualStabilizationTests(unittest.TestCase):
    def test_low_motion_bypass_is_pixel_exact(self) -> None:
        source = torch.full((3, 32, 32), 80, dtype=torch.uint8)
        swap = torch.full((3, 32, 32), 120, dtype=torch.uint8)
        context = {
            "identityResidualStabilizationEnabled": True,
            "identityResidualHighMotionOnly": True,
            "adaptiveMaskMotionClass": "trt",
        }
        output = VideoManager._temporal_identity_residual(
            object(), swap, source, {}, context
        )
        self.assertIs(output, swap)
        self.assertEqual(context["identityResidualReason"], "low-motion-bypass")

    def test_stable_pixels_blend_only_the_identity_residual(self) -> None:
        source = torch.full((3, 32, 32), 80, dtype=torch.uint8)
        first = torch.full((3, 32, 32), 120, dtype=torch.uint8)
        second = torch.full((3, 32, 32), 140, dtype=torch.uint8)
        context = {
            "identityResidualStabilizationEnabled": True,
            "identityResidualHighMotionOnly": True,
            "adaptiveMaskMotionClass": "cuda",
            "identityResidualCurrentWeight": 0.70,
            "identityResidualChangeLow": 2.0,
            "identityResidualChangeHigh": 14.0,
            "identityResidualMaxInputMae": 20.0,
            "identityResidualMaxInputPatchMae": 48.0,
        }
        parameters = {
            "SwapperTypeTextSel": "128",
            "StrengthSwitch": True,
            "StrengthSlider": 125,
            "LikenessSlider": 100,
            "EmbExtrapSlider": 0,
        }
        first_output = VideoManager._temporal_identity_residual(
            object(), first, source, parameters, context
        )
        self.assertIs(first_output, first)
        output = VideoManager._temporal_identity_residual(
            object(), second, source, parameters, context
        )
        # Source stays exactly current (80); only the generated correction
        # transitions from 40 toward 60 at the configured 70% current weight.
        self.assertTrue(torch.allclose(output, torch.full_like(output, 134.0)))
        self.assertEqual(context["identityResidualReason"], "accepted")
        self.assertEqual(context["identityResidualReusedFrames"], 1)

    def test_large_source_change_replaces_the_anchor(self) -> None:
        source = torch.zeros((3, 32, 32), dtype=torch.uint8)
        changed_source = torch.full((3, 32, 32), 255, dtype=torch.uint8)
        swap = torch.full((3, 32, 32), 120, dtype=torch.uint8)
        context = {
            "identityResidualStabilizationEnabled": True,
            "identityResidualHighMotionOnly": False,
            "identityResidualMaxInputMae": 20.0,
            "identityResidualMaxInputPatchMae": 48.0,
        }
        parameters = {"SwapperTypeTextSel": "128"}
        VideoManager._temporal_identity_residual(
            object(), swap, source, parameters, context
        )
        output = VideoManager._temporal_identity_residual(
            object(), swap, changed_source, parameters, context
        )
        self.assertIs(output, swap)
        self.assertEqual(context["identityResidualReason"], "appearance-change")


if __name__ == "__main__":
    unittest.main()
