"""Serialize this task's offline GPU experiments, including queued builders."""
import atexit,ctypes,os
_handle=None

def acquire():
    global _handle
    if os.name!='nt' or _handle is not None:return
    from ctypes import wintypes
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.CreateMutexW.argtypes=[ctypes.c_void_p,wintypes.BOOL,wintypes.LPCWSTR];kernel.CreateMutexW.restype=wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes=[wintypes.HANDLE,wintypes.DWORD];kernel.WaitForSingleObject.restype=wintypes.DWORD
    kernel.ReleaseMutex.argtypes=[wintypes.HANDLE];kernel.CloseHandle.argtypes=[wintypes.HANDLE]
    handle=kernel.CreateMutexW(None,False,'Local\\PongOwnedSwapTrial20261031')
    if not handle:raise ctypes.WinError(ctypes.get_last_error())
    result=kernel.WaitForSingleObject(handle,0xffffffff)
    if result not in (0,0x80):kernel.CloseHandle(handle);raise RuntimeError('GPU trial ownership unavailable')
    _handle=handle
    def release():kernel.ReleaseMutex(handle);kernel.CloseHandle(handle)
    atexit.register(release)
