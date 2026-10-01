"""Windows-only benchmark child containment; standard library, no GPU imports.

The child must wait for its token on stdin before loading any GPU library.
Assignment to a kill-on-close Job precedes that token. Closing the parent (even
without Python cleanup) then kills the owned child and all its descendants.
"""

import ctypes
from ctypes import wintypes
import math
import os
import subprocess
import threading
import time


def bounded_seconds(value, maximum):
    value = float(value)
    if not math.isfinite(value) or not 0 < value <= maximum:
        raise ValueError(f'Time limit must be finite, positive and <= {maximum:g} seconds')
    return value


class HardDeadline:
    """Exit the supervisor at the absolute limit, including blocked telemetry.

    Windows closes its job handles on exit, killing contained GPU workers.
    Incremental reports may remain incomplete; exit 124 must never be accepted.
    """
    def __init__(self, seconds):
        self.timer = threading.Timer(seconds, os._exit, args=(124,))
        self.timer.daemon = True

    def __enter__(self):
        self.timer.start()
        return self

    def __exit__(self, *exc):
        self.timer.cancel()
        self.timer.join()


class KillOnCloseJob:
    def __init__(self):
        if os.name != 'nt':
            raise RuntimeError('GPU benchmark containment currently requires Windows Job Objects')
        class BasicLimits(ctypes.Structure):
            _fields_ = [('processTime', ctypes.c_int64), ('jobTime', ctypes.c_int64),
                        ('flags', wintypes.DWORD), ('minWorkingSet', ctypes.c_size_t),
                        ('maxWorkingSet', ctypes.c_size_t), ('activeProcesses', wintypes.DWORD),
                        ('affinity', ctypes.c_size_t), ('priority', wintypes.DWORD),
                        ('scheduling', wintypes.DWORD)]
        class IoCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in
                        ('readOps', 'writeOps', 'otherOps', 'readBytes', 'writeBytes', 'otherBytes')]
        class ExtendedLimits(ctypes.Structure):
            _fields_ = [('basic', BasicLimits), ('io', IoCounters),
                        ('processMemory', ctypes.c_size_t), ('jobMemory', ctypes.c_size_t),
                        ('peakProcessMemory', ctypes.c_size_t), ('peakJobMemory', ctypes.c_size_t)]
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        signatures = {
            'CreateJobObjectW': ([ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
            'SetInformationJobObject': ([wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
            'AssignProcessToJobObject': ([wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
            'TerminateJobObject': ([wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
            'CloseHandle': ([wintypes.HANDLE], wintypes.BOOL),
        }
        for name, (arguments, result) in signatures.items():
            function = getattr(self.kernel, name)
            function.argtypes, function.restype = arguments, result
        self.handle = self.kernel.CreateJobObjectW(None, None)  # non-inheritable
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            error = ctypes.WinError(ctypes.get_last_error())
            self.close()
            raise error

    def assign(self, process):
        # Popen owns this native process handle until it is reaped.
        if not self.kernel.AssignProcessToJobObject(self.handle, int(process._handle)):
            raise ctypes.WinError(ctypes.get_last_error())

    def terminate(self):
        if not self.kernel.TerminateJobObject(self.handle, 124):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self):
        if self.handle:
            if not self.kernel.CloseHandle(self.handle):
                raise ctypes.WinError(ctypes.get_last_error())
            self.handle = None


def run_guarded_child(command, *, log, environment, token, timeout, minimum_free_mib, query_gpu):
    """Return exit/telemetry after cleanup; propagate failures only after cleanup."""
    job = KillOnCloseJob()
    process = None
    watchdog = None
    timed_out = threading.Event()
    observed = []
    started = time.monotonic()
    try:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=log,
                                   stderr=subprocess.STDOUT, env=environment,
                                   creationflags=subprocess.CREATE_NO_WINDOW)

        def expire():
            timed_out.set()
            try:
                job.terminate()
            finally:
                if process.poll() is None:
                    process.kill()

        watchdog = threading.Timer(timeout, expire)
        watchdog.daemon = True
        watchdog.start()
        job.assign(process)
        if timed_out.is_set():
            raise TimeoutError('Benchmark worker exceeded hard wall-time')
        process.stdin.write((token + '\n').encode('ascii'))
        process.stdin.close()
        while process.poll() is None:
            sample = query_gpu()  # its failure is fatal; watchdog is independent
            observed.append(sample)
            free = sample['freeMiB']
            if not math.isfinite(free) or free < minimum_free_mib:
                raise RuntimeError('GPU headroom guard stopped benchmark worker')
            timed_out.wait(0.5)
        if timed_out.is_set():
            raise TimeoutError('Benchmark worker exceeded hard wall-time')
        return {'exitCode': process.returncode, 'elapsedSeconds': time.monotonic() - started,
                'observedPeakDeviceUsedMiB': max((s['usedMiB'] for s in observed), default=None),
                'observedMinimumFreeMiB': min((s['freeMiB'] for s in observed), default=None)}
    finally:
        if watchdog is not None:
            watchdog.cancel()
            watchdog.join()
        try:
            job.close()  # also kills descendants after a normal child exit
        finally:
            if process is not None:
                if process.poll() is None:
                    process.kill()  # includes failures before job assignment
                process.wait(timeout=5)
                if process.stdin and not process.stdin.closed:
                    process.stdin.close()
