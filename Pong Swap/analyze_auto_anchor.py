from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

from pong_swap_identity import (
    CandidateIdentity,
    FacePresentation,
    TargetIdentity,
    compatible_identity_rankings,
)


def face_from_row(row: dict) -> TargetIdentity:
    return TargetIdentity(
        keypoints=np.zeros((5, 2), dtype=np.float32),
        embedding=np.asarray(row["identityEmbedding"], dtype=np.float32),
        presentation=FacePresentation(
            str(row["presentation"]),
            float(row["presentationConfidence"]),
            tuple(float(value) for value in row["presentationAppearance"]),
        ),
    )


def score(anchor: np.ndarray, presentation: FacePresentation, face: TargetIdentity) -> float:
    ranked = compatible_identity_rankings(
        (CandidateIdentity("anchor", anchor, presentation),),
        face,
        minimum_similarity=0,
        minimum_presentation_confidence=0,
        similarity_mode="identity",
    )
    return float(ranked[0].similarity) if ranked else -math.inf


def main() -> int:
    embeddings = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    labels = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    labels_by_frame = {int(row["frame"]): row.get("targetIndex") for row in labels["frames"]}
    frames = {int(row["frame"]): row for row in embeddings["frames"]}
    acquisition_frame = 22
    acquisition_index = int(labels_by_frame[acquisition_frame])
    acquired = face_from_row(frames[acquisition_frame]["faces"][acquisition_index])
    anchor = acquired.embedding.copy()
    presentation = acquired.presentation
    accepted = []
    rejected = []
    false_scores = []
    for frame_index in range(acquisition_frame, 189):
        frame = frames[frame_index]
        target_index = labels_by_frame.get(frame_index)
        if target_index is None:
            continue
        target = face_from_row(frame["faces"][int(target_index)])
        target_score = score(anchor, presentation, target)
        other_scores = [
            score(anchor, presentation, face_from_row(row))
            for index, row in enumerate(frame["faces"])
            if index != int(target_index)
        ]
        false_scores.extend(value for value in other_scores if math.isfinite(value))
        if target_score >= 25.0:
            accepted.append((frame_index, target_score))
            blended = anchor * 0.80 + target.embedding * 0.20
            anchor = blended / np.linalg.norm(blended)
        else:
            rejected.append((frame_index, target_score))
    print(
        json.dumps(
            {
                "accepted": len(accepted),
                "rejected": len(rejected),
                "firstRejected": rejected[:10],
                "lastAccepted": accepted[-10:],
                "acceptedMin": min((value for _, value in accepted), default=None),
                "acceptedMax": max((value for _, value in accepted), default=None),
                "otherMax": max(false_scores, default=None),
                "otherP99": float(np.quantile(false_scores, 0.99)) if false_scores else None,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
