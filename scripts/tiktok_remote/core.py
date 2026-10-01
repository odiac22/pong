"""Small, testable safety/timing primitives for the remote TikTok prototype."""
import asyncio
import math
import secrets
from collections import deque

VERSION = "30.38.4"


class InputMailbox:
    """Bounded controls; collapse only adjacent valid MOVE positions.

    DOWN/UP/CANCEL/keys are never dropped or reordered. Replaced moves are
    explicitly reported, not counted as RPC/visible-response acknowledgements.
    """
    def __init__(self, maxsize=128):
        self.maxsize = maxsize
        self.items = deque()
        self.available = asyncio.Event()
        self.coalesced = 0

    @staticmethod
    def _move(message):
        return (isinstance(message, dict) and message.get('type') == 'touch'
                and message.get('action') == 'move'
                and type(message.get('seq')) is int and 0 <= message['seq'] <= 2**53-1
                and all(type(message.get(k)) in (int, float) and math.isfinite(message[k])
                        and 0 <= message[k] <= 1 for k in ('x', 'y')))

    def put_nowait(self, item):
        replaced = None
        if (self.items and self._move(item[0]) and self._move(self.items[-1][0])
                and item[0]['seq'] > self.items[-1][0]['seq']):
            replaced = self.items[-1][0]['seq']
            self.items[-1] = item
            self.coalesced += 1
        else:
            if len(self.items) >= self.maxsize:
                raise asyncio.QueueFull
            self.items.append(item)
        self.available.set()
        return replaced

    async def get(self):
        while not self.items:
            self.available.clear()
            await self.available.wait()
        return self.items.popleft()


def authorized(provided, expected):
    return bool(expected and isinstance(provided, str)
                and secrets.compare_digest(provided, expected))


def percentile(values, fraction):
    if not values:
        return None
    items = sorted(values)
    return round(items[max(0, math.ceil(len(items) * fraction) - 1)], 3)


class Timings:
    def __init__(self):
        self.values = {}

    def add(self, name, ms):
        if math.isfinite(ms) and ms >= 0:
            self.values.setdefault(name, deque(maxlen=1000)).append(ms)

    def public(self):
        return {name: {"count": len(v), "medianMs": percentile(v, .5),
                       "p95Ms": percentile(v, .95), "maxMs": round(max(v), 3)}
                for name, v in self.values.items() if v}


class TouchState:
    """One finger, strict ordering, normalized coordinates. Never executes shell input."""
    def __init__(self):
        self.sequence = -1
        self.active = False
        self.last = (0., 0.)

    def accept(self, message):
        seq, action = message.get("seq"), message.get("action")
        if type(seq) is not int or not 0 <= seq <= 2**53 - 1 or seq <= self.sequence:
            raise ValueError("stale/invalid input sequence")
        if action not in ("down", "move", "up", "cancel"):
            raise ValueError("unsupported touch action")
        x, y = message.get("x"), message.get("y")
        if any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1
               for v in (x, y)):
            raise ValueError("coordinates must be finite and normalized")
        if action == "down" and self.active:
            raise ValueError("finger already down")
        if action != "down" and not self.active:
            raise ValueError("no active finger")
        self.sequence, self.last = seq, (x, y)
        self.active = action not in ("up", "cancel")
        return x, y, 1 if self.active else 0


def normalized_roi(values):
    if not isinstance(values, list) or len(values) != 4:
        raise ValueError("ROI requires left, top, right, bottom")
    if any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1
           for v in values):
        raise ValueError("invalid ROI")
    left, top, right, bottom = values
    if right <= left or bottom <= top:
        raise ValueError("empty ROI")
    return tuple(values)
