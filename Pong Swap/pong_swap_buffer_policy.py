"""Pure pacing policy for a bounded, foreground-only render-ahead reservoir.

This changes only how much *complete encoded media* a producer may bank while
playback is active. It does not change startup admission, frames, or timestamps.
The caller still gates on its measured playable media and browser position.
"""

from __future__ import annotations

import math


def render_ahead_ceiling_seconds(
    *,
    base_seconds: float,
    max_foreground_seconds: float,
    foreground_pacing_wait_seconds: float,
    active_foreground: bool,
    playback_paused: bool,
    startup_ready: bool,
    scrub_suspended: bool = False,
) -> float:
    """Return the maximum lead allowed for the *next* encoded frame.

    A producer that has spent time waiting at the ordinary cap has demonstrated
    spare render capacity. Give it four seconds of extra ceiling per second of
    capped wait, up to a strict maximum. A compute-bound producer never waits
    at the cap, so its ceiling stays at the existing base value.

    ``foreground_pacing_wait_seconds`` counts only active, unpaused foreground
    time at the lead gate, *including the current in-progress wait*. It excludes
    prefetch, paused/background, and browser buffering time. The caller must
    keep its existing startup-ready bypass and stop/condition checks; this
    function performs no waiting.
    """
    base = float(base_seconds)
    maximum = float(max_foreground_seconds)
    waited = float(foreground_pacing_wait_seconds)
    if not all(math.isfinite(value) for value in (base, maximum, waited)):
        raise ValueError("Lead-policy inputs must be finite")
    if base <= 0 or maximum < base or waited < 0:
        raise ValueError("Lead-policy bounds and wait must be nonnegative")
    if (
        not active_foreground
        or playback_paused
        or not startup_ready
        or scrub_suspended
    ):
        return base
    return min(maximum, base + 4.0 * waited)
