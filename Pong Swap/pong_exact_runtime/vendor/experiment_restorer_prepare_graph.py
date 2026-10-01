"""Isolated graph replay of unchanged GPEN1024 input tensor operations."""
from collections import OrderedDict
import inspect
import textwrap


def install(guard_graph=False, borrow_outputs=False):
    import torch
    import numpy as np
    from rope import VideoManager as module
    from torchvision.transforms.v2.functional import _geometry as geometry
    v2 = module.v2

    def prepare(self, image, transform, size, bilinear):
        # The affine parameters are constant per crop geometry, not face pose:
        # the current face has already been aligned by swap_core.
        angle = transform.rotation * 57.2958
        translation = (transform.translation[0], transform.translation[1])
        scale = transform.scale
        interpolation = v2.InterpolationMode.BILINEAR if bilinear else v2.InterpolationMode.NEAREST

        def operations(source):
            result = geometry._apply_grid_transform(source, entry['grid'], interpolation.value, fill=None)
            result = v2.functional.crop(result, 0, 0, size, size)
            result = torch.unsqueeze(result, 0)
            result = result.to(torch.float32).div(127.5).sub(1.0).contiguous()
            result = v2.Resize((1024, 1024), antialias=False)(result)
            pixels = torch.squeeze(result).to(torch.float32).add(1.0).mul(127.5).clamp(0.0, 255.0)
            return result, pixels

        stream = torch.cuda.current_stream(image.device)
        key = (tuple(image.shape), tuple(image.stride()), image.dtype, str(image.device),
               int(stream.cuda_stream), np.asarray(transform.params).tobytes(), int(size), bool(bilinear))
        cache = getattr(self, '_experimental_restorer_prepare_graphs', None)
        if cache is None:
            cache = self._experimental_restorer_prepare_graphs = OrderedDict()
        entry = cache.get(key)
        if entry is None:
            entry = {'seen': 0}
            parsed_angle, parsed_translate, parsed_shear, _ = geometry._affine_parse_args(
                angle, translation, scale, 0, interpolation, (0, 0))
            height, width = image.shape[-2:]
            matrix = geometry._get_inverse_affine_matrix(
                [-width * 0.5, -height * 0.5], parsed_angle,
                [float(value) for value in parsed_translate], scale, parsed_shear)
            dtype = image.dtype if torch.is_floating_point(image) else torch.float32
            theta = torch.tensor(matrix, dtype=dtype, device=image.device).reshape(1, 2, 3)
            entry['grid'] = geometry._affine_grid(theta, w=width, h=height, ow=width, oh=height)
            cache[key] = entry
        cache.move_to_end(key)
        while len(cache) > 4:
            _, evicted = cache.popitem(last=False)
            # The graph, static image/grid and queued output clones must stay
            # owned until the last replay on the owner stream completes.
            if evicted.get('lastUse') is not None:
                evicted['lastUse'].synchronize()
        entry['seen'] += 1
        if entry['seen'] < 3:
            return operations(image)
        if 'graph' not in entry:
            source = image.clone()
            operations(source)
            stream.synchronize()
            graph = torch.cuda.CUDAGraph()
            with torch.cuda.graph(graph, stream=stream, capture_error_mode='thread_local'):
                output, pixels = operations(source)
            entry.update(graph=graph, source=source, output=output, pixels=pixels)
        entry['source'].copy_(image)
        entry['graph'].replay()
        # Experimental borrowed lifetime: both consumers are on this same
        # ordered stream; all persistent temporal histories clone their input.
        # The lease ends at the next prepare call on this VM/stream. Keep the
        # default owned return until the whole-track parity contract passes.
        output, pixels = ((entry['output'], entry['pixels']) if borrow_outputs
                          else (entry['output'].clone(), entry['pixels'].clone()))
        last_use = torch.cuda.Event()
        last_use.record(stream)
        entry['lastUse'] = last_use
        return output, pixels

    original = module.VideoManager._apply_restorer_inner
    source = textwrap.dedent(inspect.getsource(original))
    old = """            input_face = v2.functional.affine(
                input_face,
                tform.rotation * 57.2958,
                (tform.translation[0], tform.translation[1]),
                tform.scale,
                0,
                center=(0, 0),
                interpolation=(
                    v2.InterpolationMode.BILINEAR
                    if bilinear_input_alignment
                    else v2.InterpolationMode.NEAREST
                ),
            )
            input_face = v2.functional.crop(input_face, 0,0, face_size, face_size)"""
    new = """            if (parameters['RestorerTypeTextSel'] == 'GPEN1024'
                    and parameters['RestorerDetTypeTextSel'] == 'Blend'
                    and input_face.is_cuda):
                input_face, prepared_pixels = self._isolated_restorer_prepare(
                    input_face, tform, face_size, bilinear_input_alignment)
                input_already_resized = True
            else:
""" + textwrap.indent(old, '    ')
    if source.count(old) != 1:
        raise RuntimeError('Restorer alignment contract changed')
    source = source.replace('    input_already_resized = False',
                            '    input_already_resized = False\n    prepared_pixels = None')
    source = source.replace(old, new)
    normalize = '    input_face = input_face.to(torch.float32).div(127.5).sub(1.0).contiguous()'
    pixels = """    current_input_pixels = (
        torch.squeeze(input_face).to(torch.float32).add(1.0).mul(127.5).clamp(0.0, 255.0)
    )"""
    if source.count(normalize) != 1 or source.count(pixels) != 1:
        raise RuntimeError('Restorer preparation contract changed')
    source = source.replace(normalize, '    if prepared_pixels is None:\n' + textwrap.indent(normalize, '    '))
    source = source.replace(pixels, '    if prepared_pixels is None:\n' + textwrap.indent(pixels, '    ')
                            + '\n    else:\n        current_input_pixels = prepared_pixels')
    if guard_graph:
        from pong_exact_runtime.vendor.experiment_restorer_guard_graph import install as install_guards, transform_source
        install_guards(module)
        source = transform_source(source)
    scope = {}
    exec(compile(source, module.__file__, 'exec'), module.__dict__, scope)
    module.VideoManager._isolated_restorer_prepare = prepare
    module.VideoManager._apply_restorer_inner = scope[original.__name__]
