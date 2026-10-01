from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import cv2
import numpy as np
import torch

from pong_swap_engine import ENGINE
from pong_swap_identity import (
    CandidateIdentity,
    FacePresentation,
    TargetIdentity,
    appearance_similarity,
    compatible_identity_rankings,
    rope_similarity,
)


def detected_faces(frame: np.ndarray, config: dict) -> list[TargetIdentity]:
    presentation_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    with ENGINE._lock:
        stream = ENGINE._compute_stream
        if stream is None:
            raise RuntimeError("Pong Swap CUDA stream is not initialized")
        with torch.cuda.stream(stream):
            rows = ENGINE._detect(
                ENGINE._frame_tensor(presentation_frame),
                recognize=True,
                config=config,
                max_faces=10,
            )
        stream.synchronize()
    faces: list[TargetIdentity] = []
    for area, keypoints, embedding in rows:
        if embedding is None:
            continue
        try:
            presentation = ENGINE._presentation_classifier.classify(
                presentation_frame,
                keypoints,
            )
        except Exception:
            presentation = FacePresentation("unknown", 0.0)
        faces.append(
            TargetIdentity(
                keypoints=np.asarray(keypoints, dtype=np.float32),
                embedding=np.asarray(embedding, dtype=np.float32),
                presentation=presentation,
                area=float(area),
            )
        )
    return faces


def combined_similarity(
    candidate: CandidateIdentity,
    target: TargetIdentity,
    *,
    mode: str = "lookalike",
) -> float:
    ranking = compatible_identity_rankings(
        (candidate,),
        target,
        minimum_similarity=0.0,
        minimum_presentation_confidence=0.0,
        similarity_mode=mode,
    )
    return float(ranking[0].similarity) if ranking else -math.inf


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--face-id", required=True)
    parser.add_argument("--target-reference", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--stride", type=int, default=1)
    args = parser.parse_args()

    started = time.perf_counter()
    config = ENGINE.config
    ENGINE.warm(config=config)
    source = CandidateIdentity(
        face_id=args.face_id,
        embedding=ENGINE.embedding_for_face(args.face_id, config),
        presentation=ENGINE.presentation_for_face(args.face_id, config),
    )
    target_embedding = ENGINE.embedding_from_images((args.target_reference,), config)
    if target_embedding is None:
        raise RuntimeError("Could not create the selected woman's reference embedding")

    reference_image = cv2.imread(str(args.target_reference), cv2.IMREAD_COLOR)
    if reference_image is None:
        raise RuntimeError(f"Could not read {args.target_reference}")
    reference_faces = detected_faces(reference_image, config)
    reference_presentation = (
        reference_faces[0].presentation
        if reference_faces
        else FacePresentation("female", 1.0)
    )
    target_reference = CandidateIdentity(
        face_id="selected-woman-ground-truth",
        embedding=np.asarray(target_embedding, dtype=np.float32),
        presentation=reference_presentation,
    )

    capture = cv2.VideoCapture(args.source)
    if not capture.isOpened():
        raise RuntimeError(f"Could not open {args.source}")
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 25.0)
    rows: list[dict] = []
    frame_index = -1
    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            frame_index += 1
            if frame_index % max(1, args.stride):
                continue
            faces = detected_faces(frame, config)
            face_rows = []
            for face_index, face in enumerate(faces):
                center = np.mean(face.keypoints, axis=0)
                face_rows.append(
                    {
                        "index": face_index,
                        "x": float(center[0] / max(1, frame.shape[1])),
                        "y": float(center[1] / max(1, frame.shape[0])),
                        "area": float(face.area),
                        "sourceSimilarity": combined_similarity(
                            source,
                            face,
                            mode="lookalike",
                        ),
                        "sourceArcSimilarity": rope_similarity(
                            source.embedding,
                            face.embedding,
                        ),
                        "sourceAppearanceSimilarity": appearance_similarity(
                            source.presentation,
                            face.presentation,
                        ),
                        "targetArcSimilarity": rope_similarity(
                            target_reference.embedding,
                            face.embedding,
                        ),
                        "targetSimilarity": combined_similarity(
                            target_reference,
                            face,
                            mode="identity",
                        ),
                        "presentation": face.presentation.label,
                        "presentationConfidence": float(face.presentation.confidence),
                        "presentationAppearance": list(face.presentation.appearance),
                        "identityEmbedding": face.embedding.tolist(),
                    }
                )
            rows.append(
                {
                    "frame": frame_index,
                    "seconds": frame_index / max(1.0, fps),
                    "faces": face_rows,
                }
            )
    finally:
        capture.release()

    # Ground truth is deliberately independent of Approved 23: the strongest
    # match to the exact selected-woman crop labels her in each frame. A wide
    # margin prevents a bystander from becoming ground truth when she is out.
    for row in rows:
        ranked = sorted(
            row["faces"],
            key=lambda face: face["targetSimilarity"],
            reverse=True,
        )
        best = ranked[0] if ranked else None
        second = ranked[1] if len(ranked) > 1 else None
        row["targetIndex"] = (
            best["index"]
            if best
            and best["targetSimilarity"] >= 55.0
            and (second is None or best["targetSimilarity"] - second["targetSimilarity"] >= 8.0)
            else None
        )

    sweep = []
    for threshold in range(0, 101):
        correct = false_positive = missed = target_frames = selected_frames = 0
        first_target = last_target = None
        first_selected = last_selected = None
        for row in rows:
            target_index = row["targetIndex"]
            if target_index is not None:
                target_frames += 1
                first_target = row["frame"] if first_target is None else first_target
                last_target = row["frame"]
            ranked = sorted(
                row["faces"],
                key=lambda face: face["sourceSimilarity"],
                reverse=True,
            )
            selected = ranked[0] if ranked and ranked[0]["sourceSimilarity"] >= threshold else None
            if selected is not None:
                selected_frames += 1
                first_selected = row["frame"] if first_selected is None else first_selected
                last_selected = row["frame"]
                if target_index is not None and selected["index"] == target_index:
                    correct += 1
                else:
                    false_positive += 1
            elif target_index is not None:
                missed += 1
        sweep.append(
            {
                "strictness": threshold,
                "targetFrames": target_frames,
                "selectedFrames": selected_frames,
                "correct": correct,
                "falsePositive": false_positive,
                "missed": missed,
                "precision": correct / max(1, correct + false_positive),
                "recall": correct / max(1, target_frames),
                "firstTargetFrame": first_target,
                "firstSelectedFrame": first_selected,
                "lastTargetFrame": last_target,
                "lastSelectedFrame": last_selected,
            }
        )

    best = sorted(
        sweep,
        key=lambda row: (
            row["falsePositive"] == 0,
            row["recall"],
            row["precision"],
            -row["strictness"],
        ),
        reverse=True,
    )[0]
    result = {
        "source": args.source,
        "faceId": args.face_id,
        "targetReference": str(args.target_reference),
        "fps": fps,
        "framesAnalyzed": len(rows),
        "elapsedSeconds": time.perf_counter() - started,
        "best": best,
        "sweep": sweep,
        "frames": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in result.items() if key not in {"frames", "sweep"}}, indent=2))
    print(json.dumps({"selectedSweep": [sweep[index] for index in (0, 3, 5, 7, 9, 12, 15, 20, 25, 30, 40, 50)]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
