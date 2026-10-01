"""Silent Detect API benchmark. Not a phone click-to-painted-box measurement."""
import argparse
import base64
import hashlib
import json
import statistics
import time
import urllib.request
from pathlib import Path

import cv2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--limit', type=int, default=12)
    ap.add_argument('--geometry-only', action='store_true')
    args = ap.parse_args()
    root = Path(r'E:\Pong Benchmarks\v3029-overnight\corpus')
    manifest = json.loads((root / 'manifest.json').read_text())
    def request(path, method='GET', body=None):
        req = urllib.request.Request('http://127.0.0.1:8792' + path, method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=25) as response:
            return json.load(response)
    def settings_hash():
        return hashlib.sha256(json.dumps(request('/settings')['config'], sort_keys=True).encode()).hexdigest()
    if any(not s.get('complete') and not s.get('playbackPaused') for s in request('/sessions')['sessions']):
        raise RuntimeError('Active playback: no user sessions interrupted')
    face_id = next(f['id'] for f in request('/faces')['faces'] if f['name'] == 'Approved 3')
    report = dict(scope='Local public stock frame encode + preview creation + Detect API response; NOT original network seek, Android paint, or swap startup',
                  silent=True, serviceVersion=request('/health').get('serviceVersion'),
                  settingsHash=settings_hash(), geometryOnlyRequested=args.geometry_only, cases=[])
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    for clip in manifest['clips'][:args.limit]:
        preview_id = None
        row = dict(clip=clip['ordinal'], sourceFps=clip['fps'])
        report['cases'].append(row)
        try:
            cap = cv2.VideoCapture(str(root / clip['path']))
            try:
                cap.set(cv2.CAP_PROP_POS_MSEC, 2000)
                ok, frame = cap.read()
            finally:
                cap.release()
            if not ok:
                raise RuntimeError('No local frame')
            started = time.perf_counter()
            ok, encoded = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 94])
            if not ok:
                raise RuntimeError('Encode failed')
            data = 'data:image/jpeg;base64,' + base64.b64encode(encoded).decode()
            row['encodeMs'] = (time.perf_counter() - started) * 1000
            preview = request('/frame-previews', 'POST', dict(sourceUrl='', faceId=face_id,
                startSeconds=2, frameDataUrl=data, geometryOnly=args.geometry_only))['preview']
            preview_id = preview['id']
            row['geometryOnlyAcknowledged'] = preview.get('geometryOnly', False)
            row['createMs'] = (time.perf_counter() - started) * 1000 - row['encodeMs']
            faces = request('/frame-previews/' + preview_id + '/faces')['faces']
            row['totalMs'] = (time.perf_counter() - started) * 1000
            row['faceCount'] = len(faces)
            row['boxesUnder1s'] = bool(faces) and row['totalMs'] < 1000
        except Exception as exc:
            row['failure'] = type(exc).__name__ + ': ' + str(exc)[:160]
        finally:
            if preview_id:
                request('/frame-previews/' + preview_id, 'DELETE')
        out.write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(row), flush=True)
    times = [r['totalMs'] for r in report['cases'] if 'totalMs' in r]
    report.update(settingsUnchanged=settings_hash() == report['settingsHash'],
                  medianMs=statistics.median(times) if times else None,
                  maxMs=max(times) if times else None,
                  boxesUnder1s=sum(r.get('boxesUnder1s', False) for r in report['cases']))
    out.write_text(json.dumps(report, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
