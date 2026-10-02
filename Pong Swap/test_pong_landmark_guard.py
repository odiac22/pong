import unittest

import numpy as np

from pong_landmark_guard import TEMPLATE, LandmarkGuard


def face(scale=3.0, shift=(400.0, 300.0), squash=1.0, eye_spread=1.0):
    pts = TEMPLATE.copy()
    center = pts[:2].mean(0)
    pts[:2] = center + (pts[:2] - center) * [eye_spread, 1.0]
    pts[2:, 1] = pts[:2, 1].mean() + (pts[2:, 1] - pts[:2, 1].mean()) * squash
    return (pts * scale + shift).astype(np.float32)


def mouth_ratio(kps):
    le, re, _, lm, rm = kps
    return float(((lm + rm) / 2 - (le + re) / 2)[1] / np.linalg.norm(re - le))


class LandmarkGuardTest(unittest.TestCase):
    def test_clear_face_passes_through_unchanged(self):
        guard = LandmarkGuard()
        for _ in range(5):
            out = guard.observe(face(), 0.85)
            np.testing.assert_allclose(out, face(), atol=1e-4)

    def test_covered_face_at_start_is_held_then_repaired_from_the_eyes(self):
        guard = LandmarkGuard()
        squashed = face(squash=0.8, eye_spread=1.0)
        outs = [guard.observe(squashed, 0.52) for _ in range(guard.acquire_wait_frames + 3)]
        self.assertTrue(all(o is None for o in outs[:guard.acquire_wait_frames]))
        repaired = outs[-1]
        np.testing.assert_allclose(repaired[:2], squashed[:2], atol=1e-3)  # eyes kept
        self.assertAlmostEqual(mouth_ratio(repaired), mouth_ratio(face()), places=2)

    def test_low_score_frames_never_become_the_learned_shape(self):
        guard = LandmarkGuard()
        for _ in range(30):
            guard.observe(face(squash=0.8), 0.60)
        self.assertIsNone(guard.shape)

    def test_learned_face_repairs_a_guessed_mouth_and_keeps_visible_points(self):
        guard = LandmarkGuard()
        for _ in range(5):
            guard.observe(face(), 0.85)
        guessed = face()
        guessed[3:, 1] -= 25  # mouth guessed too high behind a hand
        out = guard.observe(guessed, 0.50)
        np.testing.assert_allclose(out[:3], guessed[:3], atol=0.5)
        self.assertAlmostEqual(mouth_ratio(out), mouth_ratio(face()), places=2)

    def test_confident_side_profile_is_learned_not_repaired(self):
        guard = LandmarkGuard()
        for _ in range(5):
            guard.observe(face(), 0.85)
        profile = face(eye_spread=0.55)  # yawed head: eyes appear close together
        for _ in range(10):
            out = guard.observe(profile, 0.68)
        np.testing.assert_allclose(out, profile, atol=1e-4)
        self.assertEqual(guard.stats["repaired"], 0)


if __name__ == "__main__":
    unittest.main()
