"""Process-local experiment: overlap unchanged exact masks with the swap path.

The original temporal mask policy still runs at its original point and
consumes a speculative result only when it would have computed that exact
mask. A reuse decision discards the speculative result. The default heuristic
speculates likely exact frames; PONG_MASK_OVERLAP_POLICY=all speculates every
enabled mask. Use only in an isolated stage profile with frame CRCs.
"""

from concurrent.futures import ThreadPoolExecutor
import inspect
import math
import os
import sys
import textwrap
import traceback
import time


_MARK = "        mark_stage('alignedCrop')"
_INSERT = """        mark_stage('alignedCrop')
        self._isolated_mask_overlap_launch(
            pipeline_input_face, parameters, temporal_context,
        )"""
_MARK = textwrap.indent(textwrap.dedent(_MARK), "    ")
_INSERT = textwrap.indent(textwrap.dedent(_INSERT), "    ")
_DIRECT_DFL = "                mask = compute_dfl_xseg_mask()"
_DIRECT_DFL_REPLACEMENT = (
    "                mask = self._isolated_mask_overlap_consume("
    "'dflXSeg', compute_dfl_xseg_mask, temporal_context, "
    "pipeline_input_face, parameters=parameters)"
)
_PROBE_SOURCE = """        probe = v2.functional.resize(
            input_tensor.to(torch.float32),
            [64, 64],
            interpolation=v2.InterpolationMode.BILINEAR,
            antialias=False,
        )"""
_PROBE_REPLACEMENT = """        probe = self._isolated_mask_overlap_probe(
            temporal_context, key, input_tensor,
        )"""
_GUARD_SOURCE = """                delta = torch.abs(probe - prior_probe)
                metrics_evaluated = True
                local_delta = torch.mean(delta, dim=0, keepdim=True).unsqueeze(0)
                guard_tensors = [
                    torch.isfinite(delta).all(),
                    torch.mean(delta),
                    torch.nn.functional.avg_pool2d(local_delta, kernel_size=8, stride=8).max(),
                ]
                if local_guard:
                    guard_tensors.append(torch.nn.functional.avg_pool2d(
                        local_delta, kernel_size=2, stride=1,
                    ).max())
                guard_values = _read_guard_scalars(*guard_tensors)"""
_GUARD_REPLACEMENT = """                metrics_evaluated = True
                guard_values = self._isolated_mask_overlap_guard_values(
                    temporal_context, key, input_tensor, state, prior_probe,
                    probe, local_guard,
                )"""
_PROBE_SOURCE = textwrap.indent(textwrap.dedent(_PROBE_SOURCE), "    ")
_PROBE_REPLACEMENT = textwrap.indent(textwrap.dedent(_PROBE_REPLACEMENT), "    ")
_GUARD_SOURCE = textwrap.indent(textwrap.dedent(_GUARD_SOURCE), "            ")
_GUARD_REPLACEMENT = textwrap.indent(textwrap.dedent(_GUARD_REPLACEMENT), "            ")


def _side_state(self):
    state = getattr(self, "_isolated_mask_overlap", None)
    if state is not None:
        return state
    import torch
    stream = torch.cuda.Stream(device=0)
    state = {
        "stream": stream,
        "executor": ThreadPoolExecutor(max_workers=1, thread_name_prefix="mask-overlap"),
        "models": None, "vm": None,
        "mainModels": self.models,
        "pending": None, "launched": 0, "consumed": 0,
        "guardPending": None, "guardLaunched": 0, "guardUsed": 0,
        "guardFallback": 0, "discarded": 0, "fallbackExact": 0,
        "throttled": 0, "errors": [], "retired": [],
        "guidedExtra": 0, "guidedMaskCalls": 0,
    }
    self._isolated_mask_overlap = state
    return state


def _retired_complete(pending):
    future = pending["future"]
    if not future.done():
        return False
    if future.exception() is not None:
        # A worker can raise after enqueuing some kernels but before recording
        # its completion event. Retain owners until the side stream is drained.
        return False
    return pending["done"].query()


def _account_guided_discard(state, pending):
    if (not pending.get("guided") or "used" not in pending
            or pending.get("accounted") or not pending["future"].done()):
        return
    try:
        computed = set(pending["future"].result()["masks"])
    except Exception:
        computed = set()
    state["discarded"] += len(computed - pending["used"])
    pending["accounted"] = True


def _bound_retired(state):
    retired = state["retired"]
    for pending in retired:
        _account_guided_discard(state, pending)
    retired[:] = [pending for pending in retired if not _retired_complete(pending)]
    while len(retired) > 8:
        oldest = retired[0]
        try:
            oldest["future"].result()
        except Exception:
            state["stream"].synchronize()
            # Shutdown reports the recorded worker error.
        else:
            oldest["done"].synchronize()
        _account_guided_discard(state, oldest)
        retired.pop(0)


def _initialize_side(state):
    import torch
    from rope.Models import Models
    from rope.VideoManager import VideoManager

    side_stream = state["stream"]
    with torch.cuda.device(0), torch.cuda.stream(side_stream), torch.no_grad():
        side_models = state["models"]
        if side_models is None:
            main_models = state["mainModels"]
            side_models = Models()
            side_models._ordered_gpu_submission = bool(
                getattr(main_models, "_ordered_gpu_submission", False)
            )
            side_models._mask_cuda_graph = bool(
                getattr(main_models, "_mask_cuda_graph", False)
            )
            side_models._mask_backend_preference = str(
                getattr(main_models, "_mask_backend_preference", "cuda")
            )
            # These preferences are fixed for this isolated render. The side
            # sessions must make the same provider choice as the main models.
            side_models._backend_pref = dict(getattr(main_models, "_backend_pref", {}))
            side_models.set_models_folder(main_models.models_folder)
            side_models.set_shared_compute_stream(side_stream)
            side_vm = VideoManager(side_models)
            side_vm.shutdown_background_workers()
            state["models"], state["vm"] = side_models, side_vm
    return state["models"], state["vm"]


def _compute_side(state, pipeline_input_face, parameters, runtime_backend,
                  ready, done, occluder, dfl):
    import torch
    from rope.VideoManager import v2

    side_stream = state["stream"]
    with torch.cuda.device(pipeline_input_face.device), torch.cuda.stream(side_stream), torch.no_grad():
        side_models, side_vm = _initialize_side(state)
        side_models._mask_runtime_backend = runtime_backend
        side_stream.wait_event(ready)
        values = {}
        if occluder:
            values["occluder"] = v2.Resize((128, 128))(
                side_vm.apply_occlusion(
                    pipeline_input_face, parameters["OccluderSlider"],
                )
            )
        if dfl:
            value = side_vm.apply_dfl_xseg(
                pipeline_input_face, parameters["DFLXSegSizeSlider"],
            )
            value = v2.Resize((128, 128))(value)
            if parameters["DFLXSegBlurSlider"] > 0:
                value = side_vm._get_gaussian_blur(
                    parameters["DFLXSegBlurSlider"] * 2 + 1,
                    (parameters["DFLXSegBlurSlider"] + 1) * 0.2,
                )(value)
            values["dflXSeg"] = value
        done.record(side_stream)
        return values


def _prewarm_side(state, parameters, adaptive):
    import torch

    side_stream = state["stream"]
    with torch.cuda.device(0), torch.cuda.stream(side_stream), torch.no_grad():
        side_models, _ = _initialize_side(state)
        side_models.warm_mask_backends(parameters, adaptive=adaptive)
    side_stream.synchronize()


def prewarm(video_manager, parameters, *, adaptive=False):
    """Pay secondary-session cold cost before a benchmark starts measuring."""
    started = time.perf_counter()
    state = _side_state(video_manager)
    state["executor"].submit(
        _prewarm_side, state, dict(parameters), bool(adaptive)
    ).result()
    return {"seconds": time.perf_counter() - started,
            "adaptiveBackends": bool(adaptive)}


def _guard_probe(pipeline_input_face):
    import torch
    from rope.VideoManager import v2

    return v2.functional.resize(
        pipeline_input_face.to(torch.float32), [64, 64],
        interpolation=v2.InterpolationMode.BILINEAR,
        antialias=False,
    )


def _compute_guards(state, pipeline_input_face, entries, ready, done, identity=None):
    import torch

    side_stream = state["stream"]
    with torch.cuda.device(pipeline_input_face.device), torch.cuda.stream(side_stream), torch.no_grad():
        side_stream.wait_event(ready)
        results = {}
        # Every entry observes the identical current crop. The resize has no
        # history side effect; only its per-anchor delta differs. Keep the
        # single result owned until all entries finish on this side stream.
        probe = _guard_probe(pipeline_input_face) if entries else None
        for key, entry in entries.items():
            delta = torch.abs(probe - entry["priorProbe"])
            local_delta = torch.mean(delta, dim=0, keepdim=True).unsqueeze(0)
            guard_tensors = [
                torch.isfinite(delta).all(),
                torch.mean(delta),
                torch.nn.functional.avg_pool2d(
                    local_delta, kernel_size=8, stride=8,
                ).max(),
            ]
            if entry["localGuard"]:
                guard_tensors.append(torch.nn.functional.avg_pool2d(
                    local_delta, kernel_size=2, stride=1,
                ).max())
            # The original _read_guard_scalars stacks these exact reductions
            # before its D2H copy. Keep that stack, but copy asynchronously to
            # pinned host storage so the policy can read it after GPEN.
            host = torch.empty(
                (len(guard_tensors),), dtype=torch.float32, pin_memory=True,
            )
            host.copy_(torch.stack(guard_tensors), non_blocking=True)
            results[key] = {"probe": probe, "host": host}
        done.record(side_stream)
        return results


def _guard_requests_exact(values, entry):
    """Prediction only; the original temporal policy remains authoritative."""
    if len(values) < (4 if entry["localGuard"] else 3):
        return False
    if not bool(values[0]):
        return True
    mean, patch = float(values[1]), float(values[2])
    if (not math.isfinite(mean) or not math.isfinite(patch)
            or mean > entry["maxInputMae"]
            or patch > entry["maxPatchMae"]):
        return True
    return (entry["localGuard"]
            and float(values[3]) > entry["maxLocalPatchMae"])


def _compute_guided(state, pipeline_input_face, entries, ready, guard_done,
                    mask_done, identity, parameters, runtime_backend,
                    occluder, dfl):
    """Use already-required guard evidence to launch missed exact masks.

    The worker only chooses speculative computation. It neither updates
    anchors nor decides whether the renderer reuses or consumes a mask.
    """
    import torch

    guards = _compute_guards(
        state, pipeline_input_face, entries, ready, guard_done, identity,
    )
    guard_done.synchronize()  # Complete the existing pinned scalar copies.
    extra = {
        key for key, entry in entries.items()
        if _guard_requests_exact(guards[key]["host"].tolist(), entry)
    }
    run_occluder = bool(occluder or ("occluder" in extra))
    run_dfl = bool(dfl or ("dflXSeg" in extra))
    if run_occluder or run_dfl:
        masks = _compute_side(
            state, pipeline_input_face, parameters, runtime_backend,
            ready, mask_done, run_occluder, run_dfl,
        )
    else:
        with torch.cuda.device(pipeline_input_face.device), torch.cuda.stream(state["stream"]):
            mask_done.record(state["stream"])
        masks = {}
    state["guidedExtra"] += len(extra - {
        key for key, enabled in (("occluder", occluder), ("dflXSeg", dfl))
        if enabled
    })
    state["guidedMaskCalls"] += len(masks)
    return {"guards": guards, "masks": masks,
            "guidedExtra": sorted(extra - {
                key for key, enabled in (("occluder", occluder), ("dflXSeg", dfl))
                if enabled
            })}


def _guard_pending(self, context, key, input_tensor, anchor=None,
                   prior_probe=None, probe=None, local_guard=None):
    state = getattr(self, "_isolated_mask_overlap", None)
    pending = state["guardPending"] if state is not None else None
    if pending is None or key not in pending["entries"]:
        return None
    entry = pending["entries"][key]
    if (
        pending["context"] is not context
        or pending["frameIndex"] != int(context.get("frameIndex", 0))
        or pending["mediaTimeSeconds"] != context.get("mediaTimeSeconds")
        or pending["input"] is not input_tensor
        or pending["inputPtr"] != input_tensor.data_ptr()
        or pending["inputVersion"] != input_tensor._version
        or pending["inputShape"] != tuple(input_tensor.shape)
        or pending["inputStride"] != tuple(input_tensor.stride())
        or pending["inputDtype"] != input_tensor.dtype
        or pending["inputDevice"] != input_tensor.device
        or context.get(f"{key}Anchor") is not entry["anchor"]
        or entry["priorProbe"]._version != entry["priorVersion"]
        or (anchor is not None and anchor is not entry["anchor"])
        or (prior_probe is not None and prior_probe is not entry["priorProbe"])
        or (local_guard is not None and local_guard != entry["localGuard"])
    ):
        return None
    if pending["results"] is None:
        payload = pending["future"].result()
        pending["results"] = payload["guards"] if pending.get("guided") else payload
    result = pending["results"][key]
    if probe is not None and probe is not result["probe"]:
        return None
    return pending, result


def _probe(self, context, key, input_tensor):
    import torch
    from rope.VideoManager import v2

    match = _guard_pending(self, context, key, input_tensor)
    if match is not None:
        pending, result = match
        main_stream = torch.cuda.current_stream(input_tensor.device)
        main_stream.wait_event(pending["done"])
        result["probe"].record_stream(main_stream)
        return result["probe"]
    return v2.functional.resize(
        input_tensor.to(torch.float32), [64, 64],
        interpolation=v2.InterpolationMode.BILINEAR, antialias=False,
    )


def _guard_values(self, context, key, input_tensor, anchor, prior_probe,
                  probe, local_guard):
    import torch
    from rope.VideoManager import _read_guard_scalars

    match = _guard_pending(
        self, context, key, input_tensor, anchor, prior_probe,
        probe, local_guard,
    )
    if match is not None:
        pending, result = match
        pending["done"].synchronize()
        self._isolated_mask_overlap["guardUsed"] += 1
        return result["host"].tolist()
    state = getattr(self, "_isolated_mask_overlap", None)
    if state is not None:
        state["guardFallback"] += 1
    delta = torch.abs(probe - prior_probe)
    local_delta = torch.mean(delta, dim=0, keepdim=True).unsqueeze(0)
    guard_tensors = [
        torch.isfinite(delta).all(),
        torch.mean(delta),
        torch.nn.functional.avg_pool2d(
            local_delta, kernel_size=8, stride=8,
        ).max(),
    ]
    if local_guard:
        guard_tensors.append(torch.nn.functional.avg_pool2d(
            local_delta, kernel_size=2, stride=1,
        ).max())
    return _read_guard_scalars(*guard_tensors)


def _likely_exact(context, key, *, current_policy=False):
    from rope.VideoManager import _temporal_elapsed_seconds

    if not context or not context.get("enabled"):
        return True
    state = context.get(f"{key}Anchor")
    if not state or current_policy or context.get("forceExact", False):
        return True
    frame_age = int(context.get("frameIndex", 0)) - int(state.get("frameIndex", -1))
    if frame_age <= 0 or frame_age >= max(1, int(context.get("maxAnchorFrames", 1))):
        return True
    mask_hz = float(context.get("maskAnchorHz", 0.0) or 0.0)
    if mask_hz > 0 and _temporal_elapsed_seconds(context, state) >= 1.0 / mask_hz - 1e-6:
        return True
    last = (context.get("lastStageDecisions") or {}).get(key) or {}
    return last.get("primaryReason") in {
        "patch-disagreement", "mean-disagreement", "local-patch-disagreement",
    }


def _launch(self, pipeline_input_face, parameters, temporal_context):
    import torch

    policy = os.environ.get("PONG_MASK_OVERLAP_POLICY", "likely").lower()
    if policy not in {"all", "likely", "guarded"}:
        raise ValueError("PONG_MASK_OVERLAP_POLICY must be all, likely or guarded")
    occluder = bool(parameters["OccluderSwitch"]) and (
        policy == "all" or _likely_exact(
            temporal_context, "occluder", current_policy=bool(
                temporal_context and temporal_context.get(
                    "currentOccluder", temporal_context.get("currentMasks", False)
                )
            ),
        )
    )
    dfl = bool(parameters["DFLXSegSwitch"]) and (
        policy == "all" or _likely_exact(
            temporal_context, "dflXSeg", current_policy=not bool(
                temporal_context and temporal_context.get("dflXSegReuseEnabled", False)
            ) or bool(temporal_context and temporal_context.get("currentMasks", False)),
        )
    )
    guard_entries = {}
    def threshold(name, default):
        try:
            return float(temporal_context.get(name, default))
        except (TypeError, ValueError, OverflowError):
            # The original policy will handle invalid settings at its usual
            # evaluation point; speculation simply declines this prediction.
            return math.inf

    if temporal_context and temporal_context.get("enabled"):
        for key, enabled in (
            ("occluder", bool(parameters["OccluderSwitch"])),
            ("dflXSeg", bool(parameters["DFLXSegSwitch"])
             and bool(temporal_context.get("dflXSegReuseEnabled", False))),
        ):
            if not enabled:
                continue
            anchor = temporal_context.get(f"{key}Anchor")
            prior_probe = anchor.get("probe") if isinstance(anchor, dict) else None
            prior_mask = anchor.get("mask") if isinstance(anchor, dict) else None
            if (not isinstance(prior_probe, torch.Tensor)
                    or not isinstance(prior_mask, torch.Tensor)
                    or tuple(prior_probe.shape) != (int(pipeline_input_face.shape[0]), 64, 64)):
                continue
            guard_entries[key] = {
                "anchor": anchor, "priorProbe": prior_probe,
                "priorVersion": prior_probe._version,
                "localGuard": bool(
                    temporal_context.get("maskLocalChangeGuardEnabled", False)
                ),
                "maxInputMae": threshold("maxMaskInputMae", 16.0),
                "maxPatchMae": threshold("maxMaskPatchMae", 30.0),
                "maxLocalPatchMae": threshold("maxMaskLocalPatchMae", 30.0),
            }
    state = getattr(self, "_isolated_mask_overlap", None)
    if state is not None:
        _bound_retired(state)
        prior_mask = state["pending"]
        prior_guard = state["guardPending"]
        for prior in (prior_mask, prior_guard):
            if prior is not None:
                state["retired"].append(prior)
        _bound_retired(state)
        if prior_mask is not None:
            if prior_mask.get("guided"):
                _account_guided_discard(state, prior_mask)
            else:
                state["discarded"] += len(prior_mask["keys"] - prior_mask["used"])
        state["pending"] = None
        state["guardPending"] = None
        if any(
            prior is not None and not prior["future"].done()
            for prior in (prior_mask, prior_guard)
        ):
            # Never build an unbounded queue of obsolete speculative frames.
            state["throttled"] += 1
            return
    if not (occluder or dfl or guard_entries):
        return
    if state is None:
        state = _side_state(self)
    side_stream = state["stream"]
    main_stream = torch.cuda.current_stream(pipeline_input_face.device)
    ready = torch.cuda.Event()
    ready.record(main_stream)
    pipeline_input_face.record_stream(side_stream)
    def record_error(completed):
        exc = completed.exception()
        if exc is not None and len(state["errors"]) < 5:
            state["errors"].append("".join(traceback.format_exception(
                type(exc), exc, exc.__traceback__,
            )))
    runtime_backend = self.models._mask_runtime_backend
    if isinstance(runtime_backend, dict):
        runtime_backend = dict(runtime_backend)
    if policy == "guarded" and guard_entries:
        for entry in guard_entries.values():
            entry["priorProbe"].record_stream(side_stream)
        guard_done = torch.cuda.Event()
        mask_done = torch.cuda.Event()
        future = state["executor"].submit(
            _compute_guided, state, pipeline_input_face, guard_entries,
            ready, guard_done, mask_done, state.get("identityLaunch"),
            dict(parameters), runtime_backend, occluder, dfl,
        )
        future.add_done_callback(record_error)
        state["guardPending"] = {
            "future": future, "done": guard_done, "guided": True,
            "entries": guard_entries, "results": None,
            "context": temporal_context,
            "frameIndex": int(temporal_context.get("frameIndex", 0)),
            "mediaTimeSeconds": temporal_context.get("mediaTimeSeconds"),
            "input": pipeline_input_face,
            "inputPtr": pipeline_input_face.data_ptr(),
            "inputVersion": pipeline_input_face._version,
            "inputShape": tuple(pipeline_input_face.shape),
            "inputStride": tuple(pipeline_input_face.stride()),
            "inputDtype": pipeline_input_face.dtype,
            "inputDevice": pipeline_input_face.device,
        }
        state["guardLaunched"] += 1
        state["pending"] = {
            "future": future, "guided": True, "keys": {
                key for key, enabled in (("occluder", bool(parameters["OccluderSwitch"])),
                                         ("dflXSeg", bool(parameters["DFLXSegSwitch"])))
                if enabled
            }, "done": mask_done, "used": set(),
            "context": temporal_context,
            "frameIndex": int(temporal_context.get("frameIndex", 0)),
            "mediaTimeSeconds": temporal_context.get("mediaTimeSeconds"),
            "input": pipeline_input_face,
            "inputPtr": pipeline_input_face.data_ptr(),
            "inputVersion": pipeline_input_face._version,
            "inputShape": tuple(pipeline_input_face.shape),
            "inputStride": tuple(pipeline_input_face.stride()),
            "inputDtype": pipeline_input_face.dtype,
            "inputDevice": pipeline_input_face.device,
            "occluderSlider": int(parameters["OccluderSlider"]),
            "dflSize": int(parameters["DFLXSegSizeSlider"]),
            "dflBlur": int(parameters["DFLXSegBlurSlider"]),
            "runtimeBackend": runtime_backend,
        }
        state["launched"] += 1
        return
    if guard_entries:
        for entry in guard_entries.values():
            entry["priorProbe"].record_stream(side_stream)
        guard_done = torch.cuda.Event()
        guard_future = state["executor"].submit(
            _compute_guards, state, pipeline_input_face,
            guard_entries, ready, guard_done, state.get("identityLaunch"),
        )
        guard_future.add_done_callback(record_error)
        state["guardPending"] = {
            "future": guard_future, "done": guard_done,
            "entries": guard_entries, "results": None,
            "context": temporal_context,
            "frameIndex": int(temporal_context.get("frameIndex", 0)),
            "mediaTimeSeconds": temporal_context.get("mediaTimeSeconds"),
            "input": pipeline_input_face,
            "inputPtr": pipeline_input_face.data_ptr(),
            "inputVersion": pipeline_input_face._version,
            "inputShape": tuple(pipeline_input_face.shape),
            "inputStride": tuple(pipeline_input_face.stride()),
            "inputDtype": pipeline_input_face.dtype,
            "inputDevice": pipeline_input_face.device,
        }
        state["guardLaunched"] += 1
    if not (occluder or dfl):
        return
    done = torch.cuda.Event()
    future = state["executor"].submit(
        _compute_side, state, pipeline_input_face, dict(parameters),
        runtime_backend, ready, done, occluder, dfl,
    )
    future.add_done_callback(record_error)
    state["pending"] = {
        "future": future, "keys": {key for key, enabled in
                                   (("occluder", occluder), ("dflXSeg", dfl)) if enabled},
        "done": done, "used": set(),
        "context": temporal_context,
        "frameIndex": int(temporal_context.get("frameIndex", 0)) if temporal_context else None,
        "mediaTimeSeconds": temporal_context.get("mediaTimeSeconds") if temporal_context else None,
        "input": pipeline_input_face,
        "inputPtr": pipeline_input_face.data_ptr(),
        "inputVersion": pipeline_input_face._version,
        "inputShape": tuple(pipeline_input_face.shape),
        "inputStride": tuple(pipeline_input_face.stride()),
        "inputDtype": pipeline_input_face.dtype,
        "inputDevice": pipeline_input_face.device,
        "occluderSlider": int(parameters["OccluderSlider"]),
        "dflSize": int(parameters["DFLXSegSizeSlider"]),
        "dflBlur": int(parameters["DFLXSegBlurSlider"]),
        "runtimeBackend": runtime_backend,
    }
    state["launched"] += 1


def _mask_pending_matches(pending, key, context, input_tensor, signature=None,
                          parameters=None, runtime_backend=None):
    if (pending is None or key not in pending["keys"] or key in pending["used"]
            or pending["context"] is not context
            or pending["frameIndex"] != (int(context.get("frameIndex", 0)) if context else None)
            or pending["mediaTimeSeconds"] != (context.get("mediaTimeSeconds") if context else None)
            or pending["input"] is not input_tensor
            or pending["inputPtr"] != input_tensor.data_ptr()
            or pending["inputVersion"] != input_tensor._version
            or pending["inputShape"] != tuple(input_tensor.shape)
            or pending["inputStride"] != tuple(input_tensor.stride())
            or pending["inputDtype"] != input_tensor.dtype
            or pending["inputDevice"] != input_tensor.device
            or pending["runtimeBackend"] != runtime_backend):
        return False
    if key == "occluder":
        return (signature is not None and len(signature) >= 2
                and signature[0] == "occluder"
                and int(signature[1]) == pending["occluderSlider"])
    if signature is not None:
        return (len(signature) >= 3 and signature[0] == "dflXSeg"
                and int(signature[1]) == pending["dflSize"]
                and int(signature[2]) == pending["dflBlur"])
    return (parameters is not None
            and int(parameters["DFLXSegSizeSlider"]) == pending["dflSize"]
            and int(parameters["DFLXSegBlurSlider"]) == pending["dflBlur"])


def _consume(self, key, original_compute, context, input_tensor, signature=None,
             parameters=None):
    import torch

    state = getattr(self, "_isolated_mask_overlap", None)
    pending = state["pending"] if state is not None else None
    runtime_backend = self.models._mask_runtime_backend
    if isinstance(runtime_backend, dict):
        runtime_backend = dict(runtime_backend)
    if not _mask_pending_matches(pending, key, context, input_tensor,
                                 signature, parameters, runtime_backend):
        if state is not None:
            state["fallbackExact"] += 1
        return original_compute()
    main_stream = torch.cuda.current_stream()
    payload = pending["future"].result()
    values = payload["masks"] if pending.get("guided") else payload
    if key not in values:
        state["fallbackExact"] += 1
        return original_compute()
    main_stream.wait_event(pending["done"])
    result = values[key]
    result.record_stream(main_stream)
    pending["used"].add(key)
    state["consumed"] += 1
    return result


def install(video_manager_class=None):
    """Patch only current process; exact source guard rejects drift."""
    if video_manager_class is None:
        from rope.VideoManager import VideoManager as video_manager_class
    # Fake VideoManager classes used by CPU tests have no Pong graph captures.
    # The real VM and GPEN runtime switch only their capture error mode, so a
    # side-thread mask submission cannot invalidate a new main-thread graph.
    from experiment_capture_ownership import install as install_capture_ownership
    install_capture_ownership(video_manager_class)
    module = sys.modules[video_manager_class.__module__]
    original_core = video_manager_class.swap_core
    source = textwrap.dedent(inspect.getsource(original_core))
    if source.count(_MARK) != 1:
        raise RuntimeError("Aligned-crop launch point changed")
    if source.count(_DIRECT_DFL) != 1:
        raise RuntimeError("Direct DFL XSeg exact branch changed")
    source = source.replace(_DIRECT_DFL, _DIRECT_DFL_REPLACEMENT)
    scope = {}
    exec(compile(source.replace(_MARK, _INSERT), str(module.__file__), "exec"),
         module.__dict__, scope)
    policy_source = textwrap.dedent(inspect.getsource(
        video_manager_class._temporal_mask_result
    ))
    if policy_source.count(_PROBE_SOURCE) != 1:
        raise RuntimeError("Mask probe source changed")
    if policy_source.count(_GUARD_SOURCE) != 1:
        raise RuntimeError("Mask guard source changed")
    policy_source = policy_source.replace(
        _PROBE_SOURCE, _PROBE_REPLACEMENT,
    ).replace(_GUARD_SOURCE, _GUARD_REPLACEMENT)
    policy_scope = {}
    exec(compile(policy_source, str(module.__file__), "exec"),
         module.__dict__, policy_scope)
    original_policy = policy_scope["_temporal_mask_result"]
    original_shutdown = video_manager_class.shutdown_background_workers

    def policy(self, context, key, input_tensor, signature, compute,
               *args, **kwargs):
        if key in ("occluder", "dflXSeg"):
            original = compute
            compute = lambda: _consume(self, key, original, context,
                                       input_tensor, signature=signature)
        return original_policy(
            self, context, key, input_tensor, signature, compute,
            *args, **kwargs,
        )

    def shutdown(self):
        state = getattr(self, "_isolated_mask_overlap", None)
        errors = []
        if state is not None:
            state["executor"].shutdown(wait=True, cancel_futures=False)
            state["stream"].synchronize()
            pending = state["pending"]
            if pending is not None:
                if pending.get("guided"):
                    _account_guided_discard(state, pending)
                else:
                    state["discarded"] += len(
                        pending["keys"] - pending["used"]
                    )
            for retired in state["retired"]:
                _account_guided_discard(state, retired)
            if state["models"] is not None:
                state["models"].delete_models()
            print("[mask-overlap]", {
                key: state[key] for key in
                ("launched", "consumed", "discarded", "fallbackExact", "throttled",
                 "guardLaunched", "guardUsed", "guardFallback", "guidedExtra",
                 "guidedMaskCalls")
            } | {"errors": state["errors"]}, flush=True)
            errors = list(state["errors"])
            self._isolated_mask_overlap = None
        result = original_shutdown(self)
        if errors:
            raise RuntimeError(f"Secondary mask task failed: {errors[0]}")
        return result

    video_manager_class._isolated_mask_overlap_launch = _launch
    video_manager_class._isolated_mask_overlap_consume = _consume
    video_manager_class._isolated_mask_overlap_probe = _probe
    video_manager_class._isolated_mask_overlap_guard_values = _guard_values
    video_manager_class.swap_core = scope[original_core.__name__]
    video_manager_class.swap_core._isolated_source = source.replace(_MARK, _INSERT)
    video_manager_class._temporal_mask_result = policy
    video_manager_class.shutdown_background_workers = shutdown
    return video_manager_class
