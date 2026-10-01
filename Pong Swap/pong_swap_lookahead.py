"""Bounded CPU-only optical-flow lookahead; no model or timing-policy changes."""
from concurrent.futures import ThreadPoolExecutor
import cv2
import numpy as np


class TrackingLookahead:
    def __init__(self, track, *, minimum_pixels=1_500_000):
        self._track = track
        self._minimum_pixels = minimum_pixels
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='PongTrackAhead')
        self._pending = None
        self._inflight = None
        self._closed = False
        self.hits = 0

    def prepare(self, state, next_frame):
        if self._closed or not isinstance(next_frame, np.ndarray):
            return
        if next_frame.ndim != 3 or next_frame.shape[0] * next_frame.shape[1] < self._minimum_pixels:
            return  # Small-frame tracking is cheaper without thread contention.
        if self._inflight is not None and not self._inflight.done():
            return  # Never queue an unbounded trail of stale work.
        previous = state.get('gray')
        points = state.get('rawKps', state.get('kps'))
        if not isinstance(previous, np.ndarray) or points is None:
            self._pending = None
            return
        points = np.asarray(points, dtype=np.float32).copy()
        generation = int(state.get('trackGeneration', 0))
        def calculate():
            gray = cv2.cvtColor(next_frame, cv2.COLOR_RGB2GRAY)
            evidence = self._track(previous, gray, points, next_frame.shape, return_evidence=True)
            return gray, evidence
        try:
            future = self._pool.submit(calculate)
        except RuntimeError:
            self._pending = None
            return  # Optional speculation cannot fail the render pipeline.
        self._inflight = future
        self._pending = next_frame, previous, points, generation, future

    def consume(self, frame, state):
        pending, self._pending = self._pending, None
        if pending is None or self._closed:
            return None
        target, previous, points, generation, future = pending
        current_points = state.get('rawKps', state.get('kps'))
        if (target is not frame or state.get('gray') is not previous
                or generation != int(state.get('trackGeneration', 0))
                or current_points is None or not np.array_equal(points, current_points)):
            future.cancel()
            return None
        try:
            result = future.result()
        except Exception:
            return None  # Ordinary current-frame tracking remains authoritative.
        self.hits += 1
        return result

    def close(self):
        self._closed = True
        if self._pending is not None:
            self._pending[-1].cancel()
            self._pending = None
        self._pool.shutdown(wait=True, cancel_futures=True)
