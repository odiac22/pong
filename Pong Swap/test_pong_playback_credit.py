"""CPU-only coverage for opt-in TikTok playback-credit ordering."""

from __future__ import annotations

import threading
import unittest

from pong_playback_credit import apply_ordered_playback


class FakeSession:
    def __init__(self) -> None:
        self.condition = threading.Condition()
        self.client_epoch = "client-a"
        self.playback_position_seconds = 0.0
        self.playback_position_updated_at = 0.0
        self.playback_paused = False


class OrderedPlaybackTest(unittest.TestCase):
    def test_late_heartbeat_cannot_unpause_departed_session(self) -> None:
        session = FakeSession()
        self.assertTrue(apply_ordered_playback(session, client_epoch="client-a",
            sequence=2, position_seconds=0, paused=True))
        timestamp = session.playback_position_updated_at
        self.assertFalse(apply_ordered_playback(session, client_epoch="client-a",
            sequence=1, position_seconds=9, paused=False))
        self.assertTrue(session.playback_paused)
        self.assertEqual(session.playback_position_seconds, 0)
        self.assertEqual(session.playback_position_updated_at, timestamp)

    def test_return_to_old_session_outvotes_late_pause(self) -> None:
        session = FakeSession()
        apply_ordered_playback(session, client_epoch="client-a", sequence=1,
            position_seconds=3, paused=False)
        apply_ordered_playback(session, client_epoch="client-a", sequence=3,
            position_seconds=4, paused=False)
        self.assertFalse(apply_ordered_playback(session, client_epoch="client-a",
            sequence=2, position_seconds=0, paused=True))
        self.assertFalse(session.playback_paused)
        self.assertEqual(session.playback_position_seconds, 4)

    def test_duplicate_and_wrong_owner_do_not_mutate(self) -> None:
        session = FakeSession()
        self.assertTrue(apply_ordered_playback(session, client_epoch="client-a",
            sequence=1, position_seconds=5, paused=True))
        self.assertFalse(apply_ordered_playback(session, client_epoch="client-a",
            sequence=1, position_seconds=50, paused=False))
        with self.assertRaisesRegex(ValueError, "owner mismatch"):
            apply_ordered_playback(session, client_epoch="client-b", sequence=9,
                position_seconds=50, paused=False)
        self.assertEqual(session.playback_position_seconds, 5)
        self.assertTrue(session.playback_paused)

    def test_position_remains_monotonic_on_valid_pause(self) -> None:
        session = FakeSession()
        apply_ordered_playback(session, client_epoch="client-a", sequence=1,
            position_seconds=8, paused=False)
        apply_ordered_playback(session, client_epoch="client-a", sequence=2,
            position_seconds=0, paused=True)
        self.assertEqual(session.playback_position_seconds, 8)
        self.assertTrue(session.playback_paused)


if __name__ == "__main__":
    unittest.main()
