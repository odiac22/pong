from __future__ import annotations

import threading
import time
import unittest
import queue
from copy import deepcopy

from pong_swap_config import default_config
from pong_swap_engine import PongSwapEngine, SwapSession


class EmbeddingPriorityTests(unittest.TestCase):
    @staticmethod
    def _priority_engine() -> PongSwapEngine:
        engine = PongSwapEngine.__new__(PongSwapEngine)
        engine._config_lock = threading.RLock()
        engine._lock = threading.RLock()
        engine._sessions_lock = threading.RLock()
        engine._embedding_prime_lock = threading.Lock()
        engine._embedding_prime_started = False
        engine._embedding_prime_thread = None
        engine._embedding_prime_error = ""
        engine._embedding_priority_condition = threading.Condition()
        engine._foreground_embedding_work = 0
        engine._config = default_config()
        engine._config_revision = 1
        engine._sessions = {}
        engine._active_by_channel = {}
        engine._models = None
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
        engine._embedding_prime_cancel = threading.Event()
        return engine

    def test_all_face_primer_yields_between_identities_then_resumes(self) -> None:
        engine = self._priority_engine()
        engine._faces = {"face-1": object(), "face-2": object(), "face-3": object()}
        first_started = threading.Event()
        release_first = threading.Event()
        second_started = threading.Event()
        calls: list[str] = []

        engine.warm = lambda: {"ok": True}

        def embedding_for_face(face_id: str, _config: dict, **_kwargs) -> object:
            calls.append(face_id)
            if face_id == "face-1":
                first_started.set()
                self.assertTrue(release_first.wait(timeout=1.0))
            elif face_id == "face-2":
                second_started.set()
            return object()

        engine.embedding_for_face = embedding_for_face
        engine.prime_embeddings_async()
        self.assertTrue(first_started.wait(timeout=1.0))

        priority = engine._foreground_embedding_priority()
        priority.__enter__()
        try:
            release_first.set()
            # The primer may finish the identity already in flight, but it must
            # not begin another while live selected-session work is pending.
            self.assertFalse(second_started.wait(timeout=0.15))
            self.assertEqual(calls, ["face-1"])
        finally:
            priority.__exit__(None, None, None)

        primer = engine._embedding_prime_thread
        self.assertIsNotNone(primer)
        primer.join(timeout=1.0)
        self.assertFalse(primer.is_alive())
        self.assertEqual(calls, ["face-1", "face-2", "face-3"])

    def test_overlapping_foreground_reservations_do_not_clear_each_other(self) -> None:
        engine = self._priority_engine()

        first = engine._foreground_embedding_priority()
        second = engine._foreground_embedding_priority()
        first.__enter__()
        second.__enter__()
        self.assertEqual(engine._foreground_embedding_work, 2)

        first.__exit__(None, None, None)
        self.assertEqual(engine._foreground_embedding_work, 1)
        second.__exit__(None, None, None)
        self.assertEqual(engine._foreground_embedding_work, 0)

    def test_primer_waits_until_live_playback_sessions_are_retired(self) -> None:
        engine = self._priority_engine()
        session = SwapSession(
            id="b" * 32,
            channel="test",
            source_url="https://example.invalid/video.mp4",
            face_id="chosen-face",
            start_seconds=0.0,
            config=deepcopy(default_config()),
            config_revision=1,
        )
        engine._sessions = {session.id: session}
        released = threading.Event()

        waiter = threading.Thread(
            target=lambda: (engine._wait_for_embedding_prime_turn(), released.set()),
            daemon=True,
        )
        waiter.start()
        self.assertFalse(released.wait(timeout=0.15))

        session.stop.set()
        with engine._embedding_priority_condition:
            engine._embedding_priority_condition.notify_all()
        self.assertTrue(released.wait(timeout=1.0))
        waiter.join(timeout=1.0)

    def test_session_producer_prioritizes_selected_embedding_and_releases_gate(self) -> None:
        engine = self._priority_engine()
        engine._interrupt_session_resources = lambda _session: None
        engine._schedule_spool_cleanup = lambda _session, delay: None
        engine.warm = lambda *args, **kwargs: self.assertGreater(engine._foreground_embedding_work, 0)

        def selected_embedding(face_id: str, _config: dict, **_kwargs) -> object:
            self.assertEqual(face_id, "chosen-face")
            self.assertGreater(engine._foreground_embedding_work, 0)
            # Stop before opening any network/video resource; _produce_session
            # should still unwind the priority reservation in its finally path.
            raise RuntimeError("test stop after selected embedding")

        engine.embedding_for_face = selected_embedding
        config = deepcopy(default_config())
        session = SwapSession(
            id="a" * 32,
            channel="test",
            source_url="https://example.invalid/video.mp4",
            face_id="chosen-face",
            start_seconds=0.0,
            config=config,
            config_revision=1,
        )
        engine._sessions = {session.id: session}
        engine._active_by_channel = {session.channel: session.id}

        engine._produce_session(session)

        self.assertEqual(engine._foreground_embedding_work, 0)
        self.assertEqual(session.state, "error")
        self.assertIn("test stop after selected embedding", session.error)


if __name__ == "__main__":
    unittest.main()
