"""Expiring, bounded client leases; idle health polling is not user activity."""
import threading
import time


class ActivityWarmth:
    def __init__(self, engine, *, clock=time.monotonic, lease_seconds=90):
        self.engine = engine
        self.clock = clock
        self.lease_seconds = lease_seconds
        self._lock = threading.Lock()
        self._clients = {}
        self._warming = False
        self._retry_at = 0
        self._warm_count = 0

    def _prune(self):
        now = self.clock()
        self._clients = {key: expiry for key, expiry in self._clients.items() if expiry > now}

    def active(self):
        with self._lock:
            self._prune()
            return bool(self._clients)

    def touch(self, client, visible):
        with self._lock:
            self._prune()
            if visible:
                if client not in self._clients and len(self._clients) >= 64:
                    return self._snapshot()
                self._clients[client] = self.clock() + self.lease_seconds
                if not self._warming and self.clock() >= self._retry_at:
                    self._warming = True
                    threading.Thread(target=self._warm, name='PongActivityWarmth', daemon=True).start()
            else:
                self._clients.pop(client, None)
            return self._snapshot()

    def _snapshot(self):
        return {'active': bool(self._clients), 'clients': len(self._clients),
                'warming': self._warming, 'coldWarms': self._warm_count}

    def snapshot(self):
        with self._lock:
            self._prune()
            return self._snapshot()

    def _warm(self):
        try:
            if not self.active():
                return
            health = self.engine.health()
            if not health.get('ready') and not health.get('activeSessions'):
                self.engine.warm()
                with self._lock:
                    self._warm_count += 1
        except Exception:
            # Normal session admission still owns its error/reporting path.
            pass
        finally:
            with self._lock:
                self._warming = False
                self._retry_at = self.clock() + 10
