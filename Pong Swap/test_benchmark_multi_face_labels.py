import copy
import unittest
from benchmark_multi_face_labels import evaluate


class EvaluationTests(unittest.TestCase):
    def setUp(self):
        self.manifest={'approvedFaceIds':['a','b'],'cases':[
            {'id':'c1','kind':'clip','split':'heldout','sha256':'1'*64,'sourceGroup':'g1',
             'licenseOrConsent':'test fixture','labelSource':'independent-review','acceptableFaceIds':['a']}]}
        self.observed={'c1':{'selectedFaceId':'a','selectedFaceSequence':['a','a'],
                             'offeredFaceIds':['b','a'],'transformed':True}}

    def test_small_success_does_not_pass_user_scale_gate(self):
        result=evaluate(self.manifest,self.observed)
        self.assertTrue(result['cases'][0]['passed'])
        self.assertFalse(result['coverageRequirementsMet'])
        self.assertFalse(result['allRequiredPassed'])

    def test_missing_result_inconsistent_choice_and_unreviewed_label_fail(self):
        self.assertFalse(evaluate(self.manifest,{})['cases'][0]['passed'])
        self.observed['c1']['selectedFaceSequence']=['b','a']
        self.assertFalse(evaluate(self.manifest,self.observed)['cases'][0]['passed'])
        self.manifest['cases'][0]['labelSource']='matcher-generated'
        self.observed['c1']['selectedFaceSequence']=['a']
        self.assertFalse(evaluate(self.manifest,self.observed)['cases'][0]['passed'])

    def test_cannot_offer_only_the_expected_winner(self):
        self.observed['c1']['offeredFaceIds']=['a']
        self.assertFalse(evaluate(self.manifest,self.observed)['cases'][0]['passed'])

    def test_reference_duplicate_and_family_leaks_rejected(self):
        m=copy.deepcopy(self.manifest);m['referenceAssetHashes']=['1'*64]
        with self.assertRaises(ValueError):evaluate(m,self.observed)
        m=copy.deepcopy(self.manifest);m['cases'].append(dict(m['cases'][0],id='copy'))
        with self.assertRaises(ValueError):evaluate(m,self.observed)
        m=copy.deepcopy(self.manifest);m['cases'].append(dict(m['cases'][0],id='other',sha256='2'*64,split='calibration'))
        with self.assertRaises(ValueError):evaluate(m,self.observed)


if __name__=='__main__':unittest.main()
