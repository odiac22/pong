"""Exercise producer/source publication races without media, network or GPU."""
from contextlib import nullcontext
import queue
import sys
import threading
import types
import unittest
from unittest import mock

from pong_swap_engine import PongSwapEngine, SwapSession


class SourceOpenCancellationTests(unittest.TestCase):
    def fixture(self, **overrides):
        engine = PongSwapEngine.__new__(PongSwapEngine)
        engine._sessions_lock = threading.RLock()
        engine._active_by_channel = {}
        engine._models = None
        engine._standby_sources = mock.Mock()
        engine._standby_sources.take.return_value = None
        engine._prefetch_source_open_gate = threading.Semaphore(2)
        engine._foreground_embedding_priority = lambda: nullcontext()
        engine._release_prefetch_admission = mock.Mock()
        engine._schedule_spool_cleanup = mock.Mock()
        session = SwapSession(id='source-race', channel='test',
                              source_url='https://example.invalid/fixture.mp4',
                              face_id='approved', start_seconds=0,
                              config={'runtime': {}, 'parameters': {}}, **overrides)
        container = mock.Mock()
        return engine, session, container

    def test_cancel_after_publication_before_queue_consumption_closes_winner_once(self):
        engine, session, container = self.fixture()
        published = threading.Event()
        original_queue = queue.Queue

        class PublishingQueue(original_queue):
            def put_nowait(self, item):
                super().put_nowait(item)
                if isinstance(item, tuple) and item[0] == 'ok':
                    published.set()

        def cancel_during_warm(*args, **kwargs):
            self.assertTrue(published.wait(2), 'opener never published its resource')
            self.assertIs(session.container, container)
            session.stop.set()

        engine._run_gpu_work = cancel_during_warm
        with mock.patch.dict(sys.modules, {'av': types.SimpleNamespace(open=lambda *a, **k: container)}), \
                mock.patch('pong_swap_engine.queue.Queue', PublishingQueue):
            engine._produce_session(session)
        container.close.assert_called_once_with()
        self.assertIsNone(session.container)
        self.assertTrue(session.complete)
        self.assertGreater(session.resources_released_at, 0)

    def test_late_open_after_nonstop_admission_failure_cannot_publish(self):
        engine, session, container = self.fixture(prefetch=True)
        entered = threading.Event()
        release = threading.Event()

        def open_late(*args, **kwargs):
            entered.set()
            if not release.wait(3):
                raise RuntimeError('test opener was not released')
            return container

        def reject_admission(candidate):
            self.assertTrue(entered.wait(2))
            candidate.error_code = 'GPU_HEADROOM'
            return False

        engine._acquire_prefetch_admission = reject_admission
        try:
            with mock.patch.dict(sys.modules, {'av': types.SimpleNamespace(open=open_late)}):
                engine._produce_session(session)
                self.assertFalse(session.stop.is_set())
                self.assertIsNone(session.container)
                opener = session.source_opener
                self.assertTrue(opener.is_alive())
                release.set()
                opener.join(2)
                self.assertFalse(opener.is_alive())
            self.assertIsNone(session.container)
            container.close.assert_called_once_with()
        finally:
            release.set()


if __name__ == '__main__':
    unittest.main()
