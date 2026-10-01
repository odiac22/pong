"""Process-local TikTok prefetch GPU-priority trial; never changes render policy.

Network/source opening stays concurrent. Only an unactivated TikTok prefetch's
model/approved-face GPU preparation yields to an under-buffered foreground.
The wait occurs before face cache locks, and every queued GPU job from that
producer stays at speculative priority until the session is promoted.
"""

from __future__ import annotations

import threading
import time
from types import MethodType
from typing import Any


PROFILE = 'tiktok-face-size'
_METHODS = ('_produce_session', '_run_gpu_work', 'embedding_for_face',
            'presentation_for_face', 'source_frame_for_face', 'health')


class PrefetchPriorityTrial:
    def __init__(self, *, max_wait_seconds: float):
        self.max_wait_seconds = max_wait_seconds
        self.local = threading.local()
        self.lock = threading.Lock()
        self.waits = 0
        self.wait_ms = 0.0
        self.timed_out = 0
        self.canceled = 0
        self.speculative_gpu_jobs = 0
        self.priority_raised_jobs = 0
        self.speculative_gpu_exec_ms = 0.0
        self.foreground_frame_queue_waits = 0
        self.foreground_frame_queue_wait_ms = 0.0
        self.foreground_frame_queue_wait_max_ms = 0.0
        self.original_functions: dict[str, Any] = {}
        self.wrapper_functions: dict[str, Any] = {}

    @staticmethod
    def speculative(session: Any) -> bool:
        return bool(
            session is not None
            and getattr(session, 'prefetch', False)
            and not getattr(session, 'activation_requested', False)
            and not getattr(session, 'playback_started_at', 0)
            and not session.stop.is_set()
            and (getattr(session, 'config', {}) or {}).get('runtime', {}).get(
                'tiktokRestorerProfile') == PROFILE
        )

    def wait_for_turn(self, engine: Any, session: Any) -> bool:
        if not self.speculative(session):
            return not session.stop.is_set()
        started = time.monotonic()
        waited = False
        while self.speculative(session):
            if not engine._foreground_playback_needs_gpu(session.id):
                break
            waited = True
            if time.monotonic() - started >= self.max_wait_seconds:
                # An optional prefetch must not retain a model/cache-key lock or
                # producer indefinitely behind a foreground that cannot catch up.
                session.stop.set()
                with session.condition:
                    session.condition.notify_all()
                with self.lock:
                    self.timed_out += 1
                break
            with session.condition:
                session.condition.wait(timeout=0.02)
        with self.lock:
            if waited:
                self.waits += 1
                self.wait_ms += (time.monotonic() - started) * 1000.0
            if session.stop.is_set():
                self.canceled += 1
        return not session.stop.is_set()

    def status(self) -> dict[str, Any]:
        with self.lock:
            return {
                'active': True,
                'profile': PROFILE,
                'maxWaitMs': round(self.max_wait_seconds * 1000),
                'waits': self.waits,
                'waitMs': round(self.wait_ms, 3),
                'timedOutPrefetches': self.timed_out,
                'canceledWaits': self.canceled,
                'speculativeGpuJobs': self.speculative_gpu_jobs,
                'priorityRaisedJobs': self.priority_raised_jobs,
                'speculativeGpuExecMs': round(self.speculative_gpu_exec_ms, 3),
                'foregroundFrameQueueWaits': self.foreground_frame_queue_waits,
                'foregroundFrameQueueWaitMs': round(self.foreground_frame_queue_wait_ms, 3),
                'foregroundFrameQueueWaitMaxMs': round(
                    self.foreground_frame_queue_wait_max_ms, 3),
                'behavior': 'prefetch-gpu-preparation-only',
                'performanceQualification': False,
            }


def _needs_embedding_gpu(engine: Any, face_id: str, config: Any) -> bool:
    effective = engine._config if config is None else config
    key = (face_id, engine._embedding_profile_key(effective))
    return key not in engine._embedding_cache


def _needs_presentation_gpu(engine: Any, face_id: str, config: Any) -> bool:
    effective = engine._config if config is None else config
    key = (face_id, engine._presentation_profile_key(effective))
    return key not in engine._presentation_cache


def _needs_source_frame_gpu(engine: Any, face_id: str, config: Any) -> bool:
    effective = engine._config if config is None else config
    if str(effective['parameters'].get('SwapperTypeTextSel', '128')) != 'UniFace':
        return False
    key = (face_id, engine._embedding_profile_key(effective))
    return key not in engine._source_frame_cache


def install(engine: Any, *, max_wait_seconds: float = 4.0) -> PrefetchPriorityTrial:
    """Cold install before the exact service adapter; no frozen method edits."""
    previous = getattr(engine, '_tiktok_prefetch_priority_trial', None)
    if previous is not None:
        return previous
    if not 0.1 <= max_wait_seconds <= 10.0:
        raise ValueError('max_wait_seconds must be in 0.1..10')
    with engine._sessions_lock:
        if engine._sessions:
            raise RuntimeError('prefetch priority trial requires no sessions')
    worker = getattr(engine, '_gpu_worker_thread', None)
    if worker is not None and worker.is_alive():
        raise RuntimeError('prefetch priority trial requires an idle GPU worker')
    if any(getattr(engine, name, None) is not None
           for name in ('_models', '_vm', '_warming_models')):
        raise RuntimeError('prefetch priority trial requires an unwarmed engine')
    if any(name in engine.__dict__ for name in _METHODS):
        raise RuntimeError('install prefetch priority before other engine adapters')

    trial = PrefetchPriorityTrial(max_wait_seconds=max_wait_seconds)
    trial.original_functions = {name: getattr(type(engine), name) for name in _METHODS}

    def produce(_engine, session):
        former = getattr(trial.local, 'session', None)
        trial.local.session = session
        try:
            # The qualified cold installer replaces this *class* method after
            # our instance wrapper is attached. Resolve it at call time or the
            # trial would silently run the pre-qualification producer body.
            return type(_engine)._produce_session(_engine, session)
        finally:
            if former is None:
                trial.local.__dict__.pop('session', None)
            else:
                trial.local.session = former

    def gpu_work(_engine, callback, *args, **kwargs):
        session = getattr(trial.local, 'session', None)
        speculative_job = False
        if trial.speculative(session):
            if kwargs.get('work_label') == 'session-warm':
                if not trial.wait_for_turn(_engine, session):
                    return kwargs.get('cancelled_value')
            if trial.speculative(session):
                speculative_job = True
                original_priority = int(kwargs.get('priority', 0))
                kwargs['priority'] = max(10, original_priority)
                with trial.lock:
                    trial.speculative_gpu_jobs += 1
                    if original_priority < 10:
                        trial.priority_raised_jobs += 1
        foreground_frame_job = bool(
            not speculative_job
            and kwargs.get('work_label') in ('frame-render', 'frame-render-oom-retry')
            and int(kwargs.get('priority', 0)) == 0
        )
        if ((speculative_job or foreground_frame_job)
                and threading.get_ident() != getattr(_engine, '_gpu_worker_ident', 0)):
            submitted_at = time.monotonic()
            original_callback = callback

            def timed_callback(*callback_args, **callback_kwargs):
                started_at = time.monotonic()
                if foreground_frame_job:
                    waited_ms = (started_at - submitted_at) * 1000.0
                    with trial.lock:
                        trial.foreground_frame_queue_waits += 1
                        trial.foreground_frame_queue_wait_ms += waited_ms
                        trial.foreground_frame_queue_wait_max_ms = max(
                            trial.foreground_frame_queue_wait_max_ms, waited_ms)
                try:
                    return original_callback(*callback_args, **callback_kwargs)
                finally:
                    if speculative_job:
                        with trial.lock:
                            trial.speculative_gpu_exec_ms += (
                                time.monotonic() - started_at) * 1000.0

            callback = timed_callback
        return trial.original_functions['_run_gpu_work'](
            _engine, callback, *args, **kwargs)

    def prep_wrapper(name: str, needs_gpu):
        original = trial.original_functions[name]

        def prepare(_engine, face_id, config=None, *args, **kwargs):
            session = getattr(trial.local, 'session', None)
            # Test the cache *before* entering the original per-face key lock.
            # A foreground seeking the same identity can therefore proceed
            # while this speculative producer waits or expires.
            if trial.speculative(session) and needs_gpu(_engine, face_id, config):
                if not trial.wait_for_turn(_engine, session):
                    raise RuntimeError('optional prefetch GPU preparation canceled')
            return original(_engine, face_id, config, *args, **kwargs)

        return prepare

    def health(_engine, *args, **kwargs):
        return {**trial.original_functions['health'](_engine, *args, **kwargs),
                'prefetchPriorityTrial': trial.status()}

    wrappers = {
        '_produce_session': produce,
        '_run_gpu_work': gpu_work,
        'embedding_for_face': prep_wrapper('embedding_for_face', _needs_embedding_gpu),
        'presentation_for_face': prep_wrapper('presentation_for_face', _needs_presentation_gpu),
        'source_frame_for_face': prep_wrapper('source_frame_for_face', _needs_source_frame_gpu),
        'health': health,
    }
    trial.wrapper_functions = wrappers
    # All cold checks and wrapper construction precede the first mutation.
    for name, function in wrappers.items():
        setattr(engine, name, MethodType(function, engine))
    engine._tiktok_prefetch_priority_trial = trial
    return trial


def uninstall(engine: Any) -> None:
    """Undo only a directly installed adapter on a fully idle test engine."""
    trial = getattr(engine, '_tiktok_prefetch_priority_trial', None)
    if trial is None:
        return
    with engine._sessions_lock:
        if engine._sessions:
            raise RuntimeError('cannot uninstall while sessions remain')
    worker = getattr(engine, '_gpu_worker_thread', None)
    if worker is not None and worker.is_alive():
        raise RuntimeError('cannot uninstall while GPU worker remains alive')
    for name, wrapper in trial.wrapper_functions.items():
        current = engine.__dict__.get(name)
        if getattr(current, '__func__', None) is not wrapper:
            raise RuntimeError('another adapter wraps prefetch priority; stop process to remove it')
    for name in trial.wrapper_functions:
        delattr(engine, name)
    delattr(engine, '_tiktok_prefetch_priority_trial')
