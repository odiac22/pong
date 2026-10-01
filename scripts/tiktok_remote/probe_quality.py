"""Measurement validity, independent of capture/encoder libraries."""
import re


def foreground_package(activity_dump):
    match = re.search(r'(?:topResumedActivity|mResumedActivity)[^\r\n]*?\bu\d+\s+([\w.]+)/', activity_dump)
    return match.group(1) if match else None


def frame_window(count, first, last, start, end):
    """Whole-window throughput, not a misleading short-burst frame rate.

    Changed-screen capture is not the source video's frame rate. A static
    screen may legitimately emit few frames; this cannot qualify playback.
    """
    window = max(0., end-start)
    span = max(0., last-first) if count > 1 and first is not None and last is not None else 0.
    return dict(windowSeconds=round(window, 6),
                wholeWindowFps=round(count/window, 3) if window else None,
                activeSpanFps=round((count-1)/span, 3) if span else None,
                activeSpanSeconds=round(span, 6),
                captureCoverage=round(min(1., span/window), 6) if window else 0.,
                sourceVideoFps=None)
