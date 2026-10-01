"""Prepare and install user-assigned references, never infer identities.

Run prepare, inspect the contact sheets, then install. Originals and existing
references are immutable. Each installed crop has source/selection provenance.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
import shutil
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen

import cv2
import numpy as np
from PIL import Image, ImageOps
from scan_uploaded_references import Detector, sheet

ROOT = Path(__file__).resolve().parent
AUDIT = Path('E:/Pong Face References/review-20260926')
OUT = AUDIT / 'installed-reference-pack-v2903'
FACES = ROOT / 'approved-faces'
PACK = 'zz-uploaded-20260926-v2903'
SUFFIXES = {'.png', '.jpg', '.jpeg', '.webp', '.bmp'}
HOLDS = {
    '1000131563.jpg': 'Extreme open-mouth expression and overlapping background face; excluded from the pooled reference.',
    '1000131567.jpg': 'Profile facial features cut off by source edge.',
    '1000131569.jpg': 'Profile facial features cut off by source edge.',
    '1000131583.jpg': 'Soft screenshot; sharper still and video views used instead.',
}
# Explicit frame selections after visual review. Face numbers apply ONLY to
# that exact source frame, never to tracking or matching across frames.
VIDEO_SELECTIONS = {
    '1000131588.mp4': [(160, 1, 0.0)],
    '1000131590.mp4': [(40, 1, .12), (414, 1, .12)],
    '1000131589.mp4': [(0, 1, 0.0), (184, 1, .12)],
    '1000131592.mp4': [(176, 1, .12), (216, 1, .12)],
    '1000131591.mp4': [(0, 1, .12), (200, 1, .12)],
    '1000131593.mp4': [(32, 2, .12), (216, 2, .12)],
}

def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding='utf-8')

def inventory():
    return {str(p.relative_to(FACES)): digest(p) for p in sorted(FACES.rglob('*'))
            if p.is_file() and p.suffix.lower() in SUFFIXES}

def extract(row, frame):
    if frame is None:
        with Image.open(row['path']) as source:
            return ImageOps.exif_transpose(source).convert('RGB')
    cap = cv2.VideoCapture(row['path'])  # Decoding only; never audio/UI.
    try:
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame)
        ok, bgr = cap.read()
        if not ok or abs(cap.get(cv2.CAP_PROP_POS_FRAMES) - (frame + 1)) > .1:
            raise ValueError(f'Cannot decode exact frame {frame}: {row["path"]}')
        return Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    finally:
        cap.release()

def crop_reference(source, face, margin):
    x1, y1, x2, y2 = face['box']
    dx, dy = (x2-x1)*margin, (y2-y1)*margin
    box = [max(0, math.floor(x1-dx)), max(0, math.floor(y1-dy)),
           min(source.width, math.ceil(x2+dx)), min(source.height, math.ceil(y2+dy))]
    crop = source.crop(box)
    angle = face['rollDegrees'] if abs(face['rollDegrees']) > 20 else 0
    if angle:
        crop = crop.rotate(angle, expand=True, resample=Image.Resampling.BICUBIC,
                           fillcolor=(32, 32, 32))
    # No upscaling, restoration, retouching, morphing or synthetic detail.
    return crop, box, angle

def prepare():
    if (OUT/'manifest.json').exists():
        previous = json.loads((OUT/'manifest.json').read_text())
        assert previous['status'] == 'prepared-awaiting-visual-QA', 'Never overwrite installed artifacts'
    scan = json.loads((AUDIT/'scan.json').read_text(encoding='utf-8'))
    review = json.loads((AUDIT/'review.json').read_text(encoding='utf-8'))
    detector = Detector()
    records, source_records = [], []
    for row in scan['files']:
        assert digest(row['path']) == row['sha256'], row['path']
        src = {k: row[k] for k in ('group', 'originalName', 'uploadId', 'path', 'sha256')}
        source_records.append(src)
        if row['status'] == 'exact-duplicate':
            src.update(status='excluded', reason='Exact duplicate video; evidence counted once.')
            continue
        if row['originalName'] in HOLDS:
            src.update(status='excluded', reason=HOLDS[row['originalName']])
            continue
        jobs = []
        if row['type'] == 'video':
            for frame, number, margin in VIDEO_SELECTIONS[row['originalName']]:
                sample = next(s for s in row['samples'] if round(s['timeSeconds']*row['fps']) == frame)
                face = next(f for f in sample['faces'] if f['number'] == number)
                jobs.append((frame, row['group'], face, margin, 0))
        else:
            faces = row['samples'][0]['faces']
            if row['originalName'] == '1000131568.jpg':
                retry = next(r for r in review['orientationRetry'] if r['file'] == row['originalName'] and r['rotation'] == -30)
                jobs.append((None, row['group'], retry['faces'][0], .12, -30))
            elif row['originalName'] == '1000000549.jpg':
                jobs += [(None, 'approved-18', faces[0], .08, 0),
                         (None, 'approved-19', faces[1], .08, 0)]
            else:
                # For 1000131595, the reviewed central foreground crop is F1;
                # other visible people lie outside this tightly bounded crop.
                assert len(faces) == 1 or row['originalName'] == '1000131595.jpg'
                margin = .02 if row['originalName'] in {'1000131595.jpg', '1000131598.jpg', '1000131600.jpg'} else .12
                jobs.append((None, row['group'], faces[0], margin, 0))
        src.update(status='incorporated', references=[])
        for frame, group, face, margin, pre_rotation in jobs:
            source = extract(row, frame)
            if row['originalName'] == '1000131589.mp4' and frame == 0:
                # Reviewed watermark ends just inside the original detector box,
                # in background/hair to the left of the face. Crop it out.
                face = dict(face, box=[face['box'][0]+12, *face['box'][1:]])
            if pre_rotation:
                source = source.rotate(pre_rotation, expand=True, resample=Image.Resampling.BICUBIC, fillcolor=(0, 0, 0))
            crop, box, angle = crop_reference(source, face, margin)
            bgr = cv2.cvtColor(np.array(crop), cv2.COLOR_RGB2BGR)
            detections = detector.detect(bgr)
            detection_padding = 0
            # Match the production source-preparation context fallback. Padding
            # is detection-only; it does not change the saved reference pixels.
            for ratio in (.25, .50):
                if detections:
                    break
                py, px = max(16, round(crop.height*ratio)), max(16, round(crop.width*ratio))
                detections = detector.detect(cv2.copyMakeBorder(bgr, py, py, px, px, cv2.BORDER_REPLICATE))
                detection_padding = ratio
            if len(detections) != 1:
                raise ValueError(f'{row["originalName"]}/{frame}: crop has {len(detections)} detections')
            name = f'{Path(row["originalName"]).stem}-{row["uploadId"][:8]}'
            name += f'-frame-{frame:05d}' if frame is not None else '-photo'
            name += f'-region-{face["number"]}.png'
            group_name = group.replace('approved-', 'Approved ')
            relative = Path(group_name)/PACK/name
            output = OUT/'prepared'/relative
            output.parent.mkdir(parents=True, exist_ok=True)
            crop.save(output)
            record = dict(sourceUploadId=row['uploadId'], sourcePath=row['path'],
                          originalName=row['originalName'], sourceSha256=row['sha256'],
                          group=group_name, frameIndex=frame,
                          timeSeconds=frame/row['fps'] if frame is not None else None,
                          selectedRegion=face['number'], cropBox=box,
                          preRotationDegrees=pre_rotation, rollCorrectionDegrees=angle,
                          size=list(crop.size), singleFaceDetectorConfidence=detections[0][0],
                          detectorContextPadding=detection_padding,
                          relativePath=str(relative), sha256=digest(output),
                          assignmentBasis='User-assigned upload folder or explicit subject selection; no identity matching')
            records.append(record)
            src['references'].append(str(relative))
    for group in sorted({r['group'] for r in records}):
        selected = [r for r in records if r['group'] == group]
        sheet([(str(OUT/'prepared'/r['relativePath']), f'{r["originalName"]}\nFrame {r["frameIndex"]} / {r["size"]}') for r in selected], OUT/f'{group}-review.jpg')
    manifest = dict(schema='pong-incorporated-user-references-v1', status='prepared-awaiting-visual-QA',
                    version='29.03', createdAt=datetime.now(timezone.utc).isoformat(),
                    originalInventory=inventory(), sources=source_records, references=records,
                    counts=dict(Counter(r['group'] for r in records)),
                    processing='Native-resolution crops, optional rigid roll correction, lossless PNG; no face restoration or identity matching')
    write_json(OUT/'manifest.json', manifest)
    print(json.dumps({'status': manifest['status'], 'counts': manifest['counts'], 'report': str(OUT)}))

def install():
    manifest = json.loads((OUT/'manifest.json').read_text())
    assert manifest['status'] == 'prepared-awaiting-visual-QA'
    assert inventory() == manifest['originalInventory'], 'Active originals changed since preparation'
    with urlopen('http://127.0.0.1:8792/health', timeout=15) as response:
        assert json.load(response)['activeSessions'] == 0, 'Do not change packs during playback'
    groups = sorted(manifest['counts'])
    for group in groups:
        assert not (FACES/group/PACK).exists()
    for record in manifest['references']:
        assert digest(OUT/'prepared'/record['relativePath']) == record['sha256']
    for group in groups:
        shutil.copytree(FACES/group, OUT/'rollback'/group)
    # Backups are verified before the first addition is made.
    for relative, checksum in manifest['originalInventory'].items():
        if Path(relative).parts[0] in groups:
            assert digest(OUT/'rollback'/relative) == checksum
    installed = []
    for group in groups:
        staging = ROOT/'reference-install-staging'/group/PACK
        assert not staging.exists()
        shutil.copytree(OUT/'prepared'/group/PACK, staging)
        os.replace(staging, FACES/group/PACK)
        installed.append(group)
        write_json(OUT/'install-progress.json', {'installedGroups': installed})
    current = inventory()
    assert all(current[p] == sha for p, sha in manifest['originalInventory'].items())
    assert len(current) == len(manifest['originalInventory']) + len(manifest['references'])
    for record in manifest['references']:
        assert current[record['relativePath']] == record['sha256']
    manifest.update(status='installed', installedAt=datetime.now(timezone.utc).isoformat(),
                    originalFilesPreserved=True, rollbackPath=str(OUT/'rollback'))
    write_json(OUT/'manifest.json', manifest)
    print(json.dumps({'status': 'installed', 'counts': manifest['counts'], 'originalFilesPreserved': True}))

def verify():
    manifest = json.loads((OUT/'manifest.json').read_text())
    assert manifest['status'] == 'installed'
    current = inventory()
    assert all(current[p] == sha for p, sha in manifest['originalInventory'].items())
    for row in manifest['sources']:
        assert digest(row['path']) == row['sha256'], row['path']
    for row in manifest['references']:
        assert current[row['relativePath']] == row['sha256']
    def request(path):
        with urlopen('http://127.0.0.1:8792/'+path, timeout=30) as response:
            return json.load(response)
    faces = request('faces')['faces']
    settings = request('settings')['config']
    # Mirror the inspected production cache key without starting another GPU
    # process. Only verify cache integrity; do not compare people's identities.
    stat = (ROOT/'runtime/models/w600k_r50.onnx').stat()
    params = settings['parameters']
    payload = {'recognizer': f'{stat.st_size}:{stat.st_mtime_ns}',
               'merge': str(params.get('MergeTextSel', 'Mean')),
               'detectType': str(params.get('DetectTypeTextSel', 'SCRDF')),
               'detectSize': str(params.get('DetectInputSizeTextSel', '320')),
               'detectScore': .45, 'sourcePreparation': 'context-padding-v1'}
    profile = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()).hexdigest()[:16]
    checks = []
    before_counts = Counter(Path(p).parts[0] for p in manifest['originalInventory'])
    assert len(faces) == len(before_counts)
    for face in faces:
        name = face['name']
        assert face['imageCount'] == before_counts[name] + manifest['counts'].get(name, 0)
        previous_primary = sorted(p for p in manifest['originalInventory'] if Path(p).parts[0] == name)[0]
        current_primary = sorted(p for p in current if Path(p).parts[0] == name)[0]
        assert previous_primary == current_primary
        if name not in manifest['counts']:
            continue
        key = hashlib.sha256(f'{face["id"]}|{profile}'.encode()).hexdigest()[:20]
        cache = ROOT/'cache/embeddings-v2'/f'{name.lower().replace(" ", "-")}-{key}.npy'
        cache_ok = False
        if cache.exists():
            value = np.load(cache, allow_pickle=False)
            cache_ok = value.shape == (512,) and bool(np.isfinite(value).all())
        checks.append(dict(name=name, id=face['id'], imageCount=face['imageCount'],
                           newReferences=manifest['counts'][name], cacheReady=cache_ok,
                           cachePath=str(cache), originalPrimaryPreserved=True))
    health = request('health')
    with urlopen('http://127.0.0.1:8787/pong', timeout=30) as response:
        frontend_version_ok = '<div class="version-number">29.03</div>' in response.read().decode()
    result = dict(checkedAt=datetime.now(timezone.utc).isoformat(), version='29.03',
                  faces=checks, originalUploadsPreserved=True, originalReferencesPreserved=True,
                  ready=health['ready'], embeddingPrimeError=health['embeddingPrimeError'],
                  lastError=health['lastError'], embeddingPrimerActive=health['embeddingPrimerActive'],
                  frontendVersionVerified=frontend_version_ok,
                  allUpdatedPacksCached=all(r['cacheReady'] for r in checks),
                  currentSelectableGroups=len(faces), sourceMergeMethod=payload['merge'])
    write_json(OUT/'live-verification.json', result)
    print(json.dumps(result))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'install', 'verify'])
    args = parser.parse_args()
    {'prepare': prepare, 'install': install, 'verify': verify}[args.action]()
