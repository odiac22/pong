"""CPU-only contract and ownership tests for async readback prototype."""

import inspect
import queue
import threading
import unittest
from concurrent.futures import Future
from types import SimpleNamespace

import numpy as np

import experiment_async_readback as experiment


class _FakeEvent:
    def __init__(self):
        self.waits = 0

    def synchronize(self):
        self.waits += 1


class _FakeTimingEvent(_FakeEvent):
    def elapsed_time(self, other):
        return 0.25


class _FakePinned:
    def __init__(self):
        self.array = np.arange(12, dtype=np.uint8).reshape(2, 2, 3)

    def numpy(self):
        return self.array


class AsyncReadbackTests(unittest.TestCase):
    def test_interval_union_excludes_overlap_and_idle_gaps(self):
        end = None
        covered = 0.0
        for start, finish, expected_increment in (
            (0.0, 3.0, 3.0),
            (2.0, 5.0, 2.0),
            (3.0, 4.0, 0.0),
            (7.0, 8.0, 1.0),
        ):
            increment, end = experiment._interval_union_increment(start, finish, end)
            self.assertEqual(increment, expected_increment)
            covered += increment
        self.assertEqual(covered, 6.0)
        with self.assertRaises(ValueError):
            experiment._interval_union_increment(2.0, 1.0, end)

    def test_failed_and_cancelled_outputs_do_not_advance_union(self):
        state = {'lastEnd': None, 'seconds': 0.0}
        self.assertTrue(experiment._account_output_interval(
            state, 0.0, 2.0, emitted=True,
        ))
        frozen = dict(state)
        self.assertFalse(experiment._account_output_interval(
            state, 1.0, 10.0, emitted=False,
        ))
        self.assertEqual(state, frozen)
        self.assertTrue(experiment._account_output_interval(
            state, 3.0, 4.0, emitted=True,
        ))
        self.assertEqual(state['seconds'], 3.0)
        self.assertEqual(state['lastEnd'], 4.0)

    def test_held_passthrough_excludes_queue_residence_and_idle_gap(self):
        state = {'intervals': [], 'seconds': 0.0}
        # Frame 0 renders immediately, waits for acquisition and pacing, then
        # is encoded. Those intervening 19 seconds are not rendering work.
        self.assertTrue(experiment._account_output_segments(
            state, [(0.0, 1.0), (20.0, 20.5)], emitted=True,
        ))
        self.assertEqual(state['seconds'], 1.5)
        self.assertEqual(state['intervals'], [(0.0, 1.0), (20.0, 20.5)])

    def test_out_of_order_backfill_and_overlapping_output_union(self):
        state = {'intervals': [], 'seconds': 0.0}
        # A later frame can finish before the held earlier frame is emitted.
        self.assertTrue(experiment._account_output_segments(
            state, [(4.0, 6.0), (6.0, 6.5)], emitted=True,
        ))
        self.assertTrue(experiment._account_output_segments(
            state, [(0.0, 1.0), (5.0, 5.5), (7.0, 8.0)], emitted=True,
        ))
        self.assertEqual(state['intervals'], [(0.0, 1.0), (4.0, 6.5), (7.0, 8.0)])
        self.assertEqual(state['seconds'], 4.5)

    def test_long_disjoint_run_and_late_out_of_order_merges(self):
        state = {'intervals': [], 'seconds': 0.0}
        for frame in range(10_000):
            self.assertTrue(experiment._account_output_segments(
                state, [(float(frame * 2), float(frame * 2 + 1))],
                emitted=True,
            ))
        self.assertEqual(len(state['intervals']), 10_000)
        self.assertEqual(state['seconds'], 10_000.0)
        # A held frame can bridge already-accounted intervals long after the
        # monotonic output stream has reached its end.
        experiment._account_output_segments(
            state, [(5.0, 8.0), (19_999.0, 20_001.0)], emitted=True,
        )
        self.assertEqual(state['intervals'][2], (4.0, 9.0))
        self.assertEqual(state['intervals'][-1], (19_998.0, 20_001.0))
        self.assertEqual(state['seconds'], 10_004.0)

    def test_failed_and_cancelled_segment_outputs_do_not_count(self):
        state = {'intervals': [], 'seconds': 0.0}
        self.assertFalse(experiment._account_output_segments(
            state, [(0.0, 10.0)], emitted=False,
        ))
        self.assertEqual(state, {'intervals': [], 'seconds': 0.0})
        self.assertTrue(experiment._account_output_segments(
            state, [(10.0, 11.0)], emitted=True,
        ))
        self.assertEqual(state['seconds'], 1.0)

    def test_lease_fences_once_and_returns_owned_slot(self):
        pool = queue.Queue(maxsize=2)
        pinned = _FakePinned()
        ready = _FakeEvent()
        observed = []
        lease = experiment.AsyncReadbackLease(
            pinned, ready, _FakeTimingEvent(), _FakeTimingEvent(),
            object(), pool, 0.5, 1.0, {},
            lambda array, owned: observed.append((array.copy(), owned)),
        )
        self.assertIs(lease.materialize(), pinned.array)
        self.assertIs(lease.materialize(), pinned.array)
        self.assertEqual(observed, [])
        lease.observe()
        lease.observe()
        self.assertEqual(ready.waits, 1)
        self.assertEqual(lease.copy_gpu_ms, 0.25)
        self.assertEqual(lease.gpu_frame_ms, 0.25)
        self.assertEqual(len(observed), 1)
        np.testing.assert_array_equal(observed[0][0], pinned.array)
        self.assertIs(observed[0][1], lease)
        lease.release()
        lease.release()
        self.assertIs(pool.get_nowait(), pinned)
        self.assertTrue(pool.empty())

    def test_cancel_before_final_flush_returns_two_owned_pool_slots(self):
        pool = queue.Queue(maxsize=2)
        leases = []
        for _ in range(2):
            lease = experiment.AsyncReadbackLease(
                _FakePinned(), _FakeEvent(), _FakeTimingEvent(),
                _FakeTimingEvent(), object(), pool, 0.0, 0.0, {},
                lambda *_: self.fail('Abandoned output must not be observed'),
            )
            leases.append(lease)
        records = [{'result': lease} for lease in leases]
        session = SimpleNamespace(stop=threading.Event())
        session.stop.set()
        output_error = Future()
        output_error.set_exception(RuntimeError('encoder cancelled'))
        futures = [output_error]
        feeder_error = queue.Queue(maxsize=1)
        owner = SimpleNamespace()
        self.assertEqual(experiment._drain_abandoned_outputs(
            owner, records, futures, session, feeder_error,
        ), 1)
        self.assertEqual(pool.qsize(), 2)
        self.assertEqual(records, [])
        self.assertEqual(futures, [])
        self.assertTrue(feeder_error.empty())
        self.assertEqual([lease.ready.waits for lease in leases], [1, 1])
        self.assertTrue(all(lease._released for lease in leases))

    def test_output_future_failure_surfaces_for_active_session(self):
        future = Future()
        future.set_exception(RuntimeError('encoder failed'))
        error_queue = queue.Queue(maxsize=1)
        session = SimpleNamespace(stop=threading.Event())
        self.assertEqual(experiment._drain_abandoned_outputs(
            SimpleNamespace(), [], [future], session, error_queue,
        ), 1)
        self.assertEqual(str(error_queue.get_nowait()), 'encoder failed')

    def test_cancel_after_gpu_return_before_output_enqueue_reclaims_slot(self):
        pool = queue.Queue(maxsize=2)
        lease = experiment.AsyncReadbackLease(
            _FakePinned(), _FakeEvent(), _FakeTimingEvent(),
            _FakeTimingEvent(), object(), pool, 0.0, 0.0, {},
        )
        # Mirrors producer finally's synthetic pending record for the lease
        # returned by GPU work just before session.stop becomes set.
        unqueued_lease = lease
        pending_outputs = []
        session = SimpleNamespace(stop=threading.Event())
        session.stop.set()
        if unqueued_lease is not None:
            pending_outputs.append({'result': unqueued_lease})
            unqueued_lease = None
        experiment._drain_abandoned_outputs(
            SimpleNamespace(), pending_outputs, [], session, queue.Queue(),
        )
        self.assertIsNone(unqueued_lease)
        self.assertIs(pool.get_nowait(), lease.pinned)
        self.assertEqual(lease.ready.waits, 1)

    def test_failed_copy_fence_retains_lease_until_safe_retry(self):
        class FailedEvent(_FakeEvent):
            def synchronize(self):
                raise RuntimeError('copy fence failed')

        pool = queue.Queue(maxsize=2)
        lease = experiment.AsyncReadbackLease(
            _FakePinned(), FailedEvent(), _FakeTimingEvent(),
            _FakeTimingEvent(), object(), pool, 0.0, 0.0, {},
        )
        owner = SimpleNamespace()
        session = SimpleNamespace(stop=threading.Event())
        errors = queue.Queue(maxsize=1)
        self.assertEqual(experiment._drain_abandoned_outputs(
            owner, [{'result': lease}], [], session, errors,
        ), 1)
        self.assertEqual(str(errors.get_nowait()), 'copy fence failed')
        self.assertEqual(owner._isolated_async_abandoned_leases, [lease])
        self.assertTrue(pool.empty())
        lease.ready = _FakeEvent()
        lease.release()
        self.assertIs(pool.get_nowait(), lease.pinned)

    def test_install_source_guards_and_ordered_drain(self):
        from pong_swap_engine import PongSwapEngine

        old_process = PongSwapEngine.process_frame
        old_rgb = PongSwapEngine._process_frame_to_rgb
        old_produce = PongSwapEngine._produce_session
        old_shutdown = PongSwapEngine.shutdown_gpu_worker
        try:
            experiment.install()
            source = PongSwapEngine._produce_session._isolated_source
            self.assertEqual(source.count('_isolated_async_session=session'), 2)
            self.assertIn('identity_locked and session.frames > 0', source)
            self.assertEqual(source.count('session.frames += 1'), 1)
            self.assertEqual(source.count('session.transformed_frames += 1'), 1)
            emit_block = source.split('def emit_pending_output(record:', 1)[1].split(
                'def flush_pending_outputs()', 1)[0]
            self.assertNotIn('session.frames +=', emit_block)
            self.assertIn('len(isolated_output_futures) >= 2', source)
            self.assertIn('isolated_output_futures.pop(0).result()', source)
            self.assertIn('original_emit_pending_output(record)', source)
            self.assertIn('lease.release()', source)
            self.assertIn('lease.observe()', source)
            self.assertLess(source.index('original_emit_pending_output(record)'),
                            source.index('lease.observe()'))
            self.assertIn('stats["completionFps"]', source)
            self.assertIn('isolated_output_executor.shutdown(wait=True', source)
            cleanup = source.split('tracking_lookahead.close()', 1)[1].split(
                'isolated_output_executor.shutdown(wait=True', 1)[0]
            self.assertIn('_drain_abandoned_outputs(', cleanup)
            self.assertIn('"frameWorkStartedAt": frame_work_started', source)
            self.assertIn('isolated_output_failed.set()', source)
            self.assertIn('session.encoder_write_seconds > before_write', source)
            self.assertIn('session.frame_work_seconds = isolated_output_union["seconds"]', source)
            self.assertIn('isolated_unqueued_lease = output_frame', source)
            self.assertIn('isolated_unqueued_lease = None\n                    session.frames += 1', source)
            self.assertIn('pending_outputs.append({"result": isolated_unqueued_lease})', source)
            self.assertLess(source.index('isolated_unqueued_lease = output_frame'),
                            source.index('if output_frame is None or session.stop.is_set():'))
            self.assertIn('pinned = pool.get_nowait()', inspect.getsource(experiment.install))
            self.assertNotIn('pool.get(timeout=', inspect.getsource(experiment.install))
            self.assertIn('"frameWorkIntervals": [(', source)
            self.assertIn('record["frameWorkIntervals"].append((started, backfill_finished))', source)
            self.assertIn('[*record["frameWorkIntervals"], (started, finished)]', source)
            self.assertIn('_isolated_async_readback_active',
                          inspect.getsource(experiment.install))
            compile(source, 'isolated-async-producer.py', 'exec')
        finally:
            PongSwapEngine.process_frame = old_process
            PongSwapEngine._process_frame_to_rgb = old_rgb
            PongSwapEngine._produce_session = old_produce
            PongSwapEngine.shutdown_gpu_worker = old_shutdown


if __name__ == '__main__':
    unittest.main()
