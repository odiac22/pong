"""Run with the local Pong renderer environment after applying the adjacent patch."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path.cwd() / "Pong Swap"))
from pong_three_x import AdaptiveFrameCadence, AdaptiveRenderQuality, BufferForecast, RestorerLadder
from pong_tiktok_restorer import ADAPT_PROFILES, session_config_for_profile


class AdaptTests(unittest.TestCase):
    def test_swapper_override_is_reversible_across_session_clones(self):
        for original in ({}, {"SwapperTypeTextSel": "256"}):
            config = {"runtime": {}, "parameters": {**original, "RestorerTypeTextSel": "GPEN512"}}
            for profile in ADAPT_PROFILES:
                session = session_config_for_profile(config, profile)
                self.assertEqual(session["parameters"]["SwapperTypeTextSel"], "HyperSwap1C")
                clone = session_config_for_profile(session, profile)
                off = session_config_for_profile(clone, "tiktok-playback")
                self.assertEqual(off["parameters"], config["parameters"])

    def test_low_buffer_and_recovery_at_each_face_count(self):
        for faces in range(1, 6):
            with self.subTest(faces=faces):
                ladder = RestorerLadder("GPEN1024")
                quality = AdaptiveRenderQuality(responsive=True)
                cadence = AdaptiveFrameCadence()
                for _ in range(100):
                    ladder.observe(.060, 30, faces, .12, fresh_faces=faces)
                    quality.observe(.060, 30, faces, .12)
                    cadence.update(quality.level, ladder.model == "GPEN357", .12)
                self.assertEqual((ladder.model, cadence.value), ("GPEN357", 4))
                for _ in range(1200):
                    quality.observe(.005, 30, faces, 3)
                    cadence.update(quality.level, ladder.model == "GPEN357", 3)
                    ladder.observe(.005, 30, faces, 3, fresh_faces=faces, allow_upgrade=cadence.value == 1)
                self.assertEqual((ladder.model, cadence.value), ("GPEN1024", 1))

    def test_buffer_forecast_reacts_to_drain_and_resets_on_feedback_loss(self):
        budget = BufferForecast()
        self.assertEqual(budget.observe(2, 0), 2)
        self.assertLess(budget.observe(1.05, 1), .8)
        self.assertIsNone(budget.observe(None, 2))
        self.assertEqual(budget.observe(2, 3), 2)


if __name__ == "__main__":
    unittest.main()
