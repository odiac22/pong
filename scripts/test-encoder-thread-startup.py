"""CPU-only tests; do not invoke FFmpeg/NVENC or the renderer."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

import numpy as np


MODULE_PATH = Path(__file__).with_name('benchmark-encoder-thread-startup.py')
SPEC = importlib.util.spec_from_file_location('encoder_thread_startup_trial', MODULE_PATH)
trial = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(trial)


def box(kind: bytes, data: bytes, *, extended: bool = False) -> bytes:
    if extended:
        return (1).to_bytes(4, 'big') + kind + (16 + len(data)).to_bytes(8, 'big') + data
    return (8 + len(data)).to_bytes(4, 'big') + kind + data


class EncoderThreadStartupTests(unittest.TestCase):
    def test_baseline_mirrors_frozen_command_and_variants_change_one_flag(self):
        trial.verify_frozen_mirror(trial.FROZEN_SOURCE.read_text(encoding='utf-8'))
        baseline = trial.build_command('baseline')
        self.assertEqual(baseline[:5], ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin'])
        self.assertEqual(baseline[-3:], ['-f', 'mp4', 'pipe:1'])
        self.assertIn('frag_every_frame+empty_moov+default_base_moof', baseline)
        self.assertEqual(baseline[baseline.index('-g') + 1], '15')
        self.assertNotIn('-filter_threads', baseline)
        self.assertNotIn('-threads', baseline)
        for variant, option, value in (
            ('filter_threads_1', '-filter_threads', '1'),
            ('filter_threads_2', '-filter_threads', '2'),
            ('threads_1', '-threads', '1'),
        ):
            command = trial.build_command(variant)
            index = command.index(option)
            self.assertEqual(command[index + 1], value)
            self.assertEqual(command[:index] + command[index + 2:], baseline)
            self.assertEqual(command.count(option), 1)
        with self.assertRaises(ValueError):
            trial.build_command('filter_threads_4')

    def test_complete_fragment_requires_moof_then_full_mdat(self):
        probe = trial.FragmentProbe()
        payload = box(b'ftyp', b'isom') + box(b'moov', b'abc') + \
            box(b'moof', b'one') + box(b'mdat', b'frame', extended=True)
        self.assertEqual(probe.feed(payload[:11]), 0)
        self.assertEqual(probe.feed(payload[11:-1]), 0)
        self.assertEqual(probe.feed(payload[-1:]), 1)
        self.assertEqual(probe.complete_fragments, 1)
        self.assertEqual(probe.feed(box(b'mdat', b'orphan')), 0)
        self.assertEqual(probe.feed(box(b'moof', b'two') + box(b'mdat', b'two')), 1)
        with self.assertRaises(ValueError):
            trial.FragmentProbe().feed((7).to_bytes(4, 'big') + b'junk')

    def test_textured_frames_are_deterministic_and_temporally_distinct(self):
        first = trial.textured_frames(64, 64, 3)
        second = trial.textured_frames(64, 64, 3)
        self.assertEqual(first, second)
        self.assertEqual(len(first[0]), 64 * 64 * 3)
        self.assertNotEqual(first[0], first[1])
        self.assertGreater(len(set(first[0])), 100)

    def test_pixel_and_timeline_changes_fail_closed(self):
        frames = [np.full((4, 4, 3), index * 40, dtype=np.uint8) for index in range(3)]
        pts = [0, 1 / 30, 2 / 30]
        reference = (frames, pts, {'width': 4, 'height': 4})
        identical = trial.compare_decoded(reference, reference, 3, 30)
        self.assertTrue(identical['qualityPreserving'])
        changed = [frame.copy() for frame in frames]
        changed[1][0, 0, 0] += 1
        pixels = trial.compare_decoded(reference, (changed, pts, reference[2]), 3, 30)
        self.assertFalse(pixels['qualityPreserving'])
        self.assertEqual(pixels['changedFrames'], 1)
        self.assertGreater(pixels['worstFrameRgbMae'], 0)
        late = trial.compare_decoded(reference, (frames, [0, 1 / 30, 0.2], reference[2]), 3, 30)
        self.assertFalse(late['qualityPreserving'])
        self.assertFalse(late['candidateTimelineComplete'])
        short = trial.compare_decoded(reference, (frames[:2], pts[:2], reference[2]), 3, 30)
        self.assertFalse(short['qualityPreserving'])


if __name__ == '__main__':
    unittest.main()
