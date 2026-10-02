"""Owner's approved-face roster (2026-10-02): display names and match rules.

Face IDs stay derived from the ``Approved N`` folders, so saved selections,
per-face restoration settings, hair profiles and cached embeddings keep
working. Only the name shown in Pong changes.

Rules apply when several faces are selected (Multi Face): a face whose rule
the video person clearly fails is not used for that video. When hair or skin
cannot be measured with confidence (hair hidden, odd lighting) the face stays
allowed, so a swap still happens.
"""
from __future__ import annotations

import re

# Approved number -> name shown in Pong.
DISPLAY_NAMES = {3: "Ala", 8: "Lau", 13: "Cam", 17: "Syd", 19: "Car",
                 23: "Ash", 27: "Alis", 28: "Moni"}

# Hair categories measured on the video person: black, brown, light, colorful.
# None = any hair. "skin": "dark" = only for dark-skinned video people.
RULES = {
    3: {"hair": {"black"}},
    8: {"hair": {"light", "colorful"}},
    13: {"hair": {"black", "colorful"}},
    17: {"hair": {"light"}},
    19: {"hair": None},
    23: {"hair": None, "skin": "dark"},
    27: {"hair": {"black", "brown"}},
    28: {"hair": None, "skin": "dark"},
}


def approved_number(face_id: str) -> int | None:
    match = re.fullmatch(r"approved-(\d+)(?:-[0-9a-f]{12})?", str(face_id))
    return int(match.group(1)) if match else None


def folder_number(name: str) -> int | None:
    match = re.fullmatch(r"approved\s+(\d+)", str(name).strip(), re.IGNORECASE)
    return int(match.group(1)) if match else None


def display_name(face_id: str, name: str) -> str:
    number = approved_number(face_id)
    if number is None:
        number = folder_number(name)
    return DISPLAY_NAMES.get(number, name) if number is not None else name


def rule(face_id: str) -> dict | None:
    number = approved_number(face_id)
    found = RULES.get(number) if number is not None else None
    if not found or (found.get("hair") is None and not found.get("skin")):
        return None
    return found
