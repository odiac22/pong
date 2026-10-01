import threading
import unittest
from pong_activity_warmth import ActivityWarmth


class FakeEngine:
    def __init__(self, ready=False, active=0):
        self.ready, self.sessions, self.calls = ready, active, 0
        self.entered, self.release = threading.Event(), threading.Event()
    def health(self):
        return {'ready': self.ready, 'activeSessions': self.sessions}
    def warm(self):
        self.calls += 1
        self.entered.set()
        self.release.wait(2)
        self.ready = True


class ActivityTests(unittest.TestCase):
    def test_leases_expire_and_clients_do_not_release_each_other(self):
        now = [100.0]
        engine = FakeEngine(ready=True)
        leases = ActivityWarmth(engine, clock=lambda: now[0])
        leases.touch('a', True); leases.touch('b', True)
        leases.touch('a', False)
        self.assertTrue(leases.active())
        now[0] += 91
        self.assertFalse(leases.active())
        self.assertEqual(engine.calls, 0)

    def test_cold_work_is_single_flight_and_not_in_request_thread(self):
        engine = FakeEngine()
        leases = ActivityWarmth(engine)
        leases.touch('a', True)
        self.assertTrue(engine.entered.wait(1))
        for _ in range(30): leases.touch('b', True)
        self.assertEqual(engine.calls, 1)
        engine.release.set()

    def test_foreground_session_prevents_optional_warm(self):
        engine = FakeEngine(active=1)
        leases = ActivityWarmth(engine)
        leases.touch('a', True)
        self.assertFalse(engine.entered.wait(.05))
        self.assertEqual(engine.calls, 0)

    def test_bounded_clients_and_health_does_not_refresh(self):
        now = [100.0]
        leases = ActivityWarmth(FakeEngine(ready=True), clock=lambda: now[0])
        for i in range(100): leases.touch(str(i), True)
        self.assertEqual(leases.snapshot()['clients'], 64)
        now[0] += 91
        self.assertEqual(leases.snapshot()['clients'], 0)


if __name__ == '__main__': unittest.main()
