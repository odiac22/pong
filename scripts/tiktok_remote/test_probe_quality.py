import unittest
from probe_quality import foreground_package, frame_window


class ProbeQualityTests(unittest.TestCase):
    def test_short_burst_is_not_sustained_sixty_fps(self):
        value = frame_window(4, 1., 1.05, 0., 10.)
        self.assertEqual(value['wholeWindowFps'], .4)
        self.assertEqual(value['activeSpanFps'], 60.)
        self.assertEqual(value['captureCoverage'], .005)
        self.assertIsNone(value['sourceVideoFps'])

    def test_no_frames_has_zero_coverage(self):
        self.assertEqual(frame_window(0, None, None, 0, 10)['captureCoverage'], 0)

    def test_only_resumed_activity_identifies_foreground(self):
        self.assertEqual(foreground_package('topResumedActivity=ActivityRecord{abc u0 com.example.app/.Main t12}'), 'com.example.app')
        self.assertIsNone(foreground_package('ActivityRecord{abc u0 com.example.app/.Main t12}'))


if __name__ == '__main__':
    unittest.main()
