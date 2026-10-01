"""Isolated two-slot GPU readback/ordered-output overlap experiment.

This is deliberately restricted to a foreground, already identity-locked,
single-source session without output-dependent temporal reuse/stabilization.
Every unsupported call follows the original synchronous path. Install only
after pong_swap_config has been loaded by the experiment runner.
"""

import inspect
from bisect import bisect_left
import queue
import textwrap
import threading
import time

import numpy as np


class AsyncReadbackLease:
    def __init__(self, pinned, ready, copy_start, frame_start_event,
                 gpu_owner, pool, frame_started_at, submitted_at, session_stats,
                 output_observer=None):
        self.pinned = pinned
        self.ready = ready
        self.copy_start = copy_start
        self.frame_start_event = frame_start_event
        self.gpu_owner = gpu_owner
        self.pool = pool
        self.frame_started_at = frame_started_at
        self.submitted_at = submitted_at
        self.session_stats = session_stats
        self.output_observer = output_observer
        self._observer_called = False
        self._materialized = False
        self._released = False
        self.wait_seconds = 0.0
        self.copy_gpu_ms = 0.0
        self.gpu_frame_ms = 0.0

    def materialize(self):
        if not self._materialized:
            started = time.perf_counter()
            self.ready.synchronize()
            self.wait_seconds = time.perf_counter() - started
            self.copy_gpu_ms = float(self.copy_start.elapsed_time(self.ready))
            self.gpu_frame_ms = float(self.frame_start_event.elapsed_time(self.ready))
            self.gpu_owner = None
            self._materialized = True
        return self.pinned.numpy()

    def observe(self):
        """Publish diagnostic bytes only after the encoder accepted a frame."""
        if self.output_observer is not None and not self._observer_called:
            result = self.materialize()
            # Mark first so an observer exception cannot trigger duplicate
            # publication while the output lease is being released.
            self._observer_called = True
            self.output_observer(result, self)

    def release(self):
        if self._released:
            return
        # A failed/aborted encoder must not recycle a buffer while the DMA
        # write is outstanding. materialize() fences it before pool return.
        self.materialize()
        self._released = True
        self.pool.put(self.pinned)


def _replace_once(source, old, new, description):
    if source.count(old) != 1:
        raise RuntimeError(f'Async readback {description} source contract changed')
    return source.replace(old, new, 1)


def _interval_union_increment(started_at, finished_at, prior_end):
    """Return newly covered seconds and the newest completion boundary."""
    started_at = float(started_at)
    finished_at = float(finished_at)
    if finished_at < started_at:
        raise ValueError('Output completion precedes frame work start')
    if prior_end is None:
        return finished_at - started_at, finished_at
    prior_end = float(prior_end)
    if finished_at <= prior_end:
        return 0.0, prior_end
    return max(0.0, finished_at - max(started_at, prior_end)), finished_at


def _account_output_interval(state, started_at, finished_at, *, emitted):
    """Count only a successfully written output, never a canceled/failed one."""
    if not emitted:
        return False
    increment, last_end = _interval_union_increment(
        started_at, finished_at, state['lastEnd'],
    )
    state['seconds'] += increment
    state['lastEnd'] = last_end
    return True


def _account_output_segments(state, segments, *, emitted):
    """Union actual work segments, excluding held-output queue residence.

    A held acquisition frame can be emitted *after* later frames were rendered,
    so a single last-end watermark would lose those earlier disjoint segments.
    Keep a sorted disjoint union; the queue is bounded and normal frames append.
    """
    if not emitted:
        return False
    intervals = state.setdefault('intervals', [])
    for start, finish in segments:
        start, finish = float(start), float(finish)
        if finish < start:
            raise ValueError('Output work segment has negative duration')
        left = bisect_left(intervals, (start, float('-inf')))
        if left and intervals[left - 1][1] >= start:
            left -= 1
        right = left
        merged_start, merged_end = start, finish
        removed = 0.0
        while right < len(intervals) and intervals[right][0] <= merged_end:
            prior_start, prior_end = intervals[right]
            merged_start = min(merged_start, prior_start)
            merged_end = max(merged_end, prior_end)
            removed += prior_end - prior_start
            right += 1
        intervals[left:right] = [(merged_start, merged_end)]
        state['seconds'] += (merged_end - merged_start) - removed
    return True


def _drain_abandoned_outputs(owner, pending_outputs, output_futures,
                             session, feeder_error):
    """Fence/recycle unflushed leases on cancel or feeder failure.

    A lease popped into an output future is owned by that future and released
    in its ``finally``. Records still in ``pending_outputs`` are owned here.
    Keep a strong owner reference if a CUDA fence fails rather than recycling
    a buffer whose DMA completion is unknown.
    """
    errors = []
    for record in pending_outputs:
        lease = record.get('result')
        if not isinstance(lease, AsyncReadbackLease):
            continue
        lease.output_observer = None
        try:
            lease.release()
        except BaseException as exc:
            retained = getattr(owner, '_isolated_async_abandoned_leases', None)
            if retained is None:
                retained = owner._isolated_async_abandoned_leases = []
            retained.append(lease)
            errors.append(exc)
    pending_outputs.clear()
    for future in output_futures:
        try:
            future.result()
        except BaseException as exc:
            errors.append(exc)
    output_futures.clear()
    if not session.stop.is_set():
        for exc in errors:
            try:
                feeder_error.put_nowait(exc)
            except queue.Full:
                break
    return len(errors)


def install():
    import concurrent.futures
    import torch
    import pong_swap_engine as module

    engine = module.PongSwapEngine
    original_process = engine.process_frame
    original_rgb = engine._process_frame_to_rgb
    original_produce = engine._produce_session
    original_shutdown = engine.shutdown_gpu_worker

    # process_frame normally waits for all GPU work to complete before
    # returning. In lease mode, the dedicated copy stream waits on a producer
    # event instead. Diagnostics stay synchronous because elapsed_time needs
    # completed events and is intentionally outside this opt-in experiment.
    process_source = textwrap.dedent(inspect.getsource(original_process))
    process_source = _replace_once(
        process_source,
        '        compute_stream.synchronize()\n'
        '        if diagnostics is not None and len(cuda_marks) >= 2:',
        '        if not getattr(self, "_isolated_async_readback_active", False):\n'
        '            compute_stream.synchronize()\n'
        '        if diagnostics is not None and len(cuda_marks) >= 2:',
        'process-frame fence',
    )
    process_scope = {}
    exec(compile(process_source, module.__file__, 'exec'), module.__dict__, process_scope)

    def _eligible(kwargs):
        if (not kwargs.get('_isolated_async_readback', False)
                or kwargs.get('diagnostics') is not None):
            return False
        config = kwargs.get('config') or {}
        runtime = config.get('runtime') or {}
        if (not runtime.get('orderedGpuSubmission', False)
                or runtime.get('temporalForegroundReuseEnabled', False)
                or runtime.get('temporalExactOutputStabilizationEnabled', False)
                or runtime.get('temporalExactMouthStabilizationEnabled', False)
                or runtime.get('temporalSemanticMeshEnabled', False)
                or runtime.get('temporalSemanticFeaturePatchesEnabled', False)):
            return False
        return True

    def rgb(self, frame, source_embedding, anchor, **kwargs):
        opt_in = _eligible(kwargs)
        kwargs.pop('_isolated_async_readback', None)
        session = kwargs.pop('_isolated_async_session', None)
        if not opt_in or self._compute_stream is None:
            return original_rgb(self, frame, source_embedding, anchor, **kwargs)
        frame_started_at = time.perf_counter()
        frame_start_event = torch.cuda.Event(enable_timing=True)
        frame_start_event.record(self._compute_stream)
        self._isolated_async_readback_active = True
        try:
            swapped, updated_anchor = self.process_frame(
                frame, source_embedding, anchor, **kwargs,
            )
        except Exception:
            # Restore the source-original failure boundary: an exception must
            # not leave partially submitted GPU work racing model teardown.
            self._compute_stream.synchronize()
            raise
        finally:
            self._isolated_async_readback_active = False
        if swapped is None:
            return None, updated_anchor
        if (not isinstance(swapped, torch.Tensor) or not swapped.is_cuda
                or swapped.device.index != 0 or swapped.dtype != torch.uint8
                or swapped.ndim != 3 or swapped.shape[2] != 3
                or not swapped.is_contiguous()):
            # This should be unreachable for the guarded production frame
            # path, but a changed output contract must still be correct.
            self._compute_stream.synchronize()
            return swapped.cpu().numpy(), updated_anchor
        shape = tuple(swapped.shape)
        pool_shape = getattr(self, '_isolated_async_readback_pool_shape', None)
        pool = getattr(self, '_isolated_async_readback_pool', None)
        if pool is not None and pool_shape != shape:
            if pool.qsize() != 2:
                # Prior output still owns one slot. Preserve order and pixels
                # through the original synchronous path for this transition;
                # a later frame may replace the old pool after it drains.
                self._compute_stream.synchronize()
                return swapped.cpu().numpy(), updated_anchor
            pool = None
            self._isolated_async_readback_pool = None
        if pool is None:
            pool = queue.Queue(maxsize=2)
            for _ in range(2):
                pool.put(torch.empty(shape, dtype=torch.uint8, pin_memory=True))
            self._isolated_async_readback_pool = pool
            self._isolated_async_readback_pool_shape = shape
        copy_stream = getattr(self, '_isolated_async_readback_stream', None)
        if copy_stream is None:
            try:
                copy_stream = self._isolated_async_readback_stream = torch.cuda.Stream(device=0)
            except Exception:
                self._compute_stream.synchronize()
                raise
        try:
            # Other seek/cancel sessions may legitimately still own both
            # engine-wide slots. Never delay a new session's first fragment
            # for pool capacity: use the exact synchronous path immediately.
            pinned = pool.get_nowait()
        except queue.Empty:
            # Never hold the GPU owner indefinitely behind a stalled encoder.
            self._compute_stream.synchronize()
            return swapped.cpu().numpy(), updated_anchor
        try:
            producer_ready = torch.cuda.Event()
            producer_ready.record(self._compute_stream)
            copy_stream.wait_event(producer_ready)
            copy_start = torch.cuda.Event(enable_timing=True)
            copy_done = torch.cuda.Event(enable_timing=True)
            with torch.cuda.stream(copy_stream):
                copy_start.record(copy_stream)
                pinned.copy_(swapped, non_blocking=True)
                copy_done.record(copy_stream)
            swapped.record_stream(copy_stream)
        except Exception:
            self._compute_stream.synchronize()
            copy_stream.synchronize()
            pool.put(pinned)
            raise
        stats_owner = session if session is not None else self
        stats = getattr(stats_owner, '_isolated_async_readback_stats', None)
        if stats is None:
            stats = stats_owner._isolated_async_readback_stats = {
                'submitted': 0, 'completed': 0, 'firstStartAt': None,
                'firstSubmitAt': None,
                'lastCompleteAt': None, 'waitSeconds': 0.0,
                'copyGpuMs': 0.0, 'gpuFrameMs': 0.0,
                'outputSeconds': 0.0, 'latencyMs': [],
            }
        submitted_at = time.perf_counter()
        if stats['firstStartAt'] is None:
            stats['firstStartAt'] = frame_started_at
        if stats['firstSubmitAt'] is None:
            stats['firstSubmitAt'] = submitted_at
        stats['submitted'] += 1
        return AsyncReadbackLease(
            pinned, copy_done, copy_start, frame_start_event,
            swapped, pool, frame_started_at, submitted_at, stats,
            getattr(self, '_benchmark_output_sink', None),
        ), updated_anchor

    producer_source = textwrap.dedent(inspect.getsource(original_produce))
    for label in ('frame-render', 'frame-render-oom-retry'):
        old = f'                                work_label="{label}",'
        new = old + ('\n                                _isolated_async_session=session,'
                     '\n                                _isolated_async_readback=bool('
                     'identity_locked and session.frames > 0 and not session.prefetch '
                     'and len(candidates) == 1),')
        producer_source = _replace_once(producer_source, old, new, label)
    producer_source = _replace_once(
        producer_source,
        '                            previous_swapped_frame = np.ascontiguousarray(output_frame)',
        '                            previous_swapped_frame = (\n'
        '                                None if isinstance(output_frame, AsyncReadbackLease)\n'
        '                                else np.ascontiguousarray(output_frame)\n'
        '                            )',
        'previous-output anchor',
    )
    producer_source = _replace_once(
        producer_source,
        '            pending_outputs: list[dict[str, Any]] = []',
        '            pending_outputs: list[dict[str, Any]] = []\n'
        '            isolated_output_union = {"intervals": [], "seconds": 0.0, "seenLease": False}\n'
        '            isolated_output_failed = threading.Event()\n'
        '            isolated_output_executor = concurrent.futures.ThreadPoolExecutor(\n'
        '                max_workers=1, thread_name_prefix="PongAsyncReadback"\n'
        '            )\n'
        '            isolated_output_futures = []\n'
        '            isolated_unqueued_lease = None',
        'output executor',
    )
    marker = '            def flush_pending_outputs() -> None:'
    insert = '''            original_emit_pending_output = emit_pending_output

            def emit_pending_output(record: dict[str, Any]) -> None:
                lease = record.get("result")
                has_lease = isinstance(lease, AsyncReadbackLease)
                if has_lease:
                    isolated_output_union["seenLease"] = True
                if isolated_output_failed.is_set() or session.stop.is_set():
                    if has_lease:
                        lease.output_observer = None
                        lease.release()
                    return
                before_write = session.encoder_write_seconds
                started = time.perf_counter()
                try:
                    if has_lease:
                        record["result"] = lease.materialize()
                    if session.stop.is_set():
                        return
                    original_emit_pending_output(record)
                    finished = time.perf_counter()
                    segments = ([(record["frameWorkStartedAt"], finished)] if has_lease else
                                [*record["frameWorkIntervals"], (started, finished)])
                    if _account_output_segments(
                            isolated_output_union, segments,
                            emitted=session.encoder_write_seconds > before_write):
                        if isolated_output_union["seenLease"]:
                            session.frame_work_seconds = isolated_output_union["seconds"]
                        if has_lease:
                            lease.observe()
                except BaseException:
                    isolated_output_failed.set()
                    raise
                finally:
                    if has_lease:
                        ended = time.perf_counter()
                        stats = lease.session_stats
                        if session.encoder_write_seconds > before_write:
                            stats["completed"] += 1
                            stats["lastCompleteAt"] = ended
                            stats["latencyMs"].append(
                                (ended - lease.frame_started_at) * 1000.0
                            )
                            stats["completionFps"] = (
                                stats["completed"]
                                / max(1e-9, ended - stats["firstStartAt"])
                            )
                        stats["waitSeconds"] += lease.wait_seconds
                        stats["copyGpuMs"] += lease.copy_gpu_ms
                        stats["gpuFrameMs"] += lease.gpu_frame_ms
                        stats["outputSeconds"] += ended - started
                        lease.release()

'''
    producer_source = _replace_once(producer_source, marker, insert + marker,
                                    'output materialization')
    producer_source = _replace_once(
        producer_source,
        '            def flush_pending_outputs() -> None:\n'
        '                while pending_outputs:\n'
        '                    emit_pending_output(pending_outputs.pop(0))',
        '''            def flush_pending_outputs() -> None:
                while pending_outputs:
                    record = pending_outputs.pop(0)
                    if isinstance(record.get("result"), AsyncReadbackLease):
                        isolated_output_futures.append(
                            isolated_output_executor.submit(emit_pending_output, record)
                        )
                        if len(isolated_output_futures) >= 2:
                            isolated_output_futures.pop(0).result()
                    else:
                        while isolated_output_futures:
                            isolated_output_futures.pop(0).result()
                        emit_pending_output(record)''',
        'ordered output queue',
    )
    producer_source = _replace_once(
        producer_source,
        '                        "frameWorkSeconds": (\n'
        '                            time.perf_counter() - frame_work_started\n'
        '                        ),',
        '                        "frameWorkSeconds": (\n'
        '                            time.perf_counter() - frame_work_started\n'
        '                        ),\n'
        '                        "frameWorkStartedAt": frame_work_started,\n'
        '                        "frameWorkIntervals": [(\n'
        '                            frame_work_started,\n'
        '                            frame_work_started + (time.perf_counter() - frame_work_started),\n'
        '                        )],',
        'frame-work interval start',
    )
    producer_source = _replace_once(
        producer_source,
        '                        if output_frame is None or session.stop.is_set():\n'
        '                            break',
        '                        if isinstance(output_frame, AsyncReadbackLease):\n'
        '                            isolated_unqueued_lease = output_frame\n'
        '                        if output_frame is None or session.stop.is_set():\n'
        '                            break',
        'cancelled rendered lease ownership',
    )
    producer_source = _replace_once(
        producer_source,
        '                    session.frames += 1\n'
        '                    # Keep encoded output strictly ordered.',
        '                    isolated_unqueued_lease = None\n'
        '                    session.frames += 1\n'
        '                    # Keep encoded output strictly ordered.',
        'lease transferred into pending output',
    )
    producer_source = _replace_once(
        producer_source,
        '                    record["frameWorkSeconds"] = float(\n'
        '                        record.get("frameWorkSeconds", 0.0)\n'
        '                    ) + (time.perf_counter() - started)',
        '                    backfill_finished = time.perf_counter()\n'
        '                    record["frameWorkSeconds"] = float(\n'
        '                        record.get("frameWorkSeconds", 0.0)\n'
        '                    ) + (backfill_finished - started)\n'
        '                    record["frameWorkIntervals"].append((started, backfill_finished))',
        'backfill work interval',
    )
    producer_source = _replace_once(
        producer_source,
        '                flush_pending_outputs()\n            except Exception as exc:',
        '                flush_pending_outputs()\n'
        '                while isolated_output_futures:\n'
        '                    isolated_output_futures.pop(0).result()\n'
        '            except Exception as exc:',
        'final output drain',
    )
    producer_source = _replace_once(
        producer_source,
        '                tracking_lookahead.close()\n'
        '                if output_executor is not None:',
        '                tracking_lookahead.close()\n'
        '                isolated_output_failed.set()\n'
        '                if isolated_unqueued_lease is not None:\n'
        '                    pending_outputs.append({"result": isolated_unqueued_lease})\n'
        '                    isolated_unqueued_lease = None\n'
        '                _drain_abandoned_outputs(\n'
        '                    self, pending_outputs, isolated_output_futures,\n'
        '                    session, feeder_error,\n'
        '                )\n'
        '                isolated_output_executor.shutdown(wait=True, cancel_futures=False)\n'
        '                if output_executor is not None:',
        'executor teardown',
    )
    producer_scope = {}
    scope_globals = module.__dict__
    scope_globals['AsyncReadbackLease'] = AsyncReadbackLease
    scope_globals['concurrent'] = concurrent
    scope_globals['_interval_union_increment'] = _interval_union_increment
    scope_globals['_account_output_interval'] = _account_output_interval
    scope_globals['_account_output_segments'] = _account_output_segments
    scope_globals['_drain_abandoned_outputs'] = _drain_abandoned_outputs
    exec(compile(producer_source, module.__file__, 'exec'), scope_globals,
         producer_scope)

    engine.process_frame = process_scope[original_process.__name__]
    engine._process_frame_to_rgb = rgb
    engine._produce_session = producer_scope[original_produce.__name__]
    engine._produce_session._isolated_source = producer_source

    def shutdown(self, *args, **kwargs):
        result = original_shutdown(self, *args, **kwargs)
        if not result:
            return result
        # The owner can submit a final lease while shutdown drains its queue.
        # Fence after it has exited, before releasing the copy stream/pool.
        copy_stream = getattr(self, '_isolated_async_readback_stream', None)
        if copy_stream is not None:
            copy_stream.synchronize()
        pool = getattr(self, '_isolated_async_readback_pool', None)
        retained = getattr(self, '_isolated_async_abandoned_leases', None)
        if retained:
            for lease in tuple(retained):
                lease.release()
                retained.remove(lease)
        if pool is not None and pool.qsize() == 2:
            self._isolated_async_readback_pool = None
            self._isolated_async_readback_pool_shape = None
            self._isolated_async_readback_stream = None
        return result

    engine.shutdown_gpu_worker = shutdown
    return engine
