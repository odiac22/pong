"""Synthetic CPU parity, cancellation and ownership tests; no media or GPU."""
from __future__ import annotations

import hashlib
import inspect
from pathlib import Path
import threading
import tempfile
import time
import types
import unittest

import numpy as np

import experiment_tiktok_decode_ahead as trial
from experiment_tiktok_decode_ahead import (
    DecodeAhead, DecodeAheadError, EarlyDecodedContainer, MAX_QUEUED_FRAMES,
    consume_rgb_with_original_cadence,
)


class _Frame:
    def __init__(self, index: int):
        self.index = index
        self.pts = index * 40

    def to_ndarray(self, *, format: str):
        assert format == "rgb24"
        return np.full((4, 5, 3), self.index, dtype=np.uint8)


class ReviewEligibilityTests(unittest.TestCase):
    def test_default_profile_requires_explicit_isolated_review(self):
        self.assertFalse(trial.eligible_for_early_decode(1,0,False,''))
        self.assertTrue(trial.eligible_for_early_decode(1,0,False,'',allow_default=True))
        for count,start,reused in [(2,0,False),(1,1,False),(1,0,True)]:
            self.assertFalse(trial.eligible_for_early_decode(count,start,reused,'',allow_default=True))


class _Container:
    def __init__(self, length: int, *, fail_at: int | None = None,
                 pause: threading.Event | None = None):
        self.length = length
        self.fail_at = fail_at
        self.pause = pause
        self.closed = False
        self.owner = None
        self.close_owner = None
        self.close_count = 0
        self.duration = 2_000_000
        self.seek_index = 0
        self.streams = [
            types.SimpleNamespace(average_rate=25, base_rate=25, duration=500,
                                  time_base=.001,
                                  codec_context=types.SimpleNamespace(width=240, height=320)),
            types.SimpleNamespace(average_rate=25, base_rate=25, duration=500,
                                  time_base=.001,
                                  codec_context=types.SimpleNamespace(width=720, height=1280)),
        ]

    def decode(self, _stream):
        self.owner = threading.get_ident()
        for index in range(self.seek_index, self.length):
            if self.pause is not None:
                self.pause.wait(timeout=2)
            if self.fail_at == index:
                raise ValueError("synthetic decoder failure")
            yield _Frame(index)

    def close(self):
        self.close_owner = threading.get_ident()
        self.closed = True
        self.close_count += 1

    def seek(self, pts, *, stream, backward, any_frame):
        self.seek_index = int(pts / 40)


def _digest(items):
    digest = hashlib.sha256()
    metadata = []
    for rgb, pts in items:
        digest.update(rgb.tobytes())
        metadata.append(pts)
    return digest.hexdigest(), metadata


class DecodeAheadTests(unittest.TestCase):
    def test_crc_pts_order_and_stride_match_serial(self):
        for count, stride, start in ((0, 1, 0.0), (1, 1, 0.0),
                                     (37, 1, 0.0), (37, 2, 0.0),
                                     (37, 3, 0.24)):
            with self.subTest(count=count, stride=stride, start=start):
                serial = _digest(consume_rgb_with_original_cadence(
                    iter(_Frame(i) for i in range(count)), source_fps=25.0,
                    start_seconds=start, frame_stride=stride, time_base=.001,
                ))
                container = _Container(count)
                ahead = DecodeAhead(container, object())
                ahead.start()
                parallel = _digest(consume_rgb_with_original_cadence(
                    ahead.frames(), source_fps=25.0, start_seconds=start,
                    frame_stride=stride, time_base=.001,
                ))
                self.assertEqual(parallel, serial)
                self.assertTrue(ahead.close())
                self.assertTrue(container.closed)
                self.assertEqual(container.owner, container.close_owner)
                self.assertNotEqual(container.owner, threading.get_ident())

    def test_three_frame_bound_and_cancellation_without_cross_thread_close(self):
        container = _Container(100)
        ahead = DecodeAhead(container, object())
        ahead.start()
        deadline = time.monotonic() + 1
        while ahead.queued_count < MAX_QUEUED_FRAMES and time.monotonic() < deadline:
            time.sleep(.005)
        self.assertEqual(ahead.queued_count, MAX_QUEUED_FRAMES)
        self.assertTrue(ahead.close())
        self.assertLessEqual(ahead.decoded_count, MAX_QUEUED_FRAMES)
        self.assertEqual(container.owner, container.close_owner)

    def test_blocking_decode_close_is_bounded_and_worker_remains_owner(self):
        release = threading.Event()
        container = _Container(1, pause=release)
        ahead = DecodeAhead(container, object())
        ahead.start()
        began = time.monotonic()
        self.assertFalse(ahead.close(wait_seconds=.02))
        self.assertLess(time.monotonic() - began, .25)
        self.assertFalse(container.closed)
        release.set()
        self.assertTrue(ahead.close(wait_seconds=.5))
        self.assertEqual(container.owner, container.close_owner)

    def test_decoder_exception_propagates_after_preceding_frames(self):
        ahead = DecodeAhead(_Container(5, fail_at=3), object())
        ahead.start()
        seen = []
        with self.assertRaisesRegex(ValueError, 'synthetic decoder failure'):
            for frame in ahead.frames():
                seen.append(frame.index)
        self.assertEqual(seen, [0, 1, 2])
        self.assertTrue(ahead.close())

    def test_owner_close_failure_is_not_silenced(self):
        container = _Container(1)
        def bad_close():
            container.close_owner = threading.get_ident()
            raise OSError('synthetic close failure')
        container.close = bad_close
        ahead = DecodeAhead(container, object())
        ahead.start()
        seen = []
        with self.assertRaisesRegex(OSError, 'synthetic close failure'):
            for frame in ahead.frames():
                seen.append(frame.index)
        self.assertEqual(seen, [0])
        self.assertTrue(ahead.close())
        self.assertEqual(container.owner, container.close_owner)

    def test_single_start_consumer_and_capacity_guards(self):
        with self.assertRaises(ValueError):
            DecodeAhead(_Container(1), object(), capacity=4)
        ahead = DecodeAhead(_Container(1), object())
        with self.assertRaises(DecodeAheadError):
            list(ahead.frames())
        ahead.start()
        with self.assertRaises(DecodeAheadError):
            ahead.start()
        list(ahead.frames())
        with self.assertRaises(DecodeAheadError):
            list(ahead.frames())
        self.assertTrue(ahead.close())

    def test_early_proxy_keeps_selected_source_metadata_and_exact_frames(self):
        selector = lambda container: max(
            container.streams,
            key=lambda stream: stream.codec_context.width * stream.codec_context.height,
        )
        original = _Container(31)
        original_selected = selector(original)
        expected = _digest(consume_rgb_with_original_cadence(
            original.decode(original_selected), source_fps=25,
            frame_stride=2, time_base=original_selected.time_base,
        ))
        source = _Container(31)
        self.assertTrue(trial.eligible_for_early_decode(1, 0, False, 'tiktok-face-size'))
        wrapped = EarlyDecodedContainer.prepare(source, selector)
        self.assertIsInstance(wrapped, EarlyDecodedContainer)
        self.assertEqual(wrapped.duration, source.duration)
        self.assertEqual((wrapped.stream_metadata.codec_context.width,
                          wrapped.stream_metadata.codec_context.height), (720, 1280))
        wrapped.start()
        actual = _digest(consume_rgb_with_original_cadence(
            wrapped.decode(wrapped.stream_metadata), source_fps=25,
            frame_stride=2, time_base=wrapped.stream_metadata.time_base,
        ))
        self.assertEqual(actual, expected)
        wrapped.close()
        self.assertEqual(source.owner, source.close_owner)
        self.assertFalse(trial.eligible_for_early_decode(2, 0, False, 'tiktok-face-size'))
        self.assertFalse(trial.eligible_for_early_decode(1, 0.2, False, 'tiktok-face-size'))
        self.assertFalse(trial.eligible_for_early_decode(1, 0, True, 'tiktok-face-size'))
        self.assertFalse(trial.eligible_for_early_decode(1, 0, False, ''))

    def test_seek_path_stays_original_and_keeps_pts_stride(self):
        source = _Container(31)
        selected = source.streams[1]
        if trial.eligible_for_early_decode(1, .24, False, 'tiktok-face-size'):
            source = EarlyDecodedContainer.prepare(source, lambda _: selected)
        self.assertIsInstance(source, _Container)
        source.seek(240, stream=selected, backward=True, any_frame=False)
        actual = _digest(consume_rgb_with_original_cadence(
            source.decode(selected), source_fps=25, start_seconds=.24,
            frame_stride=3, time_base=selected.time_base,
        ))
        baseline = _digest(consume_rgb_with_original_cadence(
            iter(_Frame(i) for i in range(6, 31)), source_fps=25,
            start_seconds=.24, frame_stride=3, time_base=.001,
        ))
        self.assertEqual(actual, baseline)

    def test_cancel_before_start_closes_once_and_never_decodes(self):
        source = _Container(10)
        wrapped = EarlyDecodedContainer.prepare(source, lambda c: c.streams[1])
        wrapped.close()
        wrapped.close()
        self.assertEqual(source.close_count, 1)
        self.assertIsNone(source.owner)
        with self.assertRaises(DecodeAheadError):
            wrapped.start()

    def test_start_cancel_race_has_one_native_owner_and_one_close(self):
        for _ in range(30):
            source = _Container(100)
            wrapped = EarlyDecodedContainer.prepare(source, lambda c: c.streams[1])
            barrier = threading.Barrier(3)
            errors = []
            def starter():
                barrier.wait()
                try:
                    wrapped.start()
                except DecodeAheadError:
                    pass  # Cancellation won before ownership transferred.
                except BaseException as exc:
                    errors.append(exc)
            def canceller():
                barrier.wait()
                wrapped.close()
            start_thread = threading.Thread(target=starter)
            cancel_thread = threading.Thread(target=canceller)
            start_thread.start()
            cancel_thread.start()
            barrier.wait()
            start_thread.join(timeout=1)
            cancel_thread.join(timeout=1)
            self.assertFalse(start_thread.is_alive() or cancel_thread.is_alive())
            self.assertFalse(errors)
            self.assertTrue(source.closed)
            self.assertEqual(source.close_count, 1)
            if source.owner is not None:
                self.assertEqual(source.owner, source.close_owner)

    def test_source_guard_rewrites_only_three_qualified_producer_markers(self):
        from pong_swap_engine import PongSwapEngine
        from pong_exact_runtime import frozen_methods
        original = inspect.getsource(frozen_methods._produce_session)
        rewritten = trial.transformed_producer_source(original)
        self.assertEqual(rewritten.count('__pong_trial_early_container.prepare('), 1)
        self.assertEqual(rewritten.count('container.stream_metadata'), 1)
        self.assertIn('for decoded in container.decode(video_stream):', rewritten)
        for qualified_name in ('AsyncReadbackLease', '_account_output_segments',
                               '_drain_abandoned_outputs'):
            self.assertEqual(rewritten.count(qualified_name), original.count(qualified_name))
        with self.assertRaises(DecodeAheadError):
            trial.transformed_producer_source(original + '\n# changed')
        with self.assertRaises(DecodeAheadError):
            trial.transformed_producer_source(inspect.getsource(PongSwapEngine._produce_session))

    def test_real_local_pyav_frames_remain_valid_after_owner_eof(self):
        import av
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / 'synthetic.mp4'
            with av.open(str(source_path), mode='w') as output:
                stream = output.add_stream('mpeg4', rate=25)
                stream.width = 32
                stream.height = 32
                stream.pix_fmt = 'yuv420p'
                for index in range(12):
                    pixels = np.full((32, 32, 3), index * 17, dtype=np.uint8)
                    frame = av.VideoFrame.from_ndarray(pixels, format='rgb24')
                    for packet in stream.encode(frame):
                        output.mux(packet)
                for packet in stream.encode():
                    output.mux(packet)
            with av.open(str(source_path)) as original:
                baseline = _digest((frame.to_ndarray(format='rgb24'), frame.pts)
                                   for frame in original.decode(video=0))
            source = av.open(str(source_path))
            wrapped = EarlyDecodedContainer.prepare(source, lambda c: c.streams.video[0])
            self.assertIsInstance(wrapped, EarlyDecodedContainer)
            wrapped.start()
            # Let the owner reach EOF while the first decoded frames remain in
            # the bounded queue; later ndarray conversion must stay valid.
            actual = _digest((frame.to_ndarray(format='rgb24'), frame.pts)
                             for frame in wrapped.decode(wrapped.stream_metadata))
            wrapped.close()
            self.assertEqual(actual, baseline)

    def test_cold_install_binds_only_instance_and_is_idempotent(self):
        from pong_swap_engine import PongSwapEngine
        from pong_exact_runtime import frozen_methods
        class QualifiedFixture(PongSwapEngine):
            _produce_session = frozen_methods._produce_session
        engine = QualifiedFixture.__new__(QualifiedFixture)
        engine._sessions_lock = threading.RLock()
        engine._sessions = {}
        original = PongSwapEngine._produce_session
        globals_dict = frozen_methods._produce_session.__globals__
        try:
            status = trial.install(engine)
            self.assertTrue(status['active'])
            self.assertEqual(status['maxQueuedFrames'], 3)
            self.assertIs(engine._produce_session.__self__, engine)
            self.assertIs(PongSwapEngine._produce_session, original)
            self.assertIs(trial.install(engine), status)
        finally:
            globals_dict.pop('__pong_trial_early_container', None)
            globals_dict.pop('__pong_trial_early_eligible', None)

    def test_install_rejects_unqualified_baseline_class(self):
        from pong_swap_engine import PongSwapEngine
        engine = PongSwapEngine.__new__(PongSwapEngine)
        engine._sessions_lock = threading.RLock()
        engine._sessions = {}
        with self.assertRaisesRegex(DecodeAheadError, 'source hash changed'):
            trial.install(engine)
        self.assertNotIn('_produce_session', engine.__dict__)


if __name__ == '__main__':
    unittest.main()
