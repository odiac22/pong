import unittest
import numpy as np
from pong_swap_identity import (FacePresentation, CandidateIdentity, TargetIdentity,
    approved_source_allows_target, choose_compatible_identity)
from pong_multi_face import choose_multi_face

class MaleTargetPolicyTests(unittest.TestCase):
    def test_only_approved_18_admits_confident_male_targets(self):
        male=FacePresentation('male', .99)
        self.assertTrue(approved_source_allows_target('approved-18-450cb7bf9222',male))
        for n in [2,3,8,13,17,19,23,24,25,26,180]:
            self.assertFalse(approved_source_allows_target(f'approved-{n}-450cb7bf9222',male))
    def test_unknown_and_uncertain_never_pass_even_with_18(self):
        for p in [FacePresentation('unknown',1),FacePresentation('female',.89),FacePresentation('male',float('nan'))]:
            self.assertFalse(approved_source_allows_target('approved-18',p))
    def test_single_and_multi_share_the_guard(self):
        v=np.array([1.,0.,0.]); p=FacePresentation('male',.99)
        target=TargetIdentity(np.zeros((5,2)),v,p,100)
        blocked=CandidateIdentity('approved-2-b059089721b4',v,p)
        allowed=CandidateIdentity('approved-18-450cb7bf9222',v,p)
        self.assertIsNone(choose_compatible_identity([blocked],[target]))
        self.assertIsNone(choose_multi_face([blocked],[target]).selection)
        self.assertEqual(choose_multi_face([blocked,allowed],[target]).selection.candidate.face_id,allowed.face_id)
    def test_female_target_unchanged_when_confident(self):
        self.assertTrue(approved_source_allows_target('approved-2-b059089721b4',FacePresentation('female',.99)))

if __name__=='__main__':unittest.main()
