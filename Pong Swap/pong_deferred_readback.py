"""Deferred GPU-to-host frame readback for the Pong producer (perf-audit-20261101).

Before this module the render thread finished every frame with a stream
synchronize followed by a synchronous full-frame ``.cpu()`` copy and a blocking
FFmpeg pipe write. The GPU therefore sat idle while the CPU prepared the next
frame (decode wait, downscale, LK tracking, matching) and the CPU sat idle while
the GPU finished the current one.

With deferred readback the finished frame is copied asynchronously into pinned
host memory on the compute stream and a CUDA event is recorded. The render
thread returns immediately and starts the next frame; a single ordered writer
thread waits on each event, composes the final RGB frame on the host when the
render used a cropped canvas, and performs the encoder write. All frames are
emitted in order; nothing is dropped, merged or re-timed. Pixels are identical
to the synchronous path (same tensors, same uint8 conversion).
"""
from __future__ import annotations

import queue
import threading
from typing import Any, Callable

import numpy as np


class PinnedRing:
    """A small ring of pinned host buffers; ``acquire`` blocks while all are in flight."""

    def __init__(self, torch, slots: int = 3):
        self.torch = torch
        self.slots = max(2, int(slots))
        self._buffers: list[Any] = [None] * self.slots
        self._capacity = [0] * self.slots
        self._free: queue.Queue[int] = queue.Queue()
        for index in range(self.slots):
            self._free.put(index)
        self.lock = threading.Lock()

    def acquire(self, nbytes: int, timeout: float | None = None) -> tuple[int, Any]:
        index = self._free.get(timeout=timeout)
        with self.lock:
            if self._capacity[index] < nbytes:
                # Grow to the largest frame seen; a short clip rarely changes size.
                self._buffers[index] = self.torch.empty(int(nbytes), dtype=self.torch.uint8, pin_memory=True)
                self._capacity[index] = int(nbytes)
            buffer = self._buffers[index]
        return index, buffer

    def release(self, index: int) -> None:
        self._free.put(index)

    def in_flight(self) -> int:
        return self.slots - self._free.qsize()


class PendingFrame:
    """A frame whose device->host copy has been issued but not awaited."""

    __slots__ = ('ring', 'slot', 'host', 'event', 'device', 'shape', 'box', 'base_frame', 'done')

    def __init__(self, ring: PinnedRing, slot: int, host, event, device, shape, box=None, base_frame=None):
        self.ring = ring
        self.slot = slot
        self.host = host
        self.event = event
        self.device = device
        self.shape = tuple(shape)
        self.box = box
        self.base_frame = base_frame
        self.done = False

    def wait(self) -> np.ndarray:
        """Block until the copy landed; returns the composed RGB frame (host memory)."""
        self.event.synchronize()
        self.device = None
        array = self.host.numpy()
        if self.box is None:
            return array
        left, top, right, bottom = self.box
        output = np.array(self.base_frame, copy=True) if self.base_frame is not None else None
        if output is None:
            return array
        output[top:bottom, left:right] = array
        return output

    def release(self) -> None:
        if not self.done:
            self.done = True
            self.host = None
            self.device = None
            self.base_frame = None
            self.ring.release(self.slot)


def begin_readback(torch, stream, tensor_hwc_uint8, ring: PinnedRing, *, box=None, base_frame=None) -> PendingFrame:
    """Issue the asynchronous copy of a contiguous uint8 HWC CUDA tensor on ``stream``."""
    shape = tuple(tensor_hwc_uint8.shape)
    nbytes = int(np.prod(shape))
    slot, buffer = ring.acquire(nbytes)
    host = buffer[:nbytes].view(*shape)
    with torch.cuda.stream(stream):
        host.copy_(tensor_hwc_uint8, non_blocking=True)
        event = torch.cuda.Event()
        event.record(stream)
    return PendingFrame(ring, slot, host, event, tensor_hwc_uint8, shape, box=box, base_frame=base_frame)


class OrderedFrameWriter:
    """Single consumer that awaits pending frames in submission order and emits them."""

    def __init__(self, emit: Callable[[np.ndarray, dict[str, Any]], None], *, depth: int = 2, name: str = 'PongDeferredWriter'):
        self.emit = emit
        self.queue: queue.Queue = queue.Queue(maxsize=max(1, int(depth)))
        self.error: BaseException | None = None
        self.stopped = threading.Event()
        self.emitted = 0
        self.wait_seconds = 0.0
        self.emit_seconds = 0.0
        self.thread = threading.Thread(target=self._run, name=name, daemon=True)
        self.thread.start()

    def submit(self, pending: PendingFrame, record: dict[str, Any]) -> None:
        if self.error is not None:
            pending.release()
            raise self.error
        while True:
            if self.stopped.is_set():
                pending.release()
                return
            try:
                self.queue.put((pending, record), timeout=0.05)
                return
            except queue.Full:
                if self.error is not None:
                    pending.release()
                    raise self.error

    def _run(self) -> None:
        import time
        while True:
            try:
                item = self.queue.get(timeout=0.05)
            except queue.Empty:
                if self.stopped.is_set():
                    return
                continue
            if item is None:
                return
            pending, record = item
            try:
                if self.stopped.is_set():
                    continue
                started = time.perf_counter()
                array = pending.wait()
                waited = time.perf_counter()
                self.emit(array, record)
                self.emitted += 1
                finished = time.perf_counter()
                self.wait_seconds += waited - started
                self.emit_seconds += finished - waited
            except BaseException as exc:  # noqa: BLE001 - surfaced to the producer
                if self.error is None:
                    self.error = exc
                self.stopped.set()
            finally:
                pending.release()

    def close(self, *, wait: bool = True, timeout: float = 5.0) -> None:
        """Finish queued frames (unless stopped) and join the writer."""
        try:
            self.queue.put(None, timeout=timeout)
        except queue.Full:
            self.stopped.set()
        if wait:
            self.thread.join(timeout=timeout)
        self.stopped.set()

    def abort(self) -> None:
        self.stopped.set()
        self.thread.join(timeout=2.0)
