"""Consolidate only explicitly user-assigned labels; never infer a person's identity.

Originals are copied and verified before redundant folders are moved to a private
archive outside the engine's scan root. A durable manifest makes reruns safe.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
GROUP_FILE = ROOT / "approved_face_groups.json"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def consolidate(root=ROOT):
    root = Path(root).resolve()
    faces = (root / "approved-faces").resolve()
    groups = json.loads((root / GROUP_FILE.name).read_text(encoding="utf-8"))["groups"]
    state = root / "approved-face-consolidation.json"
    if state.exists():
        result = json.loads(state.read_text(encoding="utf-8"))
        if result["groups"] != groups:
            raise RuntimeError("Existing consolidation differs; review it before changing assignments")
        for row in result["copies"]:
            if digest(Path(row["destination"])) != row["sha256"]:
                raise RuntimeError("A consolidated reference changed; refusing to overwrite it")
        return result
    plan = []
    redundant = []
    for group in groups:
        destination = (faces / group["name"]).resolve()
        if destination.parent != faces or not destination.is_dir():
            raise ValueError(f"Missing or unsafe destination: {group['name']}")
        for number in group["members"]:
            source = (faces / f"Approved {number}").resolve()
            if source.parent != faces or not source.is_dir() or source.is_symlink():
                raise ValueError(f"Missing or unsafe source: Approved {number}")
            if source == destination:
                continue
            files = [p for p in source.rglob("*") if p.is_file()]
            if not files:
                raise ValueError(f"Empty source: {source.name}")
            for file in files:
                if not file.resolve().is_relative_to(source) or file.is_symlink():
                    raise ValueError("Reference escaped its source directory")
                target = destination / f"z-merged-approved-{number}" / file.relative_to(source)
                if target.exists():
                    raise FileExistsError(f"Refusing to overwrite {target}")
                plan.append((file, target, digest(file)))
            redundant.append(source)
    archive = (root / "approved-face-archives" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")).resolve()
    if archive.parent != (root / "approved-face-archives").resolve():
        raise ValueError("Unsafe archive")
    archive.mkdir(parents=True, exist_ok=False)
    # Keep all initial groups, including retained leaders, byte-for-byte.
    for group in groups:
        for number in group["members"]:
            source = faces / f"Approved {number}"
            shutil.copytree(source, archive / "originals" / source.name)
            for original in source.rglob("*"):
                if original.is_file() and digest(original) != digest(archive / "originals" / source.name / original.relative_to(source)):
                    raise RuntimeError("Backup checksum mismatch")
    result = {"schema": "pong-approved-consolidation-v1", "groups": groups,
              "archive": str(archive), "copies": [], "archivedFolders": []}
    for source, destination, expected in plan:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        if digest(destination) != expected:
            raise RuntimeError("Copied reference checksum mismatch")
        result["copies"].append({"source": str(source), "destination": str(destination), "sha256": expected})
    (archive / "retired-selectable-folders").mkdir()
    for source in redundant:
        target = (archive / "retired-selectable-folders" / source.name).resolve()
        # Explicit containment checks before each directory move.
        if source.resolve().parent != faces or target.parent != archive / "retired-selectable-folders":
            raise ValueError("Unsafe archive move")
        shutil.move(str(source), str(target))
        result["archivedFolders"].append({"old": str(source), "archive": str(target)})
    encoded = json.dumps(result, indent=2)
    (archive / "manifest.json").write_text(encoded, encoding="utf-8")
    state.write_text(encoded, encoding="utf-8")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", required=True)
    parser.parse_args()
    report = consolidate()
    print(json.dumps({"groups": report["groups"], "archive": report["archive"], "copiedFiles": len(report["copies"])}))
