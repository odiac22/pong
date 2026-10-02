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
    def __init__(self, engine: Any, *, boost_frames: int | None = None,
                 min_foreground_lead: float | None = None, interval: float = 0.015,
                 share_headroom: float | None = None, admission_slots: int | None = None):
        env = os.environ.get
        self.engine = engine
        # Baseline 1.10 (live 1.5 s auto-swipe): only the NEXT video is boosted,
        # for ~0.8 s of frames, while the visible one keeps >= 0.3 s rendered.
        self.boost_frames = max(1, int(boost_frames if boost_frames is not None
                                       else env("PONG_PREFETCH_BOOST_FRAMES", "24")))
        self.min_foreground_lead = max(0.0, float(min_foreground_lead if min_foreground_lead is not None
                                                  else env("PONG_PREFETCH_MIN_FOREGROUND_LEAD", "0.3")))
        # Baseline 1.8: an unprepared next video may share the GPU once the
        # visible video has this much playable media ahead (engine: 2 s).
        if share_headroom is None:
            share_headroom = float(env("PONG_PREFETCH_SHARE_HEADROOM", "0.6"))
        self.share_headroom = max(0.0, float(share_headroom))
        # Baseline 1.10: the engine admits ONE speculative session at a time and
        # it keeps the slot until prepared. With 1.5 s swipes that slot was
        # held by a video that never got GPU time, so the next video waited
        # in admission until shown and started cold (first swap ~3.3 s).
        self.admission_slots = max(1, int(admission_slots if admission_slots is not None
                                          else env("PONG_PREFETCH_SLOTS", "2")))
        self.shared_frames = 0
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
            speculative = bool(session is not None and session.prefetch
                               and not session.activation_requested)
            if (speculative and session.frames < self.boost_frames
                    and self._is_next(session)
                    and self._foreground_lead(session.channel) >= self.min_foreground_lead):
                return False
            # Live 2026-10-01: after each swipe the visible video needs ~5 s to
            # bank 2 s of headroom, so with swipes every 2-5 s the next video sat
            # at its 10 boost frames (0 swapped) until shown. Until it is
            # prepared, let it use the surplus above ``share_headroom``; the
            # visible video regains priority the moment it drops below that.
            if (speculative and self.share_headroom > 0 and not session.is_prepared()
                    and self._foreground_headroom(session.channel, kwargs.get("now"))
                    >= self.share_headroom):
                self.shared_frames += 1
                return False
            return original(excluded_session_id, *args, **kwargs)

        engine._foreground_playback_needs_gpu = needs_gpu

    def _is_next(self, session: Any) -> bool:
        """The oldest live speculative session on a channel is the next video:
        Pong registers prepared videos in feed order and retires passed ones."""
        engine = self.engine
        with engine._sessions_lock:
            peers = [s for s in engine._sessions.values()
                     if s.channel == session.channel and s.prefetch and not s.activation_requested
                     and not s.playback_started_at and not s.stop.is_set()]
        if not peers:
            return False
        return min(peers, key=lambda s: s.created_at).id == session.id

    def start(self) -> None:
        if not self.enabled or self._thread is not None:
            return
        if self.admission_slots > 1:
            # Same acquire(timeout)/release interface as the engine's Lock.
            # Installed before any session exists (service startup).
            self.engine._prefetch_gate = threading.BoundedSemaphore(self.admission_slots)
        self._install_yield_exemption()
        self._thread = threading.Thread(target=self._loop, name="PongPrefetchBoost", daemon=True)
        self._thread.start()

    def snapshot(self) -> dict[str, Any]:
        return {"enabled": self.enabled, "boostFrames": self.boost_frames,
                "minForegroundLead": self.min_foreground_lead,
                "promotions": self.promotions, "boosted": len(self._boosted),
                "shareHeadroom": self.share_headroom, "sharedFrames": self.shared_frames,
                "admissionSlots": self.admission_slots}

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

    def _foreground_headroom(self, channel: str, now: float | None = None) -> float:
        """Smallest playable headroom among visible streams, as the engine measures it."""
        engine = self.engine
        observed = time.monotonic() if now is None else float(now)
        with engine._sessions_lock:
            active_ids = set(engine._active_by_channel.values())
            sessions = [engine._sessions[i] for i in active_ids if i in engine._sessions]
        headroom = math.inf
        for active in sessions:
            if (active.complete or active.stop.is_set() or active.prefetch
                    or not active.activation_requested or not active.playback_started_at
                    or active.fps <= 0 or active.subscribers <= 0):
                continue
            headroom = min(headroom, engine._playback_headroom_seconds(active, observed))
        return headroom

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
            want = (session.frames < self.boost_frames and self._is_next(session)
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
