"""Guarded, unpromoted convolution-island experiment against ORIGINAL GPEN.

First reject inaccurate ONNX candidates before compiling. Then compare TensorRT
pixels with the original FP32 graph and the currently adopted immutable plan,
and time both plans in the same process with balanced ABBA ordering. Generated
fixtures cannot qualify real-face quality or end-to-end Pong performance.
"""
from __future__ import annotations

import argparse
import faulthandler
import gc
import hashlib
import json
import os
from pathlib import Path
import secrets
import sys
import time

ROOT = Path(__file__).resolve().parent
PARENT = Path(r'E:\Pong Benchmarks\tiktok-webview-2026-09-29').resolve()
SOURCE = ROOT / 'runtime/models/GPEN-BFR-512.onnx'
SOURCE_HASH = '0960f836488735444d508b588e44fb5dfd19c68fde9163ad7878aa24d1d5115e'
PLAN_HASH = 'b8c4ac5cd6e87b8bea24881b6204da953a95914ceb2092be73bb07b550906dd9'


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def paths(args):
    candidate = args.candidate.resolve()
    output = args.output_dir.resolve()
    if candidate.parent.parent != PARENT or not candidate.parent.name.startswith('gpen512-conv-islands-'):
        raise ValueError('Candidate must be an isolated convolution-island export')
    if output.parent != PARENT or not output.name.startswith('gpen512-conv-trial-'):
        raise ValueError('Output must be a new isolated gpen512-conv-trial-* directory')
    if output == candidate.parent:
        raise ValueError('Candidate input must remain immutable')
    metadata = json.loads((candidate.parent / 'manifest.json').read_text(encoding='utf-8'))
    if (metadata.get('sourceSha256') != SOURCE_HASH or digest(SOURCE) != SOURCE_HASH
            or metadata.get('candidateSha256') != digest(candidate)
            or not metadata.get('modelIoFp32') or not metadata.get('sensitiveOpsFp32')
            or not metadata.get('initializersUnchanged')):
        raise ValueError('Candidate graph identity or precision boundaries changed')
    preset = ROOT / 'presets/current.json'
    preset_bytes = preset.read_bytes()
    plan = Path(json.loads(preset_bytes)['runtime']['restorerNativeTrtQualifiedPlan'])
    if digest(plan) != PLAN_HASH:
        raise ValueError('The adopted comparison plan changed')
    return candidate, output, metadata, preset, preset_bytes, plan


def quality_pass(rows, temporal, gate):
    return bool(rows and temporal) and all(row.get('pass') is True for row in rows) and all(
        value is not None and 0 <= value <= gate for value in temporal)


def worker(args):
    faulthandler.enable()
    candidate, output, metadata, _, _, plan = paths(args)
    from run_gpen_all_tactics_trial import health
    health()
    from benchmark_gpen_generated import (bootstrap_libraries, generated_fixture,
                                         numerical_metrics, temporal_mae, KINDS, GATES)
    from benchmark_gpen512_native_trt import (make_ort_reference, build_plan,
                                            load_native_engine, timing_summary)
    report = {'schema': 'pong-conv-island-experiment-v1', 'productionEligible': False,
              'promoted': False, 'scope': 'generated and stock-face tensors; isolated kernel timing only',
              'candidateSha256': digest(candidate), 'originalSha256': SOURCE_HASH,
              'adoptedPlanSha256': PLAN_HASH, 'graphPrecision': 'explicit FP16 convolution islands; FP32 elsewhere',
              'export': metadata, 'gates': GATES, 'phases': []}

    def checkpoint(phase, **values):
        report.update(values)
        report['phases'].append({'phase': phase, 'at': time.time()})
        (output / 'report.json').write_text(json.dumps(report, indent=2, allow_nan=False), encoding='utf-8')
        print(json.dumps({'phase': phase, **values}), flush=True)

    checkpoint('loading_gpu_libraries')
    np, torch, ort, dll_handles = bootstrap_libraries(enable_tensorrt=True)
    import tensorrt as trt
    torch.cuda.set_device(0)
    stream = torch.cuda.Stream()
    shape = (1, 3, 512, 512)
    keys = [(kind, step) for kind in KINDS for step in range(3)]
    fixtures = {(kind, step): generated_fixture(np, kind, step) for kind, step in keys}
    stock_root = ROOT / 'benchmarks/gpen512-calibrator-v1/capture'
    stock_files = sorted(stock_root.glob('clip-*-gpen-inputs-f32.npy'))
    if len(stock_files) != 16:
        raise RuntimeError('Expected the 16 captured licensed stock-face input sequences')
    stock_provenance = []
    for path in stock_files:
        values = np.load(str(path), allow_pickle=False)
        if values.shape != (4, 3, 512, 512) or values.dtype != np.float32 or not np.isfinite(values).all():
            raise RuntimeError('Stock input tensor contract changed')
        if values.min() < -1.001 or values.max() > 1.001:
            raise RuntimeError('Stock inputs are not normalized GPEN image tensors')
        kind = path.name.split('-gpen')[0]
        for step in range(4):
            keys.append((kind, step))
            fixtures[kind, step] = np.ascontiguousarray(values[step:step + 1])
        stock_provenance.append({'name': path.name, 'sha256': digest(path), 'frames': 4})
    checkpoint('fixtures_validated', generatedFrames=18, stockFrames=64,
               stockTensorProvenance=stock_provenance)
    image = torch.empty(shape, dtype=torch.float32, device='cuda')
    target = torch.empty_like(image)

    def ort_outputs(model):
        session = make_ort_reference(ort, stream.cuda_stream, model, use_tf32=True)
        binding = session.io_binding()
        binding.bind_input(session.get_inputs()[0].name, 'cuda', 0, np.float32, shape, image.data_ptr())
        binding.bind_output(session.get_outputs()[0].name, 'cuda', 0, np.float32, shape, target.data_ptr())
        results = []
        with torch.cuda.stream(stream):
            for kind, step in keys:
                image.copy_(torch.from_numpy(fixtures[kind, step]))
                stream.synchronize()
                session.run_with_iobinding(binding)
                stream.synchronize()
                results.append(target.cpu().numpy().copy())
        del binding, session
        gc.collect()
        torch.cuda.empty_cache()
        return results

    checkpoint('original_ort_reference')
    reference = ort_outputs(SOURCE)
    checkpoint('candidate_ort_reference')
    candidate_ort = ort_outputs(candidate)

    def compare(reference_images, candidates):
        rows, temporal = [], []
        for index, (kind, step) in enumerate(keys):
            row = numerical_metrics(np, reference_images[index], candidates[index])
            rows.append({'kind': kind, 'step': step, **row})
            if step:
                temporal.append(temporal_mae(np, reference_images[index - 1], reference_images[index],
                                             candidates[index - 1], candidates[index]))
        return {'frames': rows, 'temporalMae': temporal,
                'pass': quality_pass(rows, temporal, GATES['temporalMae'])}

    ort_quality = compare(reference, candidate_ort)
    del candidate_ort
    checkpoint('candidate_ort_quality', candidateOrtVsOriginal=ort_quality)
    if not ort_quality['pass']:
        checkpoint('rejected_before_build', reason='candidate graph differs from original beyond frozen image gates')
        return
    if args.numerical_only:
        checkpoint('numerical_only_completed_unpromoted', requiresTensorRtAndLiveQualification=True)
        return
    health()
    checkpoint('building_candidate_plan')
    candidate_plan = output / 'candidate.plan'
    build = build_plan(trt, candidate, candidate_plan, 4 * 1024**3,
                       allow_tf32=True, strongly_typed=True, builder_optimization_level=5,
                       max_aux_streams=args.max_aux_streams, timing_cache_out=output / 'candidate.timing-cache')
    # The build helper's fp16 field is a builder flag, NOT the graph precision.
    checkpoint('candidate_plan_built', build=build, candidatePlanSha256=digest(candidate_plan))
    health()
    arms = {}
    for label, path in [('adopted', plan), ('candidate', candidate_plan)]:
        runtime, engine, context, tensors = load_native_engine(trt, path.read_bytes())
        if len(tensors) != 2 or any(tuple(row['shape']) != shape or row['dtype'] != 'DataType.FLOAT' for row in tensors):
            raise RuntimeError('A comparison plan changed its FP32 image I/O contract')
        input_name = next(row['name'] for row in tensors if 'INPUT' in row['mode'])
        output_name = next(row['name'] for row in tensors if 'OUTPUT' in row['mode'])
        tensor = torch.empty_like(image)
        context.set_tensor_address(input_name, image.data_ptr())
        context.set_tensor_address(output_name, tensor.data_ptr())
        arms[label] = {'runtime': runtime, 'engine': engine, 'context': context, 'output': tensor}

    with torch.cuda.stream(stream):
        for label, arm in arms.items():
            samples = []
            for kind, step in keys:
                image.copy_(torch.from_numpy(fixtures[kind, step]))
                if not arm['context'].execute_async_v3(stream.cuda_stream):
                    raise RuntimeError('TensorRT comparison submission failed')
                stream.synchronize()
                samples.append(arm['output'].cpu().numpy().copy())
            arm['samples'] = samples
        candidate_quality = compare(reference, arms['candidate']['samples'])
        baseline_quality = compare(reference, arms['adopted']['samples'])
        paired_quality = compare(arms['adopted']['samples'], arms['candidate']['samples'])
        checkpoint('candidate_trt_quality', candidateTrtVsOriginal=candidate_quality,
                   adoptedTrtVsOriginal=baseline_quality, candidateTrtVsAdopted=paired_quality)
        if not all(row['pass'] for row in (candidate_quality, baseline_quality, paired_quality)):
            checkpoint('rejected_numerical_quality')
            return
        image.copy_(torch.from_numpy(generated_fixture(np, 'noise', 0)))
        for arm in arms.values():
            for _ in range(12):
                if not arm['context'].execute_async_v3(stream.cuda_stream):
                    raise RuntimeError('TensorRT warm-up failed')
            stream.synchronize()
            graph = torch.cuda.CUDAGraph()
            with torch.cuda.graph(graph, stream=stream, capture_error_mode='thread_local'):
                if not arm['context'].execute_async_v3(stream.cuda_stream):
                    raise RuntimeError('TensorRT capture failed')
            arm['graph'] = graph
        rows = []
        # Alternating ABBA/BAAB controls order/heat; completed GPU and host latency.
        for round_index in range(4):
            order = ['adopted', 'candidate', 'candidate', 'adopted']
            if round_index % 2:
                order = ['candidate', 'adopted', 'adopted', 'candidate']
            for label in order:
                gpu_ms, wall_ms = [], []
                for _ in range(16):
                    begin = torch.cuda.Event(enable_timing=True)
                    end = torch.cuda.Event(enable_timing=True)
                    started = time.perf_counter_ns()
                    begin.record(stream)
                    arms[label]['graph'].replay()
                    end.record(stream)
                    end.synchronize()
                    gpu_ms.append(begin.elapsed_time(end))
                    wall_ms.append((time.perf_counter_ns() - started) / 1e6)
                rows.append({'round': round_index, 'arm': label, 'gpuMs': gpu_ms, 'wallMs': wall_ms})
            health()
        timings = {}
        for label in arms:
            timings[label] = {metric: timing_summary([value for row in rows if row['arm'] == label
                                                     for value in row[metric]]) for metric in ('gpuMs', 'wallMs')}
        speedup = timings['adopted']['wallMs']['p50Ms'] / timings['candidate']['wallMs']['p50Ms']
        diagnostic_win = speedup >= 1.05 and timings['candidate']['wallMs']['p95Ms'] <= timings['adopted']['wallMs']['p95Ms']
        checkpoint('completed_unpromoted', timings=timings, pairedRuns=rows,
                   medianSpeedup=speedup, diagnosticSpeedGate=diagnostic_win,
                   requiresRealFaceAndLiveQualification=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--numerical-only', action='store_true')
    parser.add_argument('--max-aux-streams', type=int, choices=range(8), default=0)
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker:
        token = os.environ.pop('PONG_CONV_TRIAL_START_TOKEN', '')
        if not token or sys.stdin.readline().strip() != token:
            raise RuntimeError('Worker was not assigned to its owner job')
        worker(args)
        return
    candidate, output, _, preset, preset_bytes, plan = paths(args)
    from run_gpen_all_tactics_trial import gpu, health
    health()
    if gpu()['freeMiB'] < 8192:
        raise RuntimeError('Need 8 GiB free GPU memory; no worker started')
    output.mkdir(parents=True, exist_ok=False)
    from gpen_benchmark_guard import HardDeadline, run_guarded_child
    token = secrets.token_hex(32)
    report = {'promoted': False, 'productionChanged': False}
    try:
        with HardDeadline(1860), (output / 'worker.log').open('w', encoding='utf-8') as log:
            command = [sys.executable, '-u', str(Path(__file__).resolve()), '--worker', '--candidate', str(candidate),
                       '--output-dir', str(output), '--max-aux-streams', str(args.max_aux_streams)]
            if args.numerical_only:
                command.append('--numerical-only')
            report['worker'] = run_guarded_child(command, log=log,
                environment={**os.environ, 'PONG_CONV_TRIAL_START_TOKEN': token}, token=token,
                timeout=1800, minimum_free_mib=512, query_gpu=gpu)
    except Exception as exc:
        report['error'] = str(exc)
        raise
    finally:
        report['savedPresetUnchanged'] = preset.read_bytes() == preset_bytes
        report['productionPlanUnchanged'] = digest(plan) == PLAN_HASH
        report['sourceModelUnchanged'] = digest(SOURCE) == SOURCE_HASH
        (output / 'supervisor.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report), flush=True)
    if report['worker']['exitCode'] or not all(report[key] for key in
            ('savedPresetUnchanged', 'productionPlanUnchanged', 'sourceModelUnchanged')):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
