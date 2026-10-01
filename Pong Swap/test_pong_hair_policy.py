import unittest
from unittest.mock import patch
import numpy as np
from pong_hair_policy import required_hair,hair_allows,color_from_hair_mask,head_crop,segmented_hair_score
from pong_multi_face import choose_multi_face
from pong_swap_identity import CandidateIdentity,TargetIdentity,FacePresentation,choose_compatible_identity

class HairPolicyTests(unittest.TestCase):
    def test_dark_roots_do_not_discard_the_larger_light_lengths(self):
        image=np.full((512,512,3),20,np.uint8)
        p=np.zeros((512,512),np.float32)
        p[35:115,130:380]=.95;image[35:115,130:380]=35
        p[150:470,100:170]=.95;image[150:470,100:170]=(195,170,140)
        p[150:470,342:412]=.95;image[150:470,342:412]=(195,170,140)
        self.assertEqual(color_from_hair_mask(image,p)[0],'light')
        # Unsegmented bright clothing/background must not contribute.
        image[p==0]=255
        self.assertEqual(color_from_hair_mask(image,p)[0],'light')
    def test_head_crop_includes_lengths_below_face(self):
        image=np.zeros((640,640,3),np.uint8);image[410:465,:,0]=255
        k=np.array([[290,200],[350,200],[320,230],[300,250],[340,250]],np.float32)
        self.assertGreater(int(head_crop(image,k)[...,0].max()),200)
    def test_small_highlights_do_not_turn_dark_hair_light(self):
        image=np.full((512,512,3),25,np.uint8);p=np.zeros((512,512),np.float32)
        p[40:450,110:400]=.95;image[40:90,110:400]=200
        self.assertEqual(color_from_hair_mask(image,p)[0],'dark')
    def test_hair_margin_keeps_clear_winner_despite_many_low_alternative_logits(self):
        import torch
        logits=torch.zeros((19,2,2));logits[17]=2
        self.assertLess(float(torch.softmax(logits,dim=0)[17,0,0]),.8)
        self.assertGreater(float(segmented_hair_score(logits)[0,0]),.8)
        logits[1,0,0]=3
        self.assertLess(float(segmented_hair_score(logits)[0,0]),.5)
    def test_tinted_light_hair_and_brown_hair(self):
        p=np.zeros((512,512),np.float32);p[40:180,130:380]=.95
        for rgb,expected in [((185,80,95),'light'),((75,55,40),'dark'),((30,30,30),'dark')]:
            image=np.full((512,512,3),220,np.uint8)
            values=np.linspace(.85,1.2,250)[None,:,None]
            image[40:180,130:380]=np.clip(np.array(rgb)*values,0,255).astype(np.uint8)
            self.assertEqual(color_from_hair_mask(image,p)[0],expected)
    def test_rules_exact_ids_only(self):
        for n in (2,3,13,23):self.assertEqual(required_hair(f'approved-{n}-abcdef123456'),'dark')
        for n in (8,19):self.assertEqual(required_hair(f'approved-{n}'),'light')
        for name in ('approved-18','approved-20','other-approved-2','approved-2-wrong'):self.assertIsNone(required_hair(name))
    def test_unknown_and_low_confidence_rank_all_selected_but_known_mismatch_blocks(self):
        self.assertFalse(hair_allows('approved-2','light',1))
        for color,confidence in [('unknown',1),('light',.79),('dark',float('nan'))]:
            self.assertTrue(hair_allows('approved-2',color,confidence))
        self.assertTrue(hair_allows('approved-2','dark',.9))
        self.assertTrue(hair_allows('approved-17','unknown',0))
    def test_segmented_pixels_not_background_decide_color(self):
        p=np.zeros((512,512),np.float32);p[40:180,130:380]=.99
        for hair,background,expected in [(35,220,'dark'),(200,30,'light')]:
            image=np.full((512,512,3),background,np.uint8);image[p>.8]=hair
            self.assertEqual(color_from_hair_mask(image,p)[0],expected)
    def test_bald_covered_mixed_midtones_uncertain(self):
        image=np.full((512,512,3),125,np.uint8)
        self.assertEqual(color_from_hair_mask(image,np.zeros((512,512)))[0],'unknown')
        self.assertEqual(color_from_hair_mask(image,np.ones((512,512)))[0],'unknown')
        self.assertIsNone(head_crop(image,np.zeros((5,2))))
    def test_hard_hair_gate_precedes_strong_feedback(self):
        p=FacePresentation('female',.99);v=np.array([1.,0.,0.]);k=np.zeros((5,2))
        dark=CandidateIdentity('approved-2',v,p);light=CandidateIdentity('approved-8',v,p)
        t=TargetIdentity(k,v,p,100,'light',.99)
        with patch('pong_multi_face.MATCH_FEEDBACK.bonuses',return_value={'approved-2':1000}):
            decision=choose_multi_face([dark,light],[t])
            self.assertEqual(decision.selection.candidate.face_id,'approved-8')
        self.assertIsNone(choose_multi_face([dark],[t]).selection)
    def test_single_face_matching_unchanged(self):
        p=FacePresentation('female',.99);v=np.array([1.,0.,0.]);t=TargetIdentity(np.zeros((5,2)),v,p)
        self.assertIsNotNone(choose_compatible_identity([CandidateIdentity('approved-2',v,p)],[t]))
    def test_unknown_hair_does_not_drop_all_restricted_selected_faces(self):
        p=FacePresentation('female',.99);v=np.array([1.,0.,0.])
        target=TargetIdentity(np.zeros((5,2)),v,p,100,'unknown',0)
        decision=choose_multi_face([CandidateIdentity('approved-2',v,p),CandidateIdentity('approved-8',np.array([0.,1.,0.]),p)],[target])
        self.assertIsNotNone(decision.selection)
        self.assertEqual(decision.selection.candidate.face_id,'approved-2')

if __name__=='__main__':unittest.main()
