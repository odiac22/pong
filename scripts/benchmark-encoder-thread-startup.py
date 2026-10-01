"""Offline NVENC first-fragment thread-flag comparison; never touches Pong sessions.

Run only when the renderer is idle. The baseline mirrors the muted frozen
encoder command for 720x1280, 30 fps, p1/CQ23 and the 0.5-second foreground GOP. Candidate
flags are independent; no candidate is promoted by this script. Decoded RGB
must be frame- and timestamp-identical to baseline to count as pixel preserving.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import threading
import time

import av
import numpy as np


VARIANTS = ('baseline', 'filter_threads_1', 'filter_threads_2', 'threads_1')
FROZEN_SOURCE = Path(__file__).resolve().parents[1] / 'Pong Swap' / 'pong_exact_runtime' / 'frozen_methods.py'


def build_command(variant: str, *, ffmpeg: str = 'ffmpeg', width: int = 720,
                  height: int = 1280, fps: int = 30, cq: int = 23,
                  preset: str = 'p1', fragment_seconds: float = 0.50) -> list[str]:
    if variant not in VARIANTS:
        raise ValueError('unsupported variant')
    gop = max(1, round(fps * max(1.0 / fps, fragment_seconds)))
    command = [
        ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin',
    ]
    if variant.startswith('filter_threads_'):
        # FFmpeg defines this as a global filter-pipeline thread-pool option.
        command.extend(('-filter_threads', variant.rsplit('_', 1)[1]))
    command.extend((
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s:v', f'{width}x{height}',
        '-r', f'{fps:.6f}', '-i', 'pipe:0', '-map', '0:v:0', '-an',
    ))
    command.extend((
        '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p',
        '-c:v', 'h264_nvenc',
    ))
    if variant == 'threads_1':
        command.extend(('-threads', '1'))
    command.extend((
        '-preset', preset, '-tune', 'll', '-rc', 'vbr', '-cq', str(cq), '-b:v', '0',
        '-g', str(gop), '-keyint_min', str(gop), '-bf', '0', '-rc-lookahead', '0',
        '-delay', '0', '-zerolatency', '1', '-color_range', 'tv', '-colorspace', 'bt709',
        '-color_primaries', 'bt709', '-color_trc', 'bt709',
        '-movflags', 'frag_every_frame+empty_moov+default_base_moof',
        '-flush_packets', '1', '-f', 'mp4', 'pipe:1',
    ))
    return command


def verify_frozen_mirror(source: str) -> None:
    """Fail closed if key quality/mux anchors drift from the frozen producer."""
    required = (
        '"-f", "rawvideo", "-pix_fmt", "rgb24"',
        '"-r", f"{fps:.6f}", "-i", "pipe:0"',
        'scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p',
        '"-c:v", "h264_nvenc"',
        '"-tune", "ll"',
        '"-rc", "vbr", "-cq"',
        '"-bf", "0", "-rc-lookahead", "0", "-delay", "0", "-zerolatency", "1"',
        'frag_every_frame+empty_moov+default_base_moof',
        '"-flush_packets", "1"',
    )
    if any(anchor not in source for anchor in required):
        raise RuntimeError('frozen encoder command changed; re-review benchmark mirror')


class FragmentProbe:
    """Track first complete moof+mdat, not an incidental byte signature."""

    def __init__(self):
        self.pending = bytearray()
        self.saw_moof = False
        self.complete_fragments = 0

    def feed(self, chunk: bytes) -> int:
        self.pending.extend(chunk)
        found = 0
        while len(self.pending) >= 8:
            size = int.from_bytes(self.pending[:4], 'big')
            header = 8
            if size == 1:
                if len(self.pending) < 16:
                    break
                size = int.from_bytes(self.pending[8:16], 'big')
                header = 16
            if size < header or size > 512 * 1024 * 1024:
                raise ValueError('invalid MP4 top-level box length')
            if len(self.pending) < size:
                break
            kind = bytes(self.pending[4:8])
            del self.pending[:size]
            if kind == b'moof':
                self.saw_moof = True
            elif kind == b'mdat' and self.saw_moof:
                self.complete_fragments += 1
                found += 1
                self.saw_moof = False
        return found


def textured_frames(width: int, height: int, count: int) -> list[bytes]:
    """Precompute deterministic spatial/temporal detail outside timed trials."""
    y, x = np.indices((height, width), dtype=np.uint16)
    frames = []
    for index in range(count):
        rgb = np.empty((height, width, 3), dtype=np.uint8)
        rgb[:, :, 0] = (x * 17 + y * 7 + index * 11 + ((x ^ y) & 63)) & 255
        rgb[:, :, 1] = (x * 3 + y * 19 + index * 23 + ((x * y) & 31)) & 255
        rgb[:, :, 2] = (x * 13 + y * 5 + index * 29 + (((x // 8) ^ (y // 8)) * 41)) & 255
        frames.append(rgb.tobytes())
    return frames


def decode_rgb(mp4: bytes) -> tuple[list[np.ndarray], list[float], dict[str, int]]:
    with av.open(io.BytesIO(mp4), format='mp4') as container:
        stream = next((item for item in container.streams if item.type == 'video'), None)
        if stream is None:
            raise ValueError('encoded output has no video stream')
        frames = []
        pts = []
        for frame in container.decode(stream):
            frames.append(frame.to_ndarray(format='rgb24'))
            if frame.pts is None:
                raise ValueError('decoded frame is missing PTS')
            pts.append(float(frame.pts * (frame.time_base or stream.time_base)))
        return frames, pts, {'width': stream.codec_context.width,
                             'height': stream.codec_context.height}


def compare_decoded(reference: tuple[list[np.ndarray], list[float], dict[str, int]],
                    candidate: tuple[list[np.ndarray], list[float], dict[str, int]],
                    expected_frames: int, fps: int) -> dict[str, object]:
    ref_frames, ref_pts, ref_shape = reference
    got_frames, got_pts, got_shape = candidate
    frame_count_ok = len(ref_frames) == len(got_frames) == expected_frames
    shape_ok = ref_shape == got_shape
    timestamps_ok = (len(ref_pts) == len(got_pts) and
                     all(abs(a - b) <= 1e-6 for a, b in zip(ref_pts, got_pts)))
    ref_length = (ref_pts[-1] - ref_pts[0] + 1 / fps) if ref_pts else 0
    got_length = (got_pts[-1] - got_pts[0] + 1 / fps) if got_pts else 0
    expected_length = expected_frames / fps
    baseline_timeline_complete = (
        len(ref_pts) == expected_frames and
        all(abs(value - ref_pts[0] - index / fps) <= 1e-6
            for index, value in enumerate(ref_pts))
    )
    candidate_timeline_complete = (
        len(got_pts) == expected_frames and
        all(abs(value - got_pts[0] - index / fps) <= 1e-6
            for index, value in enumerate(got_pts))
    )
    per_frame = []
    if shape_ok:
        for first, second in zip(ref_frames, got_frames):
            diff = np.abs(first.astype(np.int16) - second.astype(np.int16))
            per_frame.append({
                'identical': bool(np.array_equal(first, second)),
                'rgbMae': float(diff.mean()),
                'maxAbsDifference': int(diff.max()),
            })
    pixel_parity = frame_count_ok and shape_ok and all(row['identical'] for row in per_frame)
    return {
        'frameCount': len(got_frames), 'expectedFrameCount': expected_frames,
        'width': got_shape['width'], 'height': got_shape['height'],
        'firstPtsSeconds': got_pts[0] if got_pts else None,
        'lastPtsSeconds': got_pts[-1] if got_pts else None,
        'timestampsSeconds': got_pts,
        'referenceTimestampsSeconds': ref_pts,
        'durationSeconds': got_length,
        'referenceDurationSeconds': ref_length,
        'expectedDurationSeconds': expected_length,
        'baselineTimelineComplete': baseline_timeline_complete,
        'candidateTimelineComplete': candidate_timeline_complete,
        'timestampsEqual': timestamps_ok,
        'pixelParity': pixel_parity,
        'qualityPreserving': bool(pixel_parity and timestamps_ok and
                                  baseline_timeline_complete and candidate_timeline_complete and
                                  abs(ref_length - got_length) <= 1e-6),
        'worstFrameRgbMae': max((row['rgbMae'] for row in per_frame), default=None),
        'worstFrameMaxAbsDifference': max((row['maxAbsDifference'] for row in per_frame), default=None),
        'changedFrames': sum(not row['identical'] for row in per_frame),
        'perFrame': per_frame,
    }


def run_trial(command: list[str], frames: list[bytes], fps: int,
              timeout_seconds: float) -> tuple[dict[str, object], bytes]:
    started = time.perf_counter()
    process = subprocess.Popen(
        command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
    )
    probe = FragmentProbe()
    encoded = bytearray()
    stderr = bytearray()
    timing: dict[str, float | int | None] = {
        'processStartToFirstInputMs': None, 'processStartToFirstByteMs': None,
        'firstInputToFirstCompleteFragmentMs': None,
        'processStartToFirstCompleteFragmentMs': None,
        'fedAtFirstCompleteFragment': None,
    }
    first_input_at = None
    fed = 0
    read_error = []
    write_error = []

    def read_stdout():
        try:
            while True:
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    break
                now = time.perf_counter()
                if timing['processStartToFirstByteMs'] is None:
                    timing['processStartToFirstByteMs'] = (now - started) * 1000
                encoded.extend(chunk)
                if probe.feed(chunk) and timing['firstInputToFirstCompleteFragmentMs'] is None:
                    timing['processStartToFirstCompleteFragmentMs'] = (now - started) * 1000
                    timing['firstInputToFirstCompleteFragmentMs'] = (
                        (now - first_input_at) * 1000 if first_input_at is not None else None
                    )
                    timing['fedAtFirstCompleteFragment'] = fed
        except Exception as exc:
            read_error.append(type(exc).__name__)

    def read_stderr():
        while True:
            chunk = os.read(process.stderr.fileno(), 4096)
            if not chunk:
                break
            stderr.extend(chunk[-4096:])
            if len(stderr) > 4096:
                del stderr[:-4096]

    def write_stdin():
        nonlocal first_input_at, fed
        try:
            for index, frame in enumerate(frames):
                target = started + index / fps
                remaining = target - time.perf_counter()
                if remaining > 0:
                    time.sleep(remaining)
                if first_input_at is None:
                    first_input_at = time.perf_counter()
                    timing['processStartToFirstInputMs'] = (first_input_at - started) * 1000
                process.stdin.write(frame)
                process.stdin.flush()
                fed += 1
        except (BrokenPipeError, OSError) as exc:
            write_error.append(type(exc).__name__)
        finally:
            try:
                process.stdin.close()
            except OSError:
                pass

    reader = threading.Thread(target=read_stdout, daemon=True)
    error_reader = threading.Thread(target=read_stderr, daemon=True)
    writer = threading.Thread(target=write_stdin, daemon=True)
    reader.start()
    error_reader.start()
    writer.start()
    timed_out = False
    try:
        process.wait(timeout=max(0.1, timeout_seconds - (time.perf_counter() - started)))
    except subprocess.TimeoutExpired:
        timed_out = True
        process.kill()
        process.wait(timeout=3)
    writer.join(timeout=3)
    reader.join(timeout=3)
    error_reader.join(timeout=3)
    result = {
        **timing, 'exitCode': process.returncode, 'timedOut': timed_out,
        'fedFrames': fed, 'completeFragments': probe.complete_fragments,
        'encodedBytes': len(encoded), 'readErrorTypes': read_error,
        'writeErrorTypes': write_error,
        'ffmpegErrorTail': stderr.decode('utf-8', errors='replace')[-1000:],
    }
    return result, bytes(encoded)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rounds', type=int, default=3)
    parser.add_argument('--frames', type=int, default=45)
    parser.add_argument('--width', type=int, default=720)
    parser.add_argument('--height', type=int, default=1280)
    parser.add_argument('--fps', type=int, default=30)
    parser.add_argument('--fragment-seconds', type=float, default=0.50,
                        help='0.50 foreground default; use 0.75 for a prepared/prefetch session')
    parser.add_argument('--cq', type=int, default=23)
    parser.add_argument('--preset', default='p1')
    parser.add_argument('--timeout-seconds', type=float, default=20.0)
    parser.add_argument('--ffmpeg', default='ffmpeg')
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.rounds <= 5 or not 2 <= args.frames <= 90:
        parser.error('rounds must be 1–5 and frames 2–90')
    if not 64 <= args.width <= 1280 or not 64 <= args.height <= 1920 or not 1 <= args.fps <= 60:
        parser.error('dimensions/fps exceed bounded trial limits')
    if args.width * args.height * 3 * args.frames > 256 * 1024 * 1024:
        parser.error('precomputed input exceeds 256 MiB')
    if not 3 <= args.timeout_seconds <= 60:
        parser.error('timeout must be 3–60 seconds per trial')
    if not 0.25 <= args.fragment_seconds <= 2.0:
        parser.error('fragment seconds must match the frozen 0.25–2.0 range')
    if args.cq != 23 or args.preset != 'p1':
        parser.error('this qualification variant keeps the existing CQ23/p1 quality policy')
    frozen = FROZEN_SOURCE.read_text(encoding='utf-8')
    verify_frozen_mirror(frozen)
    frames = textured_frames(args.width, args.height, args.frames)
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    trials = []
    for round_index in range(args.rounds):
        order = list(VARIANTS)
        order = order[round_index % len(order):] + order[:round_index % len(order)]
        round_results = {}
        encoded = {}
        for variant in order:
            command = build_command(variant, ffmpeg=args.ffmpeg, width=args.width,
                                    height=args.height, fps=args.fps, cq=args.cq,
                                    preset=args.preset,
                                    fragment_seconds=args.fragment_seconds)
            timing, media = run_trial(command, frames, args.fps, args.timeout_seconds)
            round_results[variant] = {'variant': variant, 'command': command, **timing}
            encoded[variant] = media
            print(json.dumps({'round': round_index + 1, 'variant': variant,
                              'firstFragmentMs': timing['firstInputToFirstCompleteFragmentMs'],
                              'exitCode': timing['exitCode']}), flush=True)
        baseline = None
        baseline_error_type = ''
        try:
            baseline = decode_rgb(encoded['baseline'])
        except Exception as exc:
            baseline_error_type = type(exc).__name__
        for variant in VARIANTS:
            try:
                if baseline is None:
                    raise ValueError(f'baseline decode failed: {baseline_error_type}')
                decoded = decode_rgb(encoded[variant])
                round_results[variant]['decodedComparison'] = compare_decoded(
                    baseline, decoded, args.frames, args.fps
                )
            except Exception as exc:
                round_results[variant]['decodedComparison'] = {
                    'qualityPreserving': False, 'decodeErrorType': type(exc).__name__
                }
        trials.append({'round': round_index + 1, 'order': order,
                       'results': [round_results[variant] for variant in VARIANTS]})
    result = {
        'kind': 'encoder-thread-startup-offline',
        'frozenSourceSha256': hashlib.sha256(frozen.encode()).hexdigest(),
        'width': args.width, 'height': args.height, 'fps': args.fps,
        'fragmentSeconds': args.fragment_seconds,
        'frames': args.frames, 'rounds': args.rounds,
        'inputKind': 'deterministic-textured-rgb24',
        'comparisonPolicy': 'all decoded RGB pixels, frame count, dimensions and timestamps identical',
        'trials': trials,
    }
    path = output / f'encoder-thread-startup-{int(time.time() * 1000)}.json'
    path.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps({'saved': str(path)}), flush=True)


if __name__ == '__main__':
    main()
