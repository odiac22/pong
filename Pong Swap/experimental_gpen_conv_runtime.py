"""Unpromoted, explicit-opt-in GPEN512 convolution-island plan adapter.

This module has no production insertion hook. It never changes the stock model,
qualified plan, preset, or frozen GPENRuntime. Import and evidence inspection are
CPU-only; TensorRT and Torch are imported only by explicit ``load()``.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import importlib
import json
import math
from pathlib import Path
import re
import threading
from typing import Any, Callable


ROOT = Path(__file__).resolve().parent
EXPERIMENT_PARENT = Path(r"E:\Pong Benchmarks\tiktok-webview-2026-09-29")
ORIGINAL_SHA256 = "0960f836488735444d508b588e44fb5dfd19c68fde9163ad7878aa24d1d5115e"
ADOPTED_PLAN_SHA256 = "b8c4ac5cd6e87b8bea24881b6204da953a95914ceb2092be73bb07b550906dd9"
OPT_IN = "I_ACCEPT_UNPROMOTED_GPEN_CONV_ISLANDS"
SHAPE = (1, 3, 512, 512)
GATES = {"mae": 0.10, "p99Abs": 1.0, "maxAbs": 4.0,
         "psnrDb": 50.0, "ssim": 0.999, "temporalMae": 0.20}
_HEX = re.compile(r"[a-f0-9]{64}\Z")
_CANDIDATE_DIR = re.compile(r"gpen512-conv-islands-[a-z0-9-]+\Z")
_TRIAL_DIR = re.compile(r"gpen512-conv-trial-[a-z0-9-]+\Z")


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    _require(isinstance(value, dict), "experiment document must be an object")
    return value


def _name(index: int) -> str:
    return f"/generator/convs.{index}/conv/{'ConvTranspose' if index % 2 == 0 else 'Conv'}"


@dataclass(frozen=True)
class CandidateFiles:
    candidate_model: Path
    trial_directory: Path
    original_model: Path
    adopted_plan: Path
    stock_capture_directory: Path = ROOT / "benchmarks/gpen512-calibrator-v1/capture"


@dataclass(frozen=True)
class ValidatedCandidate:
    candidate_sha256: str
    plan_sha256: str
    report_sha256: str
    plan_bytes: bytes


def inspect_candidate_graph(path: Path, original_path: Path) -> dict[str, Any]:
    """CPU-only topology check; no TensorRT, Torch, or image pixels."""
    onnx = importlib.import_module("onnx")
    onnx.checker.check_model(str(path))
    candidate_model = onnx.load(str(path))
    original_model = onnx.load(str(original_path))
    graph = onnx.shape_inference.infer_shapes(
        candidate_model, check_type=True, strict_mode=True).graph
    original_graph = original_model.graph
    float32, float16 = onnx.TensorProto.FLOAT, onnx.TensorProto.FLOAT16
    typed = {value.name: value.type.tensor_type.elem_type for value in
             (*graph.input, *graph.output, *graph.value_info)
             if value.type.HasField("tensor_type")}
    typed.update({value.name: value.data_type for value in graph.initializer})
    # This legacy ONNX lists FP32 initializers as graph inputs. They are not
    # runtime I/O; TensorRT exposes only the remaining image input.
    initializer_names = {value.name for value in graph.initializer}
    runtime_inputs = [value for value in graph.input if value.name not in initializer_names]
    _require(len(runtime_inputs) == len(graph.output) == 1 and
             runtime_inputs[0].name == "input" and graph.output[0].name == "output" and
             typed.get("input") == typed.get("output") == float32,
             "candidate must have the exact FP32 GPEN I/O")
    _require(all(value.data_type == float32 for value in graph.initializer),
             "candidate changed FP32 initializers")
    _require([(value.name, value.SerializeToString()) for value in candidate_model.graph.initializer] ==
             [(value.name, value.SerializeToString()) for value in original_graph.initializer],
             "candidate changed an original initializer")
    _require([value.SerializeToString() for value in (*candidate_model.graph.input,
                                                      *candidate_model.graph.output)] ==
             [value.SerializeToString() for value in (*original_graph.input, *original_graph.output)],
             "candidate changed original graph I/O")
    nodes = {node.name: node for node in graph.node}
    _require(len(nodes) == len(graph.node), "candidate has duplicate node names")
    expected_casts = set()
    for index in range(14):
        prefix = f"pong_conv_island_v1_{index}"
        node = nodes.get(_name(index))
        _require(node is not None and node.op_type == ("ConvTranspose" if index % 2 == 0 else "Conv") and
                 len(node.input) == 2 and len(node.output) == 1,
                 f"candidate generator layer {index} is missing")
        for position in (0, 1):
            cast_name = f"{prefix}_input{position}_cast"
            cast = nodes.get(cast_name)
            expected_casts.add(cast_name)
            _require(cast is not None and cast.op_type == "Cast" and len(cast.input) == 1 and
                     list(cast.output) == [node.input[position]] and
                     typed.get(cast.input[0]) == float32 and typed.get(node.input[position]) == float16 and
                     len(cast.attribute) == 1 and cast.attribute[0].name == "to" and
                     cast.attribute[0].i == float16,
                     f"candidate input cast {index}:{position} is invalid")
        cast_name = f"{prefix}_output_cast"
        cast = nodes.get(cast_name)
        expected_casts.add(cast_name)
        _require(cast is not None and cast.op_type == "Cast" and
                 list(cast.input) == list(node.output) and len(cast.output) == 1 and
                 typed.get(node.output[0]) == float16 and typed.get(cast.output[0]) == float32 and
                 len(cast.attribute) == 1 and cast.attribute[0].name == "to" and
                 cast.attribute[0].i == float32,
                 f"candidate output cast {index} is invalid")
    _require({node.name for node in graph.node if node.op_type == "Cast"} == expected_casts,
             "candidate has casts outside the fourteen convolution islands")
    _require(all(typed.get(node.output[0]) == float32 for node in graph.node
                 if node.op_type in {"Pow", "ReduceSum", "Sqrt", "Div"}),
             "candidate sensitive arithmetic is not FP32")
    original_nodes = list(original_graph.node)
    candidate_source_nodes = [node for node in candidate_model.graph.node if node.op_type != "Cast"]
    _require(len(original_nodes) == len(candidate_source_nodes) == 1332 and
             [(node.name, node.op_type) for node in original_nodes] ==
             [(node.name, node.op_type) for node in candidate_source_nodes],
             "candidate changed the original graph operation sequence")
    selected = {_name(index) for index in range(14)}
    for before, after in zip(original_nodes, candidate_source_nodes):
        if before.name not in selected:
            _require(before.SerializeToString() == after.SerializeToString(),
                     "candidate changed a nonselected operation")
            continue
        index = next(index for index in range(14) if before.name == _name(index))
        for position in (0, 1):
            _require(list(nodes[f"pong_conv_island_v1_{index}_input{position}_cast"].input) ==
                     [before.input[position]], "candidate moved a selected convolution input")
        _require(list(nodes[f"pong_conv_island_v1_{index}_output_cast"].output) ==
                 list(before.output), "candidate moved a selected convolution output")
        restored = onnx.NodeProto()
        restored.CopyFrom(after)
        restored.input[:] = before.input
        restored.output[:] = before.output
        _require(restored.SerializeToString() == before.SerializeToString(),
                 "candidate changed a selected convolution beyond cast boundaries")
    return {"selectedLayers": list(range(14)), "selectedNodes": [_name(i) for i in range(14)],
            "castNodeCount": 42, "candidateNodeCount": len(graph.node),
            "modelIoFp32": True, "sensitiveOpsFp32": True, "initializersUnchanged": True}


def _qualified_quality(value: Any) -> bool:
    if not isinstance(value, dict) or value.get("pass") is not True:
        return False
    frames, temporal = value.get("frames"), value.get("temporalMae")
    if not isinstance(frames, list) or len(frames) != 82 or not isinstance(temporal, list) or len(temporal) != 60:
        return False
    kinds = {(row.get("kind"), row.get("step")) for row in frames if isinstance(row, dict)}
    if len(kinds) != 82 or not all(isinstance(row, dict) and row.get("pass") is True for row in frames):
        return False
    for row in frames:
        for field in ("mae", "p99Abs", "maxAbs", "psnrDb", "ssim"):
            number = row.get(field)
            if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number):
                return False
            if field in ("mae", "p99Abs", "maxAbs") and not 0 <= number <= GATES[field]:
                return False
            if field == "psnrDb" and number < GATES[field]:
                return False
            if field == "ssim" and not GATES[field] <= number <= 1:
                return False
    return all(not isinstance(number, bool) and isinstance(number, (int, float)) and
               math.isfinite(number) and 0 <= number <= GATES["temporalMae"] for number in temporal)


def validate_candidate(files: CandidateFiles, *, allowed_parent: Path = EXPERIMENT_PARENT,
                       expected_original_sha256: str = ORIGINAL_SHA256,
                       expected_adopted_sha256: str = ADOPTED_PLAN_SHA256,
                       topology_check: Callable[[Path, Path], dict[str, Any]] = inspect_candidate_graph) -> ValidatedCandidate:
    """Reject incomplete, stale, mismatched, or self-promoted benchmark outputs."""
    candidate, trial, parent = (files.candidate_model.resolve(), files.trial_directory.resolve(),
                                allowed_parent.resolve())
    _require(candidate.name == "GPEN-BFR-512-conv-islands.onnx" and
             candidate.parent.parent == parent and _CANDIDATE_DIR.fullmatch(candidate.parent.name) is not None,
             "candidate is not an isolated export")
    _require(trial.parent == parent and _TRIAL_DIR.fullmatch(trial.name) is not None and
             trial != candidate.parent, "trial is not an isolated output directory")
    plan, report_path, supervisor_path = (trial / "candidate.plan", trial / "report.json",
                                         trial / "supervisor.json")
    export = _read_json(candidate.parent / "manifest.json")
    report = _read_json(report_path)
    supervisor = _read_json(supervisor_path)
    _require(report_path.stat().st_mtime_ns <= supervisor_path.stat().st_mtime_ns,
             "report changed after supervisor completion")
    original_sha = _sha256(files.original_model)
    adopted_sha = _sha256(files.adopted_plan)
    candidate_sha = _sha256(candidate)
    plan_bytes = plan.read_bytes()
    plan_sha = hashlib.sha256(plan_bytes).hexdigest()
    _require(original_sha == expected_original_sha256 and adopted_sha == expected_adopted_sha256,
             "original model or adopted plan identity changed")
    _require(all(_HEX.fullmatch(value or "") for value in (original_sha, adopted_sha, candidate_sha, plan_sha)),
             "artifact hash is invalid")
    _require(export.get("schema") == "pong-gpen512-conv-islands-candidate-v1" and
             export.get("sourceSha256") == report.get("originalSha256") == original_sha and
             export.get("candidateSha256") == report.get("candidateSha256") == candidate_sha and
             report.get("adoptedPlanSha256") == adopted_sha and
             report.get("candidatePlanSha256") == plan_sha and
             report.get("export") == export,
             "export, report, model, or plan hashes do not agree")
    _require(export.get("selectedLayers") == list(range(14)) and
             export.get("selectedNodes") == [_name(i) for i in range(14)] and
             export.get("sourceNodeCount") == 1332 and
             export.get("candidateNodeCount") == 1374 and export.get("castNodeCount") == 42 and
             export.get("candidateBytes") == candidate.stat().st_size and
             export.get("modelIoFp32") is True and export.get("sensitiveOpsFp32") is True and
             export.get("initializersUnchanged") is True and
             all(export.get(key) is False for key in
                 ("productionEligible", "qualityQualified", "performanceQualified")),
             "export is not the full, unqualified cast-island graph")
    actual_topology = topology_check(candidate, files.original_model)
    for key in ("selectedLayers", "selectedNodes", "castNodeCount", "candidateNodeCount",
                "modelIoFp32", "sensitiveOpsFp32", "initializersUnchanged"):
        _require(actual_topology.get(key) == export.get(key), f"candidate topology mismatch: {key}")
    _require(report.get("schema") == "pong-conv-island-experiment-v1" and
             report.get("graphPrecision") == "explicit FP16 convolution islands; FP32 elsewhere" and
             report.get("productionEligible") is False and report.get("promoted") is False and
             report.get("requiresRealFaceAndLiveQualification") is True and
             isinstance(report.get("phases"), list) and report["phases"] and
             report["phases"][-1].get("phase") == "completed_unpromoted",
             "benchmark has not reached unpromoted completion")
    _require(report.get("gates") == GATES and report.get("generatedFrames") == 18 and
             report.get("stockFrames") == 64 and
             all(_qualified_quality(report.get(key)) for key in
                 ("candidateOrtVsOriginal", "candidateTrtVsOriginal",
                  "adoptedTrtVsOriginal", "candidateTrtVsAdopted")),
             "numerical or temporal qualification evidence is incomplete")
    stock = report.get("stockTensorProvenance")
    _require(isinstance(stock, list) and len(stock) == 16 and
             len({row.get("name") for row in stock if isinstance(row, dict)}) == 16,
             "stock tensor provenance is incomplete")
    for row in stock:
        _require(isinstance(row, dict) and
                 re.fullmatch(r"clip-\d{2}-gpen-inputs-f32\.npy", str(row.get("name", ""))) is not None and
                 row.get("frames") == 4 and _sha256(files.stock_capture_directory / row["name"]) == row.get("sha256"),
                 "stock tensor hash or frame provenance changed")
    build = report.get("build") or {}
    _require(build.get("stronglyTyped") is True and build.get("tf32") is True and
             build.get("fp16") is False and build.get("int8") is False and
             build.get("strictMath") is False and build.get("externalPlan") is False and
             build.get("torgbPlugin") is False and build.get("builderOptimizationLevel") == 5 and
             build.get("input") == "input" and build.get("output") == "output",
             "candidate build recipe is not the explicit strongly typed graph experiment")
    timings = report.get("timings") or {}
    try:
        adopted = float(timings["adopted"]["wallMs"]["p50Ms"])
        candidate_ms = float(timings["candidate"]["wallMs"]["p50Ms"])
        adopted_p95 = float(timings["adopted"]["wallMs"]["p95Ms"])
        candidate_p95 = float(timings["candidate"]["wallMs"]["p95Ms"])
        speedup = float(report["medianSpeedup"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("paired speed evidence is incomplete") from exc
    _require(report.get("diagnosticSpeedGate") is True and
             all(math.isfinite(value) and value > 0 for value in
                 (adopted, candidate_ms, adopted_p95, candidate_p95, speedup)) and
             speedup >= 1.05 and math.isclose(speedup, adopted / candidate_ms, rel_tol=1e-6) and
             candidate_p95 <= adopted_p95,
             "paired diagnostic speed gate did not pass")
    _require(supervisor.get("promoted") is False and supervisor.get("productionChanged") is False and
             (supervisor.get("worker") or {}).get("exitCode") == 0 and
             all(supervisor.get(key) is True for key in
                 ("savedPresetUnchanged", "productionPlanUnchanged", "sourceModelUnchanged")),
             "supervisor did not confirm clean, unchanged production state")
    return ValidatedCandidate(candidate_sha, plan_sha, _sha256(report_path), plan_bytes)


class ExperimentalGPENConvRuntime:
    """Separate one-context runtime; intentionally not wired into Pong models."""

    def __init__(self, files: CandidateFiles, *, opt_in: str):
        if opt_in != OPT_IN:
            raise PermissionError("unpromoted GPEN experiment requires explicit opt-in")
        self.files = files
        self._lock = threading.RLock()
        self._state: dict[str, Any] | None = None
        self._poisoned = False

    def load(self, *, torch=None, trt=None, validation: Callable[[CandidateFiles], ValidatedCandidate] = validate_candidate) -> None:
        with self._lock:
            if self._poisoned:
                raise RuntimeError("experimental runtime is poisoned")
            if self._state is not None:
                raise RuntimeError("experimental runtime is already loaded")
            evidence = validation(self.files)
            try:
                torch = torch if torch is not None else importlib.import_module("torch")
                trt = trt if trt is not None else importlib.import_module("tensorrt")
                logger = trt.Logger(trt.Logger.WARNING)
                runtime = trt.Runtime(logger)
                engine = runtime.deserialize_cuda_engine(evidence.plan_bytes)
                if engine is None:
                    raise RuntimeError("experimental plan deserialization failed")
                context = engine.create_execution_context()
                if context is None:
                    raise RuntimeError("experimental execution context failed")
                names = [engine.get_tensor_name(i) for i in range(engine.num_io_tensors)]
                if names != ["input", "output"]:
                    raise RuntimeError("experimental plan has unexpected I/O names")
                for name, mode in (("input", trt.TensorIOMode.INPUT),
                                   ("output", trt.TensorIOMode.OUTPUT)):
                    if (engine.get_tensor_mode(name) != mode or
                        tuple(engine.get_tensor_shape(name)) != SHAPE or
                        engine.get_tensor_dtype(name) != trt.float32 or
                        engine.get_tensor_location(name) != trt.TensorLocation.DEVICE or
                        engine.get_tensor_format(name) != trt.TensorFormat.LINEAR or
                        engine.get_tensor_vectorized_dim(name) != -1):
                        raise RuntimeError("experimental plan must expose FP32 linear device GPEN512 I/O")
                self._state = {"torch": torch, "trt": trt, "runtime": runtime, "engine": engine,
                               "context": context, "planSha256": evidence.plan_sha256,
                               "candidateSha256": evidence.candidate_sha256,
                               "lastStream": None}
            except Exception:
                self._poisoned = True
                raise

    def run(self, image, output, *, stream):
        """Submit on caller stream, synchronize completion, and return ``output``."""
        with self._lock:
            if self._poisoned or self._state is None:
                raise RuntimeError("experimental runtime is unavailable")
            torch = self._state["torch"]
            for tensor in (image, output):
                if (tuple(tensor.shape) != SHAPE or tensor.dtype != torch.float32 or
                    tensor.device.type != "cuda" or not tensor.is_contiguous()):
                    raise ValueError("experimental GPEN input/output must be contiguous CUDA FP32 [1,3,512,512]")
            if image.data_ptr() == output.data_ptr() or not isinstance(stream.cuda_stream, int):
                raise ValueError("experimental GPEN requires distinct buffers and caller CUDA stream")
            context = self._state["context"]
            try:
                image.record_stream(stream)
                output.record_stream(stream)
                if (not context.set_tensor_address("input", image.data_ptr()) or
                    not context.set_tensor_address("output", output.data_ptr()) or
                    not context.execute_async_v3(int(stream.cuda_stream))):
                    raise RuntimeError("experimental GPEN submission failed")
                self._state["lastStream"] = stream
                stream.synchronize()
                return output
            except Exception:
                self._poisoned = True
                raise

    def close(self) -> None:
        with self._lock:
            if self._state is None:
                return
            stream = self._state.get("lastStream")
            if stream is not None:
                stream.synchronize()
            self._state = None
