from __future__ import annotations

import asyncio
import base64
from contextlib import nullcontext
import importlib.util
import inspect
from io import BytesIO
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

from pong_swap_engine import (ApprovedFace, PongSwapEngine, SwapSession,
                             FrameEvidence, build_temporal_restorer_context)


def make_session(**overrides):
    values = {
        "id": "a" * 32,
        "channel": "test",
        "source_url": "https://example.invalid/video.mp4",
        "face_id": "test-face",
        "start_seconds": 0.0,
    }
    values.update(overrides)
    return SwapSession(**values)


class FakePipe:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


class FakeContainer:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


class StubbornProcess:
    """A process that requires the terminate -> kill fallback."""

    def __init__(self) -> None:
        self.stdin = FakePipe()
        self.stdout = FakePipe()
        self.stderr = FakePipe()
        self.returncode = None
        self.terminated = False
        self.killed = False

    def poll(self):
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9

    def wait(self, timeout=None):
        if self.returncode is None:
            raise subprocess.TimeoutExpired("fake-ffmpeg", timeout)
        return self.returncode


class FakeModels:
    def __init__(self) -> None:
        self.deleted = False

    def delete_models(self) -> None:
        self.deleted = True


class FaceLookupTests(unittest.TestCase):
    def test_current_content_addressed_face_does_not_rescan_inventory(self) -> None:
        engine = PongSwapEngine.__new__(PongSwapEngine)
        approved = ApprovedFace(
            id="test-face-content-digest",
            name="Test Face",
            files=(Path("approved.jpg"),),
        )
        engine._faces = {approved.id: approved}
        engine.scan_faces = mock.Mock(side_effect=AssertionError("unexpected rescan"))

        self.assertIs(engine.face(approved.id), approved)
        engine.scan_faces.assert_not_called()

    def test_unknown_face_refreshes_inventory_once(self) -> None:
        engine = PongSwapEngine.__new__(PongSwapEngine)
        approved = ApprovedFace(
            id="new-face-content-digest",
            name="New Face",
            files=(Path("new.jpg"),),
        )
        engine._faces = {}

        def refresh() -> list[ApprovedFace]:
            engine._faces = {approved.id: approved}
            return [approved]

        engine.scan_faces = mock.Mock(side_effect=refresh)

        self.assertIs(engine.face(approved.id), approved)
        engine.scan_faces.assert_called_once_with()

    def test_disk_backed_face_routes_run_in_fastapi_worker_pool(self) -> None:
        service_path = Path(__file__).with_name("pong_swap_service.py")
        source = service_path.read_text(encoding="utf-8")

        self.assertIn("def faces() -> dict[str, Any]:", source)
        self.assertIn("def face_thumbnail(face_id: str):", source)
        self.assertNotIn("async def faces() -> dict[str, Any]:", source)
        self.assertNotIn("async def face_thumbnail(face_id: str):", source)
        self.assertIn("def health() -> dict[str, Any]:", source)
        self.assertNotIn("async def health() -> dict[str, Any]:", source)


class RecordingServiceEngine:
    """Small service double that keeps route tests away from the live engine."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, bool, bool, bool]] = []
        self.activate_calls: list[str] = []
        self.activate_options: list[dict[str, object]] = []
        self.stop_calls: list[tuple[str, bool]] = []
        self.first_frame_calls: list[tuple[str, float]] = []
        self.config = {"runtime": {"idleUnloadSeconds": 900}}
        # The service now constructs its real remote-session manager at import.
        # Match the engine's lock order and residency hook so route tests retain
        # coverage of that construction without loading a live GPU engine.
        self._config_lock = threading.RLock()
        self._sessions_lock = threading.RLock()
        self._session_restorers = lambda _config: ()

    def cleanup_orphan_spools(self) -> int:
        return 0

    def session(self, session_id: str) -> object:
        return object()

    def stop_session(self, session_id: str, *, deferred: bool = False):
        self.stop_calls.append((session_id, deferred))
        return types.SimpleNamespace(public=lambda: {"id": session_id})

    def activate_session(self, session_id: str, **_kwargs):
        self.activate_calls.append(session_id)
        self.activate_options.append(dict(_kwargs))
        return types.SimpleNamespace(public=lambda: {"id": session_id})

    def session_first_frame_webp(self, session_id: str, *, wait_seconds: float = 0.0):
        self.first_frame_calls.append((session_id, wait_seconds))
        return b"RIFF-lossless-webp", True

    def stream_session(
        self,
        session_id: str,
        request_range: str = "",
        *,
        activate: bool = True,
        finite_preload: bool = False,
        media_source: bool = False,
    ):
        self.calls.append((session_id, request_range, activate, finite_preload, media_source))
        return iter((b"test-fragment",))


class LifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = PongSwapEngine.__new__(PongSwapEngine)
        self.engine._sessions_lock = threading.RLock()

    def test_session_public_exposes_original_source_duration(self) -> None:
        session = make_session(source_duration=80.24)
        self.assertEqual(session.public()["duration"], 80.24)

    def test_seek_session_exposes_lossless_first_rendered_frame(self) -> None:
        session = make_session(
            first_rendered_frame_webp=b"RIFF-lossless-webp",
            first_rendered_frame_ready_at=123.5,
            first_rendered_frame_transformed=True,
        )
        self.engine._sessions = {session.id: session}

        self.assertEqual(
            self.engine.session_first_frame_webp(session.id, wait_seconds=0.01),
            (b"RIFF-lossless-webp", True),
        )
        self.assertTrue(session.public()["firstRenderedFrameReady"])
        self.assertEqual(session.public()["firstRenderedFrameReadyAt"], 123.5)

    def test_terminal_preload_is_prepared_at_attainable_frame_target(self) -> None:
        session = make_session(
            source_duration=6.041667,
            start_seconds=5.04,
            prefetch=True,
            prebuffer_seconds=1.0,
            media_fragment_ready=True,
            fps=24.0,
            frames=24,
            fragment_frame_target=24,
            complete_fragments=1,
        )

        self.assertEqual(session.prepared_frame_target(), 24)
        self.assertTrue(session.public()["prepared"])

    def test_finalized_fragment_is_prepared_when_duration_rounding_loses_a_frame(self) -> None:
        session = make_session(
            prefetch=True,
            prebuffer_seconds=1.0,
            media_fragment_ready=True,
            fps=24.0,
            frames=23,
            complete=True,
        )

        self.assertTrue(session.public()["prepared"])

    def test_incomplete_long_stream_does_not_bypass_prebuffer_safety(self) -> None:
        session = make_session(
            prefetch=True,
            prebuffer_seconds=1.25,
            media_fragment_ready=True,
            fps=24.0,
            frames=29,
            complete=False,
        )

        self.assertEqual(session.prepared_frame_target(), 30)
        self.assertFalse(session.public()["prepared"])

    def test_submitted_frames_are_not_ready_until_complete_media_is_muxed(self) -> None:
        session = make_session(
            prefetch=True,
            prebuffer_seconds=2.0,
            media_fragment_ready=True,
            fps=25.0,
            frames=60,
            fragment_frame_target=25,
            complete_fragments=1,
            complete=False,
        )

        self.assertFalse(session.public()["prepared"])
        session.complete_fragments = 2
        self.assertTrue(session.public()["prepared"])

    def test_prefetch_producer_keeps_feeding_until_muxed_lead_is_safe(self) -> None:
        session = make_session(
            prefetch=True,
            prebuffer_seconds=2.0,
            media_fragment_ready=True,
            fps=24.0,
            frames=48,
            fragment_frame_target=24,
            complete_fragments=1,
            complete=False,
        )

        self.assertFalse(PongSwapEngine._prefetch_has_safe_lead(session))
        session.frames = 60
        session.complete_fragments = 2
        self.assertTrue(PongSwapEngine._prefetch_has_safe_lead(session))

    def _make_spooled_prefetch(
        self,
        temp_dir: str,
        payload: bytes = b"warm-fragment",
    ) -> SwapSession:
        session = make_session(prefetch=True, prebuffer_seconds=1.0)
        session.spool_path = Path(temp_dir) / f"{session.id}.mp4"
        session.spool_path.write_bytes(payload)
        session.bytes_written = len(payload)
        session.media_fragment_ready = True
        session.fps = 1.0
        session.frames = 1
        session.fragment_frame_target = 1
        session.complete_fragments = 1
        self.engine._sessions = {session.id: session}
        self.engine._active_by_channel = {}
        # These tests exercise reader lifetime only; no model, decoder, encoder,
        # network request, or GPU-backed producer should be started.
        self.engine._ensure_session_producer = lambda candidate: None
        return session

    @staticmethod
    def _load_service_with_engine(engine: RecordingServiceEngine):
        """Load only the route wiring with inert config/engine dependencies."""
        service_path = Path(__file__).with_name("pong_swap_service.py")
        module_name = f"_pong_swap_service_test_{id(engine)}"
        spec = importlib.util.spec_from_file_location(module_name, service_path)
        if spec is None or spec.loader is None:
            raise RuntimeError("could not load pong_swap_service.py")
        service = importlib.util.module_from_spec(spec)

        engine_module = types.ModuleType("pong_swap_engine")
        engine_module.ENGINE = engine
        # The remote routes share these pure data/context primitives. Keep the
        # real types while replacing only the live engine in route-wiring tests.
        engine_module.FrameEvidence = FrameEvidence
        engine_module.build_temporal_restorer_context = build_temporal_restorer_context
        engine_module.ConfigUpdateConflict = type("ConfigUpdateConflict", (RuntimeError,), {})
        engine_module.StaleActivationError = type("StaleActivationError", (RuntimeError,), {})
        config_module = types.ModuleType("pong_swap_config")
        config_module.ROOT = service_path.parent
        config_module.default_config = lambda: {"runtime": {}, "parameters": {}}
        config_module.parameter_schema = lambda: []

        # Suppress the service's idle-unload daemon. The handler itself remains
        # the real implementation, backed by the recording engine above.
        with mock.patch.dict(
            sys.modules,
            {
                module_name: service,
                "pong_swap_engine": engine_module,
                "pong_swap_config": config_module,
            },
        ), mock.patch.object(threading, "Thread"):
            spec.loader.exec_module(service)
        return service

    def test_held_stream_stays_subscribed_and_continues_after_activation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            session = self._make_spooled_prefetch(temp_dir)
            stream = self.engine.stream_session(
                session.id,
                "bytes=0-",
                activate=False,
                finite_preload=False,
            )
            self.addCleanup(stream.close)

            self.assertEqual(next(stream), b"warm-fragment")
            self.assertEqual(session.subscribers, 1)
            self.assertEqual(session.stream_requests, 1)
            self.assertFalse(session.activation_requested)

            continuation: list[bytes] = []
            read_errors: list[BaseException] = []

            def read_after_catch_up() -> None:
                try:
                    continuation.append(next(stream))
                except BaseException as exc:  # surfaced by the assertions below
                    read_errors.append(exc)

            reader = threading.Thread(target=read_after_catch_up, daemon=True)
            reader.start()
            # A finite preload would retire after 0.25 seconds at the current
            # watermark. A held attachment must remain subscribed instead.
            time.sleep(0.4)
            self.assertTrue(reader.is_alive())
            self.assertEqual(session.subscribers, 1)

            self.engine.activate_session(session.id)
            with session.spool_path.open("ab") as spool:
                spool.write(b"-continued")
            with session.condition:
                session.bytes_written += len(b"-continued")
                session.condition.notify_all()

            reader.join(timeout=1.0)
            self.assertFalse(reader.is_alive())
            self.assertEqual(read_errors, [])
            self.assertEqual(continuation, [b"-continued"])
            self.assertTrue(session.activation_requested)
            self.assertFalse(session.prefetch)
            self.assertEqual(session.stream_requests, 1)
            self.assertEqual(session.subscribers, 1)

            with session.condition:
                session.complete = True
                session.condition.notify_all()
            with self.assertRaises(StopIteration):
                next(stream)
            self.assertEqual(session.subscribers, 0)

    def test_replacement_activation_does_not_wait_for_prior_native_teardown(self) -> None:
        prior = make_session(id="1" * 32, state="streaming")
        replacement = make_session(id="2" * 32, prefetch=True)
        self.engine._sessions = {prior.id: prior, replacement.id: replacement}
        self.engine._active_by_channel = {prior.channel: prior.id}
        self.engine._ensure_session_producer = mock.Mock()
        interrupt_entered = threading.Event()
        allow_interrupt = threading.Event()
        interrupt_finished = threading.Event()

        def slow_interrupt(session: SwapSession) -> None:
            self.assertIs(session, prior)
            interrupt_entered.set()
            allow_interrupt.wait(timeout=2.0)
            interrupt_finished.set()

        self.engine._interrupt_session_resources = slow_interrupt
        started = time.monotonic()
        try:
            activated = self.engine.activate_session(replacement.id)
            elapsed = time.monotonic() - started

            self.assertIs(activated, replacement)
            self.assertLess(elapsed, 0.10)
            self.assertTrue(prior.stop.is_set())
            self.assertTrue(prior.delete_requested)
            self.assertTrue(prior.interrupt_requested)
            self.assertEqual(prior.state, "stopping")
            self.assertEqual(self.engine._active_by_channel[prior.channel], replacement.id)
            self.assertTrue(replacement.activation_requested)
            self.assertFalse(replacement.prefetch)
            self.assertGreater(replacement.playback_started_at, 0)
            self.assertTrue(interrupt_entered.wait(timeout=0.5))
            self.assertFalse(interrupt_finished.is_set())
            self.engine._ensure_session_producer.assert_called_once_with(replacement)
        finally:
            allow_interrupt.set()
        self.assertTrue(interrupt_finished.wait(timeout=1.0))
        deadline = time.monotonic() + 1.0
        while prior.id in self.engine._sessions and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertNotIn(prior.id, self.engine._sessions)
        self.assertEqual(self.engine._active_by_channel[replacement.channel], replacement.id)

    def test_promotion_preserves_distinct_future_card_prefetch(self) -> None:
        prior = make_session(id="1" * 32, state="streaming")
        replacement = make_session(
            id="2" * 32,
            source_url="https://example.invalid/current.mp4",
            prefetch=True,
        )
        future = make_session(
            id="3" * 32,
            source_url="https://example.invalid/future.mp4",
            prefetch=True,
        )
        for session in (prior, replacement, future):
            session.client_epoch = "browser-epoch"
        self.engine._sessions = {
            prior.id: prior,
            replacement.id: replacement,
            future.id: future,
        }
        self.engine._active_by_channel = {prior.channel: prior.id}
        self.engine._activation_by_client_channel = {}
        self.engine._request_session_stop_async = mock.Mock()
        self.engine._ensure_session_producer = mock.Mock()

        self.engine.activate_session(
            replacement.id,
            client_epoch="browser-epoch",
            activation_sequence=2,
        )

        self.engine._request_session_stop_async.assert_called_once_with(prior, delete=True)
        self.assertIn(future.id, self.engine._sessions)
        self.assertFalse(future.stop.is_set())
        self.assertTrue(future.prefetch)
        self.assertEqual(self.engine._active_by_channel[replacement.channel], replacement.id)

    def test_repeated_async_stop_does_not_duplicate_native_interruption(self) -> None:
        session = make_session(state="streaming")
        self.engine._sessions = {session.id: session}
        self.engine._active_by_channel = {session.channel: session.id}
        interrupted = threading.Event()
        calls = []

        def record_interrupt(candidate: SwapSession) -> None:
            calls.append(candidate.id)
            interrupted.set()

        self.engine._interrupt_session_resources = record_interrupt
        self.engine._request_session_stop_async(session, delete=True)
        self.engine._request_session_stop_async(session, delete=True)

        self.assertTrue(interrupted.wait(timeout=0.5))
        self.assertEqual(calls, [session.id])
        self.assertTrue(session.stop.is_set())
        self.assertTrue(session.delete_requested)

    def test_promotion_releases_owned_prefetch_admission_immediately(self) -> None:
        session = make_session(prefetch=True, prefetch_gate_owned=True)
        self.engine._sessions = {session.id: session}
        self.engine._active_by_channel = {}
        self.engine._prefetch_gate = threading.BoundedSemaphore(1)
        self.assertTrue(self.engine._prefetch_gate.acquire(blocking=False))
        self.engine._ensure_session_producer = mock.Mock()

        self.engine.activate_session(session.id)

        self.assertFalse(session.prefetch_gate_owned)
        self.assertFalse(session.prefetch)
        self.assertTrue(self.engine._prefetch_gate.acquire(blocking=False))
        self.engine._prefetch_gate.release()

    def test_browser_playback_feedback_holds_position_while_paused(self) -> None:
        session = make_session(
            fps=30.0,
            frames=180,
            fragment_frame_target=15,
            complete_fragments=12,
            playback_started_at=100.0,
            playback_position_seconds=2.0,
            playback_position_updated_at=110.0,
            playback_paused=True,
        )

        self.assertEqual(
            PongSwapEngine._estimated_playback_position_seconds(session, 114.0),
            2.0,
        )
        session.playback_paused = False
        self.assertEqual(
            PongSwapEngine._estimated_playback_position_seconds(session, 114.0),
            6.0,
        )
        self.assertEqual(PongSwapEngine._playback_headroom_seconds(session, 114.0), 0.0)

    def test_finite_preload_disconnects_after_reaching_prepared_watermark(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            session = self._make_spooled_prefetch(temp_dir)
            stream = self.engine.stream_session(
                session.id,
                activate=False,
                finite_preload=True,
            )

            self.assertEqual(next(stream), b"warm-fragment")
            self.assertEqual(session.subscribers, 1)
            with mock.patch(
                "pong_swap_engine.time.monotonic",
                side_effect=(10.0, 10.3),
            ):
                with self.assertRaises(StopIteration):
                    next(stream)

            self.assertEqual(session.subscribers, 0)
            self.assertEqual(session.stream_requests, 1)
            self.assertFalse(session.activation_requested)
            self.assertTrue(session.prefetch)

    def test_closing_held_stream_allows_delete_cleanup_to_retire_session(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            session = self._make_spooled_prefetch(temp_dir)
            stream = self.engine.stream_session(
                session.id,
                activate=False,
                finite_preload=False,
            )
            self.assertEqual(next(stream), b"warm-fragment")
            self.assertEqual(session.subscribers, 1)

            self.engine.stop_session(session.id)
            self.assertIn(session.id, self.engine._sessions)
            stream.close()

            deadline = time.monotonic() + 1.5
            while session.id in self.engine._sessions and time.monotonic() < deadline:
                time.sleep(0.01)

            self.assertEqual(session.subscribers, 0)
            self.assertNotIn(session.id, self.engine._sessions)
            self.assertFalse(session.spool_path.exists())

    def test_service_decouples_held_attachment_from_finite_preload(self) -> None:
        from starlette.requests import Request

        engine = RecordingServiceEngine()
        service = self._load_service_with_engine(engine)
        cases = (
            (b"attach=1", False, False, False, {}),
            (b"attach=1&transport=mse", False, False, True, {}),
            (b"preload=1", False, True, False, {}),
            (
                b"clientEpoch=epoch-7&activationSequence=7",
                True,
                False,
                False,
                {"client_epoch": "epoch-7", "activation_sequence": 7},
            ),
        )
        for query_string, expected_pre_activate, expected_finite, expected_mse, expected_options in cases:
            with self.subTest(query_string=query_string):
                engine.calls.clear()
                engine.activate_calls.clear()
                engine.activate_options.clear()
                request = Request(
                    {
                        "type": "http",
                        "method": "GET",
                        "path": "/pong-swap/sessions/test/stream",
                        "headers": [(b"range", b"bytes=0-")],
                        "query_string": query_string,
                    }
                )

                asyncio.run(service.stream_session("test", request))

                self.assertEqual(
                    engine.calls,
                    [("test", "bytes=0-", False, expected_finite, expected_mse)],
                )
                self.assertEqual(
                    engine.activate_calls,
                    ["test"] if expected_pre_activate else [],
                )
                self.assertEqual(
                    engine.activate_options,
                    [expected_options] if expected_pre_activate else [],
                )

    def test_session_creation_handler_uses_fastapi_worker_pool(self) -> None:
        engine = RecordingServiceEngine()
        service = self._load_service_with_engine(engine)

        # A synchronous FastAPI route is run in the app's worker pool.  Keeping
        # this handler non-coroutine prevents a brief model-lock wait from
        # blocking health/status/stream traffic on the main ASGI event loop.
        self.assertFalse(inspect.iscoroutinefunction(service.create_session))

    def test_exact_timeline_seek_frame_route_returns_webp_from_worker_pool(self) -> None:
        engine = RecordingServiceEngine()
        service = self._load_service_with_engine(engine)

        self.assertFalse(inspect.iscoroutinefunction(service.session_first_frame))
        response = service.session_first_frame("seek-session", waitMs=2750)

        self.assertEqual(engine.first_frame_calls, [("seek-session", 2.75)])
        self.assertEqual(response.media_type, "image/webp")
        self.assertEqual(response.body, b"RIFF-lossless-webp")
        self.assertEqual(response.headers["x-pong-swap-frame-timeline"], "exact")
        self.assertEqual(response.headers["x-pong-swap-preview-quality"], "100")
        self.assertEqual(response.headers["x-pong-swap-transformed"], "1")

    def test_session_stop_handler_uses_worker_pool_and_forwards_defer(self) -> None:
        engine = RecordingServiceEngine()
        service = self._load_service_with_engine(engine)

        self.assertFalse(inspect.iscoroutinefunction(service.stop_session))
        response = service.stop_session("old-session", defer=True)

        self.assertEqual(engine.stop_calls, [("old-session", True)])
        self.assertEqual(response["session"]["id"], "old-session")

    def test_direct_foreground_replacement_defers_prior_native_teardown(self) -> None:
        prior = make_session(id="3" * 32, state="streaming")
        self.engine._config_lock = threading.RLock()
        self.engine._lock = threading.RLock()
        self.engine._sessions = {prior.id: prior}
        self.engine._active_by_channel = {prior.channel: prior.id}
        self.engine._config = {"runtime": {"minimumHeadroom": 1.0}}
        self.engine._config_revision = 7
        self.engine._foreground_embedding_priority = lambda: nullcontext()
        self.engine.face = mock.Mock(return_value=object())
        self.engine._request_session_stop_async = mock.Mock()
        self.engine._ensure_session_producer = mock.Mock()

        replacement = self.engine.create_session(
            channel=prior.channel,
            source_url="https://example.invalid/replacement.mp4",
            face_id="test-face",
            start_seconds=0,
            prefetch=False,
        )

        self.engine._request_session_stop_async.assert_called_once_with(prior, delete=True)
        self.assertEqual(self.engine._active_by_channel[prior.channel], replacement.id)
        self.assertFalse(replacement.prefetch)
        self.assertTrue(replacement.activation_requested)

    def test_distinct_next_card_prefetches_share_one_channel(self) -> None:
        first = make_session(
            id="1" * 32,
            source_url="https://example.invalid/next-1.mp4",
            candidate_face_ids=("test-face",),
            prefetch=True,
        )
        self.engine._config_lock = threading.RLock()
        self.engine._lock = threading.RLock()
        self.engine._sessions = {first.id: first}
        self.engine._active_by_channel = {}
        self.engine._config = {"runtime": {"minimumHeadroom": 1.0}}
        self.engine._config_revision = 7
        self.engine._foreground_embedding_priority = lambda: nullcontext()
        self.engine.face = mock.Mock(return_value=object())
        self.engine._request_session_stop_async = mock.Mock()
        self.engine._ensure_session_producer = mock.Mock()

        second = self.engine.create_session(
            channel=first.channel,
            source_url="https://example.invalid/next-2.mp4",
            face_id="test-face",
            start_seconds=0,
            prefetch=True,
        )

        self.engine._request_session_stop_async.assert_not_called()
        self.assertIn(first.id, self.engine._sessions)
        self.assertIn(second.id, self.engine._sessions)

    def test_duplicate_next_card_prefetch_replaces_only_matching_target(self) -> None:
        duplicate = make_session(
            id="1" * 32,
            source_url="https://example.invalid/next-1.mp4",
            candidate_face_ids=("test-face",),
            prefetch=True,
        )
        other = make_session(
            id="2" * 32,
            source_url="https://example.invalid/next-2.mp4",
            candidate_face_ids=("test-face",),
            prefetch=True,
        )
        self.engine._config_lock = threading.RLock()
        self.engine._lock = threading.RLock()
        self.engine._sessions = {duplicate.id: duplicate, other.id: other}
        self.engine._active_by_channel = {}
        self.engine._config = {"runtime": {"minimumHeadroom": 1.0}}
        self.engine._config_revision = 7
        self.engine._foreground_embedding_priority = lambda: nullcontext()
        self.engine.face = mock.Mock(return_value=object())
        self.engine._request_session_stop_async = mock.Mock()
        self.engine._ensure_session_producer = mock.Mock()

        self.engine.create_session(
            channel=duplicate.channel,
            source_url=duplicate.source_url,
            face_id="test-face",
            start_seconds=0,
            prefetch=True,
        )

        self.engine._request_session_stop_async.assert_called_once_with(
            duplicate,
            delete=True,
        )

    def test_session_registration_does_not_wait_for_gpu_inference_lock(self) -> None:
        self.engine._config_lock = threading.RLock()
        self.engine._lock = threading.RLock()
        self.engine._sessions = {}
        self.engine._active_by_channel = {}
        self.engine._config = {"runtime": {"minimumHeadroom": 1.25}}
        self.engine._config_revision = 9
        self.engine._foreground_embedding_priority = lambda: nullcontext()
        self.engine.face = mock.Mock(return_value=object())
        self.engine._ensure_session_producer = mock.Mock()

        created: list[SwapSession] = []
        finished = threading.Event()

        def register() -> None:
            created.append(self.engine.create_session(
                channel="test",
                source_url="https://example.invalid/seek.mp4",
                face_id="test-face",
                start_seconds=12.0,
                prefetch=True,
                prebuffer_seconds=2.0,
            ))
            finished.set()

        with self.engine._lock:
            worker = threading.Thread(target=register, daemon=True)
            worker.start()
            self.assertTrue(
                finished.wait(timeout=0.5),
                "control-plane session registration waited for the GPU lock",
            )
        worker.join(timeout=1.0)

        self.assertEqual(len(created), 1)
        self.assertEqual(created[0].config_revision, 9)

    def test_content_addressed_face_thumbnail_is_immutable_cacheable(self) -> None:
        from PIL import Image

        engine = RecordingServiceEngine()
        with tempfile.TemporaryDirectory() as temp_dir:
            thumbnail = Path(temp_dir) / "approved.jpg"
            Image.new("RGB", (640, 360), (180, 90, 45)).save(thumbnail, format="JPEG")
            engine.face = lambda _face_id: types.SimpleNamespace(
                id="approved-content-digest",
                thumbnail=thumbnail,
            )
            service = self._load_service_with_engine(engine)
            service.FACE_THUMBNAIL_DIR = Path(temp_dir) / "thumbnail-cache"

            response = service.face_thumbnail("approved-content-digest")

            self.assertEqual(
                response.headers.get("cache-control"),
                "private, max-age=31536000, immutable",
            )
            with Image.open(response.path) as rendered:
                self.assertEqual(rendered.size, (128, 128))
            self.assertLess(Path(response.path).stat().st_size, thumbnail.stat().st_size)

    def test_face_inventory_inlines_all_cached_thumbnails_in_one_response(self) -> None:
        from PIL import Image

        engine = RecordingServiceEngine()
        with tempfile.TemporaryDirectory() as temp_dir:
            approved = Path(temp_dir) / "approved.jpg"
            Image.new("RGB", (640, 360), (180, 90, 45)).save(approved, format="JPEG")
            faces = [
                {
                    "id": f"approved-{index:02d}-content-digest",
                    "name": f"Approved {index + 1}",
                    "imageCount": 1,
                    "thumbnailUrl": f"/pong-swap/faces/approved-{index:02d}-content-digest/thumbnail",
                }
                for index in range(18)
            ]
            by_id = {
                face["id"]: types.SimpleNamespace(
                    id=face["id"],
                    thumbnail=approved,
                )
                for face in faces
            }
            engine.faces_public = mock.Mock(return_value=faces)
            engine.face = mock.Mock(side_effect=lambda face_id: by_id[face_id])
            service = self._load_service_with_engine(engine)
            service.FACE_THUMBNAIL_DIR = Path(temp_dir) / "thumbnail-cache"
            service.FACE_THUMBNAIL_DATA_URLS.clear()

            payload = service.faces()

            self.assertEqual(len(payload["faces"]), 18)
            self.assertEqual(
                [entry["id"] for entry in payload["faces"]],
                [entry["id"] for entry in faces],
            )
            for entry in payload["faces"]:
                self.assertIn("thumbnailUrl", entry, "URL fallback must remain available")
                prefix, encoded = entry["thumbnailDataUrl"].split(",", 1)
                self.assertEqual(prefix, "data:image/jpeg;base64")
                with Image.open(BytesIO(base64.b64decode(encoded))) as rendered:
                    self.assertEqual(rendered.size, (128, 128))

            # Force a new base64 read from the derivative files and prove the
            # immutable disk cache avoids reopening the large approved source.
            service.FACE_THUMBNAIL_DATA_URLS.clear()
            with mock.patch.object(
                service.Image,
                "open",
                side_effect=AssertionError("cached derivative should avoid source decode"),
            ):
                second = service.faces()
            self.assertEqual(len(second["faces"]), 18)
            self.assertTrue(all(entry.get("thumbnailDataUrl") for entry in second["faces"]))

    def test_interrupt_closes_container_kills_encoder_and_closes_pipes(self) -> None:
        session = make_session()
        container = FakeContainer()
        process = StubbornProcess()
        session.container = container
        session.process = process

        self.engine._interrupt_session_resources(session)

        # The decoder thread owns PyAV close. External retirement must never
        # race container.close() against a native decode call.
        self.assertFalse(container.closed)
        self.assertTrue(process.terminated)
        self.assertTrue(process.killed)
        self.assertTrue(process.stdin.closed)
        self.assertTrue(process.stdout.closed)
        self.assertTrue(process.stderr.closed)

    def test_health_accounting_includes_stopping_and_live_resources(self) -> None:
        stopping = make_session(id="b" * 32)
        stopping.state = "stopping"
        live_process = make_session(id="c" * 32)
        live_process.process = StubbornProcess()
        finished = make_session(id="d" * 32)
        finished.state = "finished"
        finished.complete = True
        self.engine._sessions = {
            stopping.id: stopping,
            live_process.id: live_process,
            finished.id: finished,
        }

        self.assertEqual(self.engine._active_session_count(), 2)

    def test_stop_request_marks_retirement_and_interrupts_resources(self) -> None:
        session = make_session()
        session.state = "streaming"
        container = FakeContainer()
        process = StubbornProcess()
        session.container = container
        session.process = process

        self.engine._request_session_stop(session, delete=True)

        self.assertTrue(session.stop.is_set())
        self.assertTrue(session.delete_requested)
        self.assertEqual(session.state, "stopping")
        self.assertFalse(container.closed)
        self.assertTrue(process.killed)

    def test_unload_is_guarded_while_stopping_session_is_visible(self) -> None:
        models = FakeModels()
        session = make_session()
        session.state = "stopping"
        self.engine._lock = threading.RLock()
        self.engine._sessions_lock = threading.RLock()
        self.engine._sessions = {session.id: session}
        self.engine._models = models
        self.engine._vm = object()
        self.engine._enhancer_session = object()
        self.engine._embedding_cache = {"face": object()}
        self.engine._torch = None

        self.engine.unload()

        self.assertFalse(models.deleted)
        self.assertIs(self.engine._models, models)

    def test_delete_wakes_delayed_retirement(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            session = make_session()
            session.complete = True
            session.state = "finished"
            session.spool_path = Path(temp_dir) / f"{session.id}.mp4"
            session.spool_path.write_bytes(b"cached media")
            self.engine._sessions = {session.id: session}
            self.engine._active_by_channel = {session.channel: session.id}

            started = time.monotonic()
            self.engine._schedule_spool_cleanup(session, delay=5.0)
            self.engine._request_session_stop(session, delete=True)
            while session.id in self.engine._sessions and time.monotonic() - started < 1.0:
                time.sleep(0.01)

            self.assertNotIn(session.id, self.engine._sessions)
            self.assertLess(time.monotonic() - started, 1.0)
            self.assertFalse(session.spool_path.exists())

    def test_startup_cleanup_only_removes_uuid_session_spools(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            spool_dir = Path(temp_dir)
            orphan = spool_dir / (("e" * 32) + ".mp4")
            unrelated = spool_dir / "keep-me.mp4"
            wrong_case = spool_dir / (("F" * 32) + ".mp4")
            orphan.write_bytes(b"orphan")
            unrelated.write_bytes(b"unrelated")
            wrong_case.write_bytes(b"other")

            removed = self.engine._cleanup_orphan_spools(spool_dir)

            self.assertEqual(removed, 1)
            self.assertFalse(orphan.exists())
            self.assertTrue(unrelated.exists())
            self.assertTrue(wrong_case.exists())


if __name__ == "__main__":
    unittest.main()
