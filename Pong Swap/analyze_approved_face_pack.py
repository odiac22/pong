from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from pong_swap_engine import ENGINE


def unit(value: np.ndarray) -> np.ndarray:
    array = np.asarray(value, dtype=np.float32).reshape(-1)
    return array / max(float(np.linalg.norm(array)), 1e-12)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Score candidate approved-face images before admitting them to an identity pack."
    )
    parser.add_argument("--reference-dir", type=Path, required=True)
    parser.add_argument("--candidate-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    reference_files = sorted(
        path for path in args.reference_dir.rglob("*")
        if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
    )
    candidate_files = sorted(
        path for path in args.candidate_dir.rglob("*")
        if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
    )
    if not reference_files or not candidate_files:
        raise RuntimeError("Both reference and candidate directories must contain images")

    config = ENGINE.config
    ENGINE.warm(config=config)
    reference_embeddings = {
        path.name: unit(ENGINE.embedding_from_images((path,), config))
        for path in reference_files
    }
    reference_mean = unit(np.mean(np.stack(tuple(reference_embeddings.values())), axis=0))

    rows = []
    for path in candidate_files:
        image = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if image is None:
            rows.append({"name": path.name, "usable": False, "reason": "unreadable"})
            continue
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        try:
            embedding = unit(ENGINE.embedding_from_images((path,), config))
        except Exception as error:
            rows.append({
                "name": path.name,
                "usable": False,
                "reason": f"no-face: {error}",
                "width": int(image.shape[1]),
                "height": int(image.shape[0]),
            })
            continue
        pairwise = {
            name: round(float(np.dot(embedding, value)), 5)
            for name, value in reference_embeddings.items()
        }
        rows.append({
            "name": path.name,
            "usable": True,
            "width": int(image.shape[1]),
            "height": int(image.shape[0]),
            "laplacianVariance": round(float(cv2.Laplacian(gray, cv2.CV_64F).var()), 3),
            "cosineToReferenceMean": round(float(np.dot(embedding, reference_mean)), 5),
            "minimumCosineToReference": round(min(pairwise.values()), 5),
            "maximumCosineToReference": round(max(pairwise.values()), 5),
            "cosineByReference": pairwise,
        })

    report = {
        "schema": "pong-approved-face-pack-analysis-v1",
        "referenceDirectory": str(args.reference_dir.resolve()),
        "candidateDirectory": str(args.candidate_dir.resolve()),
        "referenceImages": [path.name for path in reference_files],
        "candidates": rows,
    }
    encoded = json.dumps(report, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded + "\n", encoding="utf-8")
    print(encoded)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
