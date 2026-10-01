"""Diagnostic-only first-frame encoder handoff and fMP4 boundary trace.

This deliberately does not edit or recompile the qualified producer. A Python
profile callback observes its *actual* ordered emit record after the stdin
write returns; a wrapper around the existing transport writer observes the
first completed moof/mdat. Profiling adds overhead: never use this for FPS
qualification. No frame pixels, URLs, embeddings, or face IDs are retained.
"""

from __future__ import annotations

from collections import deque
import hashlib
import threading
import time
import weakref
from typing import Any


def _emit_code(code: Any) -> bool:
    return (getattr(code, 'co_name', '') == 'emit_pending_output'
            and 'encoder_write_started' in getattr(code, 'co_varnames', ())
            and 'encoder_write_seconds' in getattr(code, 'co_varnames', ()))


class EncoderHandoffTrace:
    """Bounded process-local observer for newly admitted TikTok sessions."""

    def __init__(self, *, max_sessions: int = 8, max_frames: int = 15):
        self.max_sessions = max(1, min(16, int(max_sessions)))
        self.max_frames = max(1, min(30, int(max_frames)))
        self._lock = threading.RLock()
        self._sessions: dict[int, tuple[weakref.ReferenceType[Any], dict[str, Any]]] = {}
        self._order: deque[int] = deque()
        self._closed = False
        self._previous_profile: Any = None
        self._previous_write: Any = None
        self._writer_type: Any = None
        self._engine: Any = None
        self._previous_create: Any = None
        self._previous_health: Any = None

    def register(self, session: Any) -> None:
        key = id(session)
        public_key = hashlib.sha256(str(session.id).encode('utf-8')).hexdigest()[:12]
        with self._lock:
            if self._closed:
                return
            if key in self._sessions:
                return
            self._sessions[key] = (weakref.ref(session), {
                'sessionKey': public_key, 'stdinHandoffs': [],
                'firstCompleteFragment': None,
            })
            self._order.append(key)
            while len(self._order) > self.max_sessions:
                self._sessions.pop(self._order.popleft(), None)

    def _entry(self, session: Any) -> dict[str, Any] | None:
        pair = self._sessions.get(id(session))
        return pair[1] if pair is not None and pair[0]() is session else None

    def record_emit_return(self, frame: Any, now: float | None = None) -> None:
        """A completed original emit, not the outer async lease wrapper."""
        if self._closed or not _emit_code(frame.f_code):
            return
        local = frame.f_locals
        # The original emit returns early on stop; only these locals prove the
        # actual stdin write completed. frameIndex/PTS come from its record.
        if 'encoder_write_started' not in local or 'encoder_write_seconds' not in local:
            return
        session = local.get('session')
        record = local.get('record')
        if session is None or not isinstance(record, dict):
            return
        try:
            row = {
                'frameIndex': int(record['frameIndex']),
                'inputPtsSeconds': float(record['timelineSeconds']),
                'writeStartedPerf': float(local['encoder_write_started']),
                'writeEndedPerf': float(time.perf_counter() if now is None else now),
                'writeSeconds': float(local['encoder_write_seconds']),
            }
        except (KeyError, TypeError, ValueError, OverflowError):
            return
        with self._lock:
            entry = self._entry(session)
            if entry is not None and len(entry['stdinHandoffs']) < self.max_frames:
                entry['stdinHandoffs'].append(row)

    def profile(self, frame: Any, event: str, arg: Any) -> None:
        if event != 'return' or self._closed:
            return
        try:
            self.record_emit_return(frame)
        except Exception:
            # A diagnostic observer may never interrupt video production.
            pass

    def record_first_fragment(self, session: Any, writer: Any, before: int,
                              now: float | None = None) -> None:
        after = int(writer.probe.complete_fragment_count)
        if before != 0 or after < 1:
            return
        with self._lock:
            entry = self._entry(session)
            if entry is not None and entry['firstCompleteFragment'] is None:
                entry['firstCompleteFragment'] = {
                    'atPerf': float(time.perf_counter() if now is None else now),
                    'completeFragments': after,
                    'sourceBytes': int(writer.source_bytes),
                    'spoolBytes': int(writer.bytes_written),
                }

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {'active': not self._closed, 'diagnosticOnly': True,
                    'sessions': [dict(entry, stdinHandoffs=list(entry['stdinHandoffs']))
                                 for key in self._order
                                 if (pair := self._sessions.get(key)) is not None
                                 for entry in (pair[1],)]}

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            if self._engine is not None and self._previous_create is not None:
                self._engine.create_session = self._previous_create
            if self._engine is not None and self._previous_health is not None:
                self._engine.health = self._previous_health
            if self._writer_type is not None and self._previous_write is not None:
                self._writer_type.write = self._previous_write
            # Existing feeder threads may retain profile(); _closed makes it a
            # no-op. New threads recover the pre-trial profile callback.
            threading.setprofile(self._previous_profile)


def install(engine: Any, writer_type: Any) -> EncoderHandoffTrace:
    """Install before any sessions; only a diagnostic service should call this."""
    with engine._sessions_lock:
        if engine._sessions:
            raise RuntimeError('encoder handoff trace requires zero sessions')
    if getattr(engine, '_tiktok_encoder_handoff_trace', None) is not None:
        return engine._tiktok_encoder_handoff_trace
    if 'create_session' not in engine.__dict__:
        raise RuntimeError('install the scoped TikTok stage admission first')
    trace = EncoderHandoffTrace()
    previous_create = engine.create_session
    previous_health = engine.health
    previous_write = writer_type.write
    previous_profile = threading.getprofile()
    if previous_profile is not None:
        raise RuntimeError('encoder handoff trace cannot replace an existing thread profiler')

    def create_session(*args: Any, **kwargs: Any) -> Any:
        session = previous_create(*args, **kwargs)
        if kwargs.get('restoration_profile') == 'tiktok-face-size':
            trace.register(session)
        return session

    def health(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {**previous_health(*args, **kwargs),
                'encoderHandoffTrace': trace.status()}

    def write(writer: Any, chunk: bytes) -> bool:
        before = int(writer.probe.complete_fragment_count)
        completed = previous_write(writer, chunk)
        if before == 0 and writer.probe.complete_fragment_count:
            # The qualified producer invokes write() directly from its stdout
            # loop; the actual session is present in that caller's locals.
            try:
                import sys
                session = sys._getframe(1).f_locals.get('session')
                if session is not None:
                    trace.record_first_fragment(session, writer, before)
            except Exception:
                pass
        return completed

    # All assignments follow cold validation; rollback if setup fails.
    try:
        trace._engine = engine
        trace._previous_create = previous_create
        trace._previous_health = previous_health
        trace._writer_type = writer_type
        trace._previous_write = previous_write
        trace._previous_profile = previous_profile
        writer_type.write = write
        threading.setprofile(trace.profile)
        engine.create_session = create_session
        engine.health = health
        engine._tiktok_encoder_handoff_trace = trace
        return trace
    except BaseException:
        trace.close()
        raise
