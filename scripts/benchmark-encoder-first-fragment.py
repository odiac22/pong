"""Isolated, silent encoder startup A/B; no renderer settings or sessions changed."""
import argparse
import json
import os
import subprocess
import threading
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--rounds', type=int, default=3)
parser.add_argument('--width', type=int, default=720)
parser.add_argument('--height', type=int, default=1280)
args = parser.parse_args()

def trial(bounded_probe):
    command = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
               '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s:v', f'{args.width}x{args.height}', '-r', '30']
    if bounded_probe:
        command += ['-probesize', '32', '-analyzeduration', '0', '-fpsprobesize', '0']
    command += ['-i', 'pipe:0', '-map', '0:v:0', '-an',
                '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p',
                '-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll', '-rc', 'vbr', '-cq', '23', '-b:v', '0',
                '-g', '30', '-keyint_min', '30', '-bf', '0', '-rc-lookahead', '0', '-delay', '0', '-zerolatency', '1',
                '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
                '-movflags', 'frag_every_frame+empty_moov+default_base_moof', '-flush_packets', '1', '-f', 'mp4', 'pipe:1']
    started = time.perf_counter()
    proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    result = {'boundedProbe': bounded_probe, 'firstByteMs': None, 'firstFragmentMs': None, 'fedAtFirstFragment': None}
    fed = 0
    payload = bytearray()
    def read_output():
        while True:
            chunk = os.read(proc.stdout.fileno(), 65536)
            if not chunk:
                break
            elapsed = (time.perf_counter() - started) * 1000
            if result['firstByteMs'] is None:
                result['firstByteMs'] = elapsed
            payload.extend(chunk)
            # Parse complete top-level boxes, not incidental byte signatures.
            while len(payload) >= 8:
                size = int.from_bytes(payload[:4], 'big')
                if size < 8 or len(payload) < size:
                    break
                kind = payload[4:8]
                del payload[:size]
                if kind == b'mdat' and result['firstFragmentMs'] is None:
                    result['firstFragmentMs'] = elapsed
                    result['fedAtFirstFragment'] = fed
    reader = threading.Thread(target=read_output)
    reader.start()
    frame = bytes((32, 100, 180)) * (args.width * args.height)
    try:
        for i in range(65):
            time.sleep(max(0, started + i / 30 - time.perf_counter()))
            proc.stdin.write(frame)
            proc.stdin.flush()
            fed += 1
    finally:
        proc.stdin.close()
    proc.wait(timeout=10)
    reader.join(timeout=5)
    result['exitCode'] = proc.returncode
    result['error'] = proc.stderr.read().decode(errors='replace')[-2000:]
    return result

results = []
for _ in range(args.rounds):
    for bounded in (False, True):
        result = trial(bounded)
        results.append(result)
        print(json.dumps(result), flush=True)
output = Path('E:/Pong Benchmarks/tiktok-webview-2026-09-29') / f'encoder-startup-{int(time.time()*1000)}.json'
output.write_text(json.dumps({'width': args.width, 'height': args.height, 'sourceFps': 30, 'trials': results}, indent=2))
print(json.dumps({'saved': str(output)}))
