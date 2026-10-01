"""Local, bounded resemblance preferences from explicit Fix confirmations.

No source URLs, titles, photos, or demographic labels are persisted. Original
face descriptors are retained locally for similarity-weighted preferences.
This adjusts ranking, not detector/model weights or admission restrictions.
"""
import hashlib
import json
import os
import threading
from pathlib import Path
import numpy as np

MIN_FEEDBACK_SIMILARITY = .80
CORRECTION_STRENGTH = 8.
MAXIMUM_BONUS = 18.


class MatchFeedback:
    def __init__(self, path):
        self.path=Path(path)
        self.lock=threading.RLock()
        self.rows=None

    @staticmethod
    def vector(value):
        v=np.asarray(value,dtype=np.float32).reshape(-1)
        if not 2<=v.size<=1024 or not np.isfinite(v).all() or np.linalg.norm(v)<1e-8:
            raise ValueError('A valid original face descriptor is required')
        return v/np.linalg.norm(v)

    def load(self):
        if self.rows is None:
            self.rows=json.loads(self.path.read_text(encoding='utf-8'))['examples'] if self.path.exists() else []
        return self.rows

    def confirm(self, token, index, face_id, embedding):
        vector=self.vector(embedding)
        key=hashlib.sha256(f'{token}:{index}'.encode()).hexdigest()
        with self.lock:
            rows=[r for r in self.load() if r['key']!=key]
            rows.append({'key':key,'faceId':face_id,'embedding':vector.tolist()})
            rows=rows[-1000:]
            self.path.parent.mkdir(parents=True,exist_ok=True)
            temporary=self.path.with_suffix('.tmp')
            temporary.write_text(json.dumps({'schema':1,'examples':rows}),encoding='utf-8')
            os.replace(temporary,self.path)
            self.rows=rows
            return {'ok':True,'saved':True,'examples':len(rows),'policy':'strong-local-match-preference-v2','maximumBonus':MAXIMUM_BONUS}

    def bonuses(self, embedding):
        vector=self.vector(embedding)
        with self.lock:
            try:
                rows=tuple(self.load())
            except (OSError, ValueError, KeyError, TypeError):
                # Corrupt/unavailable preference storage must never break
                # playback. Confirmation still reports a saving error.
                return {}
        votes={}
        for row in rows:
            if not isinstance(row,dict) or not isinstance(row.get('faceId'),str):continue
            try:sample=np.asarray(row['embedding'],dtype=np.float32)
            except (ValueError,KeyError,TypeError):continue
            if sample.shape!=vector.shape:continue
            if not np.isfinite(sample).all():continue
            similarity=float(np.dot(sample,vector))
            # Strong explicit corrections, but within a tighter neighborhood.
            # No new inference pass or rendering/detection setting changes.
            if similarity<MIN_FEEDBACK_SIMILARITY:continue
            weight=CORRECTION_STRENGTH*min(1.,max(0.,(similarity-MIN_FEEDBACK_SIMILARITY)/(1.-MIN_FEEDBACK_SIMILARITY)))
            votes.setdefault(row['faceId'],[]).append(weight)
        return {face:min(MAXIMUM_BONUS,sum(sorted(values,reverse=True)[:6])) for face,values in votes.items()}


MATCH_FEEDBACK=MatchFeedback(Path(__file__).resolve().parent/'cache'/'multi-face-match-feedback.json')
