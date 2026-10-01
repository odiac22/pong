import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pong_detection_learning import DetectionCalibration


class DetectionCalibrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'detection-learning.json'
        self.cal = DetectionCalibration(self.path)

    def test_no_write_on_load_and_normal_confirmations_do_not_lower_threshold(self):
        self.assertFalse(self.path.exists())
        for i in range(5):
            self.cal.confirm(f'https://stock.test/{i}', recovered=False)
        self.assertEqual(self.cal.threshold, .45)

    def test_three_distinct_recovery_confirmations_change_only_one_small_step(self):
        for i in range(2):
            self.cal.confirm(f'https://stock.test/{i}', recovered=True)
        self.assertEqual(self.cal.threshold, .45)
        result = self.cal.confirm('https://stock.test/2', recovered=True)
        self.assertTrue(result['changed'])
        self.assertEqual(self.cal.threshold, .44)
        self.assertEqual(DetectionCalibration(self.path).threshold, .44)
        self.assertEqual(json.loads(self.path.with_suffix('.previous.json').read_text())['threshold'], .45)

    def test_signed_queries_and_repeated_seeks_do_not_multiply_evidence(self):
        for i in range(10):
            self.cal.confirm(f'https://stock.test/clip?token=secret{i}#seek{i}', recovered=True)
        self.assertEqual(self.cal.public()['confirmed'], 1)
        self.assertEqual(self.cal.threshold, .45)
        text = self.path.read_text()
        for secret in ['https:', 'stock.test', 'secret', 'embedding']:
            self.assertNotIn(secret, text)

    def test_bounded_threshold_and_explicit_reset(self):
        for i in range(40):
            self.cal.confirm(f'https://stock.test/{i}', recovered=True)
        self.assertEqual(self.cal.threshold, .35)
        self.cal.reset()
        self.assertEqual(self.cal.threshold, .45)
        self.assertEqual(self.cal.public()['confirmed'], 0)

    def test_proxy_paths_do_not_merge_distinct_original_clips(self):
        for i in range(3):
            self.cal.confirm(f'https://local.test/media?url=https%3A%2F%2Fstock.test%2Fclip-{i}.mp4', recovered=True)
        self.assertEqual(self.cal.threshold, .44)
        self.assertEqual(self.cal.public()['confirmed'], 3)

    def test_proxy_and_signed_direct_source_count_once(self):
        self.cal.confirm('https://local.test/media?u=https%3A%2F%2Fstock.test%2Fwatch%3Fv%3D1%26token%3DA', recovered=True)
        self.cal.confirm('https://stock.test/watch?v=1&token=B', recovered=True)
        self.assertEqual(self.cal.public()['confirmed'], 1)
        self.cal.confirm('https://stock.test/watch?v=2&token=B', recovered=True)
        self.assertEqual(self.cal.public()['confirmed'], 2)

    def test_failed_persistence_does_not_mutate_active_state(self):
        with patch('pong_detection_learning.os.replace', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                self.cal.confirm('https://stock.test/1', recovered=True)
        self.assertEqual(self.cal.public()['confirmed'], 0)
        self.assertFalse(self.path.with_suffix('.tmp').exists())

    def test_no_training_from_unknown_or_non_video_sources(self):
        for source in ['', 'blob:test', 'data:image/jpeg,x', 'file:///private']:
            with self.assertRaises(ValueError):
                self.cal.confirm(source, recovered=True)
        self.assertFalse(self.path.exists())

    def test_invalid_disk_threshold_fails_closed_to_original_default(self):
        self.path.write_text(json.dumps(dict(schema=1, threshold=.01)))
        self.assertEqual(DetectionCalibration(self.path).threshold, .45)


if __name__ == '__main__':
    unittest.main()
