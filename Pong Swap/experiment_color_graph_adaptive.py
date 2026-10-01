"""Opt-in exact eager fallback for uncached, variable-size color crops.

The frozen color graph is replayed for existing exact keys. An unseen key
uses the same qualified LAB implementation eagerly, avoiding an expensive
capture and eviction for crops whose dimensions vary from frame to frame.
No model, color formula, mask policy, or preset is changed.
"""

from collections import Counter
import threading
import weakref


def graph_key(torch, swap, target, valid_mask):
    stream = torch.cuda.current_stream(swap.device)
    return (str(swap.device), int(stream.cuda_stream), tuple(swap.shape), swap.dtype,
            tuple(target.shape), target.dtype,
            None if valid_mask is None else (tuple(valid_mask.shape), valid_mask.dtype))


def install_on_vm(vm, torch, lab_color, *, enabled_for_call=None):
    state = getattr(vm, "_adaptive_color_graph_state", None)
    if state is not None:
        return state
    original = vm._match_color
    original_fn = getattr(original, "__func__", None)
    if original_fn is None:
        raise RuntimeError("Expected an unmodified bound VM color method")
    owner_ref = weakref.ref(vm)
    state = {"graphHits": 0, "eagerMisses": 0, "eagerSizes": Counter(),
             "lock": threading.Lock(),
             "originalFallbacks": 0}

    def adaptive(swap, target, valid_mask=None):
        owner = owner_ref()
        if owner is None:
            raise RuntimeError("Color VM was retired during a queued call")
        if ((enabled_for_call is not None and not enabled_for_call())
                or not getattr(owner, "color_match_cuda_graph_enabled", False)
                or not swap.is_cuda or swap.dtype not in (torch.uint8, torch.float32)
                or target.dtype not in (torch.uint8, torch.float32)):
            with state["lock"]:
                state["originalFallbacks"] += 1
            return original_fn(owner, swap, target, valid_mask)
        key = graph_key(torch, swap, target, valid_mask)
        cache = getattr(owner, "_color_match_graphs", {})
        if key in cache and cache[key] is not None:
            with state["lock"]:
                state["graphHits"] += 1
            return original_fn(owner, swap, target, valid_mask)
        # These two in-place clamps are the original graph-enabled path's
        # observable FP32 side effect. The same LAB function then executes
        # every original operation and reduction in the original order.
        if swap.dtype == torch.float32:
            swap.clamp_(0, 255)
        if target.dtype == torch.float32:
            target.clamp_(0, 255)
        with state["lock"]:
            state["eagerMisses"] += 1
            state["eagerSizes"][tuple(swap.shape)] += 1
        return lab_color(swap, target, valid_mask)

    vm._match_color = adaptive
    vm._adaptive_color_graph_state = state
    return state


def status(state):
    with state["lock"]:
        return {"graphHits": state["graphHits"],
                "eagerMisses": state["eagerMisses"],
                "originalFallbacks": state["originalFallbacks"],
                "eagerSizes": {"x".join(map(str, key)): value
                               for key, value in state["eagerSizes"].items()}}
