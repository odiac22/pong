"""CPU-only checks for the deferred readback ring and ordered writer (no CUDA)."""
import threading
import time
import unittest
import numpy as np
from pong_deferred_readback import PinnedRing, PendingFrame, OrderedFrameWriter


class FakeEvent:
    def __init__(self, delay=0.0):
        self.delay = delay
        self.waited = 0
    def synchronize(self):
        self.waited += 1
        if self.delay:
            time.sleep(self.delay)


class FakeHost:
    def __init__(self, array):
        self.array = array
    def numpy(self):
        return self.array


class FakeTorch:
    uint8 = np.uint8
    def empty(self, n, dtype=None, pin_memory=False):
        return np.zeros(int(n), np.uint8)


class RingTest(unittest.TestCase):
    def test_ring_blocks_when_all_slots_in_flight_and_grows_to_frame_size(self):
        ring = PinnedRing(FakeTorch(), slots=2)
        a = ring.acquire(100); b = ring.acquire(300)
        self.assertEqual(ring.in_flight(), 2)
        with self.assertRaises(Exception):
            ring.acquire(10, timeout=0.05)
        ring.release(a[0])
        c = ring.acquire(500, timeout=0.5)
        self.assertEqual(c[0], a[0])
        self.assertGreaterEqual(len(c[1]), 500)

    def test_pending_frame_composes_cropped_canvas_and_releases_once(self):
        ring = PinnedRing(FakeTorch(), slots=2)
        slot, _ = ring.acquire(4)
        crop = np.full((1, 2, 3), 9, np.uint8)
        base = np.zeros((2, 3, 3), np.uint8)
        pending = PendingFrame(ring, slot, FakeHost(crop), FakeEvent(), None, crop.shape, box=(1, 0, 3, 1), base_frame=base)
        out = pending.wait()
        self.assertEqual(out.shape, (2, 3, 3))
        self.assertTrue((out[0, 1:3] == 9).all()); self.assertTrue((out[1] == 0).all())
        self.assertTrue((base == 0).all())  # base frame untouched
        pending.release(); pending.release()
        self.assertEqual(ring.in_flight(), 0)


class WriterTest(unittest.TestCase):
    def pending(self, ring, value, delay=0.0):
        slot, _ = ring.acquire(3)
        return PendingFrame(ring, slot, FakeHost(np.full((1, 1, 3), value, np.uint8)), FakeEvent(delay), None, (1, 1, 3))

    def test_frames_are_emitted_in_order_and_slots_recycled(self):
        ring = PinnedRing(FakeTorch(), slots=3)
        seen = []
        writer = OrderedFrameWriter(lambda array, record: seen.append((record['i'], int(array[0, 0, 0]))), depth=2)
        for i in range(10):
            writer.submit(self.pending(ring, i, delay=0.002), {'i': i})
        writer.close(wait=True)
        self.assertEqual(seen, [(i, i) for i in range(10)])
        self.assertEqual(ring.in_flight(), 0)
        self.assertEqual(writer.emitted, 10)

    def test_submit_overlaps_with_slow_emit_and_errors_surface(self):
        ring = PinnedRing(FakeTorch(), slots=3)
        def emit(array, record):
            if record['i'] == 2:
                raise RuntimeError('encoder closed')
            time.sleep(0.01)
        writer = OrderedFrameWriter(emit, depth=2)
        started = time.perf_counter()
        writer.submit(self.pending(ring, 0), {'i': 0})
        first = time.perf_counter() - started
        self.assertLess(first, 0.009)  # the producer did not wait for the emit
        writer.submit(self.pending(ring, 1), {'i': 1})
        writer.submit(self.pending(ring, 2), {'i': 2})
        time.sleep(0.1)
        with self.assertRaises(RuntimeError):
            writer.submit(self.pending(ring, 3), {'i': 3})
        writer.close(wait=True)
        self.assertEqual(ring.in_flight(), 0)

    def test_abort_drops_queued_frames_quickly(self):
        ring = PinnedRing(FakeTorch(), slots=3)
        writer = OrderedFrameWriter(lambda a, r: time.sleep(0.05), depth=2)
        for i in range(3):
            writer.submit(self.pending(ring, i), {'i': i})
        started = time.perf_counter()
        writer.abort()
        self.assertLess(time.perf_counter() - started, 1.0)
        time.sleep(0.2)
        self.assertEqual(ring.in_flight(), 0)


if __name__ == '__main__':
    unittest.main()
