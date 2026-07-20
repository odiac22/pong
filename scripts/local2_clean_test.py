"""Pure-numeric tests for the isolated Local2 clean-slate engine."""

from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

from local2_clean import (
    BalancedLinearHead,
    Local2ImageEvidence,
    Local2NumericStore,
    Local2NumericView,
    Local2Policy,
    RidgeLinearHead,
)


def evidence(index: int, **overrides: object) -> Local2ImageEvidence:
    values: dict[str, object] = {
        "image_index": index,
        "photo": 0.94,
        "person": 0.91,
        "female_presentation": 0.88,
        "male_presentation": 0.04,
        "feet_dominant": 0.03,
        "nonphoto": 0.02,
        "body_mismatch": 0.05,
        "body_preferred": 0.88,
        "attached_anatomy": 0.03,
        "toy_or_prosthetic": 0.04,
        "over_60": 0.04,
        "adult_probability": 0.96,
        "adult_safety_risk": 0.02,
        "adult_safety_unclear": 0.02,
        "body_clear": True,
        "anatomy_clear": True,
        "face_clear": True,
    }
    values.update(overrides)
    return Local2ImageEvidence(**values)  # type: ignore[arg-type]


class Local2PolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = Local2Policy()

    def test_fit_reference_passes(self) -> None:
        result = self.policy.decide([evidence(1), evidence(2)], taste_probability=0.84)
        self.assertEqual("accept", result.decision)
        self.assertTrue(result.as_dict()["hard_verified"])

    def test_two_body_mismatch_views_reject(self) -> None:
        result = self.policy.decide(
            [evidence(1, body_mismatch=0.91, body_preferred=0.04), evidence(2, body_mismatch=0.87, body_preferred=0.05)],
            taste_probability=0.99,
        )
        self.assertEqual(("reject", "body_shape_mismatch"), (result.decision, result.reason_code))

    def test_one_body_mismatch_can_never_reject_artist(self) -> None:
        result = self.policy.decide(
            [evidence(1, body_mismatch=0.99, body_preferred=0.01), evidence(2)],
            taste_probability=0.99,
        )
        self.assertEqual("review", result.decision)
        self.assertIn("body-shape", result.review_codes)

    def test_unambiguous_attached_anatomy_rejects(self) -> None:
        result = self.policy.decide(
            [evidence(1, attached_anatomy=0.94, toy_or_prosthetic=0.03), evidence(2)],
            taste_probability=0.99,
        )
        self.assertEqual("visible_attached_anatomy", result.reason_code)

    def test_toy_does_not_become_attached_anatomy(self) -> None:
        result = self.policy.decide(
            [evidence(1, attached_anatomy=0.89, toy_or_prosthetic=0.91), evidence(2)],
            taste_probability=0.99,
        )
        self.assertNotEqual("reject", result.decision)
        self.assertIn("anatomy", result.review_codes)

    def test_two_male_presentation_votes_reject(self) -> None:
        rows = [
            evidence(1, female_presentation=0.05, male_presentation=0.90),
            evidence(2, female_presentation=0.06, male_presentation=0.88),
        ]
        result = self.policy.decide(rows, taste_probability=0.99)
        self.assertEqual("male_presenting_content", result.reason_code)

    def test_feet_requires_multiple_images(self) -> None:
        one = self.policy.decide([evidence(1, feet_dominant=0.96), evidence(2)], taste_probability=0.99)
        two = self.policy.decide(
            [evidence(1, feet_dominant=0.96), evidence(2, feet_dominant=0.87)],
            taste_probability=0.99,
        )
        self.assertEqual("review", one.decision)
        self.assertEqual("feet_dominant", two.reason_code)

    def test_over_60_is_the_only_age_limit_in_schema(self) -> None:
        result = self.policy.decide(
            [evidence(1, over_60=0.86), evidence(2, over_60=0.82)], taste_probability=0.99
        )
        self.assertEqual("appears_over_60", result.reason_code)
        self.assertFalse(result.checks["underage_looking"])

    def test_adult_safety_is_separate_from_over_60_preference(self) -> None:
        result = self.policy.decide(
            [evidence(1, adult_probability=0.0, adult_safety_risk=0.99), evidence(2)], taste_probability=0.99
        )
        self.assertEqual("adult_safety_risk", result.reason_code)

    def test_unclear_adult_evidence_fails_closed_to_review(self) -> None:
        rows = [
            evidence(index, adult_probability=0.10, adult_safety_risk=0.10, adult_safety_unclear=0.80)
            for index in (1, 2)
        ]
        result = self.policy.decide(rows, taste_probability=0.99)
        self.assertEqual("review", result.decision)
        self.assertIn("adult-safety", result.review_codes)

    def test_clear_adult_body_evidence_does_not_require_a_visible_face(self) -> None:
        result = self.policy.decide(
            [evidence(1, face_clear=False), evidence(2, face_clear=False)],
            taste_probability=0.99,
        )
        self.assertEqual("accept", result.decision)


class NumericLearningTests(unittest.TestCase):
    def test_balanced_head_learns_separable_numeric_rows(self) -> None:
        features = np.asarray(
            [[1.0, 0.0], [0.9, 0.1], [0.8, 0.2], [0.0, 1.0], [0.1, 0.9], [0.2, 0.8]],
            dtype=np.float32,
        )
        head = BalancedLinearHead.fit(features, [1, 1, 1, 0, 0, 0])
        self.assertGreater(head.predict_probability([0.95, 0.05]), 0.55)
        self.assertLess(head.predict_probability([0.05, 0.95]), 0.45)

    def test_ridge_head_learns_separable_numeric_rows(self) -> None:
        features = np.asarray(
            [[1.0, 0.0], [0.9, 0.1], [0.8, 0.2], [0.0, 1.0], [0.1, 0.9], [0.2, 0.8]],
            dtype=np.float32,
        )
        head = RidgeLinearHead.fit(features, [1, 1, 1, 0, 0, 0])
        self.assertGreater(head.predict_probability([0.95, 0.05]), 0.70)
        self.assertLess(head.predict_probability([0.05, 0.95]), 0.30)

    def test_sqlite_store_contains_only_numeric_evidence_and_hash(self) -> None:
        store = Local2NumericStore(":memory:")
        try:
            artist_key = store.upsert(
                artist_identity="source/service/account",
                label="accept",
                reason_code="saved",
                feature_schema="test-encoder-v1",
                descriptors=[evidence(1)],
                views=[Local2NumericView(1, "body", np.asarray([0.2, 0.4, 0.6], dtype=np.float32))],
            )
            loaded = store.load(feature_schema="test-encoder-v1")
            self.assertEqual(64, len(artist_key))
            self.assertEqual(1, len(loaded))
            self.assertEqual((3,), loaded[0].views[0].vector.shape)
            raw = store.connection.execute(
                "SELECT artist_key, descriptor_json FROM local2_examples"
            ).fetchone()
            self.assertNotIn("source/service/account", " ".join(map(str, raw)))
        finally:
            store.close()

    def test_sqlite_revision_survives_reopen(self) -> None:
        with TemporaryDirectory() as folder:
            path = Path(folder) / "local2-numeric.sqlite3"
            first = Local2NumericStore(path)
            try:
                first.upsert(
                    artist_identity="source/service/revision-test",
                    label="accept",
                    reason_code="saved",
                    feature_schema="test-encoder-v1",
                    descriptors=[evidence(1)],
                    views=[Local2NumericView(1, "full", np.asarray([0.1, 0.9], dtype=np.float32))],
                )
                token = first.revision_token
            finally:
                first.close()
            reopened = Local2NumericStore(path)
            try:
                self.assertEqual(token, reopened.revision_token)
                self.assertEqual(1, reopened.revision)
            finally:
                reopened.close()


if __name__ == "__main__":
    unittest.main()
