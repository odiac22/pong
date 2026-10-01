"""Isolated exact detector/recognizer prefetch for the next decoded frame.

Only model observations are speculative. The original next-frame tracker,
identity association, rejection reasons, and context updates run unchanged.
Use with source/CRC and temporal-decision parity checks, never in production.
"""

from concurrent.futures import ThreadPoolExecutor
import inspect
import sys
import textwrap
import time
import zlib


_MARK = '                mark_cuda("target")'
_INSERT = '''                mark_cuda("target")
                self._isolated_detection_prefetch_launch(
                    next_frame, effective_config, temporal_context,
                    tracking_state, cancel_event,
                )'''
_MARK = textwrap.indent(textwrap.dedent(_MARK), "            ")
_INSERT = textwrap.indent(textwrap.dedent(_INSERT), "            ")
_RECOGNIZE_SOURCE = '''                    embedding, _ = self._models.run_recognize(
                        img_chw,
                        candidate_kps,
                        return_crop=False,
                    )'''
_RECOGNIZE_REPLACEMENT = '''                    embedding, _ = self._isolated_detection_prefetch_embedding(
                        img_chw, candidate_kps,
                    )'''
_RECOGNIZE_SOURCE = textwrap.indent(textwrap.dedent(_RECOGNIZE_SOURCE), "                ")
_RECOGNIZE_REPLACEMENT = textwrap.indent(textwrap.dedent(_RECOGNIZE_REPLACEMENT), "                ")
_ORIGINALS = None


def _detector_signature(config, main_models):
    params = config["parameters"]
    runtime = config["runtime"]
    return (
        str(params.get("DetectTypeTextSel", "SCRDF")),
        int(params.get("DetectInputSizeTextSel", 320)),
        int(runtime.get("targetDetectIntervalFrames", 1)),
        int(runtime.get("identityCheckIntervalFrames", 12)),
        tuple(sorted((str(k), str(v)) for k, v in main_models._backend_pref.items())),
        str(main_models.models_folder),
    )


def _state(engine):
    state = getattr(engine, "_isolated_detection_prefetch", None)
    if state is not None:
        return state
    import torch

    state = {
        "stream": torch.cuda.Stream(device=0),
        "executor": ThreadPoolExecutor(max_workers=1, thread_name_prefix="detect-prefetch"),
        "models": None,
        "mainModels": engine._models,
        "originalDetect": _ORIGINALS[0],
        "originalFrameTensor": _ORIGINALS[1],
        "pending": None,
        "launched": 0,
        "used": 0,
        "discarded": 0,
        "fallback": 0,
        "throttled": 0,
        "recognitionLaunched": 0,
        "errors": [],
    }
    engine._isolated_detection_prefetch = state
    return state


def _side_models(state):
    import torch
    from rope.Models import Models

    if state["models"] is not None:
        return state["models"]
    side = Models()
    main = state["mainModels"]
    side._backend_pref = dict(main._backend_pref)
    side._ordered_gpu_submission = bool(getattr(main, "_ordered_gpu_submission", False))
    side.set_models_folder(main.models_folder)
    side.set_shared_compute_stream(state["stream"])
    state["models"] = side
    return side


def _freeze_rows(rows):
    frozen = []
    for area, kps, embedding in rows:
        # Make the prefetch result independent of the side model's scratch
        # buffers, while leaving the original association order untouched.
        frozen_kps = kps.copy()
        frozen_kps.setflags(write=False)
        frozen_embedding = None if embedding is None else embedding.copy()
        if frozen_embedding is not None:
            frozen_embedding.setflags(write=False)
        frozen.append((
            float(area),
            frozen_kps,
            frozen_embedding,
        ))
    return tuple(frozen)


def _compute(state, original_detect, original_frame_tensor, next_frame,
             config, recognize, cancel_event):
    import numpy as np
    import torch
    from types import SimpleNamespace

    if cancel_event is not None and cancel_event.is_set():
        return None
    frozen_frame = np.array(next_frame, dtype=np.uint8, copy=True, order="C")
    frame_crc = zlib.crc32(memoryview(frozen_frame).cast("B"))
    if cancel_event is not None and cancel_event.is_set():
        return None
    side_stream = state["stream"]
    with torch.cuda.device(0), torch.cuda.stream(side_stream), torch.no_grad():
        models = _side_models(state)
        proxy = SimpleNamespace(_models=models, _config=config, _torch=torch)
        img_chw = original_frame_tensor(proxy, frozen_frame)
        rows = original_detect(
            proxy, img_chw, recognize=recognize,
            config=config, max_faces=10,
        )
        side_stream.synchronize()
    return frame_crc, _freeze_rows(rows), recognize


def _prewarm_side(state, original_frame_tensor, original_detect, config):
    import numpy as np
    import torch
    from types import SimpleNamespace

    side_stream = state["stream"]
    with torch.cuda.device(0), torch.cuda.stream(side_stream), torch.no_grad():
        models = _side_models(state)
        proxy = SimpleNamespace(_models=models, _config=config, _torch=torch)
        dummy = np.zeros((256, 256, 3), dtype=np.uint8)
        image = original_frame_tensor(proxy, dummy)
        original_detect(proxy, image, recognize=False, config=config, max_faces=10)
        # A scheduled identity deadline may ask this same side session to
        # enrich every candidate. Prepare ArcFace outside benchmark timing.
        kps = np.array([
            [86.3, 111.7], [159.7, 111.5], [128.0, 151.5],
            [92.9, 189.7], [151.1, 189.4],
        ], dtype=np.float32)
        models.run_recognize(image, kps, return_crop=False)
        side_stream.synchronize()


def prewarm(engine, config=None):
    """Called only after engine.warm and before benchmark timing starts."""
    state = _state(engine)
    config = engine._config if config is None else config
    started = time.perf_counter()
    state["executor"].submit(
        _prewarm_side, state,
        state["originalFrameTensor"], state["originalDetect"], config,
    ).result()
    return {"seconds": time.perf_counter() - started}


def _launch(self, next_frame, config, temporal_context,
            tracking_state, cancel_event):
    import numpy as np

    if (not isinstance(next_frame, np.ndarray)
            or temporal_context is None
            or tracking_state is None
            or self._models is None
            or (cancel_event is not None and cancel_event.is_set())):
        return
    state = _state(self)
    prior = state["pending"]
    state["pending"] = None
    if prior is not None:
        state["discarded"] += 1
        if not prior["future"].done():
            state["throttled"] += 1
            return
    next_index = int(temporal_context.get("frameIndex", -1)) + 1
    if next_index <= 0:
        return
    signature = _detector_signature(config, self._models)
    # SCRDF currently creates an unbound CUDA session. This experiment only
    # admits Retinaface, whose ORT session binds the secondary CUDA stream.
    if signature[0] != "Retinaface":
        return
    detect_interval = max(1, signature[2])
    identity_interval = max(1, signature[3])
    next_identity_due = next_index % identity_interval == 0
    scheduled_detection = (
        tracking_state.get("kps") is None
        or int(tracking_state.get("sinceDetect", detect_interval)) >= detect_interval
        or next_identity_due
    )
    if not scheduled_detection:
        return
    recognize = next_identity_due or tracking_state.get("kps") is None
    frozen_config = {
        "parameters": dict(config["parameters"]),
        "runtime": dict(config["runtime"]),
    }
    future = state["executor"].submit(
        _compute, state, state["originalDetect"],
        state["originalFrameTensor"], next_frame, frozen_config,
        recognize, cancel_event,
    )
    def record_error(completed):
        exc = completed.exception()
        if exc is not None and len(state["errors"]) < 5:
            state["errors"].append(repr(exc))
    future.add_done_callback(record_error)
    state["pending"] = {
        "future": future,
        "frame": next_frame,
        "frameIndex": next_index,
        "trackingState": tracking_state,
        "context": temporal_context,
        "trackGeneration": int(tracking_state.get("trackGeneration", 0)),
        "signature": signature,
        "vm": self._vm,
    }
    state["launched"] += 1
    state["recognitionLaunched"] += int(recognize)


def _embedding(self, img_chw, candidate_kps):
    import numpy as np

    active = getattr(self, "_isolated_detection_active", None)
    if active is not None:
        prefetched = active.get("prefetchedEmbeddings")
        if prefetched:
            for index, (known_kps, embedding) in enumerate(prefetched):
                if embedding is not None and np.array_equal(
                    candidate_kps, known_kps,
                ):
                    prefetched.pop(index)
                    return embedding.copy(), None
    return self._models.run_recognize(
        img_chw, candidate_kps, return_crop=False,
    )


def install(engine_class):
    """Patch the benchmark process only, after its config override is set."""
    global _ORIGINALS
    module = sys.modules[engine_class.__module__]
    original_process = engine_class.process_frame
    original_detect = engine_class._detect
    original_frame_tensor = engine_class._frame_tensor
    original_unload = engine_class.unload
    _ORIGINALS = (original_detect, original_frame_tensor)
    source = textwrap.dedent(inspect.getsource(original_process))
    if source.count(_MARK) != 1:
        raise RuntimeError("Target-decision prefetch point changed")
    scope = {}
    exec(compile(source.replace(_MARK, _INSERT), str(module.__file__), "exec"),
         module.__dict__, scope)
    patched_process = scope[original_process.__name__]
    choose_source = textwrap.dedent(inspect.getsource(engine_class._choose_target))
    if choose_source.count(_RECOGNIZE_SOURCE) != 1:
        raise RuntimeError("Candidate recognition source changed")
    choose_scope = {}
    exec(compile(
        choose_source.replace(_RECOGNIZE_SOURCE, _RECOGNIZE_REPLACEMENT),
        str(module.__file__), "exec",
    ), module.__dict__, choose_scope)

    def process(self, frame, source_embedding, anchor, *args, **kwargs):
        prior = getattr(self, "_isolated_detection_active", None)
        self._isolated_detection_active = {
            "frame": frame,
            "context": kwargs.get("temporal_context"),
            "trackingState": kwargs.get("tracking_state"),
            "config": kwargs.get("config") or self._config,
            "cancelEvent": kwargs.get("cancel_event"),
        }
        try:
            return patched_process(
                self, frame, source_embedding, anchor, *args, **kwargs,
            )
        finally:
            self._isolated_detection_active = prior

    def detect(self, img_chw, *, recognize=False, config=None, max_faces=None):
        state = getattr(self, "_isolated_detection_prefetch", None)
        active = getattr(self, "_isolated_detection_active", None)
        pending = state["pending"] if state is not None else None
        if (
            not recognize and max_faces == 10
            and pending is not None and active is not None
            and active["frame"] is pending["frame"]
            and active["trackingState"] is pending["trackingState"]
            and active["context"] is pending["context"]
            and int(active["context"].get("frameIndex", -1)) == pending["frameIndex"]
            and int(active["trackingState"].get("trackGeneration", 0)) == pending["trackGeneration"]
            and self._vm is pending["vm"]
            and _detector_signature(config or self._config, self._models) == pending["signature"]
            and (active["cancelEvent"] is None or not active["cancelEvent"].is_set())
        ):
            result = pending["future"].result()
            state["pending"] = None
            if result is not None:
                frame_crc, rows, _recognition_prefetched = result
                import numpy as np
                current = np.ascontiguousarray(active["frame"], dtype=np.uint8)
                if zlib.crc32(memoryview(current).cast("B")) == frame_crc:
                    state["used"] += 1
                    active["prefetchedEmbeddings"] = [
                        (kps, embedding) for _area, kps, embedding in rows
                    ]
                    # _choose_target still receives the same detection-only
                    # rows it would get from _detect(recognize=False). Cached
                    # embeddings are consumed only inside its original
                    # `if recognize` branch by the source-patched helper.
                    return [
                        (area, kps.copy(), None) for area, kps, _embedding in rows
                    ]
        if state is not None:
            state["fallback"] += 1
        return original_detect(
            self, img_chw, recognize=recognize,
            config=config, max_faces=max_faces,
        )

    def unload(self):
        state = getattr(self, "_isolated_detection_prefetch", None)
        if state is not None:
            state["executor"].shutdown(wait=True, cancel_futures=False)
            state["stream"].synchronize()
            if state["models"] is not None:
                state["models"].delete_models()
            print("[detection-prefetch]", {
                key: state[key] for key in (
                    "launched", "used", "discarded", "fallback",
                    "throttled", "recognitionLaunched",
                )
            } | {"errors": state["errors"]}, flush=True)
            errors = list(state["errors"])
            self._isolated_detection_prefetch = None
        else:
            errors = []
        result = original_unload(self)
        if errors:
            raise RuntimeError(f"Secondary detector task failed: {errors[0]}")
        return result

    engine_class.process_frame = process
    engine_class._detect = detect
    engine_class._choose_target = choose_scope["_choose_target"]
    engine_class._isolated_detection_prefetch_embedding = _embedding
    engine_class._isolated_detection_prefetch_launch = _launch
    engine_class.unload = unload
    return engine_class
