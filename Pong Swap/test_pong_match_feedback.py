import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
from pong_match_feedback import MatchFeedback
from pong_multi_face import choose_multi_face
from pong_swap_identity import CandidateIdentity, TargetIdentity, FacePresentation

class MatchFeedbackTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.path=Path(self.temp.name)/'feedback.json';self.store=MatchFeedback(self.path)
    def test_repeated_click_deduplicates_and_changed_choice_replaces(self):
        for _ in range(3):self.store.confirm('token',0,'approved-2',[1,0,0])
        self.assertEqual(len(self.store.rows),1)
        self.store.confirm('token',0,'approved-3',[1,0,0])
        self.assertEqual(set(self.store.bonuses([1,0,0])),{'approved-3'})
    def test_learning_is_stronger_bounded_and_persistent(self):
        self.store.confirm('one',0,'approved-2',[1,0,0])
        self.assertAlmostEqual(self.store.bonuses([1,0,0])['approved-2'],8)
        for i in range(20):self.store.confirm(str(i),0,'approved-2',[1,0,0])
        self.assertEqual(MatchFeedback(self.path).bonuses([1,0,0])['approved-2'],18)
        self.assertEqual(self.store.bonuses([0,1,0]),{})
    def test_corrections_do_not_spread_to_weak_resemblances(self):
        self.store.confirm('one',0,'approved-2',[1,0,0])
        self.assertEqual(self.store.bonuses([.75,np.sqrt(1-.75**2),0]),{})
        self.assertAlmostEqual(self.store.bonuses([.9,np.sqrt(1-.9**2),0])['approved-2'],4,places=5)
    def test_invalid_vectors_rejected(self):
        for v in [[],[0,0],[float('nan'),1]]:
            with self.assertRaises(ValueError):self.store.confirm('token',0,'approved-2',v)
    def test_corrupt_store_does_not_break_matching(self):
        self.path.write_text('broken')
        self.assertEqual(self.store.bonuses([1,0,0]),{})
    def test_feedback_never_overrides_male_restriction(self):
        p=FacePresentation('male',.99);v=np.array([1.,0.,0.]);t=TargetIdentity(np.zeros((5,2)),v,p)
        blocked=CandidateIdentity('approved-2',v,p)
        self.store.confirm('token',0,'approved-2',v)
        with patch('pong_multi_face.MATCH_FEEDBACK',self.store):
            self.assertIsNone(choose_multi_face([blocked],[t]).selection)

if __name__=='__main__':unittest.main()
