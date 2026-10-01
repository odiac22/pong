"""Isolated refinement: perform the unchanged RGB conversion in the decode owner.

No GPU math, source ordering, sampling, resolution or encoding settings change.
Only the review harness opts in. Native decode/close remain single-owner and
the upstream three-frame bound is unchanged.
"""
import threading
from experiment_tiktok_decode_ahead import DecodeAhead, EarlyDecodedContainer
import experiment_tiktok_decode_ahead as early

_lock=threading.Lock()
_converted=0


class ReadyRGBFrame:
    def __init__(self, frame):
        self.pts=frame.pts
        self.rgb=frame.to_ndarray(format='rgb24')
        global _converted
        with _lock:_converted+=1

    def to_ndarray(self, *, format):
        if format!='rgb24':raise ValueError('Only unchanged RGB24 conversion is qualified')
        return self.rgb


class RGBSource:
    def __init__(self, container):self.container=container
    def decode(self, stream):
        for frame in self.container.decode(stream):yield ReadyRGBFrame(frame)
    def close(self):self.container.close()


class RGBCandidateContainer(EarlyDecodedContainer):
    def __init__(self, container, stream):
        super().__init__(container,stream)
        # The metadata is copied before transfer. The replaced queue has not
        # started and owns no native state yet.
        self._ahead=DecodeAhead(RGBSource(container),stream)


def install(engine):
    early.install(engine,review_allow_default=True)
    namespace=engine._produce_session.__globals__
    if namespace.get('__pong_trial_early_container') is not EarlyDecodedContainer:
        raise RuntimeError('Unexpected decode-ahead binding; refusing to replace it')
    namespace['__pong_trial_early_container']=RGBCandidateContainer
    return status()


def status():
    with _lock:return {**early.trial_status(),'rgbPreparedFrames':_converted,'rgbConversion':'same PyAV rgb24, executed in decode owner'}
