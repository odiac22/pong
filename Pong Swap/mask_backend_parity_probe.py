"""Benchmark-only CUDA/TensorRT mask arithmetic attribution.

The probe temporarily wraps an already-warmed Pong engine.  Each sampled mask
inference is run on both existing providers with the exact same normalized GPU
tensor.  The selected provider's output is preserved byte-for-byte; the second
execution is diagnostic only.  No image tensors are written to disk.
"""

from __future__ import annotations

import statistics
import time
import zlib

import numpy as np
import torch
import torch.nn.functional as F


_PARSER_BACKGROUND_LABELS = (0, 14, 15, 16, 17, 18)


def _tensor_crc32(tensor: torch.Tensor) -> str:
    payload = tensor.detach().contiguous().cpu().numpy().view(np.uint8)
    return f"{zlib.crc32(memoryview(payload).cast('B')):08x}"


def _morph_binary(mask: torch.Tensor, amount: int) -> torch.Tensor:
    """Match Rope's grow/shrink loop without mutating the captured logits."""
    result = mask.to(torch.float32).reshape(1, 1, mask.shape[-2], mask.shape[-1])
    kernel = torch.ones((1, 1, 3, 3), dtype=torch.float32, device=result.device)
    if amount > 0:
        for _ in range(int(amount)):
            result = F.conv2d(result, kernel, padding=(1, 1)).clamp_(0.0, 1.0)
    elif amount < 0:
        result = 1.0 - result
        for _ in range(int(-amount)):
            result = F.conv2d(result, kernel, padding=(1, 1)).clamp_(0.0, 1.0)
        result = 1.0 - result
    return result.reshape(1, mask.shape[-2], mask.shape[-1])


def _occluder_mask(logits: torch.Tensor, amount: int) -> torch.Tensor:
    return _morph_binary(torch.squeeze(logits) > 0.0, amount)


def _parser_predicates(logits: torch.Tensor, mouth_amount: int):
    labels = torch.argmax(torch.squeeze(logits), dim=0)
    background = torch.zeros_like(labels, dtype=torch.bool)
    for label in _PARSER_BACKGROUND_LABELS:
        background.logical_or_(labels == label)
    foreground = ~background
    if mouth_amount < 0:
        mouth = labels != 11
    elif mouth_amount > 0:
        mouth = ~((labels >= 11) & (labels <= 13))
    else:
        mouth = torch.ones_like(labels, dtype=torch.bool)
    return labels, foreground, mouth


def _parser_mask(
    logits: torch.Tensor,
    face_amount: int,
    mouth_amount: int,
) -> torch.Tensor:
    _, foreground, mouth = _parser_predicates(logits, mouth_amount)
    foreground = _morph_binary(foreground, face_amount)
    if mouth_amount:
        mouth = _morph_binary(mouth, mouth_amount)
    else:
        mouth = mouth.to(torch.float32).reshape(1, 512, 512)
    return foreground * mouth


def _diff_record(selected: torch.Tensor, alternate: torch.Tensor) -> dict:
    difference = (selected.to(torch.float32) - alternate.to(torch.float32)).abs()
    return {
        "elements": int(difference.numel()),
        "finite": bool(torch.isfinite(selected).all() and torch.isfinite(alternate).all()),
        "maximumAbsoluteError": float(difference.max().item()),
        "meanAbsoluteError": float(difference.mean().item()),
        "changedElements": int(torch.count_nonzero(difference).item()),
    }


class MaskBackendParityProbe:
    """Temporarily compare mask providers without changing rendered output."""

    def __init__(self, engine, *, maximum_samples_per_family: int = 12):
        self.engine = engine
        self.models = engine._models
        self.video_manager = engine._vm
        self.maximum_samples_per_family = max(1, int(maximum_samples_per_family))
        self.records = {"occluder": [], "faceparser": []}
        self._pending = {"occluder": None, "faceparser": None}
        self.elapsed_seconds = 0.0
        self._installed = False
        self._original = {}

    @staticmethod
    def _with_family_backend(selection, family: str, backend: str):
        if isinstance(selection, dict):
            updated = dict(selection)
            updated[family] = backend
            return updated
        return backend

    def _synchronize(self):
        stream = getattr(self.engine, "_compute_stream", None)
        if stream is not None:
            stream.synchronize()
        else:
            torch.cuda.synchronize()

    def _run_pair(self, family: str, original, image, output):
        if len(self.records[family]) >= self.maximum_samples_per_family:
            return original(image, output)
        started = time.perf_counter()
        selected_backend = self.models._mask_backend_for_call(family)
        alternate_backend = "trt" if selected_backend == "cuda" else "cuda"
        prior_selection = self.models._mask_runtime_backend
        original(image, output)
        selected = output.detach().clone()
        alternate = torch.empty_like(output)
        try:
            self.models._mask_runtime_backend = self._with_family_backend(
                prior_selection,
                family,
                alternate_backend,
            )
            original(image, alternate)
        finally:
            self.models._mask_runtime_backend = prior_selection
        output.copy_(selected)
        self._synchronize()
        raw = _diff_record(selected, alternate)
        raw.update({
            "inputCrc32": _tensor_crc32(image),
            "inputShape": list(image.shape),
            "inputStride": list(image.stride()),
            "inputDtype": str(image.dtype),
            "selectedBackend": selected_backend,
            "alternateBackend": alternate_backend,
        })
        if family == "occluder":
            selected_decision = torch.squeeze(selected) > 0.0
            alternate_decision = torch.squeeze(alternate) > 0.0
            disagreements = selected_decision != alternate_decision
            raw["decisionDisagreements"] = int(torch.count_nonzero(disagreements).item())
            raw["decisionElements"] = int(disagreements.numel())
            if bool(disagreements.any()):
                raw["selectedMinimumAbsoluteLogitAtDisagreement"] = float(
                    torch.squeeze(selected).abs()[disagreements].min().item()
                )
        else:
            selected_labels, selected_foreground, selected_mouth = _parser_predicates(
                selected, int(self.engine.config["parameters"].get("MouthParserSlider", 0))
            )
            alternate_labels, alternate_foreground, alternate_mouth = _parser_predicates(
                alternate, int(self.engine.config["parameters"].get("MouthParserSlider", 0))
            )
            label_disagreements = selected_labels != alternate_labels
            semantic_disagreements = (
                (selected_foreground != alternate_foreground)
                | (selected_mouth != alternate_mouth)
            )
            top_two = torch.topk(torch.squeeze(selected), 2, dim=0).values
            margin = top_two[0] - top_two[1]
            raw["labelDisagreements"] = int(torch.count_nonzero(label_disagreements).item())
            raw["semanticPredicateDisagreements"] = int(
                torch.count_nonzero(semantic_disagreements).item()
            )
            raw["decisionElements"] = int(label_disagreements.numel())
            if bool(semantic_disagreements.any()):
                raw["selectedMinimumTopTwoMarginAtSemanticDisagreement"] = float(
                    margin[semantic_disagreements].min().item()
                )
        self._pending[family] = {
            "selected": selected,
            "alternate": alternate,
            "record": raw,
        }
        self.elapsed_seconds += time.perf_counter() - started

    def _finish_postprocess(self, family: str, selected_mask: torch.Tensor, alternate_mask):
        pending = self._pending.get(family)
        if pending is None:
            return
        self._synchronize()
        record = pending["record"]
        selected_reconstructed = alternate_mask(pending["selected"])
        alternate_reconstructed = alternate_mask(pending["alternate"])
        record["selectedPostprocessReconstruction"] = _diff_record(
            selected_mask,
            selected_reconstructed,
        )
        record["postprocess"] = _diff_record(
            selected_reconstructed,
            alternate_reconstructed,
        )
        record["selectedPostprocessCrc32"] = _tensor_crc32(selected_reconstructed)
        record["alternatePostprocessCrc32"] = _tensor_crc32(alternate_reconstructed)
        self.records[family].append(record)
        self._pending[family] = None

    def install(self):
        if self._installed:
            return self
        self._original = {
            "run_occluder": self.models.run_occluder,
            "run_faceparser": self.models.run_faceparser,
            "apply_occlusion": self.video_manager.apply_occlusion,
            "apply_face_parser": self.video_manager.apply_face_parser,
        }

        def run_occluder(image, output):
            return self._run_pair(
                "occluder", self._original["run_occluder"], image, output
            )

        def run_faceparser(image, output):
            return self._run_pair(
                "faceparser", self._original["run_faceparser"], image, output
            )

        def apply_occlusion(image, amount):
            result = self._original["apply_occlusion"](image, amount)
            self._finish_postprocess(
                "occluder",
                result,
                lambda logits: _occluder_mask(logits, int(amount)),
            )
            return result

        def apply_face_parser(image, face_amount, mouth_amount):
            result = self._original["apply_face_parser"](
                image, face_amount, mouth_amount
            )
            self._finish_postprocess(
                "faceparser",
                result,
                lambda logits: _parser_mask(
                    logits,
                    int(face_amount),
                    int(mouth_amount),
                ),
            )
            return result

        self.models.run_occluder = run_occluder
        self.models.run_faceparser = run_faceparser
        self.video_manager.apply_occlusion = apply_occlusion
        self.video_manager.apply_face_parser = apply_face_parser
        self._installed = True
        return self

    def close(self):
        if not self._installed:
            return
        self.models.run_occluder = self._original["run_occluder"]
        self.models.run_faceparser = self._original["run_faceparser"]
        self.video_manager.apply_occlusion = self._original["apply_occlusion"]
        self.video_manager.apply_face_parser = self._original["apply_face_parser"]
        self._installed = False

    def report(self) -> dict:
        result = {
            "schema": "pong-mask-backend-parity-v1",
            "diagnosticSeconds": self.elapsed_seconds,
            "maximumSamplesPerFamily": self.maximum_samples_per_family,
            "families": {},
        }
        for family, records in self.records.items():
            raw_max = [item["maximumAbsoluteError"] for item in records]
            raw_mean = [item["meanAbsoluteError"] for item in records]
            post_changed = [item["postprocess"]["changedElements"] for item in records]
            result["families"][family] = {
                "sampleCount": len(records),
                "rawMaximumAbsoluteError": max(raw_max) if raw_max else None,
                "rawMeanAbsoluteError": statistics.fmean(raw_mean) if raw_mean else None,
                "postprocessChangedElementsMaximum": max(post_changed) if post_changed else None,
                "records": records,
            }
        return result
