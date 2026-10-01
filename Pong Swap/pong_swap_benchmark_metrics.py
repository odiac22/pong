"""Explicit throughput targets; averages alone do not prove consistency."""
import math


def throughput_consistency(frame_timings, output_fps, processing_fps):
    """Render-work windows, not presentation FPS or a stutter-free guarantee.

    Each window covers 1/5 seconds of the *output* timeline. The end-to-end
    rate remains a separate gate because these durations exclude encoder and
    other pipeline overhead. Missing/invalid observations fail closed.
    """
    durations = [float(row['milliseconds']) for row in frame_timings]
    valid = (math.isfinite(output_fps) and output_fps > 0 and
             math.isfinite(processing_fps) and processing_fps > 0 and
             bool(durations) and all(math.isfinite(ms) and ms > 0 for ms in durations))
    windows = {}
    for seconds in (1, 5):
        size = max(1, round(output_fps * seconds)) if valid else 1
        rates = []
        if valid and len(durations) >= size:
            total = sum(durations[:size])
            rates.append(size * 1000 / total)
            for i in range(size, len(durations)):
                total += durations[i] - durations[i-size]
                rates.append(size * 1000 / total)
        ordered = sorted(rates)
        windows[str(seconds)] = {
            'windowFrames': size, 'count': len(rates),
            'minimumRenderWorkFps': min(rates) if rates else None,
            'p10RenderWorkFps': ordered[int((len(ordered)-1)*.10)] if ordered else None,
            'windowsBelow30': sum(rate < 30 for rate in rates),
            'windowsBelow40': sum(rate < 40 for rate in rates),
        }
    return {
        'scope': 'render-work-only; not presentation cadence',
        'windowsByTimelineSeconds': windows,
        'targets': {
            str(target): {
                'endToEndPassed': valid and processing_fps >= target,
                'renderWindowsPassed': valid and all(
                    w['count'] > 0 and w['minimumRenderWorkFps'] >= target for w in windows.values()),
                'passed': valid and processing_fps >= target and all(
                    w['count'] > 0 and w['minimumRenderWorkFps'] >= target for w in windows.values()),
            } for target in (30, 40)
        },
    }
