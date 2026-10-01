"""Baseline 1.6: Multi Face ranks by face resemblance + measured hair colour."""
import unittest
from unittest.mock import patch
import numpy as np
from pong_hair_profile import HairColor, hair_lab, hair_match
from pong_multi_face import choose_multi_face
from pong_swap_identity import CandidateIdentity, TargetIdentity, FacePresentation

PROFILES = {"8": {"L": 62.0, "a": 6.0, "b": 24.0, "confidence": 1.0},
            "3": {"L": 14.0, "a": 1.0, "b": 0.0, "confidence": 1.0}}
FEMALE = FacePresentation("female", 0.99)


def unit(seed):
    v = np.random.default_rng(seed).normal(size=512).astype(np.float32)
    return v / np.linalg.norm(v)


class HairRankTests(unittest.TestCase):
    def setUp(self):
        self.patch = patch("pong_hair_profile.load_profiles", return_value=PROFILES)
        self.patch.start()
        base = unit(1)
        # Approved 3 looks slightly MORE like the target than Approved 8.
        self.target_embedding = base
        self.a3 = CandidateIdentity("approved-3-aaaaaaaaaaaa", (base * .78 + unit(2) * .62).astype(np.float32), FEMALE)
        self.a8 = CandidateIdentity("approved-8-bbbbbbbbbbbb", (base * .74 + unit(3) * .67).astype(np.float32), FEMALE)

    def tearDown(self):
        self.patch.stop()

    def target(self, lab):
        return TargetIdentity(np.zeros((5, 2), np.float32), self.target_embedding, FEMALE, 1000.0,
                              HairColor("unknown", lab), 0.9 if lab else 0.0)

    def choose(self, lab):
        # Hard light/dark gates are not under test here.
        with patch("pong_multi_face.hair_allows", return_value=True):
            return choose_multi_face([self.a3, self.a8], [self.target(lab)]).selection.candidate.face_id

    def test_without_hair_evidence_face_resemblance_decides(self):
        self.assertTrue(self.choose(None).startswith("approved-3"))

    def test_blonde_target_prefers_blonde_source_over_slightly_closer_face(self):
        self.assertTrue(self.choose({"L": 60, "a": 5, "b": 22, "confidence": 0.95}).startswith("approved-8"))

    def test_dark_target_keeps_dark_source(self):
        self.assertTrue(self.choose({"L": 15, "a": 1, "b": 1, "confidence": 0.95}).startswith("approved-3"))

    def test_match_is_graded_and_evidence_scaled(self):
        near = hair_match(HairColor("light", {"L": 60, "a": 6, "b": 24, "confidence": 1}), "approved-8-bbbbbbbbbbbb")
        far = hair_match(HairColor("dark", {"L": 12, "a": 1, "b": 0, "confidence": 1}), "approved-8-bbbbbbbbbbbb")
        weak = hair_match(HairColor("dark", {"L": 12, "a": 1, "b": 0, "confidence": .3}), "approved-8-bbbbbbbbbbbb")
        self.assertGreater(near, .8)
        self.assertLess(far, -.8)
        self.assertGreater(weak, far)
        self.assertIsNone(hair_match(HairColor("unknown", None), "approved-8-bbbbbbbbbbbb"))
        self.assertIsNone(hair_match(HairColor("light", {"L": 60, "a": 6, "b": 24, "confidence": 1}), "approved-99-cccccccccccc"))

    def test_hair_lab_reads_segmented_pixels_only(self):
        image = np.full((512, 512, 3), 255, np.uint8)
        probability = np.zeros((512, 512), np.float32)
        probability[60:300, 120:390] = .95
        image[60:300, 120:390] = (40, 28, 20)
        lab = hair_lab(image, probability)
        self.assertLess(lab["L"], 20)
        self.assertIsNone(hair_lab(image, np.zeros((512, 512), np.float32)))

    def test_hair_colour_still_equals_its_category(self):
        value = HairColor("light", {"L": 60})
        self.assertEqual(value, "light")
        self.assertEqual(value.lab["L"], 60)


if __name__ == "__main__":
    unittest.main()
