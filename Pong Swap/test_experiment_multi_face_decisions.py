import json
import types
import unittest

import numpy as np

import experiment_multi_face_decisions as diagnostic
import pong_hair_policy as hair
import pong_swap_identity as identity
from pong_swap_identity import CandidateIdentity, FacePresentation, TargetIdentity


class DecisionDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.embedding = np.asarray([1., 0., 0.], dtype=np.float32)
        self.source = CandidateIdentity('approved-18-123456789abc', self.embedding,
                                        FacePresentation('male', .98))

    def target(self, presentation):
        return TargetIdentity(np.zeros((5, 2), np.float32), self.embedding,
                              presentation, area=100.)

    def test_source_admission_and_presentation_are_distinct_count_only_gates(self):
        low = diagnostic._pair_gate_counts((self.source,),
            (self.target(FacePresentation('male', .89)),), 45., .5, identity, hair)
        self.assertEqual(low['sourceAdmissionRejected'], 1)
        self.assertEqual(low['sourceAdmissionLowConfidence'], 1)
        self.assertNotIn('presentationRejected', low)
        wrong_source = CandidateIdentity('approved-2-123456789abc', self.embedding,
                                         FacePresentation('male', .98))
        male_restricted = diagnostic._pair_gate_counts((wrong_source,),
            (self.target(FacePresentation('male', .98)),), 45., .5, identity, hair)
        self.assertEqual(male_restricted['maleSourceRestricted'], 1)
        incompatible_source = CandidateIdentity(self.source.face_id, self.embedding,
                                                FacePresentation('female', .98))
        mismatch = diagnostic._pair_gate_counts((incompatible_source,),
            (self.target(FacePresentation('male', .98)),), 45., .5, identity, hair)
        self.assertEqual(mismatch['presentationRejected'], 1)
        self.assertEqual(mismatch['presentationMismatch'], 1)
        self.assertNotIn('sourceAdmissionRejected', mismatch)

    def test_installed_wrapper_returns_original_decision_and_only_count_fields(self):
        events = []
        module = types.SimpleNamespace()
        selected = object()

        def original_choose(candidates, targets, *, minimum_similarity=0.,
                            minimum_presentation_confidence=0.):
            self.assertEqual(candidates, (self.source,))
            return types.SimpleNamespace(reason='candidate', selection=selected)

        module.choose_multi_face = original_choose

        class FakeEngine:
            def _select_compatible_identity_for_frame(self, frame, candidates,
                                                        config, frame_evidence):
                frame_evidence.detections = ((12., None, np.asarray([1.])),)
                return module.choose_multi_face(candidates,
                    (self_target,), minimum_similarity=45.,
                    minimum_presentation_confidence=.5).selection

        self_target = self.target(FacePresentation('male', .98))
        module.PongSwapEngine = FakeEngine

        class FakeConsensus:
            def observe(self, choice, seconds):
                return None

        multi = types.SimpleNamespace(MultiFaceConsensus=FakeConsensus)
        handle = diagnostic.install(module, multi, identity, hair,
                                    on_event=events.append)
        try:
            evidence = types.SimpleNamespace(frame_index=5)
            result = FakeEngine()._select_compatible_identity_for_frame(
                None, (self.source,), {}, evidence)
            self.assertIs(result, selected)
            self.assertEqual(events[0]['gates']['detectedRows'], 1)
            self.assertEqual(events[0]['gates']['eligiblePairs'], 1)
            self.assertEqual(events[0]['frameIndex'], 5)
            self.assertNotIn(self.source.face_id, json.dumps(events))
            self.assertIsNone(FakeConsensus().observe(selected, 0.1))
            self.assertEqual(handle.snapshot()['consensus:pending'], 1)
        finally:
            handle.uninstall()
        self.assertIs(module.choose_multi_face, original_choose)
        self.assertIs(FakeEngine._select_compatible_identity_for_frame,
                      handle.original_select)
        self.assertIs(FakeConsensus.observe, handle.original_observe)

    def test_failed_diagnostic_callback_cannot_change_selection(self):
        module = types.SimpleNamespace()
        decision = object()

        def chooser(*args, **kwargs):
            return types.SimpleNamespace(reason='candidate', selection=decision)

        module.choose_multi_face = chooser

        class FakeEngine:
            def _select_compatible_identity_for_frame(self, frame, candidates,
                                                        config, frame_evidence):
                frame_evidence.detections = ()
                return module.choose_multi_face(candidates, ()).selection

        class FakeConsensus:
            def observe(self, choice, seconds):
                return choice

        module.PongSwapEngine = FakeEngine
        multi = types.SimpleNamespace(MultiFaceConsensus=FakeConsensus)
        handle = diagnostic.install(module, multi, identity, hair,
                                    on_event=lambda event: 1 / 0)
        try:
            result = FakeEngine()._select_compatible_identity_for_frame(
                None, (), {}, types.SimpleNamespace(frame_index=0))
            self.assertIs(result, decision)
        finally:
            handle.uninstall()


if __name__ == '__main__':
    unittest.main()
