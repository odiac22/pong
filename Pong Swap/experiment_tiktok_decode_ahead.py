"""Default-off, single-owner source decode-ahead prototype.

This module deliberately has no service installer. The frozen producer starts
its decoder only after model/identity preparation. Before an integration can
move that start earlier, a source owner must first finish stream selection,
source seek, and cadence metadata. This queue preserves decoded-frame objects,
order and PTS; it does not choose a source, skip frames, convert RGB, or change
the encoder. A consumer must not call PyAV methods on the underlying container.
"""
from __future__ import annotations

import queue
import threading
import hashlib
import inspect
import textwrap
import types
from types import SimpleNamespace
from typing import Any, Iterator


MAX_QUEUED_FRAMES = 3
QUALIFIED_PRODUCER_SHA256 = "44ddbd66b9a65918a51daba74fa5610afda87fc50d9c645155ba56777a3ea836"
_METRICS_LOCK = threading.Lock()
_METRICS = {"prepared": 0, "started": 0, "metadataFallback": 0}


def eligible_for_early_decode(candidate_count: int, start_seconds: float,
                              reused: bool, profile: str = "", *, allow_default: bool = False) -> bool:
    """No alternate-source race, nonzero seek, or already-owned standby source."""
    return ((profile == "tiktok-face-size" or allow_default and profile in ("", "default")) and candidate_count == 1
            and start_seconds == 0 and not reused)


def trial_status() -> dict[str, int | bool]:
    with _METRICS_LOCK:
        return {"active": True, "maxQueuedFrames": MAX_QUEUED_FRAMES, **_METRICS}


class DecodeAheadError(RuntimeError):
    pass


class DecodeAhead:
    """One PyAV owner thread and a bounded ordered queue of decoded frames.

    The caller must select the immutable stream and perform any source seek
    *before* start(). The worker alone invokes container.decode and close.
    An interrupted native read remains owned by that worker until it returns;
    close() never races PyAV by force-closing the container from another thread.
    """

    def __init__(self, container: Any, stream: Any, *, capacity: int = MAX_QUEUED_FRAMES,
                 stop: threading.Event | None = None):
        if not 1 <= int(capacity) <= MAX_QUEUED_FRAMES:
            raise ValueError("decode-ahead capacity must be 1..3")
        self._container = container
        self._stream = stream
        self._queue: queue.Queue[tuple[str, Any]] = queue.Queue(maxsize=int(capacity))
        # Reserve a slot *before* requesting the next PyAV frame. Otherwise a
        # full three-frame queue would leave a fourth decoded frame in a local.
        self._slots = threading.Semaphore(int(capacity))
        self._stop = stop or threading.Event()
        self._started = False
        self._consumed = False
        self._thread: threading.Thread | None = None
        self._finished = threading.Event()
        self._error: BaseException | None = None
        self._decoded = 0

    @property
    def decoded_count(self) -> int:
        return self._decoded

    @property
    def queued_count(self) -> int:
        return self._queue.qsize()

    @property
    def finished(self) -> bool:
        return self._finished.is_set()

    def start(self) -> None:
        if self._started:
            raise DecodeAheadError("decode-ahead already started")
        if self._stop.is_set():
            raise DecodeAheadError("decode-ahead cancelled before start")
        self._started = True
        self._thread = threading.Thread(target=self._run, name="PongDecodeAheadTrial", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        try:
            iterator = iter(self._container.decode(self._stream))
            while not self._stop.is_set():
                if not self._slots.acquire(timeout=.05):
                    continue
                try:
                    frame = next(iterator)
                except StopIteration:
                    self._slots.release()
                    break
                except BaseException:
                    self._slots.release()
                    raise
                if self._stop.is_set():
                    self._slots.release()
                    break
                self._queue.put_nowait(("frame", frame))
                self._decoded += 1
        except BaseException as exc:
            self._error = exc
        finally:
            try:
                self._container.close()
            except BaseException as exc:
                if self._error is None:
                    self._error = exc
            finally:
                self._finished.set()
                # A full queue can belong to a cancelled consumer; never block
                # teardown to publish EOF. frames() also watches _finished.
                if not self._stop.is_set():
                    try:
                        self._queue.put_nowait(("end", None))
                    except queue.Full:
                        pass

    def frames(self) -> Iterator[Any]:
        if not self._started or self._consumed:
            raise DecodeAheadError("decode-ahead has one consumer after start")
        self._consumed = True
        while True:
            if self._stop.is_set():
                return
            try:
                kind, value = self._queue.get(timeout=.05)
            except queue.Empty:
                if self._finished.is_set():
                    if self._error is not None:
                        raise self._error
                    return
                continue
            if kind == "end":
                if self._error is not None:
                    raise self._error
                return
            self._slots.release()
            yield value

    def close(self, *, wait_seconds: float = .75) -> bool:
        """Request cancellation; return whether PyAV owner has exited.

        On a blocking native read, caller must retain this object until the
        worker exits. The worker still owns and eventually closes the source.
        """
        self._stop.set()
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=max(0.0, float(wait_seconds)))
        return self._finished.is_set() or not self._started


class EarlyDecodedContainer:
    """Safe source-publication proxy for the one-candidate, zero-seek trial.

    Stream metadata is copied before starting native decode. The producer
    subsequently reads only these immutable values; the PyAV container and
    stream remain private to the decode owner until that worker closes them.
    """

    def __init__(self, container: Any, stream: Any):
        self._container = container
        self._lock = threading.Lock()
        self._closed = False
        self._started = False
        self.duration = container.duration
        self.stream_metadata = SimpleNamespace(
            average_rate=stream.average_rate,
            base_rate=stream.base_rate,
            duration=stream.duration,
            time_base=stream.time_base,
            codec_context=SimpleNamespace(
                width=int(stream.codec_context.width),
                height=int(stream.codec_context.height),
            ),
        )
        self._ahead = DecodeAhead(container, stream)

    @classmethod
    def prepare(cls, container: Any, selector: Any) -> Any:
        """Return original container if metadata cannot be safely prepared."""
        try:
            stream = selector(container)
            if stream is None:
                raise ValueError("no selected video stream")
            prepared = cls(container, stream)
            with _METRICS_LOCK:
                _METRICS["prepared"] += 1
            return prepared
        except Exception:
            with _METRICS_LOCK:
                _METRICS["metadataFallback"] += 1
            return container

    def start(self) -> None:
        with self._lock:
            if self._closed:
                raise DecodeAheadError("source cancelled before decoder start")
            self._ahead.start()
            self._started = True
            with _METRICS_LOCK:
                _METRICS["started"] += 1

    def decode(self, _metadata_stream: Any) -> Iterator[Any]:
        if not self._started:
            raise DecodeAheadError("source decoder not started")
        return self._ahead.frames()

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            started = self._started
        if started:
            self._ahead.close()
        else:
            # Ownership has not yet moved to the worker. The current source
            # opener/canceller is the sole native owner in this narrow window.
            self._container.close()


_WINNER_SOURCE = '''                                race_state["winner"] = True
                                won = True
                                session.container = opened'''
_WINNER_TRIAL = '''                                race_state["winner"] = True
                                won = True
                                if __pong_trial_early_eligible(
                                        len(source_candidates), session.start_seconds, reused,
                                        session_config["runtime"].get("tiktokRestorerProfile", "")):
                                    opened = __pong_trial_early_container.prepare(
                                        opened, highest_quality_video_stream,
                                    )
                                session.container = opened'''
_PUBLISH_SOURCE = '''                    if won:
                        try:
                            source_open_result.put_nowait(("ok", opened))
                        except queue.Full:
                            won = False'''
_PUBLISH_TRIAL = '''                    if won:
                        if isinstance(opened, __pong_trial_early_container):
                            try:
                                opened.start()
                            except Exception as exc:
                                try:
                                    source_open_result.put_nowait((
                                        "stopped" if session.stop.is_set() else "error",
                                        None if session.stop.is_set() else exc,
                                    ))
                                except queue.Full:
                                    pass
                                won = False
                        if won:
                            try:
                                source_open_result.put_nowait(("ok", opened))
                            except queue.Full:
                                won = False'''
_STREAM_SOURCE = '''                return
            video_stream = highest_quality_video_stream(container)
            if video_stream is None:'''
_STREAM_TRIAL = '''                return
            video_stream = (
                container.stream_metadata
                if isinstance(container, __pong_trial_early_container)
                else highest_quality_video_stream(container)
            )
            if video_stream is None:'''


def transformed_producer_source(original_source: str) -> str:
    """Three narrow, source-hash-qualified substitutions; no arithmetic edits."""
    if hashlib.sha256(original_source.encode()).hexdigest() != QUALIFIED_PRODUCER_SHA256:
        raise DecodeAheadError("producer source hash changed; trial disabled")
    # The qualified method lives at module scope. These markers were written
    # from the indented class source; remove that one level from each marker.
    def module_level(marker: str) -> str:
        return '\n'.join(line[4:] if line.startswith('    ') else line
                         for line in marker.split('\n'))

    transformed = textwrap.dedent(original_source)
    for old, new in ((_WINNER_SOURCE, _WINNER_TRIAL),
                     (_PUBLISH_SOURCE, _PUBLISH_TRIAL),
                     (_STREAM_SOURCE, _STREAM_TRIAL)):
        old, new = module_level(old), module_level(new)
        if transformed.count(old) != 1:
            raise DecodeAheadError("producer source marker changed; trial disabled")
        transformed = transformed.replace(old, new, 1)
    compile(textwrap.dedent(transformed), '<pong-decode-ahead-trial>', 'exec')
    return transformed


def install(engine: Any, *, review_allow_default: bool = False) -> dict[str, int | bool]:
    """Install only on a cold, already-qualified engine before admission.

    This process-local experiment leaves the frozen file untouched. It is
    disabled unless a dedicated trial entrypoint calls install explicitly.
    """
    if getattr(engine, '_tiktok_decode_ahead_trial', None) is not None:
        return engine._tiktok_decode_ahead_trial
    with engine._sessions_lock:
        if engine._sessions:
            raise DecodeAheadError("decode-ahead trial requires zero sessions")
    # The qualified runtime binds frozen code onto PongSwapEngine *class* at
    # cold install. The SHA guard rejects the original baseline class method.
    # This trial then overrides only the one engine instance, leaving the
    # qualified class and every other engine untouched.
    original = type(engine)._produce_session
    source = inspect.getsource(original)
    changed = transformed_producer_source(source)
    globals_dict = original.__globals__
    helper = '__pong_trial_early_container'
    eligible_name = '__pong_trial_early_eligible'
    if helper in globals_dict or eligible_name in globals_dict:
        raise DecodeAheadError("decode-ahead helper already bound")
    globals_dict[helper] = EarlyDecodedContainer
    from functools import partial
    globals_dict[eligible_name] = partial(eligible_for_early_decode, allow_default=bool(review_allow_default))
    try:
        namespace: dict[str, Any] = {}
        exec(compile(textwrap.dedent(changed), '<pong-decode-ahead-trial>', 'exec'),
             globals_dict, namespace)
        replacement = namespace['_produce_session']
        if replacement.__code__.co_freevars:
            raise DecodeAheadError("producer closure changed")
        engine._produce_session = types.MethodType(replacement, engine)
        status = trial_status()
        engine._tiktok_decode_ahead_trial = status
        return status
    except BaseException:
        globals_dict.pop(helper, None)
        globals_dict.pop(eligible_name, None)
        raise


def consume_rgb_with_original_cadence(
    decoded: Iterator[Any], *, source_fps: float, start_seconds: float = 0.0,
    frame_stride: int = 1, time_base: float | None = None,
) -> Iterator[tuple[Any, float | None]]:
    """Reference handoff equivalent to the producer's decode_source loop.

    This is for CPU parity tests only. Integration should keep the original
    loop and merely replace its source iterator with DecodeAhead.frames().
    """
    eligible = 0
    for frame in decoded:
        timeline = None
        if frame.pts is not None and time_base:
            timestamp = float(frame.pts * time_base)
            if timestamp + (1.0 / source_fps) < start_seconds:
                continue
            timeline = max(0.0, timestamp - start_seconds)
        take = eligible % frame_stride == 0
        eligible += 1
        if take:
            yield frame.to_ndarray(format="rgb24"), timeline
