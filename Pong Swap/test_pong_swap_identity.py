from __future__ import annotations

import unittest

import numpy as np

from pong_swap_identity import (
    appearance_similarity,
    CandidateIdentity,
    FacePresentation,
    TargetIdentity,
    choose_compatible_identity,
    compatible_identity_rankings,
    face_switch_policy,
    identity_similarity_upper_bound,
    normalize_face_ids,
    presentation_confidence_for_strictness,
    presentations_are_compatible,
    rope_similarity,
    target_identity_continuity_threshold,
    target_identity_lock_threshold,
)


def unit(index: int) -> np.ndarray:
    value = np.zeros(4, dtype=np.float32)
    value[index] = 1.0
    return value


class IdentitySelectionTests(unittest.TestCase):
    def test_identity_precheck_is_an_upper_bound_not_a_new_threshold(self) -> None:
        for arcface in np.linspace(0, 100, 101):
            bound = identity_similarity_upper_bound(arcface)
            self.assertGreaterEqual(bound, arcface)
            for appearance in np.linspace(0, 100, 101):
                self.assertGreaterEqual(bound + 1e-10, .85 * arcface + .15 * appearance)
        self.assertLess(identity_similarity_upper_bound(0), target_identity_continuity_threshold())
        self.assertEqual(identity_similarity_upper_bound(float('nan')), -float('inf'))

    def test_ids_are_unique_stable_and_bounded(self) -> None:
        self.assertEqual(normalize_face_ids(["a", "b", "a", "c"], maximum=2), ("a", "b"))

    def test_cross_presentation_is_rejected(self) -> None:
        source = CandidateIdentity("adult-male", unit(0), FacePresentation("male", 0.99))
        target = TargetIdentity(np.zeros((5, 2)), unit(0), FacePresentation("female", 0.99), 100)
        self.assertIsNone(choose_compatible_identity([source], [target]))

    def test_unknown_fails_closed(self) -> None:
        self.assertFalse(
            presentations_are_compatible(
                FacePresentation("unknown", 0.0),
                FacePresentation("female", 0.99),
            )
        )

    def test_best_compatible_pair_wins_even_when_an_incompatible_pair_is_closer(self) -> None:
        male = CandidateIdentity("male", unit(0), FacePresentation("male", 0.99))
        female_a = CandidateIdentity("female-a", unit(1), FacePresentation("female", 0.98))
        female_b = CandidateIdentity("female-b", unit(2), FacePresentation("female", 0.97))
        target = TargetIdentity(
            np.zeros((5, 2)),
            np.asarray([0.95, 0.2, 0.1, 0.0], dtype=np.float32),
            FacePresentation("female", 0.96),
            80,
        )
        selected = choose_compatible_identity([male, female_a, female_b], [target])
        self.assertIsNotNone(selected)
        self.assertEqual(selected.candidate.face_id, "female-a")

    def test_choice_is_stable_until_the_switch_policy_accepts_a_later_ranking(self) -> None:
        first = CandidateIdentity("first", unit(0), FacePresentation("female", 0.95))
        second = CandidateIdentity("second", unit(1), FacePresentation("female", 0.95))
        target_a = TargetIdentity(np.zeros((5, 2)), unit(0), FacePresentation("female", 0.95), 80)
        target_b = TargetIdentity(np.zeros((5, 2)), unit(1), FacePresentation("female", 0.95), 80)
        locked = choose_compatible_identity([first, second], [target_a])
        self.assertEqual(locked.candidate.face_id, "first")
        # A later verification may rank another candidate higher. The engine
        # retains the current choice until Face Lock hysteresis accepts it.
        later = choose_compatible_identity([first, second], [target_b])
        self.assertEqual(later.candidate.face_id, "second")
        self.assertEqual(locked.candidate.face_id, "first")

    def test_face_match_strictness_filters_cached_embedding_scores(self) -> None:
        source = CandidateIdentity("source", unit(0), FacePresentation("female", 0.99))
        target = TargetIdentity(
            np.zeros((5, 2)),
            np.asarray([0.5, 0.8660254, 0.0, 0.0], dtype=np.float32),
            FacePresentation("female", 0.99),
            80,
        )
        score = choose_compatible_identity([source], [target]).similarity
        self.assertIsNotNone(
            choose_compatible_identity(
                [source], [target], minimum_similarity=score - 0.01
            )
        )
        self.assertIsNone(
            choose_compatible_identity(
                [source], [target], minimum_similarity=score + 0.01
            )
        )

    def test_arcface_scores_use_the_full_strictness_range(self) -> None:
        source = unit(0)
        high = np.asarray([0.65, 0.759934, 0.0, 0.0], dtype=np.float32)
        medium = np.asarray([0.40, 0.916515, 0.0, 0.0], dtype=np.float32)
        low = np.asarray([0.15, 0.988686, 0.0, 0.0], dtype=np.float32)
        scores = [rope_similarity(source, value) for value in (high, medium, low)]
        self.assertGreater(scores[0], scores[1])
        self.assertGreater(scores[1], scores[2])
        self.assertLess(rope_similarity(source, unit(1)), 1.0)
        self.assertGreater(scores[0] - scores[2], 40.0)

    def test_high_strictness_uses_visual_appearance_to_separate_similar_faces(self) -> None:
        source_presentation = FacePresentation(
            "female", 0.99, (0.60, 0.56, 0.57, 0.50, 0.70, 0.32)
        )
        close_presentation = FacePresentation(
            "female", 0.99, (0.61, 0.55, 0.58, 0.51, 0.71, 0.31)
        )
        far_presentation = FacePresentation(
            "female", 0.99, (0.24, 0.80, 0.31, 0.16, 0.34, 0.78)
        )
        self.assertGreater(
            appearance_similarity(source_presentation, close_presentation),
            appearance_similarity(source_presentation, far_presentation),
        )
        source = CandidateIdentity("source", unit(0), source_presentation)
        close_target = TargetIdentity(
            np.zeros((5, 2)), unit(0), close_presentation, 80
        )
        far_target = TargetIdentity(
            np.zeros((5, 2)), unit(0), far_presentation, 80
        )
        self.assertIsNotNone(
            choose_compatible_identity([source], [close_target], minimum_similarity=85)
        )
        self.assertIsNone(
            choose_compatible_identity([source], [far_target], minimum_similarity=85)
        )

    def test_high_strictness_requires_confident_matching_presentation(self) -> None:
        source = CandidateIdentity("source", unit(0), FacePresentation("female", 0.90))
        target = TargetIdentity(
            np.zeros((5, 2)), unit(0), FacePresentation("female", 0.90), 80
        )
        self.assertIsNotNone(
            choose_compatible_identity(
                [source],
                [target],
                minimum_presentation_confidence=presentation_confidence_for_strictness(50),
            )
        )
        self.assertIsNone(
            choose_compatible_identity(
                [source],
                [target],
                minimum_presentation_confidence=presentation_confidence_for_strictness(100),
            )
        )
        self.assertAlmostEqual(presentation_confidence_for_strictness(100), 0.95)

    def test_target_identity_lock_never_becomes_bystander_permissive(self) -> None:
        thresholds = [target_identity_lock_threshold(value) for value in range(101)]
        self.assertEqual(thresholds[0], 55.0)
        self.assertEqual(thresholds[-1], 60.0)
        for previous, current in zip(thresholds, thresholds[1:]):
            self.assertGreater(current, previous)
        self.assertEqual(target_identity_continuity_threshold(), 25.0)

    def test_lookalike_acquisition_and_identity_retention_use_different_weights(self) -> None:
        source_presentation = FacePresentation(
            "female", 0.99, (0.60, 0.56, 0.57, 0.50, 0.70, 0.32)
        )
        close_appearance = FacePresentation(
            "female", 0.99, (0.61, 0.55, 0.58, 0.51, 0.71, 0.31)
        )
        source = CandidateIdentity("source", unit(0), source_presentation)
        # Deliberately orthogonal ArcFace vectors model two different people
        # who look alike in visible presentation.
        target = TargetIdentity(
            np.zeros((5, 2)), unit(1), close_appearance, 80
        )
        lookalike = compatible_identity_rankings(
            [source], target, similarity_mode="lookalike"
        )[0].similarity
        identity = compatible_identity_rankings(
            [source], target, similarity_mode="identity"
        )[0].similarity
        self.assertGreater(lookalike, identity)

    def test_compatible_rankings_choose_best_selected_source(self) -> None:
        first = CandidateIdentity("first", unit(0), FacePresentation("female", 0.99))
        second = CandidateIdentity("second", unit(1), FacePresentation("female", 0.99))
        target = TargetIdentity(
            np.zeros((5, 2)),
            np.asarray([0.2, 0.95, 0.0, 0.0], dtype=np.float32),
            FacePresentation("female", 0.99),
        )
        ranked = compatible_identity_rankings([first, second], target)
        self.assertEqual([item.candidate.face_id for item in ranked], ["second", "first"])

    def test_every_face_lock_point_increases_required_gain(self) -> None:
        policies = [face_switch_policy(value) for value in range(101)]
        self.assertEqual(policies[0].minimum_gain, 0.0)
        for previous, current in zip(policies, policies[1:100]):
            self.assertGreater(current.minimum_gain, previous.minimum_gain)
            self.assertFalse(current.disabled)
        self.assertTrue(policies[100].disabled)
        self.assertEqual(policies[0].confirmations, 1)
        self.assertEqual(policies[99].confirmations, 3)


if __name__ == "__main__":
    unittest.main()
