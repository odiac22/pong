"""Opt-in, process-local prewarm for the existing exact LAB color graph.

This never changes color math or the frozen bundle. Call only after the
qualified engine is warm and before admitting a session, on its GPU owner.
The caller supplies crop descriptors; unmatched real crops take the original
lazy path. A prewarm result is diagnostic, not proof of faster playback.
"""

from dataclasses import dataclass
import threading
import time


@dataclass(frozen=True)
class ColorGraphSpec:
    size: int
    masked: bool = False

    def __post_init__(self):
        if not isinstance(self.size, int) or not 128 <= self.size <= 1024:
            raise ValueError("Color crop size must be in the renderer's supported range")


def eligible_config(config):
    params = config.get("parameters", {})
    runtime = config.get("runtime", {})
    return bool(params.get("ColorMatchSwitch") and runtime.get("colorMatchCudaGraph"))


def prewarm_on_owner(engine, specs):
    """Populate only VM-local graph keys on the existing persistent stream."""
    if threading.get_ident() != getattr(engine, "_gpu_worker_ident", None):
        raise RuntimeError("Color graph prewarm requires the GPU owner thread")
    if engine._vm is None or engine._compute_stream is None or engine._torch is None:
        raise RuntimeError("Color graph prewarm requires a warm engine")
    if engine._active_session_count() != 0:
        raise RuntimeError("Color graph prewarm requires no active sessions")
    if not eligible_config(engine.config):
        return {"eligible": False, "keys": []}

    torch = engine._torch
    vm = engine._vm
    vm.color_match_cuda_graph_enabled = True
    results = []
    with torch.cuda.stream(engine._compute_stream):
        for spec in tuple(dict.fromkeys(specs)):
            if not isinstance(spec, ColorGraphSpec):
                raise TypeError("Expected ColorGraphSpec")
            size = spec.size
            # Nonconstant bytes ensure finite LAB variance even for a full
            # mask. These are throwaway buffers, not a face or session frame.
            values = torch.arange(3 * size * size, device="cuda:0", dtype=torch.int32)
            source = values.remainder(251).to(torch.uint8).reshape(3, size, size)
            target = values.add(17).remainder(253).to(torch.uint8).reshape(3, size, size)
            mask = (torch.ones((1, size, size), device="cuda:0", dtype=torch.float32)
                    if spec.masked else None)
            before = len(getattr(vm, "_color_match_graphs", {}))
            start = time.perf_counter()
            output = vm._match_color(source, target, mask)
            engine._compute_stream.synchronize()
            cache = getattr(vm, "_color_match_graphs", {})
            # The current implementation records None on a failed capture;
            # that is not a successful prewarm even though eager output exists.
            expected = (str(source.device), int(engine._compute_stream.cuda_stream),
                        tuple(source.shape), source.dtype, tuple(target.shape),
                        target.dtype, None if mask is None else (tuple(mask.shape), mask.dtype))
            state = cache.get(expected)
            if state is None or output.shape != source.shape:
                raise RuntimeError("Exact color graph failed to capture the requested key")
            results.append({"size": size, "masked": spec.masked,
                            "newKey": len(cache) > before,
                            "captureMs": (time.perf_counter() - start) * 1000.0})
    return {"eligible": True, "keys": results}


def prewarm(engine, specs):
    """Safe external entrypoint; never runs concurrently with a live session."""
    if engine._active_session_count() != 0:
        raise RuntimeError("Color graph prewarm requires no active sessions")
    frozen_specs = tuple(dict.fromkeys(specs))
    if not frozen_specs:
        return {"eligible": eligible_config(engine.config), "keys": []}
    return engine._run_gpu_work(
        prewarm_on_owner, work_label="exact-color-graph-prewarm",
        engine=engine, specs=frozen_specs,
    )
