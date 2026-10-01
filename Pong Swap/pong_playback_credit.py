"""Optional, session-owned ordering for external TikTok playback credit.

Legacy Pong playback updates continue through the engine's original API. This
helper only handles requests that carry both a bound client epoch and sequence.
"""

from __future__ import annotations

import time


class PlaybackSessionStopped(ValueError):
    """An expired producer needs a new session, not another heartbeat."""


def apply_ordered_playback(
    session: object,
    *,
    client_epoch: str,
    sequence: int,
    position_seconds: float,
    paused: bool,
) -> bool:
    """Apply one update atomically; return False for an already superseded one.

    The sequence is stored on the immutable server session, not a process-wide
    map. The session condition is the same lock protecting playback pacing.
    """
    with session.condition:
        if getattr(session, "stop", None) is not None and session.stop.is_set():
            raise PlaybackSessionStopped("playback session has stopped")
        if not client_epoch or client_epoch != session.client_epoch:
            raise ValueError("playback owner mismatch")
        if sequence <= int(getattr(session, "_ordered_playback_sequence", 0)):
            return False
        session.playback_position_seconds = max(
            session.playback_position_seconds, max(0.0, float(position_seconds or 0.0))
        )
        session.playback_position_updated_at = time.monotonic()
        session.playback_paused = bool(paused)
        session._ordered_playback_sequence = sequence
        session.condition.notify_all()
        return True
