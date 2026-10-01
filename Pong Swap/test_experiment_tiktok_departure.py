import threading
import time
import unittest
import uuid
from types import SimpleNamespace

from experiment_tiktok_departure import (
    DepartureConflict, DepartureController, diagnostic_create_session, install,
)


def token():
    return str(uuid.uuid4())


class FakeSession:
    def __init__(self, session_id='current', *, channel='pong1', tiktok=True):
        self.id = session_id
        self.channel = channel
        self.config = {'runtime': {
            'tiktokRestorerProfile': 'tiktok-face-size' if tiktok else '',
            'minimumHeadroom': 2.0,
        }}
        self.condition = threading.Condition()
        self.scrub_suspended = threading.Event()
        self.stop = threading.Event()
        self.complete = False
        self.prefetch = False
        self.activation_requested = True
        self.subscribers = 1
        self.playback_started_at = 1.0
        self.fps = 30.0
        self.frames = 10
        self.lead = 0.5


class FakeEngine:
    def __init__(self, *sessions):
        self._sessions_lock = threading.RLock()
        self._sessions = {session.id: session for session in sessions}
        self._active_by_channel = {session.channel: session.id for session in sessions}
        self._config = {'runtime': {'minimumHeadroom': 1.25}}
        self.created = []

    def create_session(self, *args, **kwargs):
        self.created.append((args, kwargs))
        return kwargs

    def _playback_headroom_seconds(self, session, _now):
        return session.lead

    def _foreground_playback_needs_gpu(self, excluded_session_id, *, now=None):
        for session in self._sessions.values():
            if (session.id != excluded_session_id and
                    self._active_by_channel.get(session.channel) == session.id and
                    not session.stop.is_set() and not session.complete and
                    session.subscribers and not session.prefetch and
                    session.activation_requested and session.playback_started_at and
                    session.fps and session.lead < session.config['runtime']['minimumHeadroom']):
                return True
        return False

    def suspend_session(self, session_id):
        session = self._sessions[session_id]
        session.scrub_suspended.set()
        return session

    def resume_session(self, session_id):
        session = self._sessions[session_id]
        session.scrub_suspended.clear()
        return session

    def health(self):
        return {'ready': True}


class FakeApp:
    def __init__(self):
        self.routes = {}
        self.shutdown = []

    def add_api_route(self, path, endpoint, **_kwargs):
        self.routes[path] = endpoint

    def add_event_handler(self, event, callback):
        if event == 'shutdown':
            self.shutdown.append(callback)


class DepartureControllerTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.rows = []
        self.current = FakeSession()
        self.engine = FakeEngine(self.current)
        self.controller = DepartureController(
            self.engine, clock=lambda: self.now, wall_clock=lambda: 1234.0,
            emit=self.rows.append, start_expirer=False,
        )

    def tearDown(self):
        self.controller.close()

    def test_failed_navigation_expires_and_restores(self):
        lease_token = token()
        self.controller.depart('current', lease_token, 3500)
        self.assertTrue(self.current.scrub_suspended.is_set())
        self.assertFalse(self.controller.foreground_needs_gpu('next'))
        self.now += 3.501
        self.assertEqual(self.controller.expire_due(), 1)
        self.assertFalse(self.current.scrub_suspended.is_set())
        self.assertTrue(self.controller.foreground_needs_gpu('next'))
        self.assertEqual([row['kind'] for row in self.rows], ['departure-start', 'departure-expiry'])
        self.assertEqual({row['sessionId'] for row in self.rows}, {'current'})
        self.assertEqual({row['frames'] for row in self.rows}, {10})

    def test_stale_return_does_not_clear_newer_lease(self):
        old, new = token(), token()
        self.controller.depart('current', old)
        self.controller.depart('current', new)
        with self.assertRaises(DepartureConflict):
            self.controller.return_lease('current', old)
        self.assertTrue(self.current.scrub_suspended.is_set())
        self.assertFalse(self.controller.foreground_needs_gpu('next'))
        self.controller.return_lease('current', new)
        self.assertFalse(self.current.scrub_suspended.is_set())

    def test_unrelated_active_stream_remains_protected(self):
        other = FakeSession('other', channel='pong2', tiktok=False)
        self.engine._sessions[other.id] = other
        self.engine._active_by_channel[other.channel] = other.id
        self.controller.depart('current', token())
        self.assertTrue(self.controller.foreground_needs_gpu('next'))
        other.lead = 4.0
        self.assertFalse(self.controller.foreground_needs_gpu('next'))

    def test_reject_non_tiktok_non_active_stopped_and_replaced(self):
        other = FakeSession('other', channel='pong2', tiktok=False)
        self.engine._sessions[other.id] = other
        self.engine._active_by_channel[other.channel] = other.id
        with self.assertRaises(DepartureConflict):
            self.controller.depart('other', token())
        self.engine._active_by_channel['pong1'] = 'replacement'
        with self.assertRaises(DepartureConflict):
            self.controller.depart('current', token())
        self.engine._active_by_channel['pong1'] = 'current'
        self.current.stop.set()
        with self.assertRaises(DepartureConflict):
            self.controller.depart('current', token())

    def test_preexisting_and_new_scrub_are_never_cleared_by_expiry(self):
        self.current.scrub_suspended.set()
        self.controller.depart('current', token(), 25)
        self.now += .026
        self.controller.expire_due()
        self.assertTrue(self.current.scrub_suspended.is_set())
        self.current.scrub_suspended.clear()
        self.now += 1
        self.controller.depart('current', token(), 25)
        self.controller.suspend(self.engine.suspend_session, 'current')
        self.now += .026
        self.controller.expire_due()
        self.assertTrue(self.current.scrub_suspended.is_set())

    def test_scrub_resume_during_lease_waits_for_return(self):
        self.current.scrub_suspended.set()
        lease_token = token()
        self.controller.depart('current', lease_token)
        self.controller.resume(self.engine.resume_session, 'current')
        self.assertTrue(self.current.scrub_suspended.is_set())
        self.controller.return_lease('current', lease_token)
        self.assertFalse(self.current.scrub_suspended.is_set())

    def test_replaced_or_stopped_lease_no_longer_skips_anyone(self):
        self.controller.depart('current', token())
        self.engine._active_by_channel['pong1'] = 'replacement'
        replacement = FakeSession('replacement')
        self.engine._sessions['replacement'] = replacement
        self.assertTrue(self.controller.foreground_needs_gpu('next'))
        self.engine._active_by_channel['pong1'] = 'current'
        self.current.stop.set()
        self.assertFalse(self.controller.foreground_needs_gpu('next'))

    def test_same_id_replacement_never_inherits_old_lease(self):
        self.controller.depart('current', token(), 25)
        replacement = FakeSession('current')
        self.engine._sessions['current'] = replacement
        self.assertTrue(self.controller.foreground_needs_gpu('next'))
        self.now += .026
        self.controller.expire_due()
        self.assertFalse(self.current.scrub_suspended.is_set())
        self.assertFalse(replacement.scrub_suspended.is_set())
        self.assertTrue(self.controller.foreground_needs_gpu('next'))

    def test_lost_suspension_restores_foreground_protection(self):
        self.controller.depart('current', token())
        self.current.scrub_suspended.clear()
        self.assertTrue(self.controller.foreground_needs_gpu('next'))

    def test_real_expirer_is_single_thread_and_needs_no_traffic(self):
        rows = []
        controller = DepartureController(self.engine, emit=rows.append)
        try:
            self.assertIsNotNone(controller.expirer)
            controller.depart('current', token(), 30)
            deadline = time.monotonic() + .5
            while controller.status()['activeLeases'] and time.monotonic() < deadline:
                time.sleep(.005)
            self.assertEqual(controller.status()['activeLeases'], 0)
            self.assertFalse(self.current.scrub_suspended.is_set())
            self.assertEqual(sum(row['kind'] == 'departure-expiry' for row in rows), 1)
        finally:
            controller.close()

    def test_install_is_idempotent_and_health_exposes_trial(self):
        app = FakeApp()
        engine = FakeEngine()
        first = install(engine, app, stage_diagnostics=False)
        self.addCleanup(first.close)
        self.assertIs(install(engine, app), first)
        self.assertEqual(len(app.routes), 2)
        self.assertTrue(engine.health()['departureTrial']['installed'])
        self.assertEqual(engine.health()['departureTrial']['maxLeaseMs'], 4000)
        self.assertFalse(engine.health()['departureTrial']['stageDiagnostics'])

    def test_install_rejects_live_engine(self):
        with self.assertRaisesRegex(RuntimeError, 'cold engine'):
            install(self.engine, FakeApp())

    def test_stage_diagnostics_injects_only_qualified_tiktok_profile(self):
        engine = FakeEngine()
        app = FakeApp()
        controller = install(engine, app, stage_diagnostics=True)
        self.addCleanup(controller.close)
        self.assertTrue(engine.health()['departureTrial']['stageDiagnostics'])
        common = {'source_url': 'unchanged', 'face_id': 'unchanged', 'diagnostics_enabled': False}
        for profile in ('default', 'tiktok-face-size-motion-trial', ''):
            supplied = {**common, 'restoration_profile': profile}
            original = dict(supplied)
            engine.create_session(**supplied)
            self.assertEqual(engine.created[-1], ((), original))
            self.assertEqual(supplied, original)
        supplied = {**common, 'restoration_profile': 'tiktok-face-size'}
        engine.create_session(**supplied)
        self.assertEqual(engine.created[-1][1], {**supplied, 'diagnostics_enabled': True})
        self.assertFalse(supplied['diagnostics_enabled'])
        # The exact service adapter calls its captured method with a default
        # False; this wrapper must still enable the diagnostic-only session.
        engine.create_session(restoration_profile='tiktok-face-size')
        self.assertTrue(engine.created[-1][1]['diagnostics_enabled'])

    def test_diagnostic_helper_preserves_other_inputs(self):
        seen = []
        def original(*args, **kwargs):
            seen.append((args, kwargs))
            return object()
        diagnostics = {'restoration_profile': 'default', 'diagnostics_enabled': True}
        diagnostic_create_session(original, 4, **diagnostics)
        self.assertEqual(seen, [((4,), diagnostics)])


if __name__ == '__main__':
    unittest.main()
