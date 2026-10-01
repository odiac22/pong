"""Baseline 1.5: give a prepared next video its first frames in time.

The visible video's producer renders up to ``leadBufferSeconds`` ahead and
keeps Pong's single GPU worker busy; prepared (prefetch) sessions run at a
lower queue priority, so on a fast swipe the next video had often not
rendered a single frame yet (harness: first prepared frame 2.1-4.1 s after
preparation started, so swipes at 2 s were effectively cold).

This scheduler uses the engine's existing per-session promotion set (the
same mechanism used when a prepared session is activated) to raise a
speculative session to foreground priority for only its first
``boost_frames`` frames, and only while the visible video already has at
least ``min_foreground_lead`` seconds rendered ahead of playback. It changes
scheduling order only: no model, quality or pixel setting is touched, and
the frozen engine source is not modified.
"""
from __future__ import annotations

import math
import os
import threading
import time
from typing import Any


class PrefetchBoost:
    def __init__(self, engine: Any, *, boost_frames: int = 10,
                 min_foreground_lead: float = 0.6, interval: float = 0.015):
        self.engine = engine
        self.boost_frames = max(1, int(boost_frames))
        self.min_foreground_lead = max(0.0, float(min_foreground_lead))
        self.interval = max(0.005, float(interval))
        self.enabled = os.environ.get("PONG_PREFETCH_BOOST", "1") != "0"
        self.promotions = 0
        self._boosted: set[str] = set()
        self._thread: threading.Thread | None = None

    def _install_yield_exemption(self) -> None:
        """Let the first frames through the engine's speculative yield.

        ``_yield_prefetch_for_foreground`` holds every speculative frame until
        the visible stream has ``minimumHeadroom`` (2 s) rendered ahead, which
        took ~5 s at 1.4x real time, so fast swipes never had a prepared frame.
        The instance attribute wraps the engine method without editing it.
        """
        engine = self.engine
        original = engine._foreground_playback_needs_gpu

        def needs_gpu(excluded_session_id: str, *args: Any, **kwargs: Any) -> bool:
            with engine._sessions_lock:
                session = engine._sessions.get(excluded_session_id)
            if (session is not None and session.prefetch and not session.activation_requested
                    and session.frames < self.boost_frames
                    and self._foreground_lead(session.channel) >= self.min_foreground_lead):
                return False
            return original(excluded_session_id, *args, **kwargs)

        engine._foreground_playback_needs_gpu = needs_gpu

    def start(self) -> None:
        if not self.enabled or self._thread is not None:
            return
        self._install_yield_exemption()
        self._thread = threading.Thread(target=self._loop, name="PongPrefetchBoost", daemon=True)
        self._thread.start()

    def snapshot(self) -> dict[str, Any]:
        return {"enabled": self.enabled, "boostFrames": self.boost_frames,
                "minForegroundLead": self.min_foreground_lead,
                "promotions": self.promotions, "boosted": len(self._boosted)}

    def _foreground_lead(self, channel: str) -> float:
        engine = self.engine
        with engine._sessions_lock:
            active_id = engine._active_by_channel.get(channel)
            active = engine._sessions.get(active_id) if active_id else None
        if active is None or active.stop.is_set():
            return math.inf
        if not active.fps or not active.frames:
            return 0.0
        played = engine._estimated_playback_position_seconds(active, time.monotonic())
        return active.frames / active.fps - played

    def _unpromote(self, session: Any) -> None:
        engine = self.engine
        with engine._gpu_worker_lock:
            promoted = getattr(engine, "_gpu_promoted_events", None)
            if promoted is not None:
                promoted.discard(session.stop)
        self._boosted.discard(session.id)

    def tick(self) -> None:
        engine = self.engine
        with engine._sessions_lock:
            sessions = list(engine._sessions.values())
        live_ids = set()
        for session in sessions:
            live_ids.add(session.id)
            speculative = bool(session.prefetch and not session.activation_requested
                               and not session.playback_started_at and not session.stop.is_set())
            if not speculative:
                # Activation promotes permanently through the engine itself;
                # forget our bookkeeping without touching that promotion.
                self._boosted.discard(session.id)
                continue
            want = (session.frames < self.boost_frames
                    and self._foreground_lead(session.channel) >= self.min_foreground_lead)
            if want and session.id not in self._boosted:
                engine._promote_queued_session_work(session)
                self._boosted.add(session.id)
                self.promotions += 1
            elif not want and session.id in self._boosted:
                self._unpromote(session)
        self._boosted &= live_ids

    def _loop(self) -> None:
        while True:
            try:
                self.tick()
            except Exception:
                pass
            time.sleep(self.interval)
