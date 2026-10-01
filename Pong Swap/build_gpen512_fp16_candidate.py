"""Build a side-by-side mixed-FP16 GPEN512 candidate without touching baseline."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import onnx
from onnxruntime.transformers.float16 import convert_float_to_float16


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "runtime" / "models" / "GPEN-BFR-512.onnx"
CANDIDATE_ROOT = ROOT / "runtime" / "models-candidates" / "gpen512-fp16"
CANDIDATE = CANDIDATE_ROOT / "GPEN-BFR-512.onnx"
MANIFEST = CANDIDATE_ROOT / "manifest.json"
STRATEGY = "mixed-fp16-sensitive-fp32-v1"
FP32_OPERATORS = [
    "BatchNormalization", "InstanceNormalization", "LayerNormalization",
    "ReduceMean", "ReduceSum", "Softmax",
]


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def run() -> None:
    if not SOURCE.is_file():
        raise FileNotFoundError(SOURCE)
    CANDIDATE_ROOT.mkdir(parents=True, exist_ok=True)
    source_hash = digest(SOURCE)
    if CANDIDATE.is_file() and MANIFEST.is_file():
        current = json.loads(MANIFEST.read_text(encoding="utf-8"))
        if current.get("sourceSha256") == source_hash and current.get("strategy") == STRATEGY:
            print(json.dumps(current, indent=2))
            return
    model = onnx.load(str(SOURCE))
    converted = convert_float_to_float16(
        model,
        keep_io_types=False,
        disable_shape_infer=True,
        op_block_list=FP32_OPERATORS,
    )
    onnx.checker.check_model(converted)
    onnx.save(converted, str(CANDIDATE), save_as_external_data=False)
    result = {
        "schema": "pong-gpen512-fp16-candidate-v1",
        "source": str(SOURCE),
        "candidate": str(CANDIDATE),
        "sourceSha256": source_hash,
        "candidateSha256": digest(CANDIDATE),
        "sourceBytes": SOURCE.stat().st_size,
        "candidateBytes": CANDIDATE.stat().st_size,
        "keepIoTypes": False,
        "ioDtype": "float16",
        "strategy": STRATEGY,
        "fp32Operators": FP32_OPERATORS,
        "productionChanged": False,
    }
    MANIFEST.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    run()
