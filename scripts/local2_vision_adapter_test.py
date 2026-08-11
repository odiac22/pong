"""Mocked-array tests; no URL, image file, audio, or video access occurs."""

from __future__ import annotations

import unittest

import numpy as np

from local2_clean import GROUP_LABELS, Local2NumericStore
from local2_vision_adapter import Local2VisionAdapter


class FakeRuntime:
    def __init__(self) -> None:
        self.view_calls = 0
        self.dino_calls = 0

    def detect_views_batch(self, images: list[np.ndarray]) -> list[dict[str, np.ndarray]]:
        self.view_calls += 1
        return [
            {
                "full": image,
                "body": np.asarray([image[0], 1.0], dtype=np.float32),
                "lower_torso": np.asarray([image[0], 2.0], dtype=np.float32),
                "face": np.asarray([image[0], 3.0], dtype=np.float32),
            }
            for image in images
        ]

    def dino_encode(self, images: list[np.ndarray], variant: str) -> list[np.ndarray]:
        self.dino_calls += 1
        assert variant == "local2"
        result = []
        for image in images:
            marker = float(np.asarray(image).reshape(-1)[0])
            result.append(
                np.asarray([1.0, 0.0], dtype=np.float32)
                if marker >= 0 else np.asarray([0.0, 1.0], dtype=np.float32)
            )
        return result


class FakeGroupedScorer:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, images: list[np.ndarray]) -> dict[str, np.ndarray]:
        self.calls += 1
        rows = len(images)
        result = {
            "media_type": np.tile([0.94, 0.03, 0.03], (rows, 1)),
            "presentation": np.tile([0.90, 0.04, 0.06], (rows, 1)),
            "content_focus": np.tile([0.93, 0.03, 0.04], (rows, 1)),
            "body_shape": np.tile([0.90, 0.04, 0.06], (rows, 1)),
            "anatomy": np.tile([0.02, 0.03, 0.91, 0.04], (rows, 1)),
            "age_limit": np.tile([0.92, 0.03, 0.05], (rows, 1)),
            "adult_safety": np.tile([0.96, 0.01, 0.03], (rows, 1)),
        }
        for row, image in enumerate(images):
            values = np.asarray(image).reshape(-1)
            # Marker 99 in a lower-torso role is the attached-anatomy fixture.
            if float(values[0]) == 99.0 and len(values) > 1 and float(values[1]) == 2.0:
                result["anatomy"][row] = [0.95, 0.02, 0.01, 0.02]
        for name, labels in GROUP_LABELS.items():
            assert result[name].shape == (rows, len(labels))
        return {name: np.asarray(value, dtype=np.float32) for name, value in result.items()}


class ModerateBodyMismatchScorer(FakeGroupedScorer):
    def __call__(self, images: list[np.ndarray]) -> dict[str, np.ndarray]:
        result = super().__call__(images)
        for row, image in enumerate(images):
            values = np.asarray(image).reshape(-1)
            if (
                len(values) > 1 and float(values[1]) == 1.0 and
                float(values[0]) in {77.0, 78.0}
            ):
                result["body_shape"][row] = [0.16, 0.60, 0.24]
        return result


class FixedTasteHead:
    def __init__(self, probability: float) -> None:
        self.probability = float(probability)

    def predict_probability(self, _feature: np.ndarray) -> float:
        return self.probability


class FaceMaskSensitiveHead:
    def predict_probability(self, feature: np.ndarray) -> float:
        # The final two feature values are face-present/body-present flags.
        return 0.10 if float(np.asarray(feature)[-2]) > 0.5 else 0.80


def legacy_records() -> list[dict[str, object]]:
    accepted = [1.0, 0.0] * 3 + [1.0, 1.0]
    rejected = [0.0, 1.0] * 3 + [1.0, 1.0]
    return [
        {
            "label": "accept" if index < 4 else "reject",
            "artistUrl": f"https://coomerfans.com/u/onlyfans/{100 + index}/fixture",
            "rejectReasonLabel": "" if index < 4 else "Not my taste",
            "learnedAt": str(index),
            "features": {"local2": accepted if index < 4 else rejected},
        }
        for index in range(8)
    ]


class Local2VisionAdapterTests(unittest.TestCase):
    def make_adapter(
        self,
        store: Local2NumericStore | None = None,
        *,
        group_scorer: FakeGroupedScorer | None = None,
        runtime: FakeRuntime | None = None,
    ) -> Local2VisionAdapter:
        return Local2VisionAdapter(
            runtime or FakeRuntime(),
            numeric_store=store,
            legacy_record_provider=legacy_records,
            group_scorer=group_scorer or FakeGroupedScorer(),
        )

    @staticmethod
    def fixed_taste(adapter: Local2VisionAdapter, probability: float) -> None:
        head = FixedTasteHead(probability)
        adapter._taste_head = lambda _dimension: head  # type: ignore[method-assign]

    def test_low_taste_prefilter_skips_grouped_siglip(self) -> None:
        grouped = FakeGroupedScorer()
        runtime = FakeRuntime()
        adapter = self.make_adapter(group_scorer=grouped, runtime=runtime)
        self.fixed_taste(adapter, 0.42)

        result = adapter.classify_staged(
            [np.asarray([1.0, 0.0]), np.asarray([2.0, 0.0])]
        )

        self.assertEqual(("reject", "personal_preference_mismatch"), (
            result["decision"], result["reason_code"]
        ))
        self.assertEqual(0, grouped.calls)
        self.assertEqual((1, 1), (runtime.view_calls, runtime.dino_calls))
        self.assertFalse(result["taste_prefilter"]["siglip_ran"])
        self.assertTrue(result["terminal_personal_reject"])
        self.assertEqual(0.50, result["preference_threshold"])

    def test_borderline_taste_runs_grouped_siglip_then_final_threshold_rejects(self) -> None:
        grouped = FakeGroupedScorer()
        runtime = FakeRuntime()
        adapter = self.make_adapter(group_scorer=grouped, runtime=runtime)
        self.fixed_taste(adapter, 0.44)

        result = adapter.classify_staged(
            [np.asarray([1.0, 0.0]), np.asarray([2.0, 0.0])]
        )

        self.assertEqual(1, grouped.calls)
        self.assertEqual((1, 1), (runtime.view_calls, runtime.dino_calls))
        self.assertTrue(result["taste_prefilter"]["siglip_ran"])
        self.assertEqual(0.50, result["preference_threshold"])
        self.assertEqual(("reject", "personal_preference_mismatch"), (
            result["decision"], result["reason_code"]
        ))

    def test_prefilter_cannot_reject_on_a_face_mask_siglip_may_remove(self) -> None:
        grouped = FakeGroupedScorer()
        adapter = self.make_adapter(group_scorer=grouped)
        head = FaceMaskSensitiveHead()
        adapter._taste_head = lambda _dimension: head  # type: ignore[method-assign]

        result = adapter.classify_staged(
            [np.asarray([1.0, 0.0]), np.asarray([2.0, 0.0])]
        )

        self.assertEqual(1, grouped.calls)
        self.assertGreaterEqual(result["taste_prefilter"]["probability"], 0.80)
        self.assertGreater(result["taste_prefilter"]["plausible_feature_count"], 1)

    def test_high_taste_still_obeys_grouped_hard_filter(self) -> None:
        grouped = FakeGroupedScorer()
        adapter = self.make_adapter(group_scorer=grouped)
        self.fixed_taste(adapter, 0.90)

        result = adapter.classify_staged(
            [np.asarray([99.0, 0.0]), np.asarray([99.0, 0.0])]
        )

        self.assertEqual(1, grouped.calls)
        self.assertEqual("visible_attached_anatomy", result["reason_code"])

    def test_exact_save_bypasses_only_prefilter_and_still_runs_hard_filters(self) -> None:
        grouped = FakeGroupedScorer()
        adapter = self.make_adapter(group_scorer=grouped)
        self.fixed_taste(adapter, 0.10)

        result = adapter.classify_staged(
            [np.asarray([99.0, 0.0]), np.asarray([99.0, 0.0])],
            known_accept=True,
        )

        self.assertEqual(1, grouped.calls)
        self.assertTrue(result["taste_prefilter"]["bypassed_for_exact_save"])
        self.assertEqual("visible_attached_anatomy", result["reason_code"])

    def test_safe_mocked_views_accept(self) -> None:
        result = self.make_adapter().classify(
            [np.asarray([1.0, 0.0]), np.asarray([2.0, 0.0])]
        )
        self.assertEqual("accept", result["decision"])
        self.assertTrue(result["training"]["head_available"])

    def test_one_lower_torso_anatomy_vote_is_ambiguous_not_a_veto(self) -> None:
        result = self.make_adapter().classify(
            [np.asarray([99.0, 0.0]), np.asarray([2.0, 0.0])]
        )
        self.assertEqual("review", result["decision"])
        self.assertIn("anatomy", result["review_codes"])
        self.assertIsNone(result["image_grades"][0]["checks"]["attached_male_anatomy"])
        self.assertTrue(result["image_grades"][0]["checks"]["anatomy_ambiguous"])

    def test_two_lower_torso_anatomy_votes_reject(self) -> None:
        result = self.make_adapter().classify(
            [np.asarray([99.0, 0.0]), np.asarray([99.0, 0.0])]
        )
        self.assertEqual("visible_attached_anatomy", result["reason_code"])

    def test_numeric_learning_never_stores_mock_arrays_or_identity(self) -> None:
        store = Local2NumericStore(":memory:")
        try:
            adapter = self.make_adapter(store)
            analysis = adapter.analyze(
                [np.asarray([1.0, 0.0]), np.asarray([2.0, 0.0])]
            )
            response = adapter.learn_numeric(
                artist_identity="source/service/private-account",
                label="accept",
                reason_code="saved",
                analysis=analysis,
            )
            self.assertTrue(response["numeric_only"])
            raw = store.connection.execute(
                "SELECT artist_key, descriptor_json FROM local2_examples"
            ).fetchone()
            self.assertNotIn("private-account", " ".join(map(str, raw)))
            self.assertEqual(6, response["vectors"])
        finally:
            store.close()

    def test_adapter_caps_in_memory_batch_at_twelve(self) -> None:
        analysis = self.make_adapter().analyze(
            [np.asarray([float(index + 1), 0.0]) for index in range(20)]
        )
        self.assertEqual(12, len(analysis.descriptors))

    def test_hard_triage_skips_dino_taste_encoding(self) -> None:
        def forbidden_encoder(_images: list[np.ndarray]) -> list[np.ndarray]:
            raise AssertionError("DINO must not run during Local2 hard triage")

        adapter = Local2VisionAdapter(
            FakeRuntime(),
            legacy_record_provider=legacy_records,
            group_scorer=FakeGroupedScorer(),
            feature_encoder=forbidden_encoder,
        )
        analysis = adapter.analyze(
            [np.asarray([1.0, 0.0]), np.asarray([2.0, 0.0])],
            include_taste=False,
        )
        result = adapter.classify_analysis(analysis, hard_only=True)
        self.assertEqual("accept", result["decision"])
        self.assertTrue(result["training"]["hard_only"])

    def test_hard_confirmation_requires_three_clear_body_views(self) -> None:
        adapter = self.make_adapter()
        two = adapter.analyze(
            [np.asarray([1.0, 0.0]), np.asarray([2.0, 0.0])],
            include_taste=False,
        )
        three = adapter.analyze(
            [
                np.asarray([1.0, 0.0]),
                np.asarray([2.0, 0.0]),
                np.asarray([3.0, 0.0]),
            ],
            include_taste=False,
        )
        two_result = adapter.classify_analysis(
            two, hard_only=True, hard_confirmation=True
        )
        three_result = adapter.classify_analysis(
            three, hard_only=True, hard_confirmation=True
        )
        self.assertEqual("review", two_result["decision"])
        self.assertIn("body-evidence", two_result["review_codes"])
        self.assertEqual("accept", three_result["decision"])

    def test_hard_confirmation_rejects_two_moderate_body_mismatch_views(self) -> None:
        adapter = self.make_adapter(group_scorer=ModerateBodyMismatchScorer())
        analysis = adapter.analyze(
            [
                np.asarray([77.0, 0.0]),
                np.asarray([78.0, 0.0]),
                np.asarray([3.0, 0.0]),
            ],
            include_taste=False,
        )
        result = adapter.classify_analysis(
            analysis, hard_only=True, hard_confirmation=True
        )
        self.assertEqual(("reject", "body_shape_mismatch"), (
            result["decision"], result["reason_code"]
        ))
        self.assertTrue(result["training"]["hard_confirmation"])

    def test_hard_confirmation_routes_all_anatomy_consensus_to_narrow_review(self) -> None:
        adapter = self.make_adapter()
        two_vote_analysis = adapter.analyze(
            [
                np.asarray([99.0, 0.0]),
                np.asarray([99.0, 0.0]),
                np.asarray([3.0, 0.0]),
            ],
            include_taste=False,
        )
        three_vote_analysis = adapter.analyze(
            [
                np.asarray([99.0, 0.0]),
                np.asarray([99.0, 0.0]),
                np.asarray([99.0, 0.0]),
            ],
            include_taste=False,
        )
        two_vote_result = adapter.classify_analysis(
            two_vote_analysis, hard_only=True, hard_confirmation=True
        )
        three_vote_result = adapter.classify_analysis(
            three_vote_analysis, hard_only=True, hard_confirmation=True
        )
        self.assertEqual("review", two_vote_result["decision"])
        self.assertIn("anatomy", two_vote_result["review_codes"])
        self.assertEqual("review", three_vote_result["decision"])
        self.assertIn("anatomy", three_vote_result["review_codes"])

    def test_unchanged_revision_reuses_taste_head_without_reloading_records(self) -> None:
        calls = 0

        def records() -> list[dict[str, object]]:
            nonlocal calls
            calls += 1
            return legacy_records()

        adapter = Local2VisionAdapter(
            FakeRuntime(),
            legacy_record_provider=records,
            legacy_revision_provider=lambda: 7,
            group_scorer=FakeGroupedScorer(),
        )
        analysis = adapter.analyze([np.asarray([1.0, 0.0]), np.asarray([2.0, 0.0])])
        adapter.classify_analysis(analysis)
        adapter.classify_analysis(analysis)
        self.assertEqual(1, calls)

    def test_numeric_artist_overrides_duplicate_legacy_artist(self) -> None:
        store = Local2NumericStore(":memory:")
        try:
            adapter = self.make_adapter(store)
            analysis = adapter.analyze([np.asarray([1.0, 0.0]), np.asarray([2.0, 0.0])])
            adapter.learn_numeric(
                artist_identity="onlyfans:100",
                label="accept",
                reason_code="saved",
                analysis=analysis,
            )
            _, _, _, numeric_keys = adapter._numeric_rows(len(analysis.artist_feature))
            legacy_features, _, _ = adapter._legacy_rows(len(analysis.artist_feature), numeric_keys)
            self.assertEqual(7, len(legacy_features))
        finally:
            store.close()


if __name__ == "__main__":
    unittest.main()
