"""Isolated exact mask scheduling experiment. Never installed by production.

Use the same cached TensorRT engines/precision and stable I/O addresses; change
only graph submission. Whole-frame CRC parity and timing decide qualification.
"""
import inspect
import textwrap


def install(*, swapper=False):
    from rope import Models as module
    cls = module.Models

    def replace_method(name, old, new):
        source = textwrap.dedent(inspect.getsource(getattr(cls, name)))
        if source.count(old) != 1:
            raise RuntimeError(f'Experiment source contract changed: {name}')
        scope = {}
        exec(compile(source.replace(old, new), module.__file__, 'exec'), module.__dict__, scope)
        setattr(cls, name, scope[name])

    replace_method('_create_mask_session',
        "'trt_builder_optimization_level': 5,",
        "'trt_builder_optimization_level': 5,\n                'trt_cuda_graph_enable': True,")
    if swapper:
        replace_method('_create_swapper_session',
            "'trt_builder_optimization_level': 5,",
            "'trt_builder_optimization_level': 5,\n                'trt_cuda_graph_enable': True,")
    for name in ('run_occluder', 'run_faceparser'):
        replace_method(name, "backend == 'cuda'", "backend in {'cuda', 'trt'}")

    replace_method('run_dfl_xseg', '''outpred = torch.empty(
        out_shape, dtype=out_torch_dtype, device='cuda',
    ).contiguous()

    io_binding = self.dfl_xseg_model.io_binding()
    io_binding.bind_input(
        name=self._dfl_xseg_in_name, device_type='cuda', device_id=0,
        element_type=self._dfl_xseg_in_dtype, shape=in_shape,
        buffer_ptr=x.data_ptr(),
    )
    io_binding.bind_output(
        name=self._dfl_xseg_out_name, device_type='cuda', device_id=0,
        element_type=self._dfl_xseg_out_dtype, shape=out_shape,
        buffer_ptr=outpred.data_ptr(),
    )''', '''key = ('experiment-dfl', id(self.dfl_xseg_model), tuple(in_shape), tuple(out_shape), x.dtype, out_torch_dtype)
    state = self._mask_cuda_graph_io.get(key)
    if state is None:
        state = {'input': torch.empty_like(x), 'output': torch.empty(out_shape, dtype=out_torch_dtype, device='cuda')}
        binding = self.dfl_xseg_model.io_binding()
        binding.bind_input(name=self._dfl_xseg_in_name, device_type='cuda', device_id=0, element_type=self._dfl_xseg_in_dtype, shape=in_shape, buffer_ptr=state['input'].data_ptr())
        binding.bind_output(name=self._dfl_xseg_out_name, device_type='cuda', device_id=0, element_type=self._dfl_xseg_out_dtype, shape=out_shape, buffer_ptr=state['output'].data_ptr())
        state['binding'] = binding
        self._mask_cuda_graph_io[key] = state
    state['input'].copy_(x)
    x = state['input']
    outpred = state['output']
    io_binding = state['binding']''')
