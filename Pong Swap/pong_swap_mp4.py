"""Fixed-duration initialization for progressively delivered fragmented MP4.

Only fixed-width duration metadata is changed. Encoded samples, offsets, box
sizes, timestamps and codec parameters are preserved. Unknown/live duration
and malformed/unsupported initialization boxes pass through byte-for-byte.
"""
import math
import struct


def set_movie_duration(payload: bytes, seconds: float) -> bytes:
    if not math.isfinite(seconds) or seconds <= 0:
        return payload
    result = bytearray(payload)
    movie_scale = None
    tracks = []

    def walk(start, end):
        nonlocal movie_scale
        p = start
        while p < end:
            if p + 8 > end:
                raise ValueError('Truncated box')
            size, kind = struct.unpack_from('>I4s', result, p)
            if size < 8 or p + size > end:
                raise ValueError('Unsupported box size')
            data = p + 8
            if kind in (b'mvhd', b'mdhd', b'tkhd'):
                version = result[data]
                if version not in (0, 1):
                    raise ValueError('Unsupported full box version')
                width = 8 if version else 4
                if kind == b'tkhd':
                    offset = data + (28 if version else 20)
                    tracks.append((offset, width))
                else:
                    scale_offset = data + (20 if version else 12)
                    offset = data + (24 if version else 16)
                    if offset + width > p + size:
                        raise ValueError('Truncated duration field')
                    scale = struct.unpack_from('>I', result, scale_offset)[0]
                    if not scale:
                        raise ValueError('Invalid timescale')
                    if kind == b'mvhd':
                        movie_scale = scale
                    put(offset, width, scale)
                if offset + width > p + size:
                    raise ValueError('Truncated track duration')
            if kind in (b'moov', b'trak', b'mdia'):
                walk(data, p + size)
            p += size

    def put(offset, width, scale):
        value = round(seconds * scale)
        if not 0 < value < (1 << (8 * width)) - 1:
            raise ValueError('Duration outside field range')
        result[offset:offset + width] = value.to_bytes(width, 'big')

    try:
        walk(0, len(result))
        if movie_scale is None:
            return payload
        for offset, width in tracks:
            put(offset, width, movie_scale)
    except (ValueError, IndexError, struct.error, OverflowError):
        return payload
    return bytes(result)


class MovieDurationInitializer:
    """Buffer at most one bounded initialization box, never media payload."""
    def __init__(self, seconds=0):
        self.seconds = float(seconds or 0)
        self.done = not (math.isfinite(self.seconds) and self.seconds > 0)
        self.pending = bytearray()

    def feed(self, chunk, *, eof=False):
        if self.done:
            return chunk
        self.pending.extend(chunk)
        output = bytearray()
        while len(self.pending) >= 8:
            size, kind = struct.unpack_from('>I4s', self.pending)
            if size < 8 or size > 16 * 1024 * 1024 or kind in (b'moof', b'mdat'):
                self.done = True
                break
            if len(self.pending) < size:
                break
            box = bytes(self.pending[:size])
            del self.pending[:size]
            if kind == b'moov':
                box = set_movie_duration(box, self.seconds)
                self.done = True
            output.extend(box)
            if self.done:
                break
        if eof or self.done:
            output.extend(self.pending)
            self.pending.clear()
            self.done = True
        return bytes(output)
