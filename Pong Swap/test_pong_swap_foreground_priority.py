from __future__ import annotations

import threading
import time
import unittest
from copy import deepcopy
from unittest.mock import Mock

from pong_swap_config import default_config
from pong_swap_engine import PongSwapEngine, SwapSession


def session(
    identity: str,
    *,
    frames: int = 0,
    fps: float = 30.0,
    playback_started_at: float = 0.0,
    subscribers: int = 0,
    prefetch: bool = False,
    activated: bool = False,
    prebuffer_seconds: float = 0.0,
    bytes_written: int = 0,
    fragment_frame_target: int = 0,
    complete_fragments: int = 0,
) -> SwapSession:
    return SwapSession(
        id=identity,
        channel="test",
        source_url="https://example.invalid/video.mp4",
        face_id="approved-face",
        start_seconds=0.0,
        frames=frames,
        fps=fps,
        playback_started_at=playback_started_at,
        subscribers=subscribers,
        prefetch=prefetch,
        prebuffer_seconds=prebuffer_seconds,
        bytes_written=bytes_written,
        fragment_frame_target=fragment_frame_target,
        complete_fragments=complete_fragments,
        activation_requested=activated,
        config=deepcopy(default_config()),
        config_revision=1,
    )


class ForegroundHeadroomPriorityTests(unittest.TestCase):
    @staticmethod
    def _engine(*sessions: SwapSession, active: SwapSession | None = None) -> PongSwapEngine:
        engine = PongSwapEngine.__new__(PongSwapEngine)
        engine._sessions_lock = threading.RLock()
        engine._config = default_config()
        engine._sessions = {item.id: item for item in sessions}
        engine._active_by_channel = (
            {active.channel: active.id} if active is not None else {}
        )
        # These historical boundary examples assert a 1.25 s target, not the
        # independently tunable production default (currently 1.0 s).
        for item in sessions:
            item.config['runtime']['minimumHeadroom'] = 1.25
        return engine

    def test_headroom_uses_prepared_frames_minus_elapsed_playback(self) -> None:
        foreground = session(
            "foreground",
            frames=45,
            fps=30.0,
            playback_started_at=100.0,
            subscribers=1,
            activated=True,
        )

        self.assertAlmostEqual(
            PongSwapEngine._playback_headroom_seconds(foreground, 100.4),
            1.1,
        )

    def test_prefetch_buffer_is_never_below_scheduler_headroom_target(self) -> None:
        config = default_config()
        config["runtime"]["minimumHeadroom"] = 1.25

        self.assertEqual(
            PongSwapEngine._effective_prebuffer_seconds(True, 1.0, config),
            1.25,
        )
        self.assertEqual(
            PongSwapEngine._effective_prebuffer_seconds(True, 2.0, config),
            2.0,
        )
        self.assertEqual(
            PongSwapEngine._effective_prebuffer_seconds(False, 2.0, config),
            2.0,
        )
        self.assertEqual(
            PongSwapEngine._effective_prebuffer_seconds(False, 0.0, config),
            0.5,
        )

    def test_terminal_seek_clamps_prebuffer_to_attainable_whole_frames(self) -> None:
        # final17 sought to 5.04 in a 6.041667 second, 24 fps source. The
        # 1.25-second scheduler target is impossible; 24 frames (1.0 second)
        # are the largest real preload the source can provide.
        self.assertEqual(
            PongSwapEngine._attainable_prebuffer_seconds(
                1.25,
                source_duration=6.041667,
                start_seconds=5.04,
                fps=24.0,
            ),
            1.0,
        )

    def test_long_stream_keeps_full_scheduler_prebuffer(self) -> None:
        self.assertEqual(
            PongSwapEngine._attainable_prebuffer_seconds(
                1.25,
                source_duration=120.0,
                start_seconds=5.04,
                fps=24.0,
            ),
            1.25,
        )

    def test_promoted_headroom_uses_complete_fragments_not_frames_fed_to_ffmpeg(self) -> None:
        foreground = session(
            "foreground",
            frames=90,
            fps=30.0,
            playback_started_at=100.0,
            subscribers=1,
            activated=True,
            prebuffer_seconds=1.0,
            # Three complete 0.5 second fragments are playable even though
            # three seconds of raw frames have already entered FFmpeg.
            fragment_frame_target=15,
            complete_fragments=3,
        )

        self.assertAlmostEqual(
            PongSwapEngine._playable_media_seconds(foreground),
            1.5,
        )
        self.assertAlmostEqual(
            PongSwapEngine._playback_headroom_seconds(foreground, 100.4),
            1.1,
        )

    def test_promoted_headroom_never_exceeds_frames_fed(self) -> None:
        foreground = session(
            "foreground",
            frames=30,
            fps=30.0,
            playback_started_at=100.0,
            prebuffer_seconds=1.0,
            fragment_frame_target=15,
            complete_fragments=12,
        )

        self.assertEqual(
            PongSwapEngine._playable_media_seconds(foreground),
            1.0,
        )

    def test_muxed_headroom_keeps_speculation_paused_at_the_android_live_edge(self) -> None:
        foreground = session(
            "foreground",
            frames=90,
            fps=30.0,
            playback_started_at=100.0,
            subscribers=1,
            activated=True,
            prebuffer_seconds=1.25,
            # Raw input says 3.0 seconds, but only three 0.5 second fragments
            # reached the fMP4 reader.
            fragment_frame_target=15,
            complete_fragments=3,
        )
        speculative = session("speculative", prefetch=True)
        engine = self._engine(foreground, speculative, active=foreground)

        self.assertTrue(
            engine._foreground_playback_needs_gpu(speculative.id, now=100.4)
        )

    def test_only_active_viewed_session_can_preempt_prefetch(self) -> None:
        foreground = session(
            "foreground",
            frames=30,
            fps=30.0,
            playback_started_at=100.0,
            subscribers=1,
            activated=True,
        )
        speculative = session("speculative", prefetch=True)
        engine = self._engine(foreground, speculative, active=foreground)

        self.assertTrue(
            engine._foreground_playback_needs_gpu(speculative.id, now=100.0)
        )

        foreground.subscribers = 0
        self.assertFalse(
            engine._foreground_playback_needs_gpu(speculative.id, now=100.0)
        )
        foreground.subscribers = 1
        engine._active_by_channel.clear()
        self.assertFalse(
            engine._foreground_playback_needs_gpu(speculative.id, now=100.0)
        )

    def test_prefetch_waits_at_frame_boundary_until_headroom_recovers(self) -> None:
        speculative = session("speculative", prefetch=True)
        engine = self._engine(speculative)
        decisions = iter((True, True, False))
        engine._foreground_playback_needs_gpu = Mock(
            side_effect=lambda _excluded: next(decisions)
        )

        started = time.perf_counter()
        waits = engine._yield_prefetch_for_foreground(speculative)
        elapsed = time.perf_counter() - started

        self.assertEqual(waits, 2)
        self.assertEqual(engine._foreground_playback_needs_gpu.call_count, 3)
        self.assertGreaterEqual(elapsed, 0.015)
        self.assertLess(elapsed, 0.2)

    def test_promoted_prefetch_never_waits_behind_foreground_policy(self) -> None:
        promoted = session(
            "promoted",
            prefetch=False,
            activated=True,
            playback_started_at=100.0,
        )
        engine = self._engine(promoted, active=promoted)
        engine._foreground_playback_needs_gpu = Mock(return_value=True)

        self.assertEqual(engine._yield_prefetch_for_foreground(promoted), 0)
        engine._foreground_playback_needs_gpu.assert_not_called()


if __name__ == "__main__":
    unittest.main()
