"""Process-local capture ownership for concurrently running mask workers.

CUDA's default global capture mode invalidates a graph if another host thread
submits unrelated CUDA work. These source-guarded rewrites change only the
capture error mode of Pong-owned graphs; operators, streams and replay stay
unchanged. Import/install do not touch a CUDA device.
"""

import inspect
import sys
import textwrap


_VM_CAPTURE = "with torch.cuda.graph(graph, stream=stream):"
_VM_LOCAL = "with torch.cuda.graph(graph, stream=stream, capture_error_mode='thread_local'):"
_GPEN_CAPTURE = "with self.torch.cuda.graph(graph, stream=state['stream']):"
_GPEN_LOCAL = ("with self.torch.cuda.graph(graph, stream=state['stream'], "
               "capture_error_mode='thread_local'):")


def _replace_method(cls, name, old, new):
    method = getattr(cls, name)
    source = textwrap.dedent(inspect.getsource(method))
    if source.count(old) != 1:
        raise RuntimeError(f"{cls.__name__}.{name} capture contract changed")
    module = sys.modules[cls.__module__]
    scope = {}
    exec(compile(source.replace(old, new), module.__file__, "exec"), module.__dict__, scope)
    setattr(cls, name, scope[name])


def install(video_manager_class=None):
    """Patch real VM/GPEN captures only; fake VM CPU tests remain untouched."""
    if video_manager_class is None:
        from rope.VideoManager import VideoManager as video_manager_class
    if video_manager_class.__module__ != "rope.VideoManager":
        return False
    from rope.gpen_runtime import GPENRuntime

    if not getattr(video_manager_class, "_isolated_capture_ownership_installed", False):
        _replace_method(video_manager_class, "_match_color", _VM_CAPTURE, _VM_LOCAL)
        video_manager_class._isolated_capture_ownership_installed = True
    if not getattr(GPENRuntime, "_isolated_capture_ownership_installed", False):
        _replace_method(GPENRuntime, "prepare", _GPEN_CAPTURE, _GPEN_LOCAL)
        GPENRuntime._isolated_capture_ownership_installed = True
    return True
