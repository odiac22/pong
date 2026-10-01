from __future__ import annotations

import gc
import queue
import threading
import time
import unittest
import weakref
from types import SimpleNamespace

from pong_swap_engine import PongSwapEngine


def make_worker_only_engine() -> PongSwapEngine:
    engine = PongSwapEngine.__new__(PongSwapEngine)
    engine._gpu_worker_lock = threading.Lock()
    engine._gpu_worker_queue = queue.PriorityQueue()
    engine._gpu_worker_thread = None
    engine._gpu_worker_ident = 0
    engine._gpu_work_sequence = 0
    engine._gpu_worker_inflight = 0
    engine._gpu_worker_active_label = ""
    engine._gpu_worker_active_since = 0.0
    engine._gpu_worker_last_completed_at = 0.0
    engine._gpu_worker_cancelled_before_start = 0
    engine._gpu_worker_closing = False
    return engine


class _Payload:
    pass


class _AdmissionGateQueue(queue.PriorityQueue):
    """Hold the first real publication while allowing a shutdown sentinel."""

    def __init__(self) -> None:
        super().__init__()
        self.publication_entered = threading.Event()
        self.release_publication = threading.Event()
        self._held_once = False

    def put(self, item, block=True, timeout=None):  # noqa: ANN001
        callback = item[2]
        if callback is not None and not self._held_once:
            self._held_once = True
            self.publication_entered.set()
            if not self.release_publication.wait(2.0):
                raise TimeoutError("test did not release GPU publication")
        return super().put(item, block=block, timeout=timeout)


class PersistentGpuWorkerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = make_worker_only_engine()

    def tearDown(self) -> None:
        self.assertTrue(self.engine.shutdown_gpu_worker(timeout=2.0))

    def test_cancelled_queued_work_never_executes(self) -> None:
        occupied = threading.Event()
        release = threading.Event()
        first_result: list[str] = []

        def blocking_work() -> str:
            occupied.set()
            self.assertTrue(release.wait(2.0))
            return "first"

        first = threading.Thread(
            target=lambda: first_result.append(
                self.engine._run_gpu_work(blocking_work, work_label="blocking")
            )
        )
        first.start()
        self.assertTrue(occupied.wait(1.0))

        cancelled = threading.Event()
        cancelled.set()
        executed = threading.Event()
        second_result: list[str] = []
        second = threading.Thread(
            target=lambda: second_result.append(
                self.engine._run_gpu_work(
                    lambda: executed.set() or "executed",
                    queue_cancel_event=cancelled,
                    cancelled_value="cancelled",
                    work_label="cancelled-frame",
                )
            )
        )
        second.start()
        release.set()
        first.join(2.0)
        second.join(2.0)

        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(first_result, ["first"])
        self.assertEqual(second_result, ["cancelled"])
        self.assertFalse(executed.is_set())
        self.assertEqual(self.engine._gpu_worker_cancelled_before_start, 1)

    def test_activation_promotes_waiting_work_without_preempting_an_inflight_frame(self) -> None:
        entered, release = threading.Event(), threading.Event()
        order = []
        stop = threading.Event()
        first = threading.Thread(target=lambda: self.engine._run_gpu_work(
            lambda: entered.set() or release.wait(2.0), work_label="inflight"))
        first.start()
        self.assertTrue(entered.wait(1.0))
        threads = []
        for label, priority, cancel in [("promoted", 10, stop), ("other-foreground", 0, None), ("other-prefetch", 10, threading.Event())]:
            thread = threading.Thread(target=lambda l=label,p=priority,c=cancel:
                self.engine._run_gpu_work(lambda: order.append(l), priority=p, queue_cancel_event=c))
            thread.start(); threads.append(thread)
            deadline = time.monotonic() + 1
            while self.engine._gpu_worker_queue.qsize() < len(threads) and time.monotonic() < deadline:
                time.sleep(.001)
        self.assertEqual(self.engine._promote_queued_session_work(SimpleNamespace(stop=stop)), 1)
        self.assertEqual(self.engine._promote_queued_session_work(SimpleNamespace(stop=stop)), 0)
        self.assertEqual(order, [])
        release.set();first.join(2)
        for thread in threads: thread.join(2);self.assertFalse(thread.is_alive())
        self.assertEqual(order, ["promoted", "other-foreground", "other-prefetch"])

    def test_late_submission_uses_promoted_priority_and_keeps_cancellation(self) -> None:
        entered, release = threading.Event(), threading.Event()
        order = []
        first = threading.Thread(target=lambda: self.engine._run_gpu_work(
            lambda: entered.set() or release.wait(2.0)))
        first.start();self.assertTrue(entered.wait(1))
        stop = threading.Event()
        self.engine._promote_queued_session_work(SimpleNamespace(stop=stop))
        promoted = threading.Thread(target=lambda: self.engine._run_gpu_work(
            lambda: order.append("cancelled"), priority=10, queue_cancel_event=stop))
        promoted.start()
        deadline=time.monotonic()+1
        while self.engine._gpu_worker_queue.qsize()<1 and time.monotonic()<deadline:time.sleep(.001)
        with self.engine._gpu_worker_queue.mutex:
            self.assertEqual(self.engine._gpu_worker_queue.queue[0][0], 0)
        stop.set();release.set();first.join(2);promoted.join(2)
        self.assertFalse(promoted.is_alive());self.assertEqual(order, [])
        del stop;gc.collect()
        self.assertEqual(len(self.engine._gpu_promoted_events), 0)

    def test_nested_gpu_work_executes_inline_on_one_owner_thread(self) -> None:
        owner_threads: list[int] = []

        def outer() -> str:
            owner_threads.append(threading.get_ident())
            return self.engine._run_gpu_work(
                lambda: owner_threads.append(threading.get_ident()) or "nested",
                work_label="nested",
            )

        self.assertEqual(self.engine._run_gpu_work(outer, work_label="outer"), "nested")
        self.assertEqual(len(set(owner_threads)), 1)
        self.assertEqual(owner_threads[0], self.engine._gpu_worker_ident)

    def test_idle_worker_does_not_retain_last_argument_and_can_shutdown(self) -> None:
        payload = _Payload()
        reference = weakref.ref(payload)
        self.assertTrue(
            self.engine._run_gpu_work(
                lambda value: value is payload,
                payload,
                work_label="retention-check",
            )
        )
        del payload
        for _ in range(20):
            gc.collect()
            if reference() is None:
                break
            time.sleep(0.01)

        self.assertIsNone(reference())
        self.assertTrue(self.engine.shutdown_gpu_worker(timeout=2.0))
        self.assertIsNone(self.engine._gpu_worker_thread)
        self.assertEqual(self.engine._gpu_worker_ident, 0)

    def test_shutdown_cannot_overtake_an_admitted_submission(self) -> None:
        gated_queue = _AdmissionGateQueue()
        self.engine._gpu_worker_queue = gated_queue
        outcome: list[str] = []
        submitter = threading.Thread(
            target=lambda: outcome.append(
                self.engine._run_gpu_work(lambda: "completed", work_label="admitted")
            ),
            daemon=True,
        )
        submitter.start()
        self.assertTrue(gated_queue.publication_entered.wait(1.0))

        shutdown_result: list[bool] = []
        shutdown = threading.Thread(
            target=lambda: shutdown_result.append(
                self.engine.shutdown_gpu_worker(timeout=2.0)
            ),
            daemon=True,
        )
        shutdown.start()
        # The submitter owns the admission lock until its work is visible, so
        # shutdown cannot publish the sentinel ahead of it.
        time.sleep(0.05)
        self.assertTrue(shutdown.is_alive())
        gated_queue.release_publication.set()

        submitter.join(2.0)
        shutdown.join(2.0)
        self.assertFalse(submitter.is_alive())
        self.assertFalse(shutdown.is_alive())
        self.assertEqual(outcome, ["completed"])
        self.assertEqual(shutdown_result, [True])


if __name__ == "__main__":
    unittest.main()
