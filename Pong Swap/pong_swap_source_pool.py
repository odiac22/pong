"""Bounded, single-owner standby decoders for repeated VOD seeks.

No decoded pictures, embeddings, temporal history or quality settings are reused.
Only an unused input container's completed network/format negotiation is retained.
"""
from __future__ import annotations

import threading
import time
from urllib.parse import urlsplit


class StandbySourcePool:
    def __init__(self, opener=None, *, capacity=2, ttl=60.0, clock=time.monotonic):
        self._opener = opener or self._open
        self._capacity = max(1, int(capacity))
        self._ttl = max(0.01, float(ttl))
        self._clock = clock
        self._lock = threading.Lock()
        self._ready = {}
        self._pending = {}
        self._epoch = 0
        self.hits = 0
        self.misses = 0

    @staticmethod
    def _open(url):
        import av
        return av.open(url, timeout=(10.0, 5.0))

    @staticmethod
    def _close(container):
        try:
            container.close()
        except Exception:
            pass

    def take(self, url):
        """Transfer ownership immediately; never wait for speculative opening."""
        with self._lock:
            entry = self._ready.pop(url, None)
            if entry and entry[1] > self._clock():
                self.hits += 1
                return entry[0]
            self.misses += 1
        if entry:
            self._close(entry[0])
        return None

    def warm(self, url):
        evicted = None
        try:
            parsed = urlsplit(url)
            if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
                return False
        except (TypeError, ValueError):
            return False
        with self._lock:
            if url in self._ready or url in self._pending:
                return False
            if len(self._ready) + len(self._pending) >= self._capacity:
                if not self._ready:
                    return False
                evicted = self._ready.pop(next(iter(self._ready)))[0]
            token = object()
            epoch = self._epoch
            self._pending[url] = token
        if evicted is not None:
            self._close(evicted)

        def produce():
            container = None
            retained = False
            try:
                container = self._opener(url)
                # Do not hold a live stream at a stale live edge.
                if not container.duration or container.duration <= 0:
                    return
                with self._lock:
                    if self._epoch == epoch and self._pending.get(url) is token:
                        self._ready[url] = (container, self._clock() + self._ttl, token)
                        self._pending.pop(url, None)
                        retained = True
                if retained:
                    timer = threading.Timer(self._ttl, self._expire, args=(url, token))
                    timer.daemon = True
                    timer.start()
            except Exception:
                # Warm-up is optional; foreground opening remains authoritative.
                pass
            finally:
                with self._lock:
                    if self._pending.get(url) is token:
                        self._pending.pop(url, None)
                if container is not None and not retained:
                    self._close(container)

        try:
            threading.Thread(target=produce, name='PongStandbySource', daemon=True).start()
        except Exception:
            with self._lock:
                self._pending.pop(url, None)
            return False
        return True

    def _expire(self, url, token):
        with self._lock:
            entry = self._ready.get(url)
            if not entry or entry[2] is not token:
                return
            self._ready.pop(url, None)
        self._close(entry[0])

    def clear(self):
        with self._lock:
            self._epoch += 1
            ready = list(self._ready.values())
            self._ready.clear()
            # In-flight opens remain counted until they finish, then close.
        for entry in ready:
            self._close(entry[0])

    def status(self):
        with self._lock:
            return dict(ready=len(self._ready), opening=len(self._pending), hits=self.hits, misses=self.misses)
