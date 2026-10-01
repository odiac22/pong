"""CPU-only contract tests; no TensorRT plan is deserialized on a GPU."""

import hashlib
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from experimental_gpen_conv_runtime import (
    CandidateFiles, ExperimentalGPENConvRuntime, GATES, OPT_IN,
    inspect_candidate_graph, validate_candidate,
)


def sha(value):
    return hashlib.sha256(value).hexdigest()


class ExperimentalRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.parent = Path(self.temp.name)
        export_dir = self.parent / 'gpen512-conv-islands-test'
        self.trial = self.parent / 'gpen512-conv-trial-test'
        self.stock = self.parent / 'stock'
        for directory in (export_dir, self.trial, self.stock):
            directory.mkdir()
        self.candidate = export_dir / 'GPEN-BFR-512-conv-islands.onnx'
        self.original = self.parent / 'original.onnx'
        self.adopted = self.parent / 'adopted.plan'
        self.plan = self.trial / 'candidate.plan'
        for path, value in ((self.candidate, b'candidate-onnx'),
                            (self.original, b'original-onnx'),
                            (self.adopted, b'adopted-plan'),
                            (self.plan, b'candidate-plan')):
            path.write_bytes(value)
        self.files = CandidateFiles(self.candidate, self.trial, self.original, self.adopted,
                                    self.stock)
        names = [f'/generator/convs.{i}/conv/{"ConvTranspose" if i % 2 == 0 else "Conv"}'
                 for i in range(14)]
        self.export = {
            'schema':'pong-gpen512-conv-islands-candidate-v1',
            'productionEligible':False,'qualityQualified':False,'performanceQualified':False,
            'sourceSha256':sha(self.original.read_bytes()),
            'candidateSha256':sha(self.candidate.read_bytes()),
            'candidateBytes':self.candidate.stat().st_size,
            'selectedLayers':list(range(14)),'selectedNodes':names,
            'sourceNodeCount':1332,'candidateNodeCount':1374,'castNodeCount':42,
            'modelIoFp32':True,'sensitiveOpsFp32':True,'initializersUnchanged':True,
        }
        (export_dir / 'manifest.json').write_text(json.dumps(self.export), encoding='utf-8')
        rows=[]
        for kind in ('ramp','checker','bars','noise','impulse','constant'):
            rows.extend(self.row(kind,step) for step in range(3))
        self.stock_rows=[]
        for index in range(1,17):
            name=f'clip-{index:02d}-gpen-inputs-f32.npy'
            content=f'stock-{index}'.encode()
            (self.stock / name).write_bytes(content)
            self.stock_rows.append({'name':name,'sha256':sha(content),'frames':4})
            rows.extend(self.row(f'clip-{index:02d}',step) for step in range(4))
        self.quality={'frames':rows,'temporalMae':[0.01]*60,'pass':True}
        self.report={
            'schema':'pong-conv-island-experiment-v1',
            'productionEligible':False,'promoted':False,
            'candidateSha256':self.export['candidateSha256'],
            'originalSha256':self.export['sourceSha256'],
            'adoptedPlanSha256':sha(self.adopted.read_bytes()),
            'candidatePlanSha256':sha(self.plan.read_bytes()),
            'graphPrecision':'explicit FP16 convolution islands; FP32 elsewhere',
            'export':self.export,'gates':GATES,'generatedFrames':18,'stockFrames':64,
            'stockTensorProvenance':self.stock_rows,
            'candidateOrtVsOriginal':self.quality,
            'candidateTrtVsOriginal':self.quality,
            'adoptedTrtVsOriginal':self.quality,
            'candidateTrtVsAdopted':self.quality,
            'phases':[{'phase':'completed_unpromoted'}],
            'diagnosticSpeedGate':True,'requiresRealFaceAndLiveQualification':True,
            'medianSpeedup':1.5,
            'timings':{'adopted':{'wallMs':{'p50Ms':30,'p95Ms':35}},
                       'candidate':{'wallMs':{'p50Ms':20,'p95Ms':25}}},
            'build':{'stronglyTyped':True,'tf32':True,'fp16':False,'int8':False,
                     'strictMath':False,'externalPlan':False,'torgbPlugin':False,
                     'builderOptimizationLevel':5,'input':'input','output':'output'},
        }
        self.supervisor={'promoted':False,'productionChanged':False,'worker':{'exitCode':0},
                         'savedPresetUnchanged':True,'productionPlanUnchanged':True,
                         'sourceModelUnchanged':True}
        self.write_reports()

    @staticmethod
    def row(kind, step):
        return {'kind':kind,'step':step,'mae':0.01,'p99Abs':0.1,'maxAbs':0.2,
                'psnrDb':75.0,'ssim':0.99999,'pass':True}

    def write_reports(self):
        (self.trial / 'report.json').write_text(json.dumps(self.report), encoding='utf-8')
        (self.trial / 'supervisor.json').write_text(json.dumps(self.supervisor), encoding='utf-8')

    def validate(self):
        return validate_candidate(self.files, allowed_parent=self.parent,
                                  expected_original_sha256=sha(self.original.read_bytes()),
                                  expected_adopted_sha256=sha(self.adopted.read_bytes()),
                                  topology_check=lambda _candidate, _original: self.export)

    def test_complete_unpromoted_evidence_is_accepted_only_as_experiment(self):
        result=self.validate()
        self.assertEqual(result.candidate_sha256,self.export['candidateSha256'])
        self.assertEqual(result.plan_sha256,self.report['candidatePlanSha256'])
        self.assertEqual(result.plan_bytes,b'candidate-plan')

    def test_rejects_failed_or_stale_report_and_supervisor(self):
        for change in (
            lambda: self.report['phases'].append({'phase':'rejected_numerical_quality'}),
            lambda: self.report.update(diagnosticSpeedGate=False),
            lambda: self.report['candidateTrtVsOriginal'].update(pass_=False),
            lambda: self.supervisor['worker'].update(exitCode=3221225477),
            lambda: self.supervisor.update(savedPresetUnchanged=False),
            lambda: self.report.update(candidatePlanSha256='0'*64),
        ):
            with self.subTest(change=change):
                original_report=json.loads(json.dumps(self.report))
                original_supervisor=json.loads(json.dumps(self.supervisor))
                change()
                if 'pass_' in self.report['candidateTrtVsOriginal']:
                    self.report['candidateTrtVsOriginal']['pass']=False
                self.write_reports()
                with self.assertRaises(ValueError):
                    self.validate()
                self.report,self.supervisor=original_report,original_supervisor

    def test_rejects_plan_model_export_and_stock_hash_drift(self):
        for path in (self.plan,self.candidate,self.original,self.adopted,self.stock / self.stock_rows[0]['name']):
            with self.subTest(path=path.name):
                original=path.read_bytes()
                path.write_bytes(original+b'x')
                with self.assertRaises(ValueError):
                    self.validate()
                path.write_bytes(original)
        self.export['selectedLayers']=[13]
        (self.candidate.parent/'manifest.json').write_text(json.dumps(self.export),encoding='utf-8')
        with self.assertRaises(ValueError):
            self.validate()

    def test_mock_runtime_requires_opt_in_and_uses_only_caller_stream(self):
        with self.assertRaises(PermissionError):
            ExperimentalGPENConvRuntime(self.files,opt_in='')

        class Engine:
            num_io_tensors=2
            def get_tensor_name(self,i): return ('input','output')[i]
            def get_tensor_mode(self,n): return n
            def get_tensor_shape(self,n): return (1,3,512,512)
            def get_tensor_dtype(self,n): return 'float32'
            def get_tensor_location(self,n): return 'device'
            def get_tensor_format(self,n): return 'linear'
            def get_tensor_vectorized_dim(self,n): return -1
            def create_execution_context(self): return context

        class Context:
            def __init__(self): self.addresses={};self.calls=[];self.fail=False
            def set_tensor_address(self,n,value): self.addresses[n]=value;return True
            def execute_async_v3(self,stream): self.calls.append(stream);return not self.fail

        class Runtime:
            def __init__(self,logger): pass
            def deserialize_cuda_engine(self,plan):
                self.assert_plan=plan
                return Engine() if plan==b'candidate-plan' else None

        context=Context()
        trt=types.SimpleNamespace(Logger=lambda level:None,Runtime=Runtime,float32='float32',
                                  TensorIOMode=types.SimpleNamespace(INPUT='input',OUTPUT='output'),
                                  TensorLocation=types.SimpleNamespace(DEVICE='device'),
                                  TensorFormat=types.SimpleNamespace(LINEAR='linear'))
        trt.Logger.WARNING=0
        torch=types.SimpleNamespace(float32='float32')
        runtime=ExperimentalGPENConvRuntime(self.files,opt_in=OPT_IN)
        evidence=self.validate()
        runtime.load(torch=torch,trt=trt,validation=lambda _:evidence)

        class Tensor:
            shape=(1,3,512,512)
            dtype='float32'
            device=types.SimpleNamespace(type='cuda')
            def __init__(self,address):self.address=address;self.streams=[]
            def is_contiguous(self):return True
            def data_ptr(self):return self.address
            def record_stream(self,stream):self.streams.append(stream)

        class Stream:
            cuda_stream=73
            def __init__(self):self.syncs=0
            def synchronize(self):self.syncs+=1

        image,output,stream=Tensor(11),Tensor(22),Stream()
        self.assertIs(runtime.run(image,output,stream=stream),output)
        self.assertEqual(context.addresses,{'input':11,'output':22})
        self.assertEqual(context.calls,[73])
        self.assertEqual(stream.syncs,1)
        self.assertEqual(image.streams,[stream])
        self.assertEqual(output.streams,[stream])
        context.fail=True
        with self.assertRaises(RuntimeError):runtime.run(image,output,stream=stream)
        with self.assertRaises(RuntimeError):runtime.run(image,output,stream=stream)
        runtime.close()
        self.assertEqual(stream.syncs,2)


class RealCandidateTopologyTests(unittest.TestCase):
    def test_existing_full_islands_graph_has_exact_fp32_boundaries(self):
        path=Path(r'E:\Pong Benchmarks\tiktok-webview-2026-09-29\gpen512-conv-islands-layers0-13-v1\GPEN-BFR-512-conv-islands.onnx')
        if not path.exists():
            self.skipTest('isolated candidate is unavailable')
        topology=inspect_candidate_graph(path,Path(__file__).resolve().parent/'runtime/models/GPEN-BFR-512.onnx')
        self.assertEqual((topology['candidateNodeCount'],topology['castNodeCount']),(1374,42))

    def test_failed_full_islands_tensor_rt_report_is_not_loadable(self):
        root=Path(__file__).resolve().parent
        parent=Path(r'E:\Pong Benchmarks\tiktok-webview-2026-09-29')
        trial=parent/'gpen512-conv-trial-all-aux0-r1'
        candidate=parent/'gpen512-conv-islands-layers0-13-v1/GPEN-BFR-512-conv-islands.onnx'
        if not (trial/'supervisor.json').exists() or not candidate.exists():
            self.skipTest('completed failed benchmark is unavailable')
        preset=json.loads((root/'presets/current.json').read_text(encoding='utf-8'))
        files=CandidateFiles(candidate,trial,root/'runtime/models/GPEN-BFR-512.onnx',
                             Path(preset['runtime']['restorerNativeTrtQualifiedPlan']))
        with self.assertRaises(ValueError):
            validate_candidate(files)


if __name__=='__main__':
    unittest.main()
