import unittest,numpy as np
from copy import deepcopy
from pong_three_x import AssignmentRegistry,apply_quality_policy,FaceCorrectionCache
class ResponsiveTests(unittest.TestCase):
 def test_extending_video_pool_preserves_immutable_people_and_isolates_old_selection(self):
  r=AssignmentRegistry();s=r.get('ch','epoch','clip',['a'],cover_all=True)
  key=s._new('a',np.array([1,0],np.float32));s.revision=1
  t=r.get('ch','epoch','clip',['a','b'],cover_all=True,extend=True)
  self.assertEqual(t.sources[key],'a');np.testing.assert_array_equal(t.anchors[key],[1,0])
  t.correct([dict(revision=2,faceId='b',targetEmbedding=[1,0])])
  self.assertEqual(t.sources[key],'b');self.assertEqual(s.sources[key],'a')
  other=r.get('ch','epoch','other',['a','b'],cover_all=True,extend=True);self.assertFalse(other.anchors)
 def test_pressure_never_changes_model_or_disables_restoration(self):
  saved={'runtime':{'tiktokRestorerProfile':'tiktok-3x-adapt'},'parameters':{'RestorerSwitch':True,'RestorerTypeTextSel':'GPEN512','SwapperTypeTextSel':'256'}}
  original=deepcopy(saved)
  for level in range(9):
   c=deepcopy(saved);apply_quality_policy(c,saved,level,True)
   self.assertTrue(c['parameters']['RestorerSwitch']);self.assertEqual(c['parameters']['RestorerTypeTextSel'],'GPEN512')
   self.assertNotIn('crowdRestorerModel',c['runtime']);self.assertFalse(c['runtime']['threeXForce256'])
  self.assertEqual(saved,original)
if __name__=='__main__':unittest.main()
