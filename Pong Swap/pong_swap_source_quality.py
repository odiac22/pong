"""Select the best declared video track, independent of demuxer stream order."""
from __future__ import annotations

import math


def highest_quality_video_stream(container):
    def positive(value):
        try:
            number = float(value or 0)
            return number if math.isfinite(number) and number > 0 else 0.0
        except (ValueError, TypeError, OverflowError, ZeroDivisionError):
            return 0.0

    def rank(stream):
        codec = stream.codec_context
        pixels = positive(getattr(codec, "width", 0)) * positive(getattr(codec, "height", 0))
        fps = positive(getattr(stream, "average_rate", None) or getattr(stream, "base_rate", None))
        metadata = getattr(stream, "metadata", None) or {}
        bitrate = positive(getattr(codec, "bit_rate", None)) or positive(metadata.get("variant_bitrate"))
        return pixels, fps, bitrate

    streams = [stream for stream in container.streams if stream.type == "video"]
    # max is stable for identical ranks, and the one-stream path is unchanged.
    return max(streams, key=rank, default=None)
