"""Small, reversible detector calibration from explicit original-frame taps.

This is not model training. Identity thresholds and all rendering settings are
deliberately outside this module. No images, embeddings or source URLs persist.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
from copy import deepcopy
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit


class DetectionCalibration:
    DEFAULT = 0.45
    MINIMUM = 0.35
    STEP = 0.01
    REQUIRED_SOURCES = 3

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()
        self._state = self._default()
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            if data.get('schema') == 1:
                score = float(data['threshold'])
                if self.MINIMUM <= score <= self.DEFAULT:
                    self._state['threshold'] = score
                    self._state['confirmed'] = max(0, int(data.get('confirmed', 0)))
                    self._state['sources'] = [s for s in data.get('sources', [])
                                             if isinstance(s, str) and len(s) == 64][-512:]
                    self._state['pendingRecovery'] = min(2, max(0, int(data.get('pendingRecovery', 0))))
        except (OSError, ValueError, TypeError, KeyError):
            pass

    @classmethod
    def _default(cls):
        return dict(schema=1, threshold=cls.DEFAULT, confirmed=0, sources=[], pendingRecovery=0)

    @property
    def threshold(self) -> float:
        # An immutable number; avoid a file read or lock in every video frame.
        return self._state['threshold']

    def public(self):
        with self._lock:
            return dict(threshold=self.threshold, minimum=self.MINIMUM, step=self.STEP,
                        confirmed=self._state['confirmed'], pendingRecovery=self._state['pendingRecovery'],
                        scope='target_detector_only', modelWeightsChanged=False)

    def _save(self, updated):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix('.tmp')
        # Keep the immediately previous state for recovery. Atomic replace means
        # interruption cannot leave a partially-written baseline as active.
        if self.path.exists():
            previous = self.path.with_suffix('.previous.json')
            previous.write_bytes(self.path.read_bytes())
        try:
            with temporary.open('w', encoding='utf-8') as stream:
                json.dump(updated, stream, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)
        self._state = updated

    @staticmethod
    def _source_fingerprint(source: str) -> str:
        # Proxy URLs often have one shared path and the original URL in `url`
        # or `u`. Counting only that outer path would merge unrelated clips.
        # Unwrap at most twice; strip access tokens, signatures and fragments.
        for depth in range(3):
            parsed = urlsplit(source)
            if parsed.scheme not in ('http', 'https') or not parsed.hostname:
                raise ValueError('Learning requires an original video source')
            query = parse_qs(parsed.query, max_num_fields=128)
            nested = next((query[key][0] for key in ('url', 'u', 'sourceUrl', 'source')
                           if query.get(key) and query[key][0].startswith(('https://', 'http://'))), None)
            if depth < 2 and nested:
                source = nested
                continue
            # Stable media IDs are not interchangeable with arbitrary signed
            # queries. Never treat rotated access credentials as new evidence.
            identity = [(key, query[key][0]) for key in ('id', 'v', 'video_id', 'videoId') if query.get(key)]
            canonical = parsed.hostname.lower() + parsed.path + '?' + urlencode(identity)
            return hashlib.sha256(canonical.encode()).hexdigest()
        raise ValueError('Original source could not be normalized')

    def confirm(self, source: str, *, recovered: bool):
        fingerprint = self._source_fingerprint(source)
        with self._lock:
            if fingerprint in self._state['sources']:
                return dict(self.public(), saved=True, changed=False, duplicate=True)
            updated = deepcopy(self._state)
            updated['sources'] = (updated['sources'] + [fingerprint])[-512:]
            updated['confirmed'] += 1
            updated['pendingRecovery'] += int(recovered)
            old = self.threshold
            if updated['pendingRecovery'] >= self.REQUIRED_SOURCES:
                updated['threshold'] = round(max(self.MINIMUM, old - self.STEP), 4)
                updated['pendingRecovery'] = 0
            self._save(updated)
            return dict(self.public(), saved=True, changed=self.threshold != old, duplicate=False)

    def reset(self):
        with self._lock:
            self._save(self._default())
            return self.public()
