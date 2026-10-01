from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from benchmark_restorers_stock import RESTORER_SPECS
from benchmark_swappers_stock import (
    ASSET_ROOT,
    CUDA_DLL_ROOT,
    FACEFUSION,
    MODEL_SPECS,
    PYTHON,
    ROOT,
    VENDOR_ROOT,
)


TARGET = ROOT / "benchmarks" / "visual-checks" / "target.png"
OUTPUT_ROOT = ROOT / "benchmarks" / "manual-grading"
APPROVED = {
    "Approved 4": ROOT / "approved-faces" / "Approved 4" / "source.jpg",
    "Approved 8": ROOT / "approved-faces" / "Approved 8" / "source.jpg",
}


def run(command: list[str], timeout: int = 900) -> None:
    env = dict(os.environ)
    env["PATH"] = str(CUDA_DLL_ROOT) + os.pathsep + env.get("PATH", "")
    completed = subprocess.run(
        command,
        cwd=VENDOR_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if completed.returncode != 0:
        detail = (completed.stdout + "\n" + completed.stderr)[-4000:]
        raise RuntimeError(f"FaceFusion failed ({completed.returncode})\n{detail}")


def common(output: Path) -> list[str]:
    return [
        str(PYTHON),
        str(FACEFUSION),
        "headless-run",
        "-t",
        str(TARGET),
        "-o",
        str(output),
        "--workflow-strategy",
        "memory",
        "--face-mask-types",
        "box",
        "--face-mask-blur",
        "0.3",
        "--face-selector-mode",
        "one",
        "--execution-providers",
        "cuda",
        "--execution-thread-count",
        "1",
        "--video-memory-strategy",
        "tolerant",
        "--output-image-quality",
        "100",
        "--log-level",
        "warn",
    ]


def swap_command(source: Path, output: Path, model_name: str, native_size: int) -> list[str]:
    command = common(output)
    command[command.index("-t"):command.index("-t")] = ["-s", str(source)]
    command.extend(
        [
            "--processors",
            "face_swapper",
            "--face-swapper-model",
            model_name,
            "--face-swapper-pixel-boost",
            f"{native_size}x{native_size}",
            "--face-swapper-weight",
            "0.5",
        ]
    )
    return command


def restore_command(input_image: Path, output: Path, restorer_name: str) -> list[str]:
    command = common(output)
    target_index = command.index("-t") + 1
    command[target_index] = str(input_image)
    command.extend(
        [
            "--processors",
            "face_enhancer",
            "--face-enhancer-model",
            restorer_name,
            "--face-enhancer-blend",
            "100",
            "--face-enhancer-weight",
            "0.5",
        ]
    )
    return command


def prune(name: str) -> None:
    (ASSET_ROOT / f"{name}.onnx").unlink(missing_ok=True)


def main() -> None:
    if not TARGET.is_file():
        raise FileNotFoundError(TARGET)
    for source in APPROVED.values():
        if not source.is_file():
            raise FileNotFoundError(source)

    for approved_name in APPROVED:
        for category in ("Models", "Restorers"):
            destination = OUTPUT_ROOT / approved_name / category
            destination.mkdir(parents=True, exist_ok=True)
            for old in destination.iterdir():
                if old.is_file():
                    old.unlink()

    for model_index, spec in enumerate(MODEL_SPECS, start=1):
        print(f"[model {model_index}/{len(MODEL_SPECS)}] {spec.name}", flush=True)
        for approved_name, source in APPROVED.items():
            output = OUTPUT_ROOT / approved_name / "Models" / f"{spec.name}.png"
            run(swap_command(source, output, spec.name, spec.native_size))
        prune(spec.name)

    baseline_name = "inswapper_128_fp16.png"
    for approved_name in APPROVED:
        base = OUTPUT_ROOT / approved_name / "Models" / baseline_name
        reference = OUTPUT_ROOT / approved_name / "Restorers" / "00_no_restorer.png"
        shutil.copy2(base, reference)

    for restorer_index, spec in enumerate(RESTORER_SPECS, start=1):
        print(f"[restorer {restorer_index}/{len(RESTORER_SPECS)}] {spec.name}", flush=True)
        for approved_name in APPROVED:
            base = OUTPUT_ROOT / approved_name / "Models" / baseline_name
            output = OUTPUT_ROOT / approved_name / "Restorers" / f"{spec.name}.png"
            run(restore_command(base, output, spec.name))
        prune(spec.name)

    expected = len(APPROVED) * (len(MODEL_SPECS) + len(RESTORER_SPECS) + 1)
    actual = len(list(OUTPUT_ROOT.rglob("*.png")))
    if actual != expected:
        raise RuntimeError(f"Expected {expected} grading images, found {actual}")
    print(f"complete: {actual} images in {OUTPUT_ROOT}", flush=True)


if __name__ == "__main__":
    main()
