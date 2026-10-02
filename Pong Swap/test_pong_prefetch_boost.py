"""Baseline 1.8: prepared next video shares surplus GPU above 1 s headroom."""
import threading
import unittest
from types import SimpleNamespace

from pong_prefetch_boost import PrefetchBoost


def session(sid, *, prefetch, frames=0, prepared=False, headroom=0.0):
    return SimpleNamespace(
        id=sid, channel="tiktok", prefetch=prefetch, activation_requested=not prefetch,
        playback_started_at=0 if prefetch else 1.0, frames=frames, fps=30.0,
        complete=False, stop=threading.Event(), subscribers=1, created_at=0.0,
        is_prepared=lambda: prepared, headroom=headroom)


class FakeEngine:
    def __init__(self, visible, nxt):
        self._sessions_lock = threading.Lock()
        self._sessions = {visible.id: visible, nxt.id: nxt}
        self._active_by_channel = {"tiktok": visible.id}
        self.original_calls = 0

    def _foreground_playback_needs_gpu(self, excluded_session_id, **kwargs):
        self.original_calls += 1
        return True  # engine policy: visible video is below its 2 s headroom

    def _playback_headroom_seconds(self, active, now):
        return active.headroom

    def _estimated_playback_position_seconds(self, active, now):
        return active.frames / active.fps - active.headroom


class ShareHeadroomTest(unittest.TestCase):
    def build(self, *, headroom, frames=40, prepared=False, share=1.0):
        visible = session("v", prefetch=False, frames=90, headroom=headroom)
        nxt = session("n", prefetch=True, frames=frames, prepared=prepared)
        engine = FakeEngine(visible, nxt)
        boost = PrefetchBoost(engine, share_headroom=share)
        boost._install_yield_exemption()
        return engine, boost

    def test_unprepared_next_video_runs_above_share_headroom(self):
        engine, boost = self.build(headroom=1.4)
        self.assertFalse(engine._foreground_playback_needs_gpu("n"))
        self.assertEqual(boost.shared_frames, 1)

    def test_visible_video_keeps_priority_below_share_headroom(self):
        engine, _ = self.build(headroom=0.7)
        self.assertTrue(engine._foreground_playback_needs_gpu("n"))

    def test_prepared_next_video_waits_for_engine_policy(self):
        engine, _ = self.build(headroom=1.8, prepared=True)
        self.assertTrue(engine._foreground_playback_needs_gpu("n"))

    def test_only_next_video_gets_boost_frames(self):
        visible = session("v", prefetch=False, frames=90, headroom=0.2)
        nxt = session("n", prefetch=True, frames=3)
        later = session("l", prefetch=True, frames=3)
        later.created_at = 5.0
        engine = FakeEngine(visible, nxt)
        engine._sessions["l"] = later
        boost = PrefetchBoost(engine, share_headroom=0, boost_frames=20, min_foreground_lead=0.5,
                              admission_slots=2)
        boost._install_yield_exemption()
        # visible rendered lead = 90/30 - (90/30 - 0.2) = 0.2 s < 0.5: no boost yet
        self.assertTrue(engine._foreground_playback_needs_gpu("n"))
        visible.headroom = 0.8
        self.assertFalse(engine._foreground_playback_needs_gpu("n"))
        self.assertTrue(engine._foreground_playback_needs_gpu("l"))

    def test_disabled_share_keeps_engine_policy(self):
        engine, _ = self.build(headroom=1.8, share=0)
        self.assertTrue(engine._foreground_playback_needs_gpu("n"))


if __name__ == "__main__":
    unittest.main()
