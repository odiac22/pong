"""Isolated CUDA-graph experiment for the accepted identity-residual branch.

Import ``install`` before an isolated stage-profile run. Production files and
settings are untouched. No GPU work occurs merely by importing this module.
The CLI compares two ``--capture-frame-hashes`` stage-profile reports.
"""

from collections import OrderedDict
import inspect
import json
from pathlib import Path
import sys
import textwrap


_OLD = """        local_change = torch.clamp(
            (source_delta - change_low) / (change_high - change_low),
            0.0,
            1.0,
        )
        # A small spatial average prevents sensor/compression noise from
        # puncturing the stabilized region while still following thin moving
        # objects and feature edges.
        local_change = torch.nn.functional.avg_pool2d(
            local_change.unsqueeze(0),
            kernel_size=3,
            stride=1,
            padding=1,
        )[0]
        alpha = current_weight + (1.0 - current_weight) * local_change
        stabilized_residual = torch.lerp(
            prior_residual.to(torch.float32),
            residual,
            alpha,
        )
        output = (current_input + stabilized_residual).clamp_(0.0, 255.0)"""

_NEW = """        output, stabilized_residual = self._isolated_identity_graph_apply(
            current_input, prior_residual, residual, source_delta,
            current_weight, change_low, change_high,
        )"""
_OLD = textwrap.indent(textwrap.dedent(_OLD), "    ")
_NEW = textwrap.indent(textwrap.dedent(_NEW), "    ")


def _ops(current_input, prior_residual, residual, source_delta,
         current_weight, change_low, change_high):
    # Keep the exact PyTorch operations and Python-float scalar arguments from
    # VideoManager._temporal_identity_residual, in their original order.
    import torch

    local_change = torch.clamp(
        (source_delta - change_low) / (change_high - change_low),
        0.0,
        1.0,
    )
    local_change = torch.nn.functional.avg_pool2d(
        local_change.unsqueeze(0), kernel_size=3, stride=1, padding=1,
    )[0]
    alpha = current_weight + (1.0 - current_weight) * local_change
    stabilized_residual = torch.lerp(
        prior_residual.to(torch.float32), residual, alpha,
    )
    output = (current_input + stabilized_residual).clamp_(0.0, 255.0)
    return output, stabilized_residual


def _apply(self, current_input, prior_residual, residual, source_delta,
           current_weight, change_low, change_high):
    import torch

    stream = torch.cuda.current_stream(current_input.device)
    key = (
        str(current_input.device), int(stream.cuda_stream),
        tuple(current_input.shape), current_input.dtype,
        tuple(prior_residual.shape), prior_residual.dtype,
        tuple(residual.shape), residual.dtype,
        tuple(source_delta.shape), source_delta.dtype,
        float(current_weight).hex(), float(change_low).hex(),
        float(change_high).hex(),
    )
    state = getattr(self, "_isolated_identity_graph_state", None)
    if state is None:
        state = self._isolated_identity_graph_state = {
            "graphs": OrderedDict(), "seen": {}, "error": None,
            "replays": 0, "eager": 0, "captures": 0,
        }
    graphs = state["graphs"]
    entry = graphs.get(key)
    if entry is None:
        # Capture only frequent exact scalar/shape keys. Binary PTS math can
        # yield several weights for a nominally fixed FPS, so avoid capturing
        # rare values and bound the substantial static tensor/graph memory.
        seen = state["seen"]
        if key in seen or len(seen) < 256:
            seen[key] = seen.get(key, 0) + 1
        if seen.get(key, 0) < 8 or len(graphs) >= 4 or state["error"]:
            state["eager"] += 1
            return _ops(current_input, prior_residual, residual, source_delta,
                        current_weight, change_low, change_high)
        try:
            static = tuple(value.clone() for value in
                           (current_input, prior_residual, residual, source_delta))
            for _ in range(3):
                _ops(*static, current_weight, change_low, change_high)
            stream.synchronize()
            graph = torch.cuda.CUDAGraph()
            with torch.cuda.graph(graph, stream=stream, capture_error_mode='thread_local'):
                output, stable_residual = _ops(
                    *static, current_weight, change_low, change_high,
                )
            entry = (graph, static, output, stable_residual)
            graphs[key] = entry
            state["captures"] += 1
        except Exception as exc:
            state["error"] = f"{type(exc).__name__}: {exc}"
            state["eager"] += 1
            return _ops(current_input, prior_residual, residual, source_delta,
                        current_weight, change_low, change_high)
    else:
        graphs.move_to_end(key)
    graph, static, output, stable_residual = entry
    for destination, source in zip(static,
                                   (current_input, prior_residual, residual, source_delta)):
        destination.copy_(source)
    graph.replay()
    state["replays"] += 1
    # The output escapes to later pipeline stages. The graph's static output
    # must not be overwritten by a later replay while still referenced.
    return output.clone(), stable_residual


def install(video_manager_class=None):
    """Patch only this process's VideoManager; fail closed on source drift."""
    if video_manager_class is None:
        from rope.VideoManager import VideoManager as video_manager_class
    module = sys.modules[video_manager_class.__module__]
    original = video_manager_class._temporal_identity_residual
    source = textwrap.dedent(inspect.getsource(original))
    if source.count(_OLD) != 1:
        raise RuntimeError("Identity-residual source no longer matches experiment")
    scope = {}
    exec(compile(source.replace(_OLD, _NEW), str(module.__file__), "exec"),
         module.__dict__, scope)
    video_manager_class._isolated_identity_graph_apply = _apply
    video_manager_class._temporal_identity_residual = scope[original.__name__]
    return video_manager_class


def compare_reports(baseline_path, candidate_path):
    """Require identical frame CRCs and temporal decisions; return FPS data."""
    baseline = json.loads(Path(baseline_path).read_text(encoding="utf-8"))
    candidate = json.loads(Path(candidate_path).read_text(encoding="utf-8"))
    a, b = baseline["result"], candidate["result"]
    if baseline["settings"] != candidate["settings"]:
        raise AssertionError("Full settings differ")
    for field in ("source", "seconds"):
        if baseline[field] != candidate[field]:
            raise AssertionError(f"{field} differs")
    ah = a["transformation"]["frameHashProvenance"]
    bh = b["transformation"]["frameHashProvenance"]
    for field in ("source", "preEncoder"):
        if not ah[field] or not bh[field]:
            raise AssertionError(f"{field} CRCs were not captured")
        if ah[field] != bh[field]:
            raise AssertionError(f"{field} frame CRCs differ")
    ta, tb = a["transformation"], b["transformation"]
    counter_names = (
        "exactFrames", "reusedFrames", "restorerExactFrames",
        "restorerReusedFrames", "identityResidualExactFrames",
        "identityResidualReusedFrames", "occluderExactFrames",
        "occluderReusedFrames", "dflXSegExactFrames", "dflXSegReusedFrames",
        "faceParserExactFrames", "faceParserReusedFrames",
        "stageDecisionCounts",
    )
    for field in counter_names:
        if ta.get(field) != tb.get(field):
            raise AssertionError(f"Temporal counter differs: {field}")
    if a["encoded"]["videoFrames"] != b["encoded"]["videoFrames"]:
        raise AssertionError("Encoded frame count differs")
    return {
        "frames": len(ah["preEncoder"]),
        "baselineFps": a["timing"]["processingFps"],
        "candidateFps": b["timing"]["processingFps"],
        "pixelAndTemporalParity": True,
    }


if __name__ == "__main__":
    if len(sys.argv) == 3:
        print(json.dumps(compare_reports(sys.argv[1], sys.argv[2]), indent=2))
    else:
        raise SystemExit("Usage: experiment_identity_graph.py BASELINE_REPORT CANDIDATE_REPORT")
