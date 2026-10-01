"""Bound abandoned external-clock work without changing the qualified renderer.

Only sessions explicitly created with externalPlaybackClock opt in. Ordinary
Pong and unpromoted prefetches keep their existing lifetime. Real playback
reports renew the lease; HTTP stream subscribers are not proof of a live UI.
"""
from __future__ import annotations

from dataclasses import dataclass
import threading
import time
from typing import Callable


@dataclass
class _Lease:
    session: object
    active_since: float | None
    paused_at_report: float | None = None


class ExternalPlaybackLeases:
    def __init__(self, *, clock: Callable[[], float] = time.monotonic,
                 pause_after: float = 3.0, expire_after: float = 15.0):
        if not 0 < pause_after < expire_after:
            raise ValueError("invalid external playback lease deadlines")
        self._clock = clock
        self._pause_after = pause_after
        self._expire_after = expire_after
        self._lock = threading.Lock()
        self._leases: dict[str, _Lease] = {}

    def register(self, session: object) -> None:
        with session.condition:
            active = not session.prefetch or session.activation_requested
        with self._lock:
            self._leases.setdefault(session.id, _Lease(
                session, self._clock() if active else None))

    def sweep(self, stop_deferred: Callable[[str], object]) -> dict[str, int]:
        with self._lock:
            entries = list(self._leases.items())
        now = self._clock()
        paused = expired = 0
        for session_id, lease in entries:
            session = lease.session
            discard = retire = False
            # The same condition protects ordered playback reports. Mark stop
            # before releasing it, so a racing late report cannot revive work.
            # Native teardown happens outside this lock and the registry lock.
            with session.condition:
                if session.stop.is_set() or session.complete:
                    discard = True
                elif not session.prefetch or session.activation_requested:
                    if lease.active_since is None:
                        lease.active_since = now
                    reported_at = session.playback_position_updated_at
                    if (lease.paused_at_report is not None and
                            reported_at != lease.paused_at_report):
                        lease.paused_at_report = None
                    # An intentional pause has no running clock to extrapolate.
                    # Leave its ready buffer available for a later resume.
                    intentionally_paused = (session.playback_paused and
                                            lease.paused_at_report is None)
                    elapsed = max(0.0, now - max(lease.active_since, reported_at))
                    if not intentionally_paused and elapsed >= self._expire_after:
                        session.stop.set()
                        session.condition.notify_all()
                        discard = retire = True
                        expired += 1
                    elif (not intentionally_paused and elapsed >= self._pause_after
                          and lease.paused_at_report is None):
                        # Freeze the inferred playback clock at the last real
                        # report. Do not fabricate a heartbeat or rendered frame.
                        session.playback_paused = True
                        lease.paused_at_report = reported_at
                        session.condition.notify_all()
                        paused += 1
            if retire:
                try:
                    stop_deferred(session_id)
                except KeyError:
                    pass  # Concurrent normal cleanup already removed it.
            if discard:
                with self._lock:
                    if self._leases.get(session_id) is lease:
                        self._leases.pop(session_id, None)
        with self._lock:
            watched = len(self._leases)
        return {"watched": watched, "paused": paused, "expired": expired}
