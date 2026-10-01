"""OFF-by-default, read-only source-open attribution for an idle diagnostic service.

This module does not replace the qualified/frozen producer. A caller may sample
its live threads and publish the returned, URL-free dictionaries in a separate
diagnostic artifact. Cache state must come from a side-effect-free snapshot
provider; the existing /video-cache/status route refreshes its idle heartbeat.
"""

from __future__ import annotations

import hashlib
import ipaddress
import linecache
import math
from pathlib import Path
import re
import sys
import threading
import time
from urllib.parse import parse_qs, urlsplit


_CACHE_STATES = frozenset({'missing', 'idle', 'queued', 'downloading', 'ready', 'error'})
_FAILURE_CATEGORIES = frozenset({
    'canceled', 'timeout', 'upstream_http', 'network', 'source_unavailable',
    'media_invalid', 'media_integrity', 'storage', 'extractor', 'unknown',
})
_SESSION_ID = re.compile(r'[a-f0-9]{32}\Z')


def authorized_source_open_request(host: str | None, session_id: str, *,
                                   enabled: bool, proxied: bool = False) -> bool:
    """Direct renderer loopback only; the helper must also block proxying it."""
    return bool(enabled and not proxied and host in {'127.0.0.1', '::1'} and
                _SESSION_ID.fullmatch(str(session_id or '')))


def _host_class(host: str) -> str:
    host = host.lower().rstrip('.')
    if host in {'localhost', '127.0.0.1', '::1'}:
        return 'loopback'
    if host in {'10.0.2.2', '10.0.3.2'}:
        return 'emulator_alias'
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return 'public_dns' if host else 'invalid'
    if address.is_private:
        return 'private_ip'
    return 'public_ip' if address.is_global else 'special_ip'


def source_identity(raw_url: str) -> dict[str, str]:
    """Expose route family and cache key, never source/page URL or hostname."""
    try:
        parsed = urlsplit(str(raw_url or ''))
        if parsed.scheme not in {'http', 'https'} or not parsed.hostname:
            return {'routeFamily': 'invalid', 'hostClass': 'invalid', 'cacheId': ''}
        family = ('cache_stream' if parsed.path == '/video-cache/stream' else
                  'cache_media' if parsed.path.startswith('/video-cache/media/') else
                  'other')
        cache_id = ''
        if family == 'cache_media':
            candidate = parsed.path.rsplit('/', 1)[-1]
            if len(candidate) == 32 and all(ch in '0123456789abcdef' for ch in candidate):
                cache_id = candidate
        elif family == 'cache_stream':
            target = parse_qs(parsed.query).get('url', [''])[0]
            target_parts = urlsplit(target)
            if target_parts.scheme in {'http', 'https'} and target_parts.hostname:
                identity = target_parts.hostname.lower() + target_parts.path
                cache_id = hashlib.sha256(identity.encode()).hexdigest()[:32]
        return {'routeFamily': family, 'hostClass': _host_class(parsed.hostname),
                'cacheId': cache_id}
    except (TypeError, ValueError):
        return {'routeFamily': 'invalid', 'hostClass': 'invalid', 'cacheId': ''}


def sanitize_cache_state(raw: object) -> dict[str, object]:
    """Copy only fixed, non-identifying diagnostic fields."""
    value = raw if isinstance(raw, dict) else {}
    status = str(value.get('status', 'missing'))
    failure = value.get('failure') if isinstance(value.get('failure'), dict) else {}
    category = str(failure.get('category', ''))
    def bounded_number(item: object) -> int:
        try:
            number = float(item)
        except (TypeError, ValueError):
            return 0
        return max(0, min(2**53 - 1, int(number))) if math.isfinite(number) else 0
    return {
        'status': status if status in _CACHE_STATES else 'missing',
        'bytes': bounded_number(value.get('bytes')),
        'totalBytes': bounded_number(value.get('totalBytes')),
        'failureCategory': category if category in _FAILURE_CATEGORIES else '',
        'failureAttempts': min(255, bounded_number(failure.get('attempts'))),
    }


def _frames(top: object):
    frame = top
    while frame is not None:
        yield frame
        frame = frame.f_back


def _line(frame: object) -> str:
    return linecache.getline(frame.f_code.co_filename, frame.f_lineno).strip()


def _belongs_to_session(stack: list[object], session: object) -> bool:
    for frame in stack:
        if frame.f_code.co_name in {'open_candidate', 'open_source'}:
            if frame.f_locals.get('session') is session:
                return True
    return False


def classify_source_stage(session: object, thread_frames: list[tuple[str, object]]) -> str:
    """Classify Python stack positions without changing producer or I/O."""
    if float(getattr(session, 'source_opened_at', 0) or 0) > 0:
        return 'opened'
    if getattr(session, 'state', '') == 'error':
        return 'error'
    if getattr(session, 'stop', None) is not None and session.stop.is_set():
        return 'stopped'
    opener = False
    candidate_other = False
    for name, top in thread_frames:
        if not name.startswith(('PongSwapOpen-', 'PongSwapRoute-')):
            continue
        stack = list(_frames(top))
        if not _belongs_to_session(stack, session):
            continue
        candidate = next((frame for frame in stack if frame.f_code.co_name == 'open_candidate'), None)
        if candidate is not None:
            if any(frame.f_code.co_name == 'take' and
                   Path(frame.f_code.co_filename).name == 'pong_swap_source_pool.py'
                   for frame in stack) or '_standby_sources.take(' in _line(candidate):
                return 'standby_take'
            if 'av.open(' in _line(candidate):
                return 'av_open'
            candidate_other = True
        source = next((frame for frame in stack if frame.f_code.co_name == 'open_source'), None)
        if source is not None:
            if '_prefetch_source_open_gate.acquire(' in _line(source):
                return 'gate_wait'
            opener = True
    if candidate_other:
        return 'candidate_other'
    return 'opener_other' if opener else 'not_observed'


def classify_pipeline_stage(session: object, thread_frames: list[tuple[str, object]]) -> dict[str, object]:
    """Observe this session's decoder/feed stacks and bounded decoded queue.

    A queue-depth observation is not a first-decode timestamp: a fast consumer
    may empty it between samples. No frame, media URL, or decoded pixels leave
    the producer through this diagnostic.
    """
    decoder_stage = 'not_observed'
    feed_stage = 'not_observed'
    decode_queue = None
    for name, top in thread_frames:
        if top is None or not name.startswith(('PongSwapProducer-', 'PongSwapDecode-', 'PongSwapFeed-')):
            continue
        stack = list(_frames(top))
        own_frames = [frame for frame in stack if frame.f_locals.get('session') is session]
        if not own_frames:
            continue
        if decode_queue is None:
            for frame in own_frames:
                candidate = frame.f_locals.get('decode_queue')
                if candidate is not None and callable(getattr(candidate, 'qsize', None)):
                    decode_queue = candidate
                    break
        if name.startswith('PongSwapDecode-'):
            if any(frame.f_code.co_name == 'publish_decoded' for frame in own_frames):
                decoder_stage = 'queue_put'
            else:
                decode_frame = next((frame for frame in own_frames
                                     if frame.f_code.co_name == 'decode_source'), None)
                if decode_frame is not None:
                    line = _line(decode_frame)
                    decoder_stage = 'rgb_convert' if 'decoded.to_ndarray(' in line else 'source_decode'
        elif name.startswith('PongSwapFeed-'):
            if any(frame.f_code.co_name == '_yield_prefetch_for_foreground'
                   for frame in own_frames):
                feed_stage = 'foreground_yield'
            else:
                feed_frame = next((frame for frame in own_frames
                                   if frame.f_code.co_name == 'feed'), None)
                if feed_frame is not None:
                    line = _line(feed_frame)
                    if 'decode_queue.get(' in line:
                        feed_stage = 'queue_get'
                    elif 'session.condition.wait(timeout=0.025)' in line:
                        feed_stage = 'scrub_wait'
                    else:
                        feed_stage = 'processing'
    queue_depth = None
    if decode_queue is not None:
        try:
            queue_depth = max(0, min(256, int(decode_queue.qsize())))
        except (AttributeError, TypeError, ValueError):
            pass
    scrub = getattr(session, 'scrub_suspended', None)
    return {
        'decoderStage': decoder_stage,
        'feedStage': feed_stage,
        'decodedQueueDepth': queue_depth,
        'scrubSuspended': bool(scrub.is_set()) if scrub is not None else False,
    }


class SourceOpenSampler:
    """Bounded stateful snapshots; diagnostic caller controls scheduling."""

    def __init__(self, *, max_sessions: int = 32, clock=time.monotonic):
        self._max_sessions = max(1, min(128, int(max_sessions)))
        self._clock = clock
        self._lock = threading.RLock()
        self._stages: dict[str, tuple[str, float]] = {}
        self._pipeline_stages: dict[str, dict[str, tuple[str, float]]] = {}
        self._pipeline_first_seen: dict[str, dict[str, float]] = {}
        self._creation_cache: dict[str, dict[str, object]] = {}

    def mark_created(self, session: object, cache_state: object) -> None:
        """Record an externally supplied, side-effect-free cache snapshot once."""
        session_id = str(getattr(session, 'id', ''))
        if not session_id or cache_state is None:
            return
        with self._lock:
            if session_id in self._creation_cache:
                return
            self._creation_cache[session_id] = sanitize_cache_state(cache_state)
            while len(self._creation_cache) > self._max_sessions:
                self._creation_cache.pop(next(iter(self._creation_cache)))

    def sample(self, session: object, *, cache_state: object = None,
               thread_frames: list[tuple[str, object]] | None = None) -> dict[str, object]:
        if thread_frames is None:
            current = sys._current_frames()
            thread_frames = [(thread.name, current.get(thread.ident))
                             for thread in threading.enumerate() if thread.ident in current]
        stage = classify_source_stage(session, thread_frames)
        pipeline = classify_pipeline_stage(session, thread_frames)
        now = self._clock()
        session_id = str(getattr(session, 'id', ''))
        with self._lock:
            previous = self._stages.get(session_id)
            began = previous[1] if previous and previous[0] == stage else now
            previous_stage = previous[0] if previous and previous[0] != stage else ''
            previous_duration_ms = round(max(0, now - previous[1]) * 1000, 1) if previous_stage else 0.0
            self._stages[session_id] = (stage, began)
            while len(self._stages) > self._max_sessions:
                self._stages.pop(next(iter(self._stages)))
            pipeline_stages = self._pipeline_stages.setdefault(session_id, {})
            for key, value in (('decoder', pipeline['decoderStage']), ('feed', pipeline['feedStage'])):
                previous_pipeline = pipeline_stages.get(key)
                pipeline_stages[key] = (
                    value,
                    previous_pipeline[1] if previous_pipeline and previous_pipeline[0] == value else now,
                )
            first_seen = self._pipeline_first_seen.setdefault(session_id, {'sample': now})
            if pipeline['decodedQueueDepth'] is not None and pipeline['decodedQueueDepth'] > 0:
                first_seen.setdefault('queue_nonempty', now)
            if pipeline['feedStage'] == 'foreground_yield':
                first_seen.setdefault('foreground_yield', now)
            if bool(getattr(session, 'activation_requested', False)):
                first_seen.setdefault('activation', now)
            while len(self._pipeline_stages) > self._max_sessions:
                self._pipeline_stages.pop(next(iter(self._pipeline_stages)))
            while len(self._pipeline_first_seen) > self._max_sessions:
                self._pipeline_first_seen.pop(next(iter(self._pipeline_first_seen)))
            # Do not compose a response from dictionaries another diagnostic
            # request may mutate after this lock is released.
            pipeline_stages = dict(pipeline_stages)
            first_seen = dict(first_seen)
            creation_cache = self._creation_cache.get(session_id)
        identity = source_identity(getattr(session, 'source_url', ''))
        return {
            'sessionId': session_id,
            'stage': stage,
            'stageObservedMs': round(max(0, now - began) * 1000, 1),
            'previousStage': previous_stage,
            'previousStageObservedMs': previous_duration_ms,
            'prefetch': bool(getattr(session, 'prefetch', False)),
            'activationRequested': bool(getattr(session, 'activation_requested', False)),
            **pipeline,
            'decoderStageObservedMs': round(max(0, now - pipeline_stages['decoder'][1]) * 1000, 1),
            'feedStageObservedMs': round(max(0, now - pipeline_stages['feed'][1]) * 1000, 1),
            'firstQueueNonemptyObservedMs': (
                round(max(0, first_seen['queue_nonempty'] - first_seen['sample']) * 1000, 1)
                if 'queue_nonempty' in first_seen else None
            ),
            'firstForegroundYieldObservedMs': (
                round(max(0, first_seen['foreground_yield'] - first_seen['sample']) * 1000, 1)
                if 'foreground_yield' in first_seen else None
            ),
            'activationObservedMs': (
                round(max(0, first_seen['activation'] - first_seen['sample']) * 1000, 1)
                if 'activation' in first_seen else None
            ),
            **identity,
            'cacheAtCreation': creation_cache,
            'cache': sanitize_cache_state(cache_state) if cache_state is not None else None,
        }
