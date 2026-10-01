"""Small process-local NVRTC harness; never used by production."""
import ctypes as ct
from pathlib import Path


class CudaModule:
    def __init__(self, source, names):
        import torch
        self.driver = ct.WinDLL('nvcuda.dll')
        nvrtc = ct.WinDLL(str(Path(torch.__file__).parent / 'lib/nvrtc64_120_0.dll'))
        ptr = ct.c_void_p
        signatures = {
            'nvrtcCreateProgram': [ct.POINTER(ptr), ct.c_char_p, ct.c_char_p, ct.c_int, ptr, ptr],
            'nvrtcCompileProgram': [ptr, ct.c_int, ct.POINTER(ct.c_char_p)],
            'nvrtcGetProgramLogSize': [ptr, ct.POINTER(ct.c_size_t)],
            'nvrtcGetProgramLog': [ptr, ptr], 'nvrtcGetPTXSize': [ptr, ct.POINTER(ct.c_size_t)],
            'nvrtcGetPTX': [ptr, ptr], 'nvrtcDestroyProgram': [ct.POINTER(ptr)],
        }
        for name, args in signatures.items():
            getattr(nvrtc, name).argtypes = args
            getattr(nvrtc, name).restype = ct.c_int
        self.driver.cuModuleLoadData.argtypes = [ct.POINTER(ptr), ptr]
        self.driver.cuModuleGetFunction.argtypes = [ct.POINTER(ptr), ptr, ct.c_char_p]
        self.driver.cuLaunchKernel.argtypes = [ptr, *([ct.c_uint] * 7), ptr, ct.POINTER(ptr), ptr]
        program = ptr()
        self.check(nvrtc.nvrtcCreateProgram(ct.byref(program), source.encode(), b'isolated.cu', 0, None, None))
        try:
            major, minor = torch.cuda.get_device_capability(0)
            options = [f'--gpu-architecture=compute_{major}{minor}'.encode(),
                       b'--fmad=false', b'--ftz=false', b'--prec-div=true', b'--prec-sqrt=true']
            flags = (ct.c_char_p * len(options))(*options)
            status = nvrtc.nvrtcCompileProgram(program, len(options), flags)
            size = ct.c_size_t()
            self.check(nvrtc.nvrtcGetProgramLogSize(program, ct.byref(size)))
            log = ct.create_string_buffer(size.value)
            self.check(nvrtc.nvrtcGetProgramLog(program, log))
            if status:
                raise RuntimeError(log.value.decode(errors='replace'))
            self.check(nvrtc.nvrtcGetPTXSize(program, ct.byref(size)))
            ptx = ct.create_string_buffer(size.value)
            self.check(nvrtc.nvrtcGetPTX(program, ptx))
            self.module = ptr()
            self.check(self.driver.cuModuleLoadData(ct.byref(self.module), ptx))
            self.functions = {}
            for name in names:
                value = ptr()
                self.check(self.driver.cuModuleGetFunction(ct.byref(value), self.module, name.encode()))
                self.functions[name] = value
        finally:
            nvrtc.nvrtcDestroyProgram(ct.byref(program))

    @staticmethod
    def check(status):
        if status:
            raise RuntimeError(f'CUDA experiment returned {status}')

    def launch(self, name, count, values, tensors):
        import torch
        stream = torch.cuda.current_stream(tensors[0].device)
        pointers = (ct.c_void_p * len(values))(*[ct.cast(ct.byref(v), ct.c_void_p) for v in values])
        self.check(self.driver.cuLaunchKernel(self.functions[name], (count+255)//256, 1, 1,
                   256, 1, 1, 0, ct.c_void_p(stream.cuda_stream), pointers, None))
        for tensor in tensors:
            tensor.record_stream(stream)

