"""Idle-only GPEN1024 candidates, never installed or automatically quality-rejected.

The supervisor owns a kill-on-close Windows job. Candidate precision differs
only where explicitly requested; source weights, I/O and live plans are immutable.
Numerical differences are diagnostic, not the user's visual approval.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import sys
import time

ROOT=Path(__file__).resolve().parent
REVIEW=Path('E:/Pong Benchmarks/user-quality-review-2026-09-30').resolve()
SOURCE=ROOT/'runtime/models/GPEN-BFR-1024.onnx'
SOURCE_SHA='bcd31aa52110a2005efc96abbab4546d57e42482648f08715b552423d96b381b'

def digest(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for c in iter(lambda:f.read(1024*1024),b''):h.update(c)
    return h.hexdigest()

def worker(a):
    from run_gpen_all_tactics_trial import health
    health()
    if digest(SOURCE)!=SOURCE_SHA:raise RuntimeError('Source model identity changed')
    report={'schema':'review-gpen1024-build-v1','promoted':False,'sourceSha256':SOURCE_SHA,
            'precision':a.precision,'qualityDecision':'Awaiting user; numerical differences are not a veto',
            'phases':[]}
    def record(phase,**kw):
        report.update(kw);report['phases'].append({'name':phase,'at':time.time()})
        (a.output_dir/'report.json').write_text(json.dumps(report,indent=2,allow_nan=False),encoding='utf8')
        print(json.dumps({'phase':phase,**kw}),flush=True)
    try:
        model=SOURCE
        if a.precision=='selective-fp16':
            import onnx
            import build_gpen512_conv_islands as islands
            # GPEN1024 has two additional generator convolutions. The shared
            # exporter validates every selected node, shape, edge and weight.
            islands.LAYER_COUNT=16
            layers=islands.parse_layers(a.layers)
            candidate,topology=islands.make_candidate(onnx.load(str(SOURCE)),layers)
            model=a.output_dir/'candidate.onnx'
            onnx.save_model(candidate,str(model));onnx.checker.check_model(str(model))
            record('graph_exported',topology=topology,candidateModelSha256=digest(model))
            del candidate
        from benchmark_gpen_generated import bootstrap_libraries,generated_fixture
        from benchmark_gpen512_native_trt import build_plan,load_native_engine,timing_summary
        np,torch,ort,handles=bootstrap_libraries(enable_tensorrt=True)
        import tensorrt as trt
        record('building')
        build=build_plan(trt,model,a.output_dir/'candidate.plan',4*1024**3,
                         strict_math=a.precision=='fp32',strongly_typed=a.precision=='selective-fp16',
                         allow_tf32=False,tactic_profile='all',builder_optimization_level=5,
                         max_aux_streams=a.aux_streams,timing_cache_in=a.timing_cache,
                         timing_cache_out=a.output_dir/'timing-cache')
        record('built',build=build,candidatePlanSha256=digest(a.output_dir/'candidate.plan'))
        health()
        current=json.loads((ROOT/'presets/current.json').read_text(encoding='utf8'))
        baseline=Path(current['runtime']['restorerNativeTrtQualifiedPlan1024'])
        shape=(1,3,1024,1024);stream=torch.cuda.Stream();image=torch.empty(shape,device='cuda',dtype=torch.float32)
        arms={}
        with torch.cuda.stream(stream),torch.no_grad():
            for label,path in [('before',baseline),('after',a.output_dir/'candidate.plan')]:
                rt,engine,context,tensors=load_native_engine(trt,path.read_bytes())
                if len(tensors)!=2 or any(tuple(t['shape'])!=shape or t['dtype']!='DataType.FLOAT' for t in tensors):
                    raise RuntimeError('I/O contract mismatch')
                output=torch.empty_like(image)
                context.set_tensor_address('input',image.data_ptr());context.set_tensor_address('output',output.data_ptr())
                arms[label]={'runtime':rt,'engine':engine,'context':context,'output':output,'samples':[]}
            # Finite outputs are a correctness guard. Appearance differences
            # are recorded without applying the historic visual gate.
            differences=[]
            for kind in ['constant','ramp','noise']:
                image.copy_(torch.from_numpy(generated_fixture(np,kind,1,edge=1024)))
                values={}
                for label,arm in arms.items():
                    if not arm['context'].execute_async_v3(stream.cuda_stream):raise RuntimeError('Inference submission failed')
                    stream.synchronize();values[label]=arm['output'].cpu().numpy().copy()
                    if not np.isfinite(values[label]).all():raise RuntimeError('Non-finite output; cannot encode a valid comparison')
                delta=np.abs(values['before']-values['after'])*127.5
                differences.append({'fixture':kind,'maePixels':float(delta.mean()),'p99Pixels':float(np.percentile(delta,99)),'maxPixels':float(delta.max())})
            record('finite_outputs_verified',numericalDifferences=differences)
            for arm in arms.values():
                for _ in range(12):arm['context'].execute_async_v3(stream.cuda_stream)
                stream.synchronize();graph=torch.cuda.CUDAGraph()
                with torch.cuda.graph(graph,stream=stream,capture_error_mode='thread_local'):
                    if not arm['context'].execute_async_v3(stream.cuda_stream):raise RuntimeError('Graph submission failed')
                arm['graph']=graph
            # Balanced order; GPU completion measured, not launch overhead.
            rounds=[]
            for iteration in range(4):
                for label in (['before','after','after','before'] if iteration%2==0 else ['after','before','before','after']):
                    samples=[]
                    for _ in range(16):
                        begin=torch.cuda.Event(enable_timing=True);end=torch.cuda.Event(enable_timing=True)
                        begin.record(stream);arms[label]['graph'].replay();end.record(stream);end.synchronize()
                        samples.append(begin.elapsed_time(end))
                    arms[label]['samples'].extend(samples);rounds.append({'round':iteration,'arm':label,'gpuMs':samples})
                health()
            record('model_benchmark_complete',scope='Isolated model GPU time; full five-clip renderer still required',
                   timings={k:timing_summary(v['samples']) for k,v in arms.items()},rounds=rounds,
                   completed=True)
    except Exception as e:
        record('failed',error=f'{type(e).__name__}: {e}');raise
    finally:
        if digest(SOURCE)!=SOURCE_SHA:raise RuntimeError('Original model changed during experiment')

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output-dir',type=Path,required=True)
    p.add_argument('--precision',choices=['fp32','selective-fp16'],required=True)
    p.add_argument('--layers',default='11,13,15');p.add_argument('--aux-streams',type=int,choices=range(4),default=0)
    p.add_argument('--timing-cache',type=Path,help='Read-only cache from an earlier isolated build on this GPU')
    p.add_argument('--worker',action='store_true');a=p.parse_args()
    a.output_dir=a.output_dir.resolve()
    if not a.output_dir.is_relative_to(REVIEW) or a.output_dir==REVIEW:raise ValueError('Fresh review child required')
    if a.timing_cache:
        a.timing_cache=a.timing_cache.resolve(strict=True)
        if not a.timing_cache.is_relative_to(REVIEW) or not a.timing_cache.is_file():raise ValueError('Review timing cache required')
    if a.worker:
        token=os.environ.pop('PONG_REVIEW_BUILD_TOKEN','')
        if not token or sys.stdin.readline().strip()!=token:raise RuntimeError('Worker not assigned to owner job')
        return worker(a)
    from run_gpen_all_tactics_trial import gpu
    if gpu()['freeMiB']<8192:raise RuntimeError('Need 8 GiB free before building')
    a.output_dir.mkdir(parents=True,exist_ok=False)
    preset=ROOT/'presets/current.json';preset_bytes=preset.read_bytes()
    plan=Path(json.loads(preset_bytes)['runtime']['restorerNativeTrtQualifiedPlan1024']);plan_sha=digest(plan)
    from gpen_benchmark_guard import HardDeadline,run_guarded_child
    token=secrets.token_hex(32);summary={'promoted':False,'productionChanged':False}
    try:
        with HardDeadline(1860),(a.output_dir/'worker.log').open('w',encoding='utf8') as log:
            command=[sys.executable,'-u',str(Path(__file__).resolve()),'--worker','--output-dir',str(a.output_dir),'--precision',a.precision,'--layers',a.layers,'--aux-streams',str(a.aux_streams)]
            if a.timing_cache:command+=['--timing-cache',str(a.timing_cache)]
            summary['worker']=run_guarded_child(command,
                log=log,environment={**os.environ,'PONG_REVIEW_BUILD_TOKEN':token},token=token,timeout=1800,minimum_free_mib=512,query_gpu=gpu)
    finally:
        summary.update(savedPresetUnchanged=preset.read_bytes()==preset_bytes,productionPlanUnchanged=digest(plan)==plan_sha)
        (a.output_dir/'supervisor.json').write_text(json.dumps(summary,indent=2),encoding='utf8')
        print(json.dumps(summary),flush=True)
    if summary['worker']['exitCode'] or not summary['savedPresetUnchanged'] or not summary['productionPlanUnchanged']:raise SystemExit(1)

if __name__=='__main__':main()
