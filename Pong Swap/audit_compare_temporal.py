"""Paired post-render analysis with identical face association and time windows."""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np
from benchmark_temporal_attachment import analyze_pair
from pong_swap_engine import PongSwapEngine
from benchmark_realtime_corpus import detect_on_engine_stream, sha256_file


def identity_measurements(engine, video, identity, paired_source=None):
    capture = cv2.VideoCapture(str(video))
    source_capture = cv2.VideoCapture(str(paired_source)) if paired_source else None
    fps = capture.get(cv2.CAP_PROP_FPS)
    count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    samples = []
    previous = None
    def cosine(a, b):
        return float(np.dot(a,b)/(np.linalg.norm(a)*np.linalg.norm(b)+1e-9))
    for index in range(0, count, max(1,round(fps/2))):
        capture.set(cv2.CAP_PROP_POS_FRAMES, index)
        ok, frame = capture.read()
        if not ok:
            continue
        detected = detect_on_engine_stream(engine, cv2.cvtColor(frame,cv2.COLOR_BGR2RGB), recognize=True, max_faces=10)
        if not detected:
            continue
        if source_capture:
            source_capture.set(cv2.CAP_PROP_POS_FRAMES, index)
            ok, source_frame = source_capture.read()
            if not ok:
                continue
            from benchmark_temporal_attachment import first_landmarks
            source_kps = first_landmarks(engine, cv2.cvtColor(source_frame,cv2.COLOR_BGR2RGB), previous)
            if source_kps is None:
                continue
            previous = source_kps
            chosen = min(detected, key=lambda row: np.linalg.norm(row[1].mean(axis=0)-source_kps.mean(axis=0)))
        else:
            # Approved references may include a companion: measure the most
            # similar face, not the largest one. This is reference analysis,
            # never a claim that recognition alone establishes consent.
            chosen = max(detected, key=lambda row: cosine(row[2], identity))
        samples.append({'frameIndex':index,'cosine':cosine(chosen[2],identity)})
    capture.release()
    if source_capture:
        source_capture.release()
    scores = [s['cosine'] for s in samples]
    return {'sha256':sha256_file(video), 'sampleHz':2, 'samples':samples,
            'medianCosine':float(np.median(scores)) if scores else None,
            'p10Cosine':float(np.quantile(scores,.1)) if scores else None}


def sheets(source, rendered, quality, destination):
    metrics = quality['frameMetrics']
    spikes = set()
    for key in ('attachmentPoseDelta', 'featureRelationChange', 'boundaryFlickerMae'):
        values = [float(m[key]) for m in metrics if key in m]
        if not values:
            continue
        threshold = float(np.quantile(values, .99))
        spikes.update(m['frameIndex'] for m in metrics if float(m.get(key, -1)) > threshold)
    by_frame = {m['frameIndex']: m for m in metrics}
    destination.mkdir(parents=True, exist_ok=True)
    paths = []
    for spike in sorted(spikes):
        points = np.asarray(by_frame[spike]['sourceLandmarks'])
        center = points.mean(axis=0)
        side = max(80, int(np.ptp(points, axis=0).max() * 3))
        rows = []
        for path in (source, rendered):
            capture = cv2.VideoCapture(str(path))
            tiles = []
            for index in range(max(0, spike-2), spike+3):
                capture.set(cv2.CAP_PROP_POS_FRAMES, index)
                ok, frame = capture.read()
                if not ok:
                    break
                x = max(0, min(frame.shape[1]-side, int(center[0]-side/2)))
                y = max(0, min(frame.shape[0]-side, int(center[1]-side/2)))
                tile = cv2.resize(frame[y:y+side, x:x+side], (240,240))
                cv2.putText(tile, f'frame {index}', (4,18), cv2.FONT_HERSHEY_SIMPLEX, .45, (0,255,0), 1)
                tiles.append(tile)
            capture.release()
            if len(tiles) == 5:
                rows.append(np.concatenate(tiles, axis=1))
        if len(rows) == 2:
            output = destination / f'spike-{spike:05}.jpg'
            cv2.imwrite(str(output), np.concatenate(rows, axis=0))
            paths.append(str(output))
    return paths


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--baseline', type=Path, required=True)
    p.add_argument('--candidate', type=Path, required=True)
    p.add_argument('--clips', type=Path, nargs='+', required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--identity', type=Path)
    p.add_argument('--references', type=Path, nargs='*', default=[])
    a = p.parse_args()
    a.output.mkdir(parents=True, exist_ok=False)
    engine = PongSwapEngine()
    report = {'association': 'source-continuity-and-paired-position; geometric diagnostic, not identity proof', 'clips': []}
    try:
        engine.warm(allow_create_selected=True)
        embedding = engine.embedding_from_images(tuple(sorted(a.identity.glob('*.jpg')))) if a.identity else None
        if embedding is not None:
            report['approvedReferences'] = {ref.name: identity_measurements(engine, ref, embedding) for ref in a.references}
        for source in a.clips:
            pair = {'clip': source.name}
            for name, directory in (('baseline', a.baseline), ('candidate', a.candidate)):
                matches = list(directory.glob(f'{source.stem}-gpen*-silent.mp4'))
                if len(matches) != 1:
                    raise ValueError(f'Expected one explicit rendered result for {source} in {directory}')
                quality = analyze_pair(engine, source, matches[0], max_seconds=30,
                    sample_fps=60, occlusion_fixture=False, associate_faces=True)
                pair[name] = quality
                if embedding is not None:
                    pair[name+'Identity'] = identity_measurements(engine, matches[0], embedding, source)
                pair[name+'SpikeSheets'] = sheets(source, matches[0], quality, a.output / source.stem / name)
            keys = ('attachmentPoseDeltaP95', 'attachmentPoseAccelerationP95',
                    'motionFidelityErrorP95', 'featureRelationChangeP95',
                    'temporalResidualMaeP95', 'boundaryFlickerMaeP95', 'sharpnessFrameDeltaP95')
            pair['changePercent'] = {k: 100*(pair['candidate'][k]/pair['baseline'][k]-1)
                for k in keys if pair['baseline'].get(k) and pair['candidate'].get(k) is not None}
            report['clips'].append(pair)
            (a.output/'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
            print(json.dumps({'clip': source.name, 'changePercent': pair['changePercent']}), flush=True)
    finally:
        engine.unload()
        engine.shutdown_gpu_worker()


if __name__ == '__main__':
    main()
