import unittest
import tempfile
import subprocess
from pathlib import Path
from types import SimpleNamespace as NS
from pong_swap_source_quality import highest_quality_video_stream


def stream(width, height, fps=24, bitrate=1000, kind='video'):
    return NS(type=kind, codec_context=NS(width=width, height=height, bit_rate=bitrate),
              average_rate=fps, base_rate=None, metadata={})


class SourceQualityTests(unittest.TestCase):
    def test_unordered_master_selects_1080_not_first_240(self):
        tracks = [stream(426, 240), stream(640, 360), stream(1920, 1080), stream(256, 144)]
        self.assertIs(highest_quality_video_stream(NS(streams=tracks)), tracks[2])

    def test_portrait_area_and_fps(self):
        tracks = [stream(1920, 1080, 24), stream(1080, 1920, 60)]
        self.assertIs(highest_quality_video_stream(NS(streams=tracks)), tracks[1])

    def test_bandwidth_tiebreaker(self):
        tracks = [stream(1920, 1080, bitrate=2e6), stream(1920, 1080, bitrate=5e6)]
        self.assertIs(highest_quality_video_stream(NS(streams=tracks)), tracks[1])

    def test_hls_variant_bitrate_metadata(self):
        tracks = [stream(1920, 1080, bitrate=None), stream(1920, 1080, bitrate=None)]
        tracks[0].metadata['variant_bitrate'] = '2000000'
        tracks[1].metadata['variant_bitrate'] = '5000000'
        self.assertIs(highest_quality_video_stream(NS(streams=tracks)), tracks[1])

    def test_audio_and_unknown_streams_do_not_beat_video(self):
        tracks = [stream(9999, 9999, kind='audio'), stream(None, None), stream(1280, 720)]
        self.assertIs(highest_quality_video_stream(NS(streams=tracks)), tracks[2])

    def test_single_stream_unchanged(self):
        one = stream(640, 360)
        self.assertIs(highest_quality_video_stream(NS(streams=[one])), one)

    def test_no_video(self):
        self.assertIsNone(highest_quality_video_stream(NS(streams=[stream(0, 0, kind='audio')])))

    def test_invalid_numbers_do_not_break_selection(self):
        tracks = [stream(float('nan'), 720, float('inf'), 'invalid'), stream(1280, 720)]
        self.assertIs(highest_quality_video_stream(NS(streams=tracks)), tracks[1])

    def test_real_pyav_decodes_highest_track_from_unordered_silent_file(self):
        import av
        root = Path(__file__).resolve().parents[1]
        fixtures = root / 'artifacts' / 'quality-selection-7.21.0' / 'assets' / 'one'
        if not all((fixtures / f'{name}.mp4').exists() for name in ['a', 'b', 'c']):
            self.skipTest('Generate silent quality fixtures with test-userscript-quality-browser.py first')
        with tempfile.TemporaryDirectory(prefix='pong-stream-quality-') as directory:
            output = Path(directory) / 'tracks.mp4'
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(fixtures/'a.mp4'),
                            '-i', str(fixtures/'b.mp4'), '-i', str(fixtures/'c.mp4'),
                            '-map', '0:v', '-map', '1:v', '-map', '2:v', '-an', '-c', 'copy', str(output)],
                           check=True, capture_output=True)
            with av.open(str(output)) as container:
                self.assertEqual(container.streams.video[0].codec_context.height, 360)
                selected = highest_quality_video_stream(container)
                self.assertEqual(selected.codec_context.height, 1080)
                frame = next(container.decode(selected))
                self.assertEqual((frame.width, frame.height), (1920, 1080))
                self.assertEqual(len(container.streams.audio), 0)


if __name__ == '__main__':
    unittest.main()
