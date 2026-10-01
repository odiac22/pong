"""Silent, isolated restoration comparison; never writes live presets."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts' / (sys.argv[1] if len(sys.argv) > 1 else 'approved-28-restoration')
SOURCE = sys.argv[2] if len(sys.argv) > 2 else 'https://www.pexels.com/video/a-woman-smiling-at-the-camera-5228667/'
sys.path.insert(0, str(ROOT / 'Pong Swap'))
import cv2
import numpy as np
import pong_swap_config as cfg

with urllib.request.urlopen('http://127.0.0.1:8792/health', timeout=5) as response:
    health = json.load(response)
if health.get('activeSessions') or health.get('embeddingPrimerActive'):
    raise RuntimeError('Live renderer busy; no comparison started')
preset = cfg.CURRENT_PRESET.read_bytes()
config = copy.deepcopy(cfg.load_config())
config['runtime']['swapAudioEnabled'] = False
config['parameters']['RestorerSwitch'] = True
config['parameters']['RestorerTypeTextSel'] = 'GPEN1024'
cfg.CACHE_DIR = OUT / 'cache'
cfg.CACHE_DIR.mkdir(exist_ok=True)
cfg.load_config = lambda: copy.deepcopy(config)
def no_save(*args, **kwargs):
    raise RuntimeError('Live preset writes prohibited')
cfg.save_config = no_save
sys.path.insert(0, str(cfg.ROPE_ROOT))
os.environ['PONG_MASK_OVERLAP_POLICY'] = 'guarded'
from pong_exact_runtime.install import install_cold, model_binding_token
handle = install_cold(cfg.MODELS_DIR, binding_token=model_binding_token(config, cfg.MODELS_DIR), requested=True)
from pong_swap_engine import PongSwapEngine
engine = PongSwapEngine()
engine.warm()
references = sorted((cfg.FACES_DIR / 'Approved 28').glob('*.png'))
assert len(references) == 7
embedding = engine.embedding_from_images(references)
report = {'face': 'Approved 28', 'referenceCount': len(references), 'restorer': 'GPEN1024',
          'source': SOURCE, 'runs': []}
for strength in (90, 60, 30):
    test_config = copy.deepcopy(config)
    test_config['parameters']['RestorerSlider'] = strength
    cap = cv2.VideoCapture(str(OUT / 'stock.mp4'))
    fps = cap.get(cv2.CAP_PROP_FPS)
    anchor, tracking = None, {}
    encoder = None
    count, changed = 0, 0
    started = time.perf_counter()
    try:
        while True:
            ok, bgr = cap.read()
            if not ok:
                break
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            swapped, anchor = engine.process_frame(rgb, embedding, anchor,
                tracking_state=tracking, config=test_config,
                verify_identity=(count % max(1, int(config['runtime'].get('identityCheckIntervalFrames', 12))) == 0))
            result = swapped.cpu().numpy() if hasattr(swapped, 'cpu') else np.asarray(swapped)
            result = np.ascontiguousarray(result, dtype=np.uint8)
            if encoder is None:
                h, w = result.shape[:2]
                encoder = subprocess.Popen(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
                    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{w}x{h}', '-r', str(fps), '-i', 'pipe:0',
                    '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '15', '-pix_fmt', 'yuv420p',
                    '-movflags', '+faststart', str(OUT / f'restoration-{strength}.mp4')], stdin=subprocess.PIPE)
            encoder.stdin.write(result.tobytes())
            base = cv2.resize(rgb, (result.shape[1], result.shape[0]))
            # Whole-frame mean hides real swaps on distant faces. Require an
            # acquired face and a measurable region of changed RGB pixels.
            delta = np.abs(result.astype(np.int16) - base.astype(np.int16))
            changed += anchor is not None and np.count_nonzero(delta.max(axis=2) > 5) > 100
            count += 1
            if count % 48 == 0:
                print(f'{strength}%: {count} frames', flush=True)
    finally:
        cap.release()
        if encoder:
            encoder.stdin.close()
            if encoder.wait(timeout=60) != 0:
                raise RuntimeError('Encode failed')
    report['runs'].append({'restoration': strength, 'frames': count, 'changedFrames': int(changed),
                           'seconds': time.perf_counter() - started})
    assert count > 0 and changed > 0, 'No visible change detected'
assert cfg.CURRENT_PRESET.read_bytes() == preset, 'Live preset changed externally during render'
(OUT / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report), flush=True)
