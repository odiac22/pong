"""Deterministic, CPU-only external-clock lifetime and ownership contracts."""
import asyncio
from pathlib import Path
import threading
from types import SimpleNamespace
import unittest
from unittest import mock

from pong_external_playback_lease import ExternalPlaybackLeases
from pong_playback_credit import apply_ordered_playback


class LeaseTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.leases = ExternalPlaybackLeases(clock=lambda: self.now)
        self.stopped = []
        self.s = SimpleNamespace(id="owned", condition=threading.Condition(),
            stop=threading.Event(), complete=False, prefetch=False,
            activation_requested=True, playback_position_updated_at=0.0,
            playback_position_seconds=0.0, playback_paused=False,
            client_epoch="owner")

    def tick(self, seconds):
        self.now = seconds
        return self.leases.sweep(self.stopped.append)

    def report(self, sequence=1, paused=False, owner="owner"):
        with mock.patch("pong_playback_credit.time.monotonic", return_value=self.now):
            return apply_ordered_playback(self.s, client_epoch=owner,
                sequence=sequence, position_seconds=4, paused=paused)

    def test_legacy_session_not_registered_or_modified(self):
        self.assertEqual(self.tick(200), {"watched": 0, "paused": 0, "expired": 0})
        self.assertFalse(self.s.stop.is_set())
        self.assertFalse(self.s.playback_paused)

    def test_crash_before_first_heartbeat_freezes_then_retires(self):
        self.leases.register(self.s)
        self.assertEqual(self.tick(102.99)["paused"], 0)
        self.assertEqual(self.tick(103)["paused"], 1)
        self.assertTrue(self.s.playback_paused)
        self.assertEqual(self.s.playback_position_updated_at, 0)
        self.assertEqual(self.tick(114.99)["expired"], 0)
        self.assertEqual(self.tick(115), {"watched": 0, "paused": 0, "expired": 1})
        self.assertEqual(self.stopped, ["owned"])
        self.assertTrue(self.s.stop.is_set())

    def test_live_reports_keep_production_enabled(self):
        self.leases.register(self.s)
        for seq in range(1, 80):
            self.now = 100 + seq * .5
            self.report(sequence=seq)
            self.tick(self.now)
        self.assertFalse(self.s.playback_paused)
        self.assertEqual(self.stopped, [])

    def test_report_resumes_automatic_pause_and_renews_deadline(self):
        self.leases.register(self.s)
        self.tick(104)
        self.report()
        self.assertFalse(self.s.playback_paused)
        self.assertEqual(self.tick(106)["paused"], 0)
        self.assertEqual(self.tick(107)["paused"], 1)
        self.assertEqual(self.tick(118.9)["expired"], 0)
        self.assertEqual(self.tick(119)["expired"], 1)

    def test_intentional_pause_stays_available_without_gpu_clock(self):
        self.leases.register(self.s)
        self.report(paused=True)
        self.assertEqual(self.tick(500)["expired"], 0)
        self.report(sequence=2)
        self.assertEqual(self.tick(502)["paused"], 0)
        self.assertEqual(self.tick(515)["expired"], 1)

    def test_intentional_pause_after_auto_pause_replaces_intent(self):
        self.leases.register(self.s)
        self.tick(103)
        self.report(paused=True)
        self.assertEqual(self.tick(500)["expired"], 0)

    def test_prefetch_gets_fresh_grace_only_when_promoted(self):
        self.s.prefetch = True
        self.s.activation_requested = False
        self.leases.register(self.s)
        self.assertEqual(self.tick(500)["expired"], 0)
        self.assertFalse(self.s.playback_paused)
        self.s.activation_requested = True
        self.tick(500)
        self.assertEqual(self.tick(502)["paused"], 0)
        self.assertEqual(self.tick(503)["paused"], 1)
        self.assertEqual(self.tick(515)["expired"], 1)

    def test_duplicate_wrong_owner_reports_and_registration_do_not_renew(self):
        self.leases.register(self.s)
        self.report(sequence=2)
        self.tick(104)
        self.assertFalse(self.report(sequence=1))
        with self.assertRaisesRegex(ValueError, "owner mismatch"):
            self.report(sequence=3, owner="wrong")
        self.leases.register(self.s)
        self.assertEqual(self.tick(115)["expired"], 1)

    def test_report_at_deadline_wins_if_it_arrives_before_sweep(self):
        self.leases.register(self.s)
        self.now = 115
        self.report()
        self.assertEqual(self.tick(115)["expired"], 0)

    def test_late_report_cannot_resurrect_expired_work(self):
        self.leases.register(self.s)
        self.tick(115)
        with self.assertRaisesRegex(ValueError, "has stopped"):
            self.report()

    def test_teardown_runs_outside_locks_with_stop_already_marked(self):
        self.leases.register(self.s)
        self.now = 115
        observed = []
        def retire(_id):
            def concurrent_reader():
                with self.s.condition:
                    observed.append(self.s.stop.is_set())
            t = threading.Thread(target=concurrent_reader)
            t.start()
            t.join(timeout=1)
            self.assertFalse(t.is_alive())
        self.leases.sweep(retire)
        self.assertEqual(observed, [True])

    def test_concurrently_removed_session_is_harmless(self):
        self.leases.register(self.s)
        self.now = 115
        def removed(_id):
            raise KeyError(_id)
        self.assertEqual(self.leases.sweep(removed)["watched"], 0)

    def test_complete_and_explicitly_stopped_records_are_forgotten(self):
        for attr in ("complete", "stop"):
            self.setUp()
            self.leases.register(self.s)
            if attr == "complete":
                self.s.complete = True
            else:
                self.s.stop.set()
            self.assertEqual(self.tick(120)["watched"], 0)
            self.assertEqual(self.stopped, [])


class LeaseServiceTests(unittest.TestCase):
    def test_only_explicit_external_clock_requests_register(self):
        from test_pong_swap_lifecycle import LifecycleTests, RecordingServiceEngine, make_session
        engine = RecordingServiceEngine()
        service = LifecycleTests._load_service_with_engine(engine)
        session = make_session()
        engine.create_session = mock.Mock(return_value=session)
        service.EXTERNAL_PLAYBACK_LEASES.register = mock.Mock()
        for external in (False, True):
            service.create_session(service.SessionRequest(sourceUrl="https://example.invalid/test.mp4",
                faceId="fixture", externalPlaybackClock=external))
        service.EXTERNAL_PLAYBACK_LEASES.register.assert_called_once_with(session)
        # No changes to engine constructor/config or frozen production math.
        self.assertNotIn("external_playback_clock", engine.create_session.call_args.kwargs)

    def test_stopped_ordered_heartbeat_triggers_existing_gone_recovery(self):
        from test_pong_swap_lifecycle import LifecycleTests, RecordingServiceEngine, make_session
        from fastapi import HTTPException
        engine = RecordingServiceEngine()
        service = LifecycleTests._load_service_with_engine(engine)
        session = make_session(client_epoch="owner")
        session.stop.set()
        engine.session = mock.Mock(return_value=session)
        with self.assertRaises(HTTPException) as raised:
            asyncio.run(service.update_playback(session.id, service.PlaybackUpdateRequest(
                clientEpoch="owner", playbackSequence=1)))
        self.assertEqual(raised.exception.status_code, 410)

    def test_all_three_frontend_creation_paths_bind_external_owner(self):
        html = (Path(__file__).resolve().parents[1] / "index.html").read_text(encoding="utf-8")
        self.assertEqual(html.count("externalPlaybackClock: wrapper?.dataset?.pongExternalPlaybackAuthority === 'true'"), 3)


if __name__ == "__main__":
    unittest.main()
