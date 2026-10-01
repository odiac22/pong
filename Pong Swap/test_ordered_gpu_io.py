import gc
import sys
import unittest
import weakref
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0,str(Path(__file__).parent/'engine'/'Rope'))
from rope.ordered_io import OrderedIoRunner


class Buffer:
    def __init__(self, cuda=True, device='cuda:0'):
        self.is_cuda=cuda;self.device=device;self.recorded=[]
    def record_stream(self,stream):self.recorded.append(stream)

class Options:
    def __init__(self):self.values={}
    def add_run_config_entry(self,key,value):self.values[key]=value

class Session:
    def __init__(self,providers=None):
        self.providers=providers if providers is not None else {'CUDAExecutionProvider':{'user_compute_stream':'7'},'TensorrtExecutionProvider':{'user_compute_stream':'7'},'CPUExecutionProvider':{}}
        self.calls=[]
    def get_provider_options(self):return self.providers
    def run_with_iobinding(self,*args):self.calls.append(args)


class OrderedIoTests(unittest.TestCase):
    def setUp(self):
        self.stream=SimpleNamespace(cuda_stream=7,device='cuda:0')
        self.current=self.stream
        torch=SimpleNamespace(Tensor=Buffer,cuda=SimpleNamespace(current_stream=lambda:self.current))
        self.runner=OrderedIoRunner(torch,SimpleNamespace(RunOptions=Options))

    def test_all_gpu_providers_and_buffers_share_owned_stream(self):
        session=Session();buffers=[Buffer(),Buffer()]
        self.runner.run(session,'binding',self.stream,buffers)
        self.assertEqual(session.calls[0][1].values,{'disable_synchronize_execution_providers':'1'})
        self.assertEqual(self.runner.ordered_calls,1)
        self.assertTrue(all(b.recorded==[self.stream] for b in buffers))

    def test_unproven_provider_or_stream_keeps_fence(self):
        for providers in ({'CUDAExecutionProvider':{}},
                          {'CUDAExecutionProvider':{'user_compute_stream':'8'}},
                          {'CUDAExecutionProvider':{'user_compute_stream':'7'},'TensorrtExecutionProvider':{'user_compute_stream':'8'}},
                          {'CPUExecutionProvider':{}},
                          {'CUDAExecutionProvider':{'user_compute_stream':'7'},'UnknownExecutionProvider':{}}):
            session=Session(providers)
            self.runner.run(session,'binding',self.stream,[Buffer()])
            self.assertEqual(session.calls,[('binding',)])

    def test_cpu_foreign_device_and_missing_buffers_keep_fence(self):
        for buffers in ([Buffer(cuda=False)],[Buffer(device='cuda:1')],[]):
            session=Session();self.runner.run(session,'binding',self.stream,buffers)
            self.assertEqual(session.calls,[('binding',)])

    def test_current_stream_rechecked_after_cached_proof(self):
        session=Session();self.runner.run(session,'first',self.stream,[Buffer()])
        self.current=SimpleNamespace(cuda_stream=9,device='cuda:0')
        self.runner.run(session,'second',self.stream,[Buffer()])
        self.assertEqual(session.calls[-1],('second',))
        self.assertEqual(self.runner.ordered_calls,1)

    def test_cache_does_not_retain_unloaded_session(self):
        session=Session();ref=weakref.ref(session)
        self.runner.run(session,'binding',self.stream,[Buffer()])
        del session;gc.collect()
        self.assertIsNone(ref());self.assertEqual(len(self.runner._proofs),0)

if __name__=='__main__':unittest.main()
