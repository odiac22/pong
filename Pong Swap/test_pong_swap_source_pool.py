import threading
import time
import unittest
from pong_swap_source_pool import StandbySourcePool


class Container:
    duration = 10000000
    def __init__(self): self.closed = False
    def close(self): self.closed = True


class SourcePoolTests(unittest.TestCase):
    def wait(self, predicate):
        deadline = time.monotonic() + 2
        while not predicate() and time.monotonic() < deadline:
            time.sleep(.005)
        self.assertTrue(predicate())

    def test_single_owner_and_exact_url(self):
        c = Container()
        pool = StandbySourcePool(lambda _: c)
        pool.warm('https://example.invalid/a?sig=1')
        self.wait(lambda: pool.status()['ready'] == 1)
        self.assertIsNone(pool.take('https://example.invalid/a?sig=2'))
        self.assertIs(pool.take('https://example.invalid/a?sig=1'), c)
        self.assertIsNone(pool.take('https://example.invalid/a?sig=1'))
        pool.clear()
        self.assertFalse(c.closed, 'leased container belongs exclusively to caller')
        c.close()

    def test_inflight_is_bounded_and_take_never_waits(self):
        gate = threading.Event()
        made = []
        def opener(_):
            gate.wait(2)
            c = Container(); made.append(c); return c
        pool = StandbySourcePool(opener, capacity=1)
        self.assertTrue(pool.warm('https://example.invalid/a'))
        self.assertFalse(pool.warm('https://example.invalid/a'))
        self.assertFalse(pool.warm('https://example.invalid/b'))
        before = time.monotonic()
        self.assertIsNone(pool.take('https://example.invalid/a'))
        self.assertLess(time.monotonic()-before, .05)
        pool.clear()
        self.assertFalse(pool.warm('https://example.invalid/b'))
        gate.set()
        self.wait(lambda: pool.status()['opening'] == 0)
        self.assertTrue(made[0].closed)
        self.assertEqual(pool.status()['ready'], 0)

    def test_expiration_closes_only_unleased_container(self):
        c = Container(); pool = StandbySourcePool(lambda _: c, ttl=.04)
        pool.warm('https://example.invalid/a')
        self.wait(lambda: c.closed)
        self.assertIsNone(pool.take('https://example.invalid/a'))

    def test_old_timer_cannot_close_new_lease(self):
        pool = StandbySourcePool(lambda _: Container(), ttl=10)
        url='https://example.invalid/a'
        pool.warm(url); self.wait(lambda: pool.status()['ready'] == 1)
        token=pool._ready[url][2]
        first=pool.take(url)
        pool.warm(url); self.wait(lambda: pool.status()['ready'] == 1)
        pool._expire(url, token)
        second=pool.take(url)
        self.assertIsNotNone(second)
        self.assertFalse(first.closed); self.assertFalse(second.closed)
        first.close(); second.close()

    def test_live_streams_and_local_files_are_not_cached(self):
        live = Container(); live.duration = None
        pool = StandbySourcePool(lambda _: live)
        self.assertFalse(pool.warm('C:/video.mp4'))
        self.assertFalse(pool.warm('file:///video.mp4'))
        self.assertFalse(pool.warm('https://user:password@example.invalid/a'))
        pool.warm('https://example.invalid/live')
        self.wait(lambda: live.closed)
        self.assertEqual(pool.status()['ready'], 0)

    def test_failed_warm_does_not_poison_future_attempts(self):
        def bad(_): raise OSError('network failed')
        pool = StandbySourcePool(bad)
        pool.warm('https://example.invalid/a')
        self.wait(lambda: pool.status()['opening'] == 0)
        pool._opener = lambda _: Container()
        pool.warm('https://example.invalid/a')
        self.wait(lambda: pool.status()['ready'] == 1)
        pool.clear()

    def test_new_video_evicts_old_unused_decoder_not_an_active_lease(self):
        made=[]
        def opener(_):
            c=Container();made.append(c);return c
        pool=StandbySourcePool(opener,capacity=1)
        pool.warm('https://example.invalid/a');self.wait(lambda: pool.status()['ready']==1)
        self.assertTrue(pool.warm('https://example.invalid/b'))
        self.wait(lambda: pool.status()['ready']==1)
        self.assertTrue(made[0].closed)
        leased=pool.take('https://example.invalid/b')
        pool.warm('https://example.invalid/c');self.wait(lambda: pool.status()['ready']==1)
        self.assertFalse(leased.closed)
        pool.clear();leased.close()


if __name__ == '__main__': unittest.main()
