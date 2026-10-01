import itertools
import unittest
from unittest.mock import patch
import numpy as np
from pong_swap_identity import CandidateIdentity, TargetIdentity, FacePresentation
from pong_multi_face import (choose_multi_face, MultiFaceConsensus, acquisition_probe_step,
                            MultiVideoSources, multi_video_key)


def vector(cosine):
    return np.asarray([cosine, (1-cosine*cosine)**.5, 0], dtype=np.float32)


def candidate(name, cosine, appearance=()):
    return CandidateIdentity(name, vector(cosine), FacePresentation('female', .99, appearance))


def target(embedding=None, appearance=()):
    return TargetIdentity(np.zeros((5,2)), np.asarray([1,0,0] if embedding is None else embedding, dtype=np.float32),
                          FacePresentation('female', .99, appearance), 100)


class MultiFaceTests(unittest.TestCase):
    def test_features_outweigh_identical_colour(self):
        chosen=choose_multi_face([candidate('colour',.1,(.5,)*6), candidate('features',.6,(.8,)*6)],
                                 [target(appearance=(.5,)*6)])
        self.assertEqual(chosen.selection.candidate.face_id,'features')

    def test_order_never_selects_default_first_face(self):
        choices=[candidate('a',.2),candidate('b',.55),candidate('c',.3)]
        for ordered in itertools.permutations(choices):
            self.assertEqual(choose_multi_face(ordered,[target()]).selection.candidate.face_id,'b')

    def test_ties_and_near_ties_choose_best_available_independent_of_order(self):
        for a,b in [(.5,.5),(.5,.501)]:
            for ordered in itertools.permutations([candidate('a',a),candidate('b',b)]):
                decision=choose_multi_face(ordered,[target()])
                self.assertEqual(decision.selection.candidate.face_id,'a' if a==b else 'b')
                self.assertEqual(decision.reason,'best-available-close-match')
                self.assertIsNotNone(decision.margin)

    def test_close_runner_up_is_reported_without_blocking_an_eligible_winner(self):
        decision=choose_multi_face([candidate('a',.5),candidate('b',.495)], [target()], minimum_similarity=68)
        self.assertEqual(decision.selection.candidate.face_id,'a')
        self.assertLess(decision.margin,2)
        self.assertEqual(len(decision.scores),2)

    def test_feedback_ineligible_winner_cannot_veto_eligible_runner_up(self):
        choices=[candidate('eligible',.4),candidate('below-floor',.3)]
        with patch('pong_multi_face.MATCH_FEEDBACK.bonuses',return_value={'below-floor':18}):
            for ordered in itertools.permutations(choices):
                decision=choose_multi_face(ordered,[target()],minimum_similarity=45)
                self.assertIsNotNone(decision.selection)
                self.assertEqual(decision.selection.candidate.face_id,'eligible')
                self.assertEqual([face for face,_ in decision.scores],['eligible'])

    def test_nonpositive_arcface_colour_winner_cannot_veto_valid_choice(self):
        choices=[candidate('eligible',.14),candidate('colour-only',0,(.5,)*6)]
        with patch('pong_multi_face.MATCH_FEEDBACK.bonuses',return_value={}):
            decision=choose_multi_face(choices,[target(appearance=(.5,)*6)])
        self.assertIsNotNone(decision.selection)
        self.assertEqual(decision.selection.candidate.face_id,'eligible')
        self.assertEqual([face for face,_ in decision.scores],['eligible'])

    def test_feedback_never_makes_all_ineligible_sources_eligible(self):
        with patch('pong_multi_face.MATCH_FEEDBACK.bonuses',return_value={'below-floor':18}):
            self.assertIsNone(choose_multi_face([candidate('below-floor',.3)],
                [target()],minimum_similarity=45).selection)

    def test_unrelated_or_nonfinite_embedding_cannot_win_by_colour(self):
        self.assertIsNone(choose_multi_face([candidate('a',0,(.5,)*6)], [target(appearance=(.5,)*6)]).selection)
        self.assertIsNone(choose_multi_face([candidate('a',.5)], [target([np.nan,0,0])]).selection)
        bad=CandidateIdentity('bad',np.zeros(3),FacePresentation('female',.99))
        self.assertIsNone(choose_multi_face([bad],[target()]).selection)

    def test_more_than_five_choices_and_duplicate_ids(self):
        choices=[candidate(str(i),.1+i*.02) for i in range(15)]+[candidate('best',.6)]
        choice=choose_multi_face(choices+[choices[-1]], [target()])
        self.assertEqual(choice.selection.candidate.face_id,'best')

    def test_consensus_is_time_based_at_all_requested_fps(self):
        decision=choose_multi_face([candidate('a',.6),candidate('b',.1)],[target()])
        for fps in [24,25,30,50,59.94,60]:
            tracker=MultiFaceConsensus()
            self.assertIsNone(tracker.observe(decision.selection,0))
            first=None
            for frame in range(1,8):
                if tracker.observe(decision.selection,frame/fps):
                    first=frame/fps;break
            self.assertGreaterEqual(first,.04-1e-8)
            self.assertLess(first,.04+1/fps+1e-8)

    def test_cut_missing_backwards_or_different_target_resets_acquisition(self):
        choice=choose_multi_face([candidate('a',.6)],[target()]).selection
        for middle,seconds in [(None,.02),(choice,.5),(choice,-1)]:
            tracker=MultiFaceConsensus();tracker.observe(choice,0)
            self.assertIsNone(tracker.observe(middle,seconds))
            self.assertIsNone(tracker.observe(choice,1))

    def test_locked_source_never_changes_in_that_video(self):
        a=choose_multi_face([candidate('a',.6)],[target()]).selection
        b=choose_multi_face([candidate('b',.6)],[target()]).selection
        tracker=MultiFaceConsensus();tracker.observe(a,0)
        self.assertIs(tracker.observe(a,.04),a)
        self.assertIs(tracker.observe(b,1),a)
        self.assertIs(tracker.observe(None,2),a)
        self.assertIsNone(MultiFaceConsensus().observe(b,0))

    def test_speculative_probes_finish_consensus_before_throttling(self):
        choice=choose_multi_face([candidate('a',.6),candidate('b',.1)],[target()]).selection
        for fps in [24,25,30,50,59.94,60]:
            tracker=MultiFaceConsensus();frame=0;locked=None
            while frame/fps<.2:
                locked=tracker.observe(choice,frame/fps)
                if locked:break
                frame+=acquisition_probe_step(fps,True,tracker.pending is not None)
            self.assertIsNotNone(locked)
            self.assertGreater(acquisition_probe_step(fps,True,False),1)

    def test_seek_retains_choice_and_new_video_set_epoch_do_not(self):
        cache=MultiVideoSources()
        key=multi_video_key('phone','epoch','video',['a','b'],1)
        self.assertEqual(cache.bind(key,'a'),'a')
        self.assertEqual(cache.bind(key,'b'),'a')
        self.assertEqual(cache.bind(multi_video_key('phone','epoch','video',['b','a'],1)),'a')
        for args in [('other','epoch','video',['a','b'],1),('phone','new','video',['a','b'],1),
                     ('phone','epoch','other',['a','b'],1),('phone','epoch','video',['a','c'],1),
                     ('phone','epoch','video',['a','b'],2)]:
            self.assertIsNone(cache.bind(multi_video_key(*args)))
        self.assertIsNone(multi_video_key('phone','epoch','video',['a','b'],1,manual=True))

    def test_choice_cache_bounded_and_expires(self):
        now=[0.];cache=MultiVideoSources(maximum=2,ttl_seconds=10,clock=lambda:now[0])
        for key in ['a','b','c']:cache.bind(key,key)
        self.assertIsNone(cache.bind('a'))
        self.assertEqual(len(cache.items),2)
        now[0]=11
        self.assertIsNone(cache.bind('b'));self.assertFalse(cache.items)


if __name__=='__main__': unittest.main()
