"""Disposable startup scheduling trial; no pixel/model/encoder changes.

Only TikTok speculative sessions can prepare a half-second bootstrap. During
that bounded bootstrap they may use spare GPU time while the foreground still
has >=0.75 seconds of fully muxed media. Normal priority, serialized inference,
memory admission, cancellation, startup byte checks, and activation remain.
This is intentionally NOT imported by the production service.
"""
import time
import json
import os
import threading
from pathlib import Path
from types import MethodType


def is_tiktok(config):
    return (config or {}).get('runtime', {}).get('tiktokRestorerProfile') == 'tiktok-face-size'


def bootstrap_target(original, prefetch, requested_seconds, config):
    if prefetch and is_tiktok(config):
        return 0.5
    return original(prefetch, requested_seconds, config)


def foreground_needs_gpu(engine, excluded, observed_at, minimum=0.75):
    with engine._sessions_lock:
        candidates = list(engine._sessions.values())
        active_ids = set(engine._active_by_channel.values())
    for candidate in candidates:
        if (candidate.id == excluded or candidate.id not in active_ids or
                candidate.complete or candidate.stop.is_set() or
                not candidate.activation_requested):
            continue
        if is_tiktok(candidate.config):
            # Publishing the active owner precedes reader attachment and the
            # playback clock. That cold interval needs MORE protection, not a
            # speculative exemption. Never lend GPU credit before its first
            # fragment is actually muxed and its consumer has attached.
            if (candidate.prefetch or candidate.subscribers <= 0 or
                    not candidate.playback_started_at or candidate.fps <= 0 or
                    candidate.complete_fragments < 1):
                return True
        elif (candidate.subscribers <= 0 or candidate.prefetch or
              not candidate.playback_started_at or candidate.fps <= 0):
            continue
        # A non-TikTok foreground keeps its existing safety reservation.
        headroom = minimum if is_tiktok(candidate.config) else max(
            1.0, float(candidate.config.get('runtime', {}).get('minimumHeadroom', 1.25)))
        if engine._playback_headroom_seconds(candidate, observed_at) < headroom:
            return True
    return False


def install(engine):
    original_target = engine._effective_prebuffer_seconds
    original_needs = engine._foreground_playback_needs_gpu

    def effective(_engine, prefetch, requested_seconds, config):
        return bootstrap_target(original_target, prefetch, requested_seconds, config)

    def needs(_engine, excluded_session_id, *, now=None):
        with _engine._sessions_lock:
            speculative = _engine._sessions.get(excluded_session_id)
        if (not speculative or not speculative.prefetch or speculative.activation_requested or
                not is_tiktok(speculative.config) or speculative.is_prepared()):
            return original_needs(excluded_session_id, now=now)
        return foreground_needs_gpu(_engine, excluded_session_id,
                                    time.monotonic() if now is None else float(now))

    engine._effective_prebuffer_seconds = MethodType(effective, engine)
    engine._foreground_playback_needs_gpu = MethodType(needs, engine)


def install_cold_priority(engine):
    """Separate trial: preserve every normal threshold and prebuffer depth.

    Only protect an activated TikTok owner until its FIRST muxed fragment.
    This does not edit frozen model/engine sources or qualification manifests.
    """
    original = engine._foreground_playback_needs_gpu

    def needs(_engine, excluded_session_id, *, now=None):
        with _engine._sessions_lock:
            candidates = list(_engine._sessions.values())
            active_ids = set(_engine._active_by_channel.values())
        for candidate in candidates:
            if (candidate.id != excluded_session_id and candidate.id in active_ids and
                    not candidate.complete and not candidate.stop.is_set() and
                    candidate.activation_requested and is_tiktok(candidate.config) and
                    candidate.complete_fragments < 1):
                return True
        return original(excluded_session_id, now=now)

    engine._foreground_playback_needs_gpu = MethodType(needs, engine)


def observe(engine, destination):
    """Bounded scheduler-only evidence; no URLs, face IDs, or pixel changes."""
    lock = threading.Lock()
    rows = 0
    original_admission = engine._acquire_prefetch_admission
    original_yield = engine._yield_prefetch_for_foreground

    def snapshot(session):
        now = time.monotonic()
        with engine._sessions_lock:
            sessions = list(engine._sessions.values())
            active = set(engine._active_by_channel.values())
        return [{
            'id': item.id, 'active': item.id in active, 'prefetch': item.prefetch,
            'activated': item.activation_requested, 'stopped': item.stop.is_set(),
            'subscribers': item.subscribers, 'frames': item.frames,
            'prepared': item.is_prepared(), 'gateOwned': item.prefetch_gate_owned,
            'paused': item.playback_paused, 'sourceOpened': bool(item.source_opened_at),
            'lead': round(engine._playback_headroom_seconds(item, now), 3),
        } for item in sessions if item.id != session.id]

    def emit(session, kind, started, before, result):
        nonlocal rows
        elapsed = (time.monotonic() - started) * 1000
        if elapsed < 20 and kind != 'admission':
            return
        with lock:
            if rows >= 1000:
                return
            rows += 1
            with open(destination, 'a', encoding='utf-8') as stream:
                stream.write(json.dumps({
                    'at': time.time(), 'id': session.id, 'kind': kind,
                    'ms': round(elapsed, 2), 'result': result,
                    'prefetchAfter': session.prefetch,
                    'activatedAfter': session.activation_requested,
                    'framesAfter': session.frames, 'stoppedAfter': session.stop.is_set(),
                    'before': before,
                }) + '\n')

    def admission(_engine, session):
        before = snapshot(session)
        started = time.monotonic()
        result = original_admission(session)
        emit(session, 'admission', started, before, result)
        return result

    def yielding(_engine, session):
        # Only collect the initial blocker list when the unchanged predicate
        # actually predicts a wait; do not scan all sessions for every frame.
        if not (session.prefetch and not session.activation_requested and
                not session.playback_started_at and not session.stop.is_set() and
                _engine._foreground_playback_needs_gpu(session.id)):
            return original_yield(session)
        before = snapshot(session)
        started = time.monotonic()
        result = original_yield(session)
        emit(session, 'foreground-yield', started, before, result)
        return result

    engine._acquire_prefetch_admission = MethodType(admission, engine)
    engine._yield_prefetch_for_foreground = MethodType(yielding, engine)

def wait_for_speculative_source(session, *, clock=time.monotonic, maximum=15.0):
    """Do not occupy the single GPU preparation slot during source I/O.

    Source negotiation already runs on its separately bounded opener thread.
    Promotion/cancellation bypass this wait immediately. A failed opener falls
    through to the original producer error handling; no error is hidden and no
    GPU/memory admission, pixel processing or source quality check is removed.
    """
    deadline = clock() + maximum
    while is_tiktok(session.config):
        with session.condition:
            if (session.stop.is_set() or not session.prefetch or
                    session.activation_requested or session.playback_started_at or
                    session.source_opened_at):
                return
            opener = session.source_opener
            if opener is None or not opener.is_alive() or clock() >= deadline:
                return
            session.condition.wait(timeout=.01)


def install_source_ready_admission(engine):
    original = engine._acquire_prefetch_admission
    def admit(_engine, session):
        wait_for_speculative_source(session)
        return original(session)
    engine._acquire_prefetch_admission = MethodType(admit, engine)


if __name__ == '__main__':
    import pong_swap_service
    import uvicorn
    if os.environ.get('PONG_TIKTOK_SOURCE_READY_ADMISSION') == '1':
        install_source_ready_admission(pong_swap_service.ENGINE)
    elif os.environ.get('PONG_TIKTOK_COLD_PRIORITY_ONLY') == '1':
        install_cold_priority(pong_swap_service.ENGINE)
    elif os.environ.get('PONG_TIKTOK_SCHEDULER_OBSERVE_ONLY') != '1':
        install(pong_swap_service.ENGINE)
    audit_path = Path('E:/Pong Benchmarks/tiktok-webview-2026-09-29') / f'scheduler-{time.time_ns()}.jsonl'
    observe(pong_swap_service.ENGINE, audit_path)
    print(f'Scheduler observation: {audit_path}', flush=True)
    # Same service startup still performs its unchanged exact qualification.
    uvicorn.run(pong_swap_service.app, host='127.0.0.1', port=8792, log_level='info')
