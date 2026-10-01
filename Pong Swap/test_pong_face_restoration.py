import copy
import unittest
from pong_face_restoration import apply_face_restoration

class FaceRestorationTests(unittest.TestCase):
    def test_only_approved28(self):
        for face in ['approved-8-aabb', 'approved-27-aabb', 'approved-280-aabb', '']:
            config = {'parameters': {'RestorerSlider': 93}, 'runtime': {}}
            original = copy.deepcopy(config)
            apply_face_restoration(config, face)
            self.assertEqual(config, original)

    def test_multiface_switch_restores_baseline(self):
        config = {'parameters': {'RestorerSlider': 93, 'RestorerTypeTextSel': 'GPEN1024'}, 'runtime': {}}
        saved = copy.deepcopy(config)
        for _ in range(3):
            apply_face_restoration(config, 'approved-28-b14cb1d667c1')
            self.assertEqual(config['parameters']['RestorerSlider'], 50)
        apply_face_restoration(config, 'approved-8-aabb')
        self.assertEqual(config, saved)

    def test_other_quality_preserved(self):
        for profile in ['default', 'adaptive']:
            config = {'parameters': {'RestorerSlider': 100, 'RestorerSwitch': True, 'RestorerTypeTextSel': 'GPEN1024'}, 'runtime': {'tiktokRestorerProfile': profile}}
            apply_face_restoration(config, 'approved-28-abcd')
            self.assertEqual(config['parameters'], {'RestorerSlider': 50, 'RestorerSwitch': True, 'RestorerTypeTextSel': 'GPEN1024'})
            self.assertEqual(config['runtime']['tiktokRestorerProfile'], profile)

if __name__ == '__main__':
    unittest.main()
