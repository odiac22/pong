"""Prevent unrelated hair edits silently disabling the approved fast path."""
import hashlib
from pathlib import Path
import unittest
from pong_exact_acceleration import SOURCE_HASHES

ROOT = Path(__file__).resolve().parent

class HairAccelerationQualification(unittest.TestCase):
    def test_current_engine_matches_reviewed_qualification(self):
        content = (ROOT / 'pong_swap_engine.py').read_bytes()
        self.assertEqual(hashlib.sha256(content).hexdigest(), SOURCE_HASHES['pong_swap_engine.py'])

    def test_reviewed_change_is_only_hair_acquisition(self):
        content = (ROOT / 'pong_swap_engine.py').read_bytes()
        before = content.replace(
            b'head_crop, color_from_hair_mask, segmented_hair_score',
            b'head_crop, color_from_hair_mask').replace(
            b'segmented_hair_score(output[0]).cpu().numpy()',
            b'torch.softmax(output,dim=1)[0,17].cpu().numpy()')
        self.assertEqual(hashlib.sha256(before).hexdigest(),
            '3a7dcb09568b12e3f69113db5c8205689ba78189eb12389d8f9dbb1931f0e56a')

if __name__ == '__main__':
    unittest.main()
