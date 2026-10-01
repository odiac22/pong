"""Disposable TikTok departure scheduler trial; never changes rendered pixels.

The caller must install this on the idle, normally qualified service before
Uvicorn starts. A lease only suppresses a departed foreground session from the
prefetch headroom predicate after pausing that session at a frame boundary.
Normal activation, rendering, and quality settings remain untouched.
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from dataclasses import dataclass
from types import MethodType
from typing import Any, Callable
from pydantic import BaseModel, Field

MAX_LEASE_MS = 4000
TIKTOK_PROFILE = 'tiktok-face-size'


def diagnostic_create_session(original: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Enable existing stage events only for the qualified TikTok profile."""
    if kwargs.get('restoration_profile') != TIKTOK_PROFILE:
        return original(*args, **kwargs)
    enabled = dict(kwargs)
    enabled['diagnostics_enabled'] = True
    return original(*args, **enabled)


class DepartureRequest(BaseModel):
    token: str
    leaseMs: int = Field(default=3500, ge=1, le=MAX_LEASE_MS)


class ReturnRequest(BaseModel):
    token: str


class DepartureConflict(ValueError):
    """A request does not own the active TikTok session or current lease."""


@dataclass
class _Lease:
    session: Any
    token: str
    started: float
    deadline: float
    external_scrub: bool


class DepartureController:
    def __init__(
        self,
        engine: Any,
        *,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
        emit: Callable[[dict[str, Any]], None] | None = None,
        start_expirer: bool = True,
        stage_diagnostics: bool = False,
    ) -> None:
        self.engine = engine
        self.clock = clock
        self.wall_clock = wall_clock
        self.emit = emit or (lambda row: print(json.dumps(row, separators=(',', ':')), flush=True))
        self.condition = threading.Condition(threading.RLock())
        self.leases: dict[str, _Lease] = {}
        self.closed = False
        self.stage_diagnostics = bool(stage_diagnostics)
        self.expirer: threading.Thread | None = None
        if start_expirer:
            self.expirer = threading.Thread(target=self._expire_loop, name='PongTikTokDepartureExpiry', daemon=True)
            self.expirer.start()

    @staticmethod
    def _tiktok(session: Any) -> bool:
        return (getattr(session, 'config', None) or {}).get('runtime', {}).get(
            'tiktokRestorerProfile'
        ) == 'tiktok-face-size'

    @staticmethod
    def _token(value: str) -> str:
        try:
            parsed = uuid.UUID(str(value))
        except (ValueError, AttributeError, TypeError) as exc:
            raise DepartureConflict('token must be a UUID') from exc
        if str(parsed) != str(value).lower():
            raise DepartureConflict('token must be a canonical UUID')
        return str(parsed)

    def _active_session(self, session_id: str) -> Any:
        with self.engine._sessions_lock:
            session = self.engine._sessions.get(session_id)
            if (
                session is None
                or self.engine._active_by_channel.get(session.channel) != session_id
                or session.stop.is_set()
                or session.complete
                or session.prefetch
                or not session.activation_requested
                or not self._tiktok(session)
            ):
                raise DepartureConflict('session is not an active TikTok foreground')
            return session

    def _record(self, kind: str, lease: _Lease, *, reason: str = '') -> None:
        row = {
            'kind': 'departure-' + kind,
            'at': self.wall_clock(),
            'sessionId': lease.session.id,
            'token': lease.token,
            'frames': int(lease.session.frames),
        }
        if reason:
            row['reason'] = reason
        self.emit(row)

    def depart(self, session_id: str, token: str, lease_ms: int = 3500) -> dict[str, Any]:
        token = self._token(token)
        if not 1 <= int(lease_ms) <= MAX_LEASE_MS:
            raise DepartureConflict('leaseMs must be within 1..4000')
        session = self._active_session(session_id)
        now = self.clock()
        with self.condition:
            if self.closed:
                raise DepartureConflict('departure trial is closing')
            # Recheck after acquiring the lease lock: activation may have
            # replaced this owner while the request was waiting.
            if self._active_session(session_id) is not session:
                raise DepartureConflict('session was replaced')
            previous = self.leases.get(session_id)
            if previous and previous.deadline <= now:
                self._end_locked(session_id, reason='expiry')
                previous = None
            if previous and previous.token == token:
                return self._public(previous)
            if previous:
                external_scrub = previous.external_scrub
                started = previous.started
                deadline = min(now + lease_ms / 1000.0, started + MAX_LEASE_MS / 1000.0)
                self._record('return', previous, reason='replaced-token')
            else:
                external_scrub = session.scrub_suspended.is_set()
                started = now
                deadline = now + lease_ms / 1000.0
            lease = _Lease(session, token, started, deadline, external_scrub)
            with session.condition:
                if not session.scrub_suspended.is_set():
                    session.scrub_suspended.set()
                session.condition.notify_all()
            self.leases[session_id] = lease
            self._record('start', lease)
            self.condition.notify_all()
            return self._public(lease)

    def _public(self, lease: _Lease) -> dict[str, Any]:
        return {
            'ok': True,
            'sessionId': lease.session.id,
            'token': lease.token,
            'expiresInMs': max(0, round((lease.deadline - self.clock()) * 1000)),
        }

    def _end_locked(self, session_id: str, *, reason: str) -> _Lease | None:
        lease = self.leases.pop(session_id, None)
        if lease is None:
            return None
        with lease.session.condition:
            if not lease.external_scrub:
                lease.session.scrub_suspended.clear()
            lease.session.condition.notify_all()
        self._record('expiry' if reason == 'expiry' else 'return', lease, reason=reason)
        self.condition.notify_all()
        return lease

    def return_lease(self, session_id: str, token: str) -> dict[str, Any]:
        token = self._token(token)
        with self.condition:
            current = self.leases.get(session_id)
            if current is None or current.token != token:
                raise DepartureConflict('token does not own the current lease')
            self._end_locked(session_id, reason='client-return')
            return {'ok': True, 'sessionId': session_id, 'token': token}

    def expire_due(self) -> int:
        with self.condition:
            now = self.clock()
            due = [session_id for session_id, lease in self.leases.items() if lease.deadline <= now]
            for session_id in due:
                self._end_locked(session_id, reason='expiry')
            return len(due)

    def _expire_loop(self) -> None:
        with self.condition:
            while not self.closed:
                if self.leases:
                    deadline = min(lease.deadline for lease in self.leases.values())
                    remaining = deadline - self.clock()
                    if remaining <= 0:
                        self.expire_due()
                        continue
                    self.condition.wait(timeout=remaining)
                else:
                    self.condition.wait()

    def _live_lease_sessions(self, observed_at: float) -> dict[str, Any]:
        # Do not nest the controller lock and engine session lock here. An
        # activation may replace a session object while retaining an ID in a
        # test double; a stale lease must never exempt that new foreground.
        with self.condition:
            leases = dict(self.leases)
        with self.engine._sessions_lock:
            current = {session_id: self.engine._sessions.get(session_id) for session_id in leases}
        return {
            session_id: lease.session for session_id, lease in leases.items()
            if (lease.deadline > observed_at and
                current[session_id] is lease.session and
                lease.session.scrub_suspended.is_set() and
                not lease.session.stop.is_set())
        }

    def live_leased_ids(self, observed_at: float) -> set[str]:
        return set(self._live_lease_sessions(observed_at))

    def foreground_needs_gpu(self, excluded_session_id: str, *, now: float | None = None) -> bool:
        observed_at = self.clock() if now is None else float(now)
        excluded = self._live_lease_sessions(observed_at)
        with self.engine._sessions_lock:
            candidates = list(self.engine._sessions.values())
            active_ids = set(self.engine._active_by_channel.values())
        for candidate in candidates:
            if (
                candidate.id == excluded_session_id
                or excluded.get(candidate.id) is candidate
                or candidate.id not in active_ids
                or candidate.complete
                or candidate.stop.is_set()
                or candidate.subscribers <= 0
                or candidate.prefetch
                or not candidate.activation_requested
                or not candidate.playback_started_at
                or candidate.fps <= 0
            ):
                continue
            minimum_headroom = max(1.0, float(
                (candidate.config or self.engine._config)['runtime'].get('minimumHeadroom', 1.25)
            ))
            if self.engine._playback_headroom_seconds(candidate, observed_at) < minimum_headroom:
                return True
        return False

    def suspend(self, original: Callable[..., Any], session_id: str) -> Any:
        with self.condition:
            lease = self.leases.get(session_id)
            if lease:
                lease.external_scrub = True
            return original(session_id)

    def resume(self, original: Callable[..., Any], session_id: str) -> Any:
        with self.condition:
            lease = self.leases.get(session_id)
            if lease:
                lease.external_scrub = False
                with lease.session.condition:
                    lease.session.condition.notify_all()
                return lease.session
            return original(session_id)

    def status(self) -> dict[str, Any]:
        with self.condition:
            return {
                'installed': not self.closed,
                'activeLeases': len(self.leases),
                'maxLeaseMs': MAX_LEASE_MS,
                'stageDiagnostics': self.stage_diagnostics,
            }

    def close(self) -> None:
        with self.condition:
            if self.closed:
                return
            self.closed = True
            for session_id in list(self.leases):
                self._end_locked(session_id, reason='shutdown')
            self.condition.notify_all()
        if self.expirer and self.expirer is not threading.current_thread():
            self.expirer.join(timeout=1.0)


def install(engine: Any, app: Any, *, stage_diagnostics: bool | None = None) -> DepartureController:
    """Install once after the normal service import, before ASGI startup."""
    if getattr(engine, '_tiktok_departure_trial', None) is not None:
        return engine._tiktok_departure_trial
    with engine._sessions_lock:
        if engine._sessions:
            raise RuntimeError('departure trial requires a cold engine with no sessions')
    worker = getattr(engine, '_gpu_worker_thread', None)
    if worker is not None and worker.is_alive():
        raise RuntimeError('departure trial requires an idle GPU worker')
    from fastapi import HTTPException
    if stage_diagnostics is None:
        stage_diagnostics = os.environ.get('PONG_TIKTOK_STAGE_DIAGNOSTICS') == '1'
    controller = DepartureController(engine, stage_diagnostics=stage_diagnostics)
    original_health = engine.health
    original_suspend = engine.suspend_session
    original_resume = engine.resume_session
    original_create = engine.create_session if stage_diagnostics else None

    def health(_engine: Any) -> dict[str, Any]:
        return {**original_health(), 'departureTrial': controller.status()}

    def needs(_engine: Any, excluded_session_id: str, *, now: float | None = None) -> bool:
        if not controller.live_leased_ids(controller.clock() if now is None else float(now)):
            return original_needs(excluded_session_id, now=now)
        return controller.foreground_needs_gpu(excluded_session_id, now=now)

    def suspend(_engine: Any, session_id: str) -> Any:
        return controller.suspend(original_suspend, session_id)

    def resume(_engine: Any, session_id: str) -> Any:
        return controller.resume(original_resume, session_id)

    def create_session(_engine: Any, *args: Any, **kwargs: Any) -> Any:
        return diagnostic_create_session(original_create, *args, **kwargs)

    original_needs = engine._foreground_playback_needs_gpu
    engine.health = MethodType(health, engine)
    engine._foreground_playback_needs_gpu = MethodType(needs, engine)
    engine.suspend_session = MethodType(suspend, engine)
    engine.resume_session = MethodType(resume, engine)
    if stage_diagnostics:
        engine.create_session = MethodType(create_session, engine)

    def departure(session_id: str, request: DepartureRequest) -> dict[str, Any]:
        try:
            return controller.depart(session_id, request.token, request.leaseMs)
        except DepartureConflict as exc:
            raise HTTPException(409, str(exc)) from exc

    def returning(session_id: str, request: ReturnRequest) -> dict[str, Any]:
        try:
            return controller.return_lease(session_id, request.token)
        except DepartureConflict as exc:
            raise HTTPException(409, str(exc)) from exc

    app.add_api_route('/sessions/{session_id}/departure', departure, methods=['POST'])
    app.add_api_route('/sessions/{session_id}/return', returning, methods=['POST'])
    # Current FastAPI exposes lifecycle registration on the router; the fake
    # CPU contract app exposes it directly.
    getattr(app, 'router', app).add_event_handler('shutdown', controller.close)
    engine._tiktok_departure_trial = controller
    return controller


if __name__ == '__main__':
    import uvicorn
    import pong_swap_service

    install(pong_swap_service.ENGINE, pong_swap_service.app)
    uvicorn.run(pong_swap_service.app, host='127.0.0.1', port=8792, log_level='info')
